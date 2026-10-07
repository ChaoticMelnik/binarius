import { and, eq, notInArray, sql, type SQL } from 'drizzle-orm';
import {
  BrokerAccountStatus,
  TradeMode,
  UserStatus,
  isBalanceFresh,
  type BrokerBalance,
  type BrokerBalanceView,
  type BrokerUser,
} from '@binarius/shared';
import type { Db } from './client';
import { MONEY_INTEGER_DIGITS, MONEY_SCALE, sqlLiteralList } from './schema/columns';
import { brokerAccounts } from './schema/broker-accounts';
import {
  BalanceRefreshError,
  LEVEL_CODE_MAX_LENGTH,
  LEVEL_RANK_INTEGER_DIGITS,
  LEVEL_RANK_SCALE,
  brokerBalanceSnapshots,
} from './schema/broker-balance-snapshots';
import { TERMINAL_TRADE_INTENT_STATUSES, tradeIntents } from './schema/trade-intents';
import { users } from './schema/users';
import { millisecondsAgo } from './trade-intent-ops';

// The only writers of broker_balance_snapshots (#235, part 1 of #137).
//
// Every operation takes Db, not a transaction, and is one autocommit statement: the snapshot row
// is never locked while users, broker_accounts or trade_intents are (lock order users →
// broker_accounts → trade_intents is unaffected). Times are the database clock at the statement.
//
// The writers. The REST refresh (#137) and the socket's user.data (the worker's session manager,
// #101) both write the full snapshot through upsertBalanceSnapshot; user.data passes both modes
// in `eventAt`. A user.<mode>.update_balance event goes through applyBalanceEvent: only that
// mode's three amounts and <mode>_event_at on an existing row, nothing inserted (it carries
// neither the other mode nor min_trade_amount); the session's user.data, the first event of every
// connection, writes the row it needs. The session manager writes a socket event only after the
// connection's user.data carried the account's broker_user_id (docs/broker-session.md).

export type BalanceSnapshotWrite = { written: true } | { written: false; field: string };

const MONEY_SHAPE = new RegExp(`^\\d{1,${MONEY_INTEGER_DIGITS}}(\\.\\d{1,${MONEY_SCALE}})?$`);
const LEVEL_RANK_SHAPE = new RegExp(
  `^\\d{1,${LEVEL_RANK_INTEGER_DIGITS}}(\\.\\d{1,${LEVEL_RANK_SCALE}})?$`,
);
// level_code is text without a CHECK; this is its only bound. With the u flag the count is in
// code points, and \p{Cc} covers NUL (which text refuses outright), line breaks, tab and DEL.
const LEVEL_CODE_SHAPE = new RegExp(`^[^\\p{Cc}]{1,${LEVEL_CODE_MAX_LENGTH}}$`, 'u');

// The wire schemas accept a sign and any number of digits, because broker_trades shares them and
// signs a profit. The columns here would round extra fraction digits silently, fail on extra
// integer digits and refuse a sign, so a value outside them is refused before the statement and
// named by its path. The rank is checked by its decimal form: a range check on the number lets
// 9999.99995 round up to an overflow and 1e-7 round down to 0.
function amountsOutOfDomain(amounts: readonly [string, string][]): string | undefined {
  for (const [field, value] of amounts) {
    if (!MONEY_SHAPE.test(value)) return field;
  }
  return undefined;
}

export function balanceSnapshotOutOfDomain(user: BrokerUser): string | undefined {
  const amount = amountsOutOfDomain([
    ['real.available', user.real.available],
    ['real.held', user.real.held],
    ['real.total', user.real.total],
    ['demo.available', user.demo.available],
    ['demo.held', user.demo.held],
    ['demo.total', user.demo.total],
    ['minTradeAmount', user.minTradeAmount],
  ]);
  if (amount !== undefined) return amount;
  if (!LEVEL_RANK_SHAPE.test(String(user.level.rank))) return 'level.rank';
  if (!LEVEL_CODE_SHAPE.test(user.level.code)) return 'level.code';
  return undefined;
}

export interface UpsertBalanceSnapshotInput {
  brokerAccountId: string;
  user: BrokerUser;
  // the bot asked for this account: last_requested_at moves to now(), otherwise it is kept
  requested: boolean;
  // the modes whose *_event_at moves to now() (the socket's user.data); the REST refresh passes none
  eventAt?: readonly TradeMode[];
}

export async function upsertBalanceSnapshot(
  db: Db,
  { brokerAccountId, user, requested, eventAt = [] }: UpsertBalanceSnapshotInput,
): Promise<BalanceSnapshotWrite> {
  const field = balanceSnapshotOutOfDomain(user);
  if (field !== undefined) return { written: false, field };

  const t = brokerBalanceSnapshots;
  const now = sql`now()`;
  const realEvent = eventAt.includes(TradeMode.Real);
  const demoEvent = eventAt.includes(TradeMode.Demo);
  await db
    .insert(t)
    .values({
      brokerAccountId,
      realAvailable: user.real.available,
      realHeld: user.real.held,
      realTotal: user.real.total,
      demoAvailable: user.demo.available,
      demoHeld: user.demo.held,
      demoTotal: user.demo.total,
      minTradeAmount: user.minTradeAmount,
      levelCode: user.level.code,
      levelRank: user.level.rank,
      restObservedAt: now,
      realEventAt: realEvent ? now : null,
      demoEventAt: demoEvent ? now : null,
      lastRequestedAt: requested ? now : null,
    })
    .onConflictDoUpdate({
      target: t.brokerAccountId,
      set: {
        realAvailable: sql`excluded.real_available`,
        realHeld: sql`excluded.real_held`,
        realTotal: sql`excluded.real_total`,
        demoAvailable: sql`excluded.demo_available`,
        demoHeld: sql`excluded.demo_held`,
        demoTotal: sql`excluded.demo_total`,
        minTradeAmount: sql`excluded.min_trade_amount`,
        levelCode: sql`excluded.level_code`,
        levelRank: sql`excluded.level_rank`,
        restObservedAt: now,
        ...(realEvent ? { realEventAt: now } : {}),
        ...(demoEvent ? { demoEventAt: now } : {}),
        ...(requested ? { lastRequestedAt: now } : {}),
        lastRefreshError: null,
        lastRefreshFailedAt: null,
        updatedAt: now,
      },
    });
  return { written: true };
}

export type BalanceEventWrite =
  | { written: true }
  | { written: false; reason: 'out_of_domain'; field: string }
  | { written: false; reason: 'no_snapshot' };

export interface ApplyBalanceEventInput {
  brokerAccountId: string;
  mode: TradeMode;
  balance: BrokerBalance;
}

// user.<mode>.update_balance: the mode's three amounts and its event time on the existing row.
// The REST columns (rest_observed_at, the refresh error), the other mode, min_trade_amount, the
// level and last_requested_at describe other sources and stay.
export async function applyBalanceEvent(
  db: Db,
  { brokerAccountId, mode, balance }: ApplyBalanceEventInput,
): Promise<BalanceEventWrite> {
  const field = amountsOutOfDomain([
    ['available', balance.available],
    ['held', balance.held],
    ['total', balance.total],
  ]);
  if (field !== undefined) return { written: false, reason: 'out_of_domain', field };

  const t = brokerBalanceSnapshots;
  const now = sql`now()`;
  const set =
    mode === TradeMode.Real
      ? {
          realAvailable: balance.available,
          realHeld: balance.held,
          realTotal: balance.total,
          realEventAt: now,
        }
      : {
          demoAvailable: balance.available,
          demoHeld: balance.held,
          demoTotal: balance.total,
          demoEventAt: now,
        };
  const rows = await db
    .update(t)
    .set({ ...set, updatedAt: now })
    .where(eq(t.brokerAccountId, brokerAccountId))
    .returning({ id: t.brokerAccountId });
  return rows.length === 0 ? { written: false, reason: 'no_snapshot' } : { written: true };
}

// false when the account has no snapshot yet: a failure alone does not create one
export async function recordBalanceRefreshFailure(
  db: Db,
  brokerAccountId: string,
  error: BalanceRefreshError,
): Promise<boolean> {
  const rows = await db
    .update(brokerBalanceSnapshots)
    .set({ lastRefreshError: error, lastRefreshFailedAt: sql`now()`, updatedAt: sql`now()` })
    .where(eq(brokerBalanceSnapshots.brokerAccountId, brokerAccountId))
    .returning({ id: brokerBalanceSnapshots.brokerAccountId });
  return rows.length > 0;
}

// false when the account has no snapshot yet; the refresh that follows sets it on insert
export async function touchBalanceRequested(db: Db, brokerAccountId: string): Promise<boolean> {
  const rows = await db
    .update(brokerBalanceSnapshots)
    .set({ lastRequestedAt: sql`now()`, updatedAt: sql`now()` })
    .where(eq(brokerBalanceSnapshots.brokerAccountId, brokerAccountId))
    .returning({ id: brokerBalanceSnapshots.brokerAccountId });
  return rows.length > 0;
}

// Whole seconds since a timestamp by the database clock; a future timestamp (clock step) is 0.
const ageSecOf = (at: SQL) => sql`greatest(0, floor(extract(epoch from now() - ${at})))::int`;
// NULL stays NULL: greatest(0, NULL) would be 0, a missing time read as a fresh one
const nullableAgeSec = (at: SQL): SQL<number | null> =>
  sql<number | null>`case when ${at} is null then null else ${ageSecOf(at)} end`;

// greatest() skips NULLs, so this is NULL only while neither mode has seen an event
const newestEventAt = sql`greatest(${brokerBalanceSnapshots.realEventAt}, ${brokerBalanceSnapshots.demoEventAt})`;

export interface BalanceSnapshotRead {
  real: BrokerUser['real'];
  demo: BrokerUser['demo'];
  minTradeAmount: BrokerUser['minTradeAmount'];
  level: BrokerUser['level'];
  restSnapshotAgeSec: number;
  // NULL until a socket writer (#99/#101) has recorded an event for either mode
  balanceEventAgeSec: number | null;
  lastRefreshError: BalanceRefreshError | null;
}

export async function readBalanceSnapshot(
  db: Db,
  brokerAccountId: string,
): Promise<BalanceSnapshotRead | undefined> {
  const t = brokerBalanceSnapshots;
  const [row] = await db
    .select({
      realAvailable: t.realAvailable,
      realHeld: t.realHeld,
      realTotal: t.realTotal,
      demoAvailable: t.demoAvailable,
      demoHeld: t.demoHeld,
      demoTotal: t.demoTotal,
      minTradeAmount: t.minTradeAmount,
      levelCode: t.levelCode,
      levelRank: t.levelRank,
      restSnapshotAgeSec: sql<number>`${ageSecOf(sql`${t.restObservedAt}`)}`,
      balanceEventAgeSec: nullableAgeSec(newestEventAt),
      lastRefreshError: t.lastRefreshError,
    })
    .from(t)
    .where(eq(t.brokerAccountId, brokerAccountId));
  if (row === undefined) return undefined;
  return {
    real: { available: row.realAvailable, held: row.realHeld, total: row.realTotal },
    demo: { available: row.demoAvailable, held: row.demoHeld, total: row.demoTotal },
    minTradeAmount: row.minTradeAmount,
    level: { code: row.levelCode, rank: row.levelRank },
    restSnapshotAgeSec: row.restSnapshotAgeSec,
    balanceEventAgeSec: row.balanceEventAgeSec,
    lastRefreshError: row.lastRefreshError,
  };
}

// The wire view: keys built one by one, so nothing the row carries (lastRefreshError, the
// account id) reaches the bot by accident.
export function toBrokerBalanceView(read: BalanceSnapshotRead): BrokerBalanceView {
  return {
    real: { available: read.real.available, held: read.real.held, total: read.real.total },
    demo: { available: read.demo.available, held: read.demo.held, total: read.demo.total },
    minTradeAmount: read.minTradeAmount,
    level: { code: read.level.code, rank: read.level.rank },
    restSnapshotAgeSec: read.restSnapshotAgeSec,
    balanceEventAgeSec: read.balanceEventAgeSec,
    fresh: isBalanceFresh(read.restSnapshotAgeSec, read.balanceEventAgeSec),
  };
}

// "An account in work": an active account of an active user with a non-terminal intent, or one
// the bot asked about within the window. The intent predicate is trade_intents_active_account_idx's
// own, so the EXISTS can use that index.
const inWork = (watchWindowMs: number): SQL => sql`(
  exists (
    select 1 from ${tradeIntents}
     where ${tradeIntents.brokerAccountId} = ${brokerAccounts.id}
       and ${tradeIntents.status} not in (${sqlLiteralList(TERMINAL_TRADE_INTENT_STATUSES)})
  )
  or ${brokerBalanceSnapshots.lastRequestedAt} > ${millisecondsAgo(watchWindowMs)}
)`;

const activeAccountOfActiveUser = and(
  eq(brokerAccounts.status, BrokerAccountStatus.Active),
  eq(users.status, UserStatus.Active),
);

export interface BalanceRefreshCandidatesOptions {
  watchWindowMs: number;
  // only accounts whose access token outlives now() + this: the background refresh never needs
  // a token exchange; ensureFreshAccessToken with mayRefresh: false still refuses one under the
  // row lock (apps/backend/src/auth/token-service.ts)
  accessSkewMs: number;
  limit: number;
  // accounts the caller holds back for now (the reconciler's attempts that left no row to mark)
  exclude?: readonly string[];
}

// Never-observed accounts first, then the longest since the last attempt (a recorded failure
// counts as one), so an account that keeps failing does not hold the head of the queue.
export async function listBalanceRefreshCandidates(
  db: Db,
  { watchWindowMs, accessSkewMs, limit, exclude = [] }: BalanceRefreshCandidatesOptions,
): Promise<string[]> {
  const rows = await db
    .select({ id: brokerAccounts.id })
    .from(brokerAccounts)
    .innerJoin(users, eq(users.id, brokerAccounts.userId))
    .leftJoin(brokerBalanceSnapshots, eq(brokerBalanceSnapshots.brokerAccountId, brokerAccounts.id))
    .where(
      and(
        activeAccountOfActiveUser,
        sql`${brokerAccounts.accessTokenExpiresAt} > now() + (${accessSkewMs}::int * interval '1 millisecond')`,
        inWork(watchWindowMs),
        notInArray(brokerAccounts.id, [...exclude]),
      ),
    )
    .orderBy(
      sql`greatest(${brokerBalanceSnapshots.restObservedAt}, ${brokerBalanceSnapshots.lastRefreshFailedAt}) asc nulls first`,
      brokerAccounts.id,
    )
    .limit(limit);
  return rows.map((row) => row.id);
}

export interface SessionCandidate {
  id: string;
  brokerUserId: string;
}

export interface SessionCandidatesOptions {
  watchWindowMs: number;
  // accounts the caller holds back for now
  exclude?: readonly string[];
}

// The accounts the worker keeps a broker session for: the balance tick's "in work". No limit:
// the caller must see every account in work to tell a running session's account from an idle
// one, and caps in memory. No token-expiry filter: the caller asks for the token with
// mayRefresh: false and holds back an account whose token needs an exchange.
export async function listSessionCandidates(
  db: Db,
  { watchWindowMs, exclude = [] }: SessionCandidatesOptions,
): Promise<SessionCandidate[]> {
  return db
    .select({ id: brokerAccounts.id, brokerUserId: brokerAccounts.brokerUserId })
    .from(brokerAccounts)
    .innerJoin(users, eq(users.id, brokerAccounts.userId))
    .leftJoin(brokerBalanceSnapshots, eq(brokerBalanceSnapshots.brokerAccountId, brokerAccounts.id))
    .where(
      and(
        activeAccountOfActiveUser,
        inWork(watchWindowMs),
        notInArray(brokerAccounts.id, [...exclude]),
      ),
    )
    .orderBy(brokerAccounts.id);
}

export interface WatchedBalancesSummary {
  watched: number;
  withoutSnapshot: number;
  // the stalest snapshot among the watched, by its newest observation (REST or event); NULL
  // when none of them has a snapshot
  oldestAgeSec: number | null;
}

// Over every account in work, whatever its token: one whose token needs an exchange is not
// refreshed in the background, and this is where its age shows.
export async function summarizeWatchedBalances(
  db: Db,
  { watchWindowMs }: { watchWindowMs: number },
): Promise<WatchedBalancesSummary> {
  const t = brokerBalanceSnapshots;
  const [row] = await db
    .select({
      watched: sql<number>`count(*)::int`,
      withoutSnapshot: sql<number>`(count(*) - count(${t.brokerAccountId}))::int`,
      oldestAgeSec: sql<
        number | null
      >`max(${nullableAgeSec(sql`greatest(${t.restObservedAt}, ${newestEventAt})`)})`,
    })
    .from(brokerAccounts)
    .innerJoin(users, eq(users.id, brokerAccounts.userId))
    .leftJoin(t, eq(t.brokerAccountId, brokerAccounts.id))
    .where(and(activeAccountOfActiveUser, inWork(watchWindowMs)));
  // an aggregate without GROUP BY returns exactly one row
  return row;
}

export interface BalanceAccount {
  id: string;
  status: BrokerAccountStatus;
  brokerUserId: string;
  accessTokenExpiresAt: Date;
  userStatus: UserStatus;
}

export type BalanceAccountResolution =
  | { kind: 'account'; account: BalanceAccount }
  | { kind: 'no_user' }
  // no explicit id and no active account
  | { kind: 'no_account' }
  // no explicit id and more than one active account
  | { kind: 'ambiguous' }
  // the explicit id is not an account of this user
  | { kind: 'not_found' };

// Which account a balance read is about. Without an id, the user's only active account; with
// one, that account whatever its status, so the caller can say it is pending or revoked.
export async function resolveBalanceAccount(
  db: Db,
  { telegramUserId, brokerAccountId }: { telegramUserId: bigint; brokerAccountId?: string },
): Promise<BalanceAccountResolution> {
  const accountFilter =
    brokerAccountId === undefined
      ? eq(brokerAccounts.status, BrokerAccountStatus.Active)
      : eq(brokerAccounts.id, brokerAccountId);
  const rows = await db
    .select({
      userStatus: users.status,
      id: brokerAccounts.id,
      status: brokerAccounts.status,
      brokerUserId: brokerAccounts.brokerUserId,
      accessTokenExpiresAt: brokerAccounts.accessTokenExpiresAt,
    })
    .from(users)
    .leftJoin(brokerAccounts, and(eq(brokerAccounts.userId, users.id), accountFilter))
    .where(eq(users.telegramUserId, telegramUserId))
    .orderBy(brokerAccounts.id)
    .limit(2);
  const [first, second] = rows;
  if (first === undefined) return { kind: 'no_user' };
  if (second !== undefined) return { kind: 'ambiguous' };
  const { id, status, brokerUserId, accessTokenExpiresAt, userStatus } = first;
  if (id === null || status === null || brokerUserId === null || accessTokenExpiresAt === null) {
    return { kind: brokerAccountId === undefined ? 'no_account' : 'not_found' };
  }
  return {
    kind: 'account',
    account: { id, status, brokerUserId, accessTokenExpiresAt, userStatus },
  };
}
