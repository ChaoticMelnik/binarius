import { and, eq, inArray, notInArray, sql, type SQL } from 'drizzle-orm';
import {
  AccountHaltReason,
  BrokerAccountStatus,
  TokenLedgerKind,
  TradeIntentErrorCode,
  UserStatus,
  TradeIntentFailureReason,
  TradeIntentStatus,
  TradeMode,
  TradingSessionStatus,
  canTransition,
  checkDemoStake,
  isClosedTrade,
  normalizeDecimal,
  type BrokerTrade,
  type ClosedTrade,
  type CreateTradeIntentRequest,
  type DecimalString,
  type OpenTrade,
  type TradeIntentView,
  type TradeTransport,
} from '@binarius/shared';
import type { Db } from './client';
import { brokerAccounts } from './schema/broker-accounts';
import { brokerBalanceSnapshots } from './schema/broker-balance-snapshots';
import { BrokerTradeStatus, brokerTrades } from './schema/broker-trades';
import { OutboxTopic, outboxEvents } from './schema/outbox-events';
import { tokenLedger } from './schema/token-ledger';
import { sqlLiteralList } from './schema/columns';
import { TERMINAL_TRADE_INTENT_STATUSES, tradeIntents } from './schema/trade-intents';
import { tradingSessions } from './schema/trading-sessions';
import { users } from './schema/users';
import { isTradingOpen, readTradingSwitch, tradingOpenSql } from './trading-switch-ops';

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

// The session named by createSessionIntent is not an active session of this account and mode
// (stopped between the orchestrator's scan and the insert, or named with other terms; the
// session/account/mode FK would otherwise refuse the insert with a raw 23503). Not a TradeIntentErrorCode: the route never passes a
// session, so its callers never see it.
export class TradingSessionNotActiveError extends Error {
  constructor(readonly sessionId: string) {
    super('trading session is not active');
    this.name = 'TradingSessionNotActiveError';
  }
}

// the session an intent belongs to (trade_intents.trading_session_id); only the orchestrator
// passes one
export interface IntentSession {
  id: string;
}

export interface CreateTradeIntentOptions {
  // Only POST /trading/intents passes it (#297, stated): the demo stake's bounds against the
  // account's stored snapshot. The orchestrator's session intents rely on the sizer (Rule 23); a
  // future non-session creator of demo intents must pass it too.
  checkDemoStake?: true;
}

export interface CreateTradeIntentResult {
  intent: TradeIntentRow;
  created: boolean;
}

export async function createTradeIntent(
  db: Db,
  input: CreateTradeIntentRequest,
  session?: IntentSession,
  options?: CreateTradeIntentOptions,
): Promise<CreateTradeIntentResult> {
  try {
    return await db.transaction((tx) => createInTransaction(tx, input, session, options));
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

// Lock order is users → broker_accounts (the reserve UPDATE, then FOR NO KEY UPDATE) →
// trading_sessions (a session intent only); every other writer touching these tables must keep
// it. The session writers (trading-session-ops.ts) lock session rows and nothing after them.
async function createInTransaction(
  tx: Tx,
  input: CreateTradeIntentRequest,
  session: IntentSession | undefined,
  options: CreateTradeIntentOptions | undefined,
): Promise<CreateTradeIntentResult> {
  const tokens = TOKENS_PER_INTENT;
  const user = await findUser(tx, input.telegramUserId);
  if (user === undefined) throw new TradeIntentError(TradeIntentErrorCode.UserNotFound);

  // before any eligibility guard: a retry must find its intent even after the user was blocked
  // or the account revoked in the meantime
  const replay = await findReplay(tx, user.id, input);
  if (replay !== undefined) return replay;

  // after the replay, so a retry still finds an intent created while trading was open; before
  // the account and the reserve, so a refusal reads no account and touches no balance. Any mode:
  // one switch for demo and real (#144). A plain read: a kill-switch commit after it does not
  // stop this creation, and takeIntent's predicate refuses the intent instead (the window).
  if (!isTradingOpen(await readTradingSwitch(tx))) {
    throw new TradeIntentError(TradeIntentErrorCode.TradingPaused);
  }

  const brokerAccountId = await resolveAccount(tx, user.id, input.brokerAccountId);

  // after the replay, so a retry after a committed trade that spent the balance gets its intent
  // back; before the reserve, so a refusal writes nothing. A plain read with no row lock: the
  // snapshot's writers are not in the lock order (Rule 5), and a stored snapshot of any age serves
  // (#297)
  if (input.mode === TradeMode.Demo && options?.checkDemoStake === true) {
    const [snapshot] = await tx
      .select({
        minTradeAmount: brokerBalanceSnapshots.minTradeAmount,
        demoAvailable: brokerBalanceSnapshots.demoAvailable,
      })
      .from(brokerBalanceSnapshots)
      .where(eq(brokerBalanceSnapshots.brokerAccountId, brokerAccountId));
    if (snapshot === undefined) throw new TradeIntentError(TradeIntentErrorCode.BalanceUnavailable);
    const refusal = checkDemoStake(input.amount, snapshot);
    if (refusal !== null) throw new TradeIntentError(refusal);
  }

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

  // a session stopped after the orchestrator's scan gets no intent; the lock holds a concurrent
  // stop until this transaction commits
  if (session !== undefined) {
    const active = await tx
      .select({ id: tradingSessions.id })
      .from(tradingSessions)
      .where(
        and(
          eq(tradingSessions.id, session.id),
          eq(tradingSessions.brokerAccountId, brokerAccountId),
          eq(tradingSessions.mode, input.mode),
          eq(tradingSessions.status, TradingSessionStatus.Active),
        ),
      )
      .for('no key update');
    if (active.length === 0) throw new TradingSessionNotActiveError(session.id);
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
      tradingSessionId: session?.id ?? null,
      status: TradeIntentStatus.Planned,
      tokensReserved: tokens,
    })
    .returning();
  if (planned === undefined) throw new Error('trade_intents insert returned no row');

  // The pause after two losses (#379) compares the next signal with the action traded last. It is
  // written with the intent row, on the session row this transaction already holds, so an ending
  // lost after the INSERT (the attempt's deadline, a restart) cannot lose it.
  if (session !== undefined) {
    await tx
      .update(tradingSessions)
      .set({ lastSignalAction: input.action, updatedAt: sql`now()` })
      .where(
        and(
          eq(tradingSessions.id, session.id),
          eq(tradingSessions.status, TradingSessionStatus.Active),
        ),
      );
  }

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

export type TradingAccountRefusal =
  | typeof TradeIntentErrorCode.BrokerAccountNotFound
  | typeof TradeIntentErrorCode.AccountNotConfirmed
  | typeof TradeIntentErrorCode.AmbiguousBrokerAccount;

export type TradingAccountResolution =
  { ok: true; brokerAccountId: string } | { ok: false; code: TradingAccountRefusal };

// The account a trade or a session runs on: the named one if it is the user's, else the user's
// only active account. Its status beyond that is the caller's check.
export async function resolveTradingAccount(
  exec: DbExecutor,
  userId: string,
  brokerAccountId: string | undefined,
): Promise<TradingAccountResolution> {
  if (brokerAccountId !== undefined) {
    const [account] = await exec
      .select({ id: brokerAccounts.id })
      .from(brokerAccounts)
      .where(and(eq(brokerAccounts.id, brokerAccountId), eq(brokerAccounts.userId, userId)));
    if (account === undefined)
      return { ok: false, code: TradeIntentErrorCode.BrokerAccountNotFound };
    return { ok: true, brokerAccountId: account.id };
  }
  const accounts = await exec
    .select({ id: brokerAccounts.id, status: brokerAccounts.status })
    .from(brokerAccounts)
    .where(eq(brokerAccounts.userId, userId));
  const [only, ...more] = accounts.filter((a) => a.status === BrokerAccountStatus.Active);
  if (only === undefined) {
    // "no account" and "an account nobody confirmed yet" need different answers: the second one
    // tells the user to finish the login they already started
    return {
      ok: false,
      code: accounts.some((a) => a.status === BrokerAccountStatus.Pending)
        ? TradeIntentErrorCode.AccountNotConfirmed
        : TradeIntentErrorCode.BrokerAccountNotFound,
    };
  }
  if (more.length > 0) return { ok: false, code: TradeIntentErrorCode.AmbiguousBrokerAccount };
  return { ok: true, brokerAccountId: only.id };
}

async function resolveAccount(
  exec: DbExecutor,
  userId: string,
  brokerAccountId: string | undefined,
): Promise<string> {
  const resolved = await resolveTradingAccount(exec, userId, brokerAccountId);
  if (!resolved.ok) throw new TradeIntentError(resolved.code);
  return resolved.brokerAccountId;
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
export const millisecondsFromNow = (ms: number): SQL =>
  sql`now() + (${ms}::int * interval '1 millisecond')`;

export interface TakeIntentOptions {
  id: string;
  expectedVersion: number;
  maxAgeMs: number;
}

// queued → submitting, refused for an intent older than maxAgeMs (database clock) and while the
// global trading switch is closed (#144): the fence sits before submitting, so a paused intent
// is rejected plainly and never becomes unknown (Rule 15)
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
    where: and(sql`${tradeIntents.createdAt} >= ${millisecondsAgo(maxAgeMs)}`, tradingOpenSql),
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

export interface RejectPausedOptions {
  id: string;
  expectedVersion: number;
}

// After takeIntent refused an unexpired intent. No switch predicate on purpose: a switch reopened
// between the refused take and this statement would otherwise leave the intent queued with its
// job already consumed, holding the account's live-intent slot with nothing to move it. The
// version CAS keeps it safe: at this version the take refused for the switch alone.
export function rejectPausedIntent(
  tx: Tx,
  { id, expectedVersion }: RejectPausedOptions,
): Promise<TradeIntentRow | undefined> {
  return rejectIntent(tx, {
    id,
    from: TradeIntentStatus.Queued,
    expectedVersion,
    reason: TradeIntentFailureReason.TradingPaused,
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

// submitting → unknown plus the reconciliation outbox row (the trading-reconciliation job
// consumes it, #89); idempotent on the (topic, intent_id) unique key
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
// users → broker_accounts → trading_sessions → trade_intents, with broker_trades as its tail).
// Settlement does not lock broker_accounts. The reconciliation writer (concludeReconciled, #89) keeps the order; its
// account halt (haltAccountForManualReview, #90) takes broker_accounts before the intent and never
// touches users.

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
  // submitting for the executor's answer; reconciling for concludeReconciled (#89)
  from?: typeof TradeIntentStatus.Submitting | typeof TradeIntentStatus.Reconciling;
  // null only from reconciliation of an intent whose transport was never recorded: it learns the
  // trade, not how the order travelled
  transport: TradeTransport | null;
  // the broker's trade as received, never a locally built one; closed only from reconciliation,
  // which then settles it in the same transaction
  trade: BrokerTrade;
}

// accepted only together with the broker's trade (closed only from concludeReconciled, which
// settles it next): the trade is checked against the intent (mode, asset, action and amount
// never change after creation, so an unlocked read is enough), then the CAS, then the open
// broker_trades row is written. A four-field mismatch throws before
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
    potentialProfit: isClosedTrade(trade) ? null : trade.potentialProfit,
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

// --- Reconciliation (#89) --------------------------------------------------------------------
// unknown → reconciling by the trading-reconciliation job; the worker's pass then claims each
// reconciling intent (the lease below), asks the IntentReconciler and writes one outcome CAS
// with the version the claim returned.

export interface StartReconcilingOptions {
  id: string;
  expectedVersion: number;
}

// reconcile_claimed_at stays NULL, which puts a fresh intent first in the pass's order
export function startReconciling(
  exec: DbExecutor,
  { id, expectedVersion }: StartReconcilingOptions,
): Promise<TradeIntentRow | undefined> {
  return transitionIntent(exec, {
    id,
    from: TradeIntentStatus.Unknown,
    to: TradeIntentStatus.Reconciling,
    expectedVersion,
  });
}

// the one spelling of the lease: never claimed, or claimed longer than retryMs ago (database
// clock). A claim in the future is simply fresh.
const reconcileLeaseExpired = (retryMs: number): SQL =>
  sql`(${tradeIntents.reconcileClaimedAt} is null or ${tradeIntents.reconcileClaimedAt} < ${millisecondsAgo(retryMs)})`;

export async function listReconcilingCandidates(
  exec: DbExecutor,
  { retryMs, limit }: { retryMs: number; limit: number },
): Promise<{ id: string }[]> {
  return exec
    .select({ id: tradeIntents.id })
    .from(tradeIntents)
    .where(
      and(eq(tradeIntents.status, TradeIntentStatus.Reconciling), reconcileLeaseExpired(retryMs)),
    )
    .orderBy(sql`${tradeIntents.reconcileClaimedAt} asc nulls first`, tradeIntents.createdAt)
    .limit(limit);
}

// The one UPDATE of trade_intents that is not a transition: no status in its SET list (the
// transition guard does not fire), but version + 1, so an older attempt whose lease lapsed and
// was re-claimed can no longer write its outcome. Autocommit, before the broker is asked: the
// lease outlives the transaction because the broker call is outside it.
export async function claimReconciling(
  exec: DbExecutor,
  { id, retryMs }: { id: string; retryMs: number },
): Promise<TradeIntentRow | undefined> {
  const [row] = await exec
    .update(tradeIntents)
    .set({ reconcileClaimedAt: sql`now()`, version: sql`${tradeIntents.version} + 1` })
    .where(
      and(
        eq(tradeIntents.id, id),
        eq(tradeIntents.status, TradeIntentStatus.Reconciling),
        reconcileLeaseExpired(retryMs),
      ),
    )
    .returning();
  return row;
}

export interface ConcludeReconciledOptions {
  id: string;
  expectedVersion: number;
  // the broker's own record that the reconciler found, open or closed
  trade: BrokerTrade;
}

// reconciling → accepted with the broker's trade, and → settled in the same transaction when
// that trade is already closed. The user row is locked before the intent: settleIntent locks it,
// and a creation for the same user holds it while its INSERT waits on this intent's
// active-account index entry (rejectIntent's deadlock). A mismatch throws
// TradeIntentMismatchError and the caller's transaction rolls back.
export async function concludeReconciled(
  tx: Tx,
  { id, expectedVersion, trade }: ConcludeReconciledOptions,
): Promise<TradeIntentRow | undefined> {
  await lockIntentUser(tx, id);
  const [current] = await tx
    .select({ transport: tradeIntents.transport })
    .from(tradeIntents)
    .where(eq(tradeIntents.id, id));
  if (current === undefined) return undefined;
  const accepted = await markIntentAccepted(tx, {
    id,
    expectedVersion,
    from: TradeIntentStatus.Reconciling,
    transport: current.transport,
    trade,
  });
  if (accepted === undefined || !isClosedTrade(trade)) return accepted;
  const settled = await settleIntent(tx, {
    id,
    expectedVersion: accepted.version,
    from: TradeIntentStatus.Accepted,
    trade,
  });
  if (settled === undefined) throw new Error('accepted intent vanished inside its own tx');
  return settled;
}

export interface MarkManualReviewOptions {
  id: string;
  expectedVersion: number;
  reason: TradeIntentFailureReason;
}

// reconciling → manual_review; the reserve is kept and the account stays blocked by the
// active-intent index. The reconciliation pass goes through haltAccountForManualReview, which also
// halts the account.
export function markIntentManualReview(
  exec: DbExecutor,
  { id, expectedVersion, reason }: MarkManualReviewOptions,
): Promise<TradeIntentRow | undefined> {
  return transitionIntent(exec, {
    id,
    from: TradeIntentStatus.Reconciling,
    to: TradeIntentStatus.ManualReview,
    expectedVersion,
    patch: { lastError: reason },
  });
}

export type ManualReviewReason =
  | typeof TradeIntentFailureReason.ReconciliationAmbiguous
  | typeof TradeIntentFailureReason.ReconciliationNotFound
  | typeof TradeIntentFailureReason.TradeMismatch;

const HALT_REASON_FOR = {
  [TradeIntentFailureReason.ReconciliationAmbiguous]: AccountHaltReason.ReconciliationAmbiguous,
  [TradeIntentFailureReason.ReconciliationNotFound]: AccountHaltReason.ReconciliationNotFound,
  [TradeIntentFailureReason.TradeMismatch]: AccountHaltReason.TradeMismatch,
} as const satisfies Record<ManualReviewReason, AccountHaltReason>;

export interface HaltForManualReviewOptions {
  id: string;
  expectedVersion: number;
  reason: ManualReviewReason;
}

// reconciling → manual_review and the account's halt in the caller's transaction (#90). The
// account row is locked first, FOR NO KEY UPDATE like a creator's: a creator holds users and then
// waits here, and since the intent is touched only after this lock its INSERT never waits on our
// uncommitted tuple. users is not locked. A lost CAS writes nothing and returns undefined; a halt
// on an already halted account overwrites the reason.
export async function haltAccountForManualReview(
  tx: Tx,
  { id, expectedVersion, reason }: HaltForManualReviewOptions,
): Promise<TradeIntentRow | undefined> {
  const [account] = await tx
    .select({ id: brokerAccounts.id })
    .from(brokerAccounts)
    .where(
      eq(
        brokerAccounts.id,
        sql`(select ${tradeIntents.brokerAccountId} from ${tradeIntents} where ${tradeIntents.id} = ${id})`,
      ),
    )
    .for('no key update');
  if (account === undefined) return undefined;
  const row = await markIntentManualReview(tx, { id, expectedVersion, reason });
  if (row === undefined) return undefined;
  await tx
    .update(brokerAccounts)
    .set({ tradingHalted: true, haltedReason: HALT_REASON_FOR[reason] })
    .where(eq(brokerAccounts.id, account.id));
  return row;
}

// --- Reads --------------------------------------------------------------------------------------

// Which of these broker trade ids already back an intent of the account: the reconciler drops
// them before counting candidates, so an earlier trade with the same keys is not a second match.
export async function listLinkedBrokerTradeIds(
  exec: DbExecutor,
  {
    brokerAccountId,
    brokerTradeIds,
  }: { brokerAccountId: string; brokerTradeIds: readonly string[] },
): Promise<Set<string>> {
  if (brokerTradeIds.length === 0) return new Set();
  const rows = await exec
    .select({ brokerTradeId: brokerTrades.brokerTradeId })
    .from(brokerTrades)
    .where(
      and(
        eq(brokerTrades.brokerAccountId, brokerAccountId),
        inArray(brokerTrades.brokerTradeId, [...brokerTradeIds]),
        sql`${brokerTrades.intentId} is not null`,
      ),
    );
  return new Set(rows.map((row) => row.brokerTradeId));
}

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

// the broker's open time plus the intent's duration, Unix ms; over broker_trades joined to its intent
const expectedCloseMs = sql`${brokerTrades.openTimestampMs} + ${tradeIntents.durationSec}::bigint * 1000`;

// The one definition of "accepted past its expected close" (#17), for the REST catch-up of #90:
// the broker's open time plus the intent's duration plus graceMs, against the database clock.
// Ordered by that expected close, oldest first; graceMs and its chain belong to the polling loop.
// `exclude` names accounts the caller is holding back, so the head of the queue cannot starve
// the rest.
export async function listOverdueAcceptedIntents(
  exec: DbExecutor,
  { graceMs, limit, exclude = [] }: { graceMs: number; limit: number; exclude?: readonly string[] },
): Promise<OverdueAcceptedIntent[]> {
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
        exclude.length === 0 ? undefined : notInArray(tradeIntents.brokerAccountId, [...exclude]),
      ),
    )
    .orderBy(expectedCloseMs)
    .limit(limit);
}

export interface HeldExposure {
  mode: TradeMode;
  // our open broker_trades of the account in this mode, sorted
  openTradeIds: string[];
  // trade_intents of the account in this mode created after `intentsSince` (default: within
  // RECENT_INTENTS_WINDOW_MS of this read): bounded by the window, not by the account's history.
  // A second read passes the first read's bound, so its window contains the first's and an intent
  // created between them always changes the count, even one whose creating transaction began
  // before the first read
  recentIntentCount: number;
  // a non-terminal intent of this mode that is not `accepted` with an open linked trade
  unresolvedIntent: boolean;
  // an open linked trade at or past its expected close, by the database clock
  settlementPending: boolean;
  // held > the sum of the open amounts, compared as numeric; null when no held was passed
  heldExceedsOpen: boolean | null;
  // the database clock at the read, the same in every row
  readAt: Date;
}

// far longer than one balance check (BALANCE_CHECK_TIMEOUT_MS, 20 s)
export const RECENT_INTENTS_WINDOW_MS = 10 * 60_000;

// Our side of the broker balance check (#92): per mode, what we hold open at the broker and what
// could make a compare with the broker's `held` meaningless. One statement, no locks; the money
// comparison stays in SQL numeric (Rule 2). `held` must already have passed the snapshot's domain
// check, so the cast cannot fail.
export async function readHeldExposure(
  exec: DbExecutor,
  {
    brokerAccountId,
    held = {},
    intentsSince,
  }: {
    brokerAccountId: string;
    held?: Partial<Record<TradeMode, DecimalString>>;
    intentsSince?: Date;
  },
): Promise<HeldExposure[]> {
  const openOfMode = sql`${brokerTrades.brokerAccountId} = ${brokerAccountId}
    and ${brokerTrades.mode} = m.mode
    and ${brokerTrades.status} = ${BrokerTradeStatus.Open}`;
  const intentsOfMode = sql`${tradeIntents.brokerAccountId} = ${brokerAccountId}
    and ${tradeIntents.mode} = m.mode`;
  const { rows } = await exec.execute<{
    mode: TradeMode;
    open_trade_ids: string[];
    recent_intent_count: number;
    unresolved_intent: boolean;
    settlement_pending: boolean;
    held_exceeds_open: boolean | null;
    read_at: Date | string;
  }>(sql`
    select m.mode, now() as read_at,
      coalesce(
        (select array_agg(${brokerTrades.brokerTradeId} order by ${brokerTrades.brokerTradeId})
           from ${brokerTrades} where ${openOfMode}),
        '{}'
      ) as open_trade_ids,
      (select count(*)::int from ${tradeIntents}
        where ${intentsOfMode}
          and ${tradeIntents.createdAt} > ${intentsSince ?? millisecondsAgo(RECENT_INTENTS_WINDOW_MS)}
      ) as recent_intent_count,
      exists (
        select 1 from ${tradeIntents}
         where ${intentsOfMode}
           and ${tradeIntents.status} not in (${sqlLiteralList(TERMINAL_TRADE_INTENT_STATUSES)})
           and not (
             ${tradeIntents.status} = ${TradeIntentStatus.Accepted}
             and exists (
               select 1 from ${brokerTrades}
                where ${brokerTrades.intentId} = ${tradeIntents.id}
                  and ${brokerTrades.status} = ${BrokerTradeStatus.Open}
             )
           )
      ) as unresolved_intent,
      exists (
        select 1 from ${brokerTrades}
          join ${tradeIntents} on ${tradeIntents.id} = ${brokerTrades.intentId}
         where ${openOfMode}
           and ${expectedCloseMs} <= (extract(epoch from now()) * 1000)
      ) as settlement_pending,
      (case m.mode
         when ${TradeMode.Demo} then ${held.demo ?? null}::numeric
         when ${TradeMode.Real} then ${held.real ?? null}::numeric
       end)
        > coalesce((select sum(${brokerTrades.amount}) from ${brokerTrades} where ${openOfMode}), 0)
        as held_exceeds_open
    from unnest(array[${sqlLiteralList(Object.values(TradeMode))}]::text[]) as m(mode)
    order by m.mode
  `);
  return rows.map((row) => ({
    mode: row.mode,
    openTradeIds: row.open_trade_ids,
    recentIntentCount: row.recent_intent_count,
    unresolvedIntent: row.unresolved_intent,
    settlementPending: row.settlement_pending,
    heldExceedsOpen: row.held_exceeds_open,
    readAt: new Date(row.read_at),
  }));
}

export async function findTradeIntent(
  exec: DbExecutor,
  id: string,
): Promise<TradeIntentRow | undefined> {
  const [row] = await exec.select().from(tradeIntents).where(eq(tradeIntents.id, id));
  return row;
}

// Scoped by the owner: the id reaches the bot in a button's callback data, so a forwarded message
// must not read another user's intent. Another user's id and a missing one are both undefined.
export async function getTradeIntentView(
  exec: DbExecutor,
  id: string,
  telegramUserId: bigint,
): Promise<TradeIntentView | undefined> {
  const [row] = await exec
    .select({ intent: tradeIntents, telegramUserId: users.telegramUserId })
    .from(tradeIntents)
    .innerJoin(users, eq(users.id, tradeIntents.userId))
    .where(and(eq(tradeIntents.id, id), eq(users.telegramUserId, telegramUserId)));
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
