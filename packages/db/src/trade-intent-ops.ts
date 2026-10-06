import { and, eq, sql, type SQL } from 'drizzle-orm';
import {
  BrokerAccountStatus,
  TradeIntentErrorCode,
  UserStatus,
  TradeIntentFailureReason,
  TradeIntentStatus,
  TradeMode,
  canTransition,
  type ClosedTrade,
  type CreateTradeIntentRequest,
  type OpenTrade,
  type TradeIntentView,
  type TradeTransport,
} from '@binarius/shared';
import type { Db } from './client';
import { brokerAccounts } from './schema/broker-accounts';
import { BrokerTradeStatus, brokerTrades } from './schema/broker-trades';
import { OutboxTopic, outboxEvents } from './schema/outbox-events';
import { TokenLedgerKind, tokenLedger } from './schema/token-ledger';
import { tradeIntents } from './schema/trade-intents';
import { users } from './schema/users';

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbExecutor = Db | Tx;
export type TradeIntentRow = typeof tradeIntents.$inferSelect;

// one token per accepted trade in both modes (product plan, owner decision 2026-09-23)
export const TOKENS_PER_INTENT = 1n;

// Only these two mean "someone else won the race for this account"; a violation of any other
// unique constraint is a bug and must surface as an error, not as a 409.
const REPLAY_CONSTRAINTS: ReadonlySet<string> = new Set([
  'trade_intents_user_request_idx',
  'trade_intents_active_account_idx',
]);

export class TradeIntentError extends Error {
  constructor(readonly code: TradeIntentErrorCode) {
    super(code);
    this.name = 'TradeIntentError';
  }
}

// drizzle wraps the driver error in DrizzleQueryError; the SQLSTATE and the constraint name are
// on the cause. Reading them off the top-level error would turn every replay into a 500.
export function uniqueViolation(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: unknown; constraint?: unknown } } | undefined)?.cause;
  if (cause?.code !== '23505') return undefined;
  return typeof cause.constraint === 'string' ? cause.constraint : undefined;
}

export interface CreateTradeIntentResult {
  intent: TradeIntentRow;
  created: boolean;
}

// Required, with no default: every creator of intents (the route today, the session
// orchestrator of #130 tomorrow) names the policy it runs under.
export interface TradePolicy {
  realTradingEnabled: boolean;
}

export async function createTradeIntent(
  db: Db,
  input: CreateTradeIntentRequest,
  policy: TradePolicy,
): Promise<CreateTradeIntentResult> {
  try {
    return await db.transaction((tx) => createInTransaction(tx, input, policy));
  } catch (error) {
    const constraint = uniqueViolation(error);
    if (constraint === undefined || !REPLAY_CONSTRAINTS.has(constraint)) throw error;
    // Two identical requests violate the request index, two different ones the active-account
    // index, and PostgreSQL does not promise which of the two it reports when both apply —
    // the winner's row, looked up by client_request_id, tells the cases apart.
    const user = await findUser(db, input.telegramUserId);
    if (user === undefined) throw new TradeIntentError(TradeIntentErrorCode.UserNotFound);
    const replay = await findReplay(db, user.id, input);
    if (replay !== undefined) return replay;
    throw new TradeIntentError(TradeIntentErrorCode.ActiveIntentExists);
  }
}

// Lock order is users → broker_accounts (the reserve UPDATE, then FOR NO KEY UPDATE); every
// other writer touching both tables must keep it.
async function createInTransaction(
  tx: Tx,
  input: CreateTradeIntentRequest,
  policy: TradePolicy,
): Promise<CreateTradeIntentResult> {
  const tokens = TOKENS_PER_INTENT;
  const user = await findUser(tx, input.telegramUserId);
  if (user === undefined) throw new TradeIntentError(TradeIntentErrorCode.UserNotFound);

  // before any eligibility guard: a retry must find its intent even after the user was blocked
  // or the account revoked in the meantime
  const replay = await findReplay(tx, user.id, input);
  if (replay !== undefined) return replay;

  // after the replay, so a retry still finds an intent created while the grant was on; before
  // the account and the reserve, so a refusal reads no account and touches no balance
  if (input.mode === TradeMode.Real && !policy.realTradingEnabled) {
    throw new TradeIntentError(TradeIntentErrorCode.RealTradingDisabled);
  }

  const brokerAccountId = await resolveAccount(tx, user.id, input.brokerAccountId);

  const reserved = await tx
    .update(users)
    .set({ tokenReserved: sql`${users.tokenReserved} + ${tokens}` })
    .where(
      and(
        eq(users.id, user.id),
        eq(users.status, UserStatus.Active),
        sql`${users.tokenBalance} - ${users.tokenReserved} >= ${tokens}`,
      ),
    )
    .returning({ id: users.id });
  if (reserved.length === 0) {
    const [fresh] = await tx
      .select({ status: users.status })
      .from(users)
      .where(eq(users.id, user.id));
    throw new TradeIntentError(
      fresh?.status === UserStatus.Blocked
        ? TradeIntentErrorCode.UserBlocked
        : TradeIntentErrorCode.InsufficientTokens,
    );
  }

  // NO KEY UPDATE: serializes creators and blocks a concurrent revoke/halt until commit while
  // staying compatible with the KEY SHARE locks the trade_intents FKs take on this row
  const locked = await tx
    .select({ id: brokerAccounts.id })
    .from(brokerAccounts)
    .where(
      and(
        eq(brokerAccounts.id, brokerAccountId),
        eq(brokerAccounts.status, BrokerAccountStatus.Active),
        eq(brokerAccounts.tradingHalted, false),
      ),
    )
    .for('no key update');
  if (locked.length === 0) {
    const [fresh] = await tx
      .select({ status: brokerAccounts.status })
      .from(brokerAccounts)
      .where(eq(brokerAccounts.id, brokerAccountId));
    throw new TradeIntentError(accountErrorFor(fresh?.status));
  }

  const [planned] = await tx
    .insert(tradeIntents)
    .values({
      brokerAccountId,
      userId: user.id,
      mode: input.mode,
      assetId: input.assetId,
      amount: input.amount,
      action: input.action,
      durationSec: input.durationSec,
      clientRequestId: input.clientRequestId,
      status: TradeIntentStatus.Planned,
      tokensReserved: tokens,
    })
    .returning();
  if (planned === undefined) throw new Error('trade_intents insert returned no row');

  await tx.insert(tokenLedger).values({
    userId: user.id,
    kind: TokenLedgerKind.Reserve,
    reservedDelta: tokens,
    intentId: planned.id,
  });
  const reservedIntent = await transitionIntent(tx, {
    id: planned.id,
    from: TradeIntentStatus.Planned,
    to: TradeIntentStatus.Reserved,
    expectedVersion: planned.version,
  });
  if (reservedIntent === undefined) throw new Error('planned intent vanished inside its own tx');

  await tx.insert(outboxEvents).values({
    intentId: planned.id,
    topic: OutboxTopic.TradingIntents,
    payload: { intent_id: planned.id },
  });
  const queued = await transitionIntent(tx, {
    id: planned.id,
    from: TradeIntentStatus.Reserved,
    to: TradeIntentStatus.Queued,
    expectedVersion: reservedIntent.version,
  });
  if (queued === undefined) throw new Error('reserved intent vanished inside its own tx');
  return { intent: queued, created: true };
}

async function findUser(
  exec: DbExecutor,
  telegramUserId: string,
): Promise<{ id: string; status: string } | undefined> {
  const [user] = await exec
    .select({ id: users.id, status: users.status })
    .from(users)
    .where(eq(users.telegramUserId, BigInt(telegramUserId)));
  return user;
}

// keyed by (user, clientRequestId) — the unique index trade_intents_user_request_idx — so a
// retry finds its intent whatever account it names now; naming a different account is "same
// id, different parameters", not a replay
async function findReplay(
  exec: DbExecutor,
  userId: string,
  input: CreateTradeIntentRequest,
): Promise<CreateTradeIntentResult | undefined> {
  const [row] = await exec
    .select()
    .from(tradeIntents)
    .where(
      and(eq(tradeIntents.userId, userId), eq(tradeIntents.clientRequestId, input.clientRequestId)),
    );
  if (row === undefined) return undefined;
  const same =
    (input.brokerAccountId === undefined || input.brokerAccountId === row.brokerAccountId) &&
    row.mode === input.mode &&
    row.assetId === input.assetId &&
    row.action === input.action &&
    row.durationSec === input.durationSec &&
    normalizeDecimal(row.amount) === normalizeDecimal(input.amount);
  if (!same) throw new TradeIntentError(TradeIntentErrorCode.ClientRequestIdConflict);
  return { intent: row, created: false };
}

// numeric(20,8) comes back as '10.00000000' while the request said '10.00': compare the values,
// not the spellings, without ever going through a float
function normalizeDecimal(value: string): string {
  const [integer = '0', fraction = ''] = value.split('.');
  const int = integer.replace(/^0+(?=\d)/, '');
  const frac = fraction.replace(/0+$/, '');
  return frac === '' ? int : `${int}.${frac}`;
}

async function resolveAccount(
  exec: DbExecutor,
  userId: string,
  brokerAccountId: string | undefined,
): Promise<string> {
  if (brokerAccountId !== undefined) {
    const [account] = await exec
      .select({ id: brokerAccounts.id })
      .from(brokerAccounts)
      .where(and(eq(brokerAccounts.id, brokerAccountId), eq(brokerAccounts.userId, userId)));
    if (account === undefined)
      throw new TradeIntentError(TradeIntentErrorCode.BrokerAccountNotFound);
    return account.id;
  }
  const accounts = await exec
    .select({ id: brokerAccounts.id, status: brokerAccounts.status })
    .from(brokerAccounts)
    .where(eq(brokerAccounts.userId, userId));
  const [only, ...more] = accounts.filter((a) => a.status === BrokerAccountStatus.Active);
  if (only === undefined) {
    // "no account" and "an account nobody confirmed yet" need different answers: the second one
    // tells the user to finish the login they already started
    throw new TradeIntentError(
      accounts.some((a) => a.status === BrokerAccountStatus.Pending)
        ? TradeIntentErrorCode.AccountNotConfirmed
        : TradeIntentErrorCode.BrokerAccountNotFound,
    );
  }
  if (more.length > 0) throw new TradeIntentError(TradeIntentErrorCode.AmbiguousBrokerAccount);
  return only.id;
}

function accountErrorFor(status: BrokerAccountStatus | undefined): TradeIntentErrorCode {
  if (status === BrokerAccountStatus.Revoked) return TradeIntentErrorCode.AccountRevoked;
  if (status === BrokerAccountStatus.Pending) return TradeIntentErrorCode.AccountNotConfirmed;
  return TradeIntentErrorCode.AccountHalted;
}

// --- Transitions --------------------------------------------------------------------------------

export interface IntentPatch {
  lastError?: TradeIntentFailureReason | null;
  transport?: TradeTransport | null;
  submittedAt?: Date | SQL | null;
  tokensReserved?: bigint;
}

export interface TransitionOptions {
  id: string;
  from: TradeIntentStatus;
  to: TradeIntentStatus;
  // omitted by callers that guard on time instead (the sweeper); every transition still bumps it
  expectedVersion?: number;
  patch?: IntentPatch;
  where?: SQL;
}

// The one CAS every status change goes through: `status = from`, optionally `version = expected`
// and an extra predicate, all in the UPDATE itself, so a duplicate or late caller gets zero rows
// instead of overwriting a newer state.
export async function transitionIntent(
  exec: DbExecutor,
  { id, from, to, expectedVersion, patch, where }: TransitionOptions,
): Promise<TradeIntentRow | undefined> {
  if (!canTransition(from, to)) throw new Error(`illegal trade intent transition ${from} -> ${to}`);
  const [row] = await exec
    .update(tradeIntents)
    .set({ ...patch, status: to, version: sql`${tradeIntents.version} + 1` })
    .where(
      and(
        eq(tradeIntents.id, id),
        eq(tradeIntents.status, from),
        expectedVersion === undefined ? undefined : eq(tradeIntents.version, expectedVersion),
        where,
      ),
    )
    .returning();
  return row;
}

// database-clock arithmetic shared by every age predicate (worker, publisher, sweeper): the
// app clock never enters a CAS
export const millisecondsAgo = (ms: number): SQL =>
  sql`now() - (${ms}::int * interval '1 millisecond')`;

export interface TakeIntentOptions {
  id: string;
  expectedVersion: number;
  maxAgeMs: number;
}

// queued → submitting, refused for an intent older than maxAgeMs (database clock)
export function takeIntent(
  exec: DbExecutor,
  { id, expectedVersion, maxAgeMs }: TakeIntentOptions,
): Promise<TradeIntentRow | undefined> {
  return transitionIntent(exec, {
    id,
    from: TradeIntentStatus.Queued,
    to: TradeIntentStatus.Submitting,
    expectedVersion,
    patch: { submittedAt: sql`now()` },
    where: sql`${tradeIntents.createdAt} >= ${millisecondsAgo(maxAgeMs)}`,
  });
}

export interface RejectIntentOptions {
  id: string;
  from: TradeIntentStatus;
  expectedVersion?: number;
  reason: TradeIntentFailureReason;
  where?: SQL;
}

// Rejection releases the reserve in the same transaction: ledger release row, users cache,
// intent.tokens_reserved back to 0. Needs a transaction because it is three statements.
// Lock order is users → trade_intents, the same as creation (users → broker_accounts →
// trade_intents): taking the intent first and the user second deadlocked against a creation
// that held the user row while its INSERT waited on this intent's index entry.
export async function rejectIntent(
  tx: Tx,
  { id, from, expectedVersion, reason, where }: RejectIntentOptions,
): Promise<TradeIntentRow | undefined> {
  await lockIntentUser(tx, id);
  const [current] = await tx
    .select({
      userId: tradeIntents.userId,
      tokensReserved: tradeIntents.tokensReserved,
      status: tradeIntents.status,
      version: tradeIntents.version,
    })
    .from(tradeIntents)
    .where(eq(tradeIntents.id, id))
    .for('update');
  if (current === undefined || current.status !== from) return undefined;
  if (expectedVersion !== undefined && current.version !== expectedVersion) return undefined;
  const rejected = await transitionIntent(tx, {
    id,
    from,
    to: TradeIntentStatus.Rejected,
    expectedVersion: current.version,
    patch: { lastError: reason, tokensReserved: 0n },
    where,
  });
  if (rejected === undefined) return undefined;
  if (current.tokensReserved > 0n) {
    await releaseTokens(tx, {
      userId: current.userId,
      intentId: id,
      tokens: current.tokensReserved,
    });
  }
  return rejected;
}

async function lockIntentUser(tx: Tx, intentId: string): Promise<void> {
  await tx
    .select({ id: users.id })
    .from(users)
    .where(
      eq(
        users.id,
        sql`(select ${tradeIntents.userId} from ${tradeIntents} where ${tradeIntents.id} = ${intentId})`,
      ),
    )
    .for('no key update');
}

export interface RejectExpiredOptions {
  id: string;
  expectedVersion: number;
  maxAgeMs: number;
}

export function rejectExpiredIntent(
  tx: Tx,
  { id, expectedVersion, maxAgeMs }: RejectExpiredOptions,
): Promise<TradeIntentRow | undefined> {
  return rejectIntent(tx, {
    id,
    from: TradeIntentStatus.Queued,
    expectedVersion,
    reason: TradeIntentFailureReason.Expired,
    where: sql`${tradeIntents.createdAt} < ${millisecondsAgo(maxAgeMs)}`,
  });
}

async function releaseTokens(
  tx: Tx,
  { userId, intentId, tokens }: { userId: string; intentId: string; tokens: bigint },
): Promise<void> {
  await tx.insert(tokenLedger).values({
    userId,
    kind: TokenLedgerKind.Release,
    reservedDelta: -tokens,
    intentId,
  });
  const rows = await tx
    .update(users)
    .set({ tokenReserved: sql`${users.tokenReserved} - ${tokens}` })
    .where(and(eq(users.id, userId), sql`${users.tokenReserved} >= ${tokens}`))
    .returning({ id: users.id });
  // the cache is a sum of the ledger; going below the intent's own reserve means they diverged
  if (rows.length === 0) throw new Error(`token reserve underflow for user ${userId}`);
}

// settlement: the reserved token leaves both the reserve and the balance, in the ledger row and
// in the users cache, in one transaction (the settle row's terminal index makes it exactly-once)
async function consumeTokens(
  tx: Tx,
  { userId, intentId, tokens }: { userId: string; intentId: string; tokens: bigint },
): Promise<void> {
  await tx.insert(tokenLedger).values({
    userId,
    kind: TokenLedgerKind.Settle,
    reservedDelta: -tokens,
    balanceDelta: -tokens,
    intentId,
  });
  const rows = await tx
    .update(users)
    .set({
      tokenBalance: sql`${users.tokenBalance} - ${tokens}`,
      tokenReserved: sql`${users.tokenReserved} - ${tokens}`,
    })
    .where(
      and(
        eq(users.id, userId),
        sql`${users.tokenReserved} >= ${tokens}`,
        sql`${users.tokenBalance} >= ${tokens}`,
      ),
    )
    .returning({ id: users.id });
  if (rows.length === 0) throw new Error(`token settle underflow for user ${userId}`);
}

export interface MarkUnknownOptions {
  id: string;
  reason: TradeIntentFailureReason;
  expectedVersion?: number;
  // sweeper: only an intent that has been submitting longer than this
  olderThanMs?: number;
}

// submitting → unknown plus the reconciliation outbox row (ARCH-04 consumes it); idempotent on
// the (topic, intent_id) unique key
export async function markIntentUnknown(
  tx: Tx,
  { id, reason, expectedVersion, olderThanMs }: MarkUnknownOptions,
): Promise<TradeIntentRow | undefined> {
  const row = await transitionIntent(tx, {
    id,
    from: TradeIntentStatus.Submitting,
    to: TradeIntentStatus.Unknown,
    expectedVersion,
    patch: { lastError: reason },
    where:
      olderThanMs === undefined
        ? undefined
        : sql`${tradeIntents.submittedAt} < ${millisecondsAgo(olderThanMs)}`,
  });
  if (row === undefined) return undefined;
  await tx
    .insert(outboxEvents)
    .values({ intentId: id, topic: OutboxTopic.TradingReconciliation, payload: { intent_id: id } })
    .onConflictDoNothing({ target: [outboxEvents.topic, outboxEvents.intentId] });
  return row;
}

// --- Acceptance and settlement (#17) ----------------------------------------------------------
// Lock order for everything below: users → trade_intents → broker_trades (the creation chain
// users → broker_accounts → trade_intents, with broker_trades as its tail). Settlement does not
// lock broker_accounts. A future writer of broker_trades (#90's reconciliation) keeps the order.

export const TradeMismatchReason = {
  Mode: 'mode',
  Asset: 'asset',
  Action: 'action',
  Amount: 'amount',
  // the broker trade is already linked to another intent, or this intent to another trade
  TradeAlreadyLinked: 'trade_already_linked',
} as const;
export type TradeMismatchReason = (typeof TradeMismatchReason)[keyof typeof TradeMismatchReason];

// Thrown inside the caller's transaction; the caller lets it roll back, and nothing of the
// acceptance or settlement is written. A four-field mismatch is found before any write, but
// trade_already_linked can come from a unique violation that has already aborted the
// transaction: a caller that catches this error writes its follow-up (unknown, manual_review)
// in a fresh transaction, never in the one that threw. Carries ids and a code only, nothing the
// broker sent.
export class TradeIntentMismatchError extends Error {
  constructor(
    readonly reason: TradeMismatchReason,
    readonly intentId: string,
    readonly brokerTradeId: string,
  ) {
    super(`broker trade does not match the intent: ${reason}`);
    this.name = 'TradeIntentMismatchError';
  }
}

const LINK_CONSTRAINTS: ReadonlySet<string> = new Set([
  'broker_trades_account_trade_key',
  'broker_trades_intent_id_key',
]);

type IntentTerms = Pick<TradeIntentRow, 'mode' | 'assetId' | 'action' | 'amount'>;

function mismatchOf(intent: IntentTerms, trade: OpenTrade | ClosedTrade) {
  if (trade.isDemo !== (intent.mode === TradeMode.Demo)) return TradeMismatchReason.Mode;
  if (trade.assetId !== intent.assetId) return TradeMismatchReason.Asset;
  if (trade.action !== intent.action) return TradeMismatchReason.Action;
  if (normalizeDecimal(trade.amount) !== normalizeDecimal(intent.amount)) {
    return TradeMismatchReason.Amount;
  }
  return undefined;
}

// the open columns of a broker_trades row; raw is the parsed domain trade (shared's parsers
// strip unknown keys, so no token or wire extra reaches it)
function tradeRow(intent: TradeIntentRow, trade: OpenTrade | ClosedTrade) {
  return {
    brokerAccountId: intent.brokerAccountId,
    intentId: intent.id,
    brokerTradeId: trade.id,
    mode: intent.mode,
    assetId: trade.assetId,
    action: trade.action,
    amount: trade.amount,
    payout: trade.payout,
    openPrice: trade.openPrice,
    openTimestampMs: trade.openTimestamp,
    source: trade.source ?? null,
    brokerClientId: trade.brokerClientId ?? null,
    raw: { ...trade },
  };
}

async function insertTrade(
  tx: Tx,
  intent: TradeIntentRow,
  trade: OpenTrade | ClosedTrade,
  values: Partial<typeof brokerTrades.$inferInsert> & { status: BrokerTradeStatus },
): Promise<void> {
  try {
    await tx.insert(brokerTrades).values({ ...tradeRow(intent, trade), ...values });
  } catch (error) {
    const constraint = uniqueViolation(error);
    if (constraint === undefined || !LINK_CONSTRAINTS.has(constraint)) throw error;
    throw new TradeIntentMismatchError(TradeMismatchReason.TradeAlreadyLinked, intent.id, trade.id);
  }
}

export interface MarkAcceptedOptions {
  id: string;
  expectedVersion: number;
  // submitting for the executor's answer; reconciling for #89, with the trade REST found
  from?: typeof TradeIntentStatus.Submitting | typeof TradeIntentStatus.Reconciling;
  transport: TradeTransport;
  // the broker's open trade as received, never a locally built one
  trade: OpenTrade;
}

// accepted only together with the broker's open trade: the trade is checked against the intent
// (mode, asset, action and amount never change after creation, so an unlocked read is enough),
// then the CAS, then the open broker_trades row is written. A four-field mismatch throws before
// any write; a lost CAS answers undefined and inserts nothing; a trade already linked throws from
// the insert, and the caller's transaction rolls the CAS back.
export async function markIntentAccepted(
  tx: Tx,
  {
    id,
    expectedVersion,
    from = TradeIntentStatus.Submitting,
    transport,
    trade,
  }: MarkAcceptedOptions,
): Promise<TradeIntentRow | undefined> {
  const [terms] = await tx
    .select({
      mode: tradeIntents.mode,
      assetId: tradeIntents.assetId,
      action: tradeIntents.action,
      amount: tradeIntents.amount,
    })
    .from(tradeIntents)
    .where(eq(tradeIntents.id, id));
  if (terms === undefined) return undefined;
  const reason = mismatchOf(terms, trade);
  if (reason !== undefined) throw new TradeIntentMismatchError(reason, id, trade.id);
  const row = await transitionIntent(tx, {
    id,
    from,
    to: TradeIntentStatus.Accepted,
    expectedVersion,
    patch: { transport },
  });
  if (row === undefined) return undefined;
  await insertTrade(tx, row, trade, {
    status: BrokerTradeStatus.Open,
    potentialProfit: trade.potentialProfit,
  });
  return row;
}

export interface SettleIntentOptions {
  id: string;
  expectedVersion?: number;
  // manual_review: the operator's conclusion with the trade the broker reports closed
  from: typeof TradeIntentStatus.Accepted | typeof TradeIntentStatus.ManualReview;
  // For a never-linked manual_review intent the row is written under the intent's
  // broker_account_id, and a ClosedTrade carries no account: the caller takes it from this
  // account's own closed list (listTrades with the account's own token).
  trade: ClosedTrade;
}

// → settled: the token is debited whatever the trade's outcome (owner, 2026-10-06), the
// broker_trades row is closed, or inserted closed for a manual_review intent never linked.
// On the linked path only the id is checked and the close is applied as received: the row's open
// fields are the broker's own (written from its open trade) and the close does not overwrite
// them. The four-field check guards only the insert for a never-linked manual_review intent,
// which stays parked for the operator on a mismatch.
export async function settleIntent(
  tx: Tx,
  { id, expectedVersion, from, trade }: SettleIntentOptions,
): Promise<TradeIntentRow | undefined> {
  await lockIntentUser(tx, id);
  const [current] = await tx
    .select()
    .from(tradeIntents)
    .where(eq(tradeIntents.id, id))
    .for('update');
  if (current === undefined || current.status !== from) return undefined;
  if (expectedVersion !== undefined && current.version !== expectedVersion) return undefined;

  const [linked] = await tx
    .select({ id: brokerTrades.id, brokerTradeId: brokerTrades.brokerTradeId })
    .from(brokerTrades)
    .where(eq(brokerTrades.intentId, id))
    .for('update');
  if (linked !== undefined && linked.brokerTradeId !== trade.id) {
    throw new TradeIntentMismatchError(TradeMismatchReason.TradeAlreadyLinked, id, trade.id);
  }
  if (linked === undefined) {
    const reason = mismatchOf(current, trade);
    if (reason !== undefined) throw new TradeIntentMismatchError(reason, id, trade.id);
  }

  const settled = await transitionIntent(tx, {
    id,
    from,
    to: TradeIntentStatus.Settled,
    expectedVersion: current.version,
    patch: { tokensReserved: 0n },
  });
  if (settled === undefined) return undefined;
  if (current.tokensReserved > 0n) {
    await consumeTokens(tx, {
      userId: current.userId,
      intentId: id,
      tokens: current.tokensReserved,
    });
  }
  const closing = {
    status: BrokerTradeStatus.Closed,
    closePrice: trade.closePrice,
    closeTimestampMs: trade.closeTimestamp,
    profit: trade.profit,
    raw: { ...trade },
  };
  if (linked === undefined) {
    await insertTrade(tx, current, trade, closing);
  } else {
    await tx.update(brokerTrades).set(closing).where(eq(brokerTrades.id, linked.id));
  }
  return settled;
}

export type ClosedTradeOutcome =
  // the intent is settled and the token debited
  | { brokerTradeId: string; result: 'settled'; intentId: string }
  // an earlier pass settled it; nothing to do
  | { brokerTradeId: string; result: 'already_settled'; intentId: string }
  // no intent behind this trade: a platform/manual trade, or an acceptance not persisted yet —
  // ignore; a later snapshot links it
  | { brokerTradeId: string; result: 'not_ours' }
  // the intent is reconciling/manual_review: for #89/#90/the operator, never settled here
  | {
      brokerTradeId: string;
      result: 'intent_not_accepted';
      intentId: string;
      status: TradeIntentStatus;
    };

// The one applier of closed trades: a close_trade.success payload (#101) and a REST closed
// snapshot (#90). One transaction per trade, so a database error mid-batch leaves the earlier
// trades applied and propagates; every outcome is idempotent, so the replay is safe. The lookup
// is by (account, broker trade id), so the linked row always carries the trade's own id and
// settleIntent cannot answer a mismatch here; any error is a bug or a database failure.
export async function settleClosedTrades(
  db: Db,
  { brokerAccountId, trades }: { brokerAccountId: string; trades: readonly ClosedTrade[] },
): Promise<ClosedTradeOutcome[]> {
  const outcomes: ClosedTradeOutcome[] = [];
  for (const trade of trades) {
    outcomes.push(await settleClosedTrade(db, brokerAccountId, trade));
  }
  return outcomes;
}

async function settleClosedTrade(
  db: Db,
  brokerAccountId: string,
  trade: ClosedTrade,
): Promise<ClosedTradeOutcome> {
  const brokerTradeId = trade.id;
  const link = () =>
    db
      .select({
        tradeStatus: brokerTrades.status,
        intentId: brokerTrades.intentId,
        intentStatus: tradeIntents.status,
      })
      .from(brokerTrades)
      .leftJoin(tradeIntents, eq(tradeIntents.id, brokerTrades.intentId))
      .where(
        and(
          eq(brokerTrades.brokerAccountId, brokerAccountId),
          eq(brokerTrades.brokerTradeId, brokerTradeId),
        ),
      );
  // an outcome, or the id of the accepted intent to settle
  const classify = (
    found: Awaited<ReturnType<typeof link>>[number] | undefined,
  ): ClosedTradeOutcome | string => {
    if (found === undefined || found.intentId === null || found.intentStatus === null) {
      return { brokerTradeId, result: 'not_ours' };
    }
    if (found.tradeStatus === BrokerTradeStatus.Closed) {
      return { brokerTradeId, result: 'already_settled', intentId: found.intentId };
    }
    if (found.intentStatus !== TradeIntentStatus.Accepted) {
      return {
        brokerTradeId,
        result: 'intent_not_accepted',
        intentId: found.intentId,
        status: found.intentStatus,
      };
    }
    return found.intentId;
  };

  const [found] = await link();
  const intentId = classify(found);
  if (typeof intentId !== 'string') return intentId;
  const settled = await db.transaction((tx) =>
    settleIntent(tx, { id: intentId, from: TradeIntentStatus.Accepted, trade }),
  );
  if (settled !== undefined) return { brokerTradeId, result: 'settled', intentId };
  // a concurrent writer won the CAS: report what it left
  const after = classify((await link())[0]);
  return typeof after === 'string'
    ? { brokerTradeId, result: 'intent_not_accepted', intentId, status: TradeIntentStatus.Accepted }
    : after;
}

// --- Reads --------------------------------------------------------------------------------------

// the one place the "stuck in submitting" predicate is spelled out; markIntentUnknown re-checks
// it inside its CAS with the same olderThanMs
export async function listStaleSubmittingIntents(
  exec: DbExecutor,
  { olderThanMs, limit }: { olderThanMs: number; limit: number },
): Promise<{ id: string }[]> {
  return exec
    .select({ id: tradeIntents.id })
    .from(tradeIntents)
    .where(
      and(
        eq(tradeIntents.status, TradeIntentStatus.Submitting),
        sql`${tradeIntents.submittedAt} < ${millisecondsAgo(olderThanMs)}`,
      ),
    )
    .orderBy(tradeIntents.submittedAt)
    .limit(limit);
}

export interface OverdueAcceptedIntent {
  id: string;
  brokerAccountId: string;
  brokerTradeId: string;
  mode: TradeMode;
}

// The one definition of "accepted past its expected close" (#17), for the REST catch-up of #90:
// the broker's open time plus the intent's duration plus graceMs, against the database clock.
// Ordered by that expected close, oldest first; graceMs and its chain belong to the polling loop.
export async function listOverdueAcceptedIntents(
  exec: DbExecutor,
  { graceMs, limit }: { graceMs: number; limit: number },
): Promise<OverdueAcceptedIntent[]> {
  const expectedCloseMs = sql`${brokerTrades.openTimestampMs} + ${tradeIntents.durationSec}::bigint * 1000`;
  return exec
    .select({
      id: tradeIntents.id,
      brokerAccountId: tradeIntents.brokerAccountId,
      brokerTradeId: brokerTrades.brokerTradeId,
      mode: tradeIntents.mode,
    })
    .from(tradeIntents)
    .innerJoin(brokerTrades, eq(brokerTrades.intentId, tradeIntents.id))
    .where(
      and(
        eq(tradeIntents.status, TradeIntentStatus.Accepted),
        eq(brokerTrades.status, BrokerTradeStatus.Open),
        sql`${expectedCloseMs} + ${graceMs}::bigint < (extract(epoch from now()) * 1000)`,
      ),
    )
    .orderBy(expectedCloseMs)
    .limit(limit);
}

export async function findTradeIntent(
  exec: DbExecutor,
  id: string,
): Promise<TradeIntentRow | undefined> {
  const [row] = await exec.select().from(tradeIntents).where(eq(tradeIntents.id, id));
  return row;
}

export async function getTradeIntentView(
  exec: DbExecutor,
  id: string,
): Promise<TradeIntentView | undefined> {
  const [row] = await exec
    .select({ intent: tradeIntents, telegramUserId: users.telegramUserId })
    .from(tradeIntents)
    .innerJoin(users, eq(users.id, tradeIntents.userId))
    .where(eq(tradeIntents.id, id));
  return row === undefined ? undefined : toTradeIntentView(row.intent, row.telegramUserId);
}

// explicit column mapping: the wire view never spreads a database row
export function toTradeIntentView(
  row: TradeIntentRow,
  telegramUserId: bigint | string,
): TradeIntentView {
  return {
    id: row.id,
    brokerAccountId: row.brokerAccountId,
    telegramUserId: String(telegramUserId),
    mode: row.mode,
    assetId: row.assetId,
    amount: row.amount,
    action: row.action,
    durationSec: row.durationSec,
    clientRequestId: row.clientRequestId,
    createdAt: row.createdAt.toISOString(),
    status: row.status,
    version: row.version,
    tokensReserved: row.tokensReserved.toString(),
    transport: row.transport ?? null,
    submittedAt: row.submittedAt === null ? null : row.submittedAt.toISOString(),
    lastError: row.lastError ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}
