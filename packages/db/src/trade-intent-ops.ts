import { and, eq, sql, type SQL } from 'drizzle-orm';
import {
  TradeIntentErrorCode,
  TradeIntentFailureReason,
  TradeIntentStatus,
  canTransition,
  type CreateTradeIntentRequest,
  type TradeIntentView,
  type TradeTransport,
} from '@binarius/shared';
import type { Db } from './client';
import { BrokerAccountStatus, brokerAccounts } from './schema/broker-accounts';
import { OutboxTopic, outboxEvents } from './schema/outbox-events';
import { TokenLedgerKind, tokenLedger } from './schema/token-ledger';
import { tradeIntents } from './schema/trade-intents';
import { UserStatus, users } from './schema/users';

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbExecutor = Db | Tx;
export type TradeIntentRow = typeof tradeIntents.$inferSelect;

// one token per accepted trade in both modes (product plan, owner decision 2026-09-23)
export const TOKENS_PER_INTENT = 1n;

// Only these two mean "someone else won the race for this account"; a violation of any other
// unique constraint is a bug and must surface as an error, not as a 409.
const REPLAY_CONSTRAINTS: ReadonlySet<string> = new Set([
  'trade_intents_account_request_idx',
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

export async function createTradeIntent(
  db: Db,
  input: CreateTradeIntentRequest,
): Promise<CreateTradeIntentResult> {
  try {
    return await db.transaction((tx) => createInTransaction(tx, input));
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
): Promise<CreateTradeIntentResult> {
  const tokens = TOKENS_PER_INTENT;
  const user = await findUser(tx, input.telegramUserId);
  if (user === undefined) throw new TradeIntentError(TradeIntentErrorCode.UserNotFound);

  // before any eligibility guard: a retry must find its intent even after the user was blocked
  // or the account revoked in the meantime
  const replay = await findReplay(tx, user.id, input);
  if (replay !== undefined) return replay;

  const accountId = await resolveAccount(tx, user.id, input.brokerAccountId);

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
        eq(brokerAccounts.id, accountId),
        eq(brokerAccounts.status, BrokerAccountStatus.Active),
        eq(brokerAccounts.tradingHalted, false),
      ),
    )
    .for('no key update');
  if (locked.length === 0) {
    const [fresh] = await tx
      .select({ status: brokerAccounts.status })
      .from(brokerAccounts)
      .where(eq(brokerAccounts.id, accountId));
    throw new TradeIntentError(
      fresh?.status === BrokerAccountStatus.Revoked
        ? TradeIntentErrorCode.AccountRevoked
        : TradeIntentErrorCode.AccountHalted,
    );
  }

  const [planned] = await tx
    .insert(tradeIntents)
    .values({
      brokerAccountId: accountId,
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

async function findReplay(
  exec: DbExecutor,
  userId: string,
  input: CreateTradeIntentRequest,
): Promise<CreateTradeIntentResult | undefined> {
  const rows = await exec
    .select()
    .from(tradeIntents)
    .where(
      and(
        eq(tradeIntents.userId, userId),
        eq(tradeIntents.clientRequestId, input.clientRequestId),
        input.brokerAccountId === undefined
          ? undefined
          : eq(tradeIntents.brokerAccountId, input.brokerAccountId),
      ),
    );
  if (rows.length === 0) return undefined;
  // the contract makes clientRequestId unique per user; two rows means the caller reused it
  // across accounts and we cannot tell which one it is replaying
  if (rows.length > 1) throw new TradeIntentError(TradeIntentErrorCode.AmbiguousBrokerAccount);
  const [row] = rows;
  if (row === undefined) return undefined;
  const same =
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
  const [only, ...more] = await exec
    .select({ id: brokerAccounts.id })
    .from(brokerAccounts)
    .where(
      and(eq(brokerAccounts.userId, userId), eq(brokerAccounts.status, BrokerAccountStatus.Active)),
    );
  if (only === undefined) throw new TradeIntentError(TradeIntentErrorCode.BrokerAccountNotFound);
  if (more.length > 0) throw new TradeIntentError(TradeIntentErrorCode.AmbiguousBrokerAccount);
  return only.id;
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

const millisecondsAgo = (ms: number): SQL => sql`now() - (${ms}::int * interval '1 millisecond')`;

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
export async function rejectIntent(
  tx: Tx,
  { id, from, expectedVersion, reason, where }: RejectIntentOptions,
): Promise<TradeIntentRow | undefined> {
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

export interface MarkAcceptedOptions {
  id: string;
  expectedVersion: number;
  transport?: TradeTransport;
}

export function markIntentAccepted(
  exec: DbExecutor,
  { id, expectedVersion, transport }: MarkAcceptedOptions,
): Promise<TradeIntentRow | undefined> {
  return transitionIntent(exec, {
    id,
    from: TradeIntentStatus.Submitting,
    to: TradeIntentStatus.Accepted,
    expectedVersion,
    patch: { transport: transport ?? null },
  });
}

// --- Reads --------------------------------------------------------------------------------------

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
