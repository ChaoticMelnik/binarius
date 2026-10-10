import { and, asc, desc, eq, isNull, notInArray, sql } from 'drizzle-orm';
import {
  BrokerAccountStatus,
  TokenLedgerKind,
  TradingSessionErrorCode,
  TradeIntentStatus,
  TradeMode,
  TradingSessionStatus,
  TradingSessionStopReason,
  UserStatus,
  type DecimalString,
  type SessionSummary,
  type TradeAction,
  type TradeIntentFailureReason,
  type TradingSessionSettings,
  type TradingSessionView,
  safeParseTradingSessionSettings,
} from '@binarius/shared';
import { nullableAgeSec } from './balance-snapshot-ops';
import type { Db } from './client';
import { brokerAccounts } from './schema/broker-accounts';
import { brokerBalanceSnapshots } from './schema/broker-balance-snapshots';
import { brokerTrades } from './schema/broker-trades';
import { MONEY_SCALE, literal, sqlLiteralList } from './schema/columns';
import { tokenLedger } from './schema/token-ledger';
import { TERMINAL_TRADE_INTENT_STATUSES, tradeIntents } from './schema/trade-intents';
import { tradingSessions } from './schema/trading-sessions';
import { users } from './schema/users';
import {
  TOKENS_PER_INTENT,
  createTradeIntent,
  millisecondsAgo,
  resolveTradingAccount,
  toTradeIntentView,
  uniqueViolation,
  type CreateTradeIntentOptions,
  type CreateTradeIntentResult,
  type DbExecutor,
} from './trade-intent-ops';
import { isTradingOpen, readTradingSwitch, tradingOpenSql } from './trading-switch-ops';

// The session orchestrator's operations (#130; the orchestrator is #287; docs/trading-session.md). Lock order: the creator
// takes users → broker_accounts, as intent creation does; the stops and the decision mark lock
// session rows and nothing after them, so they never wait on a lock a creator holds while it
// waits on theirs.

export type TradingSessionRow = typeof tradingSessions.$inferSelect;

// createTradingSession's refusals; the start route maps each to its wire code
// (TradingSessionErrorCode in shared)
export const TradingSessionDbErrorCode = {
  AccountNotFound: 'account_not_found',
  AccountRevoked: 'account_revoked',
  AccountNotConfirmed: 'account_not_confirmed',
  AccountHalted: 'account_halted',
  UserNotActive: 'user_not_active',
  ActiveSessionExists: 'active_session_exists',
  // the global trading switch is closed (#144)
  TradingPaused: 'trading_paused',
  // sessions are demo only until #327: createTradingSession refuses another mode (#144 review m1)
  ModeNotAllowed: 'mode_not_allowed',
  // a real session on a DEMO_ONLY process (#396), before mode_not_allowed
  DemoOnly: 'demo_only',
} as const;
export type TradingSessionDbErrorCode =
  (typeof TradingSessionDbErrorCode)[keyof typeof TradingSessionDbErrorCode];

export class TradingSessionError extends Error {
  constructor(readonly code: TradingSessionDbErrorCode) {
    super(code);
    this.name = 'TradingSessionError';
  }
}

export interface CreateTradingSessionInput {
  // the owner the caller acts for: an account of another user is account_not_found
  telegramUserId: string;
  brokerAccountId: string;
  mode: TradeMode;
  settings: TradingSessionSettings;
}

export interface CreateTradingSessionOptions {
  // required, not optional: no route test can send a real session on main, so the type is what
  // proves every caller passes the process's flag (#396)
  demoOnly: boolean;
}

export async function createTradingSession(
  db: Db,
  input: CreateTradingSessionInput,
  options: CreateTradingSessionOptions,
): Promise<TradingSessionRow> {
  // before mode_not_allowed, so the guard outlives the demo-only rule of sessions (#327)
  if (options.demoOnly && input.mode === TradeMode.Real) {
    throw new TradingSessionError(TradingSessionDbErrorCode.DemoOnly);
  }
  if (input.mode !== TradeMode.Demo) {
    throw new TradingSessionError(TradingSessionDbErrorCode.ModeNotAllowed);
  }
  try {
    return await db.transaction(async (tx) => {
      const [account] = await tx
        .select({ userId: brokerAccounts.userId })
        .from(brokerAccounts)
        .innerJoin(users, eq(users.id, brokerAccounts.userId))
        .where(
          and(
            eq(brokerAccounts.id, input.brokerAccountId),
            eq(users.telegramUserId, BigInt(input.telegramUserId)),
          ),
        );
      if (account === undefined) {
        throw new TradingSessionError(TradingSessionDbErrorCode.AccountNotFound);
      }
      // a lock, not a read: a block committed between a read and the insert would leave an
      // active session for a blocked user
      const user = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, account.userId), eq(users.status, UserStatus.Active)))
        .for('no key update');
      if (user.length === 0) throw new TradingSessionError(TradingSessionDbErrorCode.UserNotActive);
      const [locked] = await tx
        .select({ status: brokerAccounts.status, tradingHalted: brokerAccounts.tradingHalted })
        .from(brokerAccounts)
        .where(eq(brokerAccounts.id, input.brokerAccountId))
        .for('no key update');
      if (locked === undefined) {
        throw new TradingSessionError(TradingSessionDbErrorCode.AccountNotFound);
      }
      if (locked.status === BrokerAccountStatus.Revoked) {
        throw new TradingSessionError(TradingSessionDbErrorCode.AccountRevoked);
      }
      if (locked.status === BrokerAccountStatus.Pending) {
        throw new TradingSessionError(TradingSessionDbErrorCode.AccountNotConfirmed);
      }
      if (locked.tradingHalted) {
        throw new TradingSessionError(TradingSessionDbErrorCode.AccountHalted);
      }
      // a plain read (Rule 5): a kill-switch commit after it is caught by stopPausedSessions
      if (!isTradingOpen(await readTradingSwitch(tx))) {
        throw new TradingSessionError(TradingSessionDbErrorCode.TradingPaused);
      }
      const [row] = await tx
        .insert(tradingSessions)
        .values({
          brokerAccountId: input.brokerAccountId,
          mode: input.mode,
          settings: input.settings,
        })
        .returning();
      if (row === undefined) throw new Error('trading_sessions insert returned no row');
      return row;
    });
  } catch (error) {
    if (uniqueViolation(error) === 'trading_sessions_active_account_idx') {
      throw new TradingSessionError(TradingSessionDbErrorCode.ActiveSessionExists);
    }
    throw error;
  }
}

export interface RunnableSession {
  id: string;
  brokerAccountId: string;
  mode: TradeMode;
  // raw: the orchestrator parses it
  settings: unknown;
  startedAt: Date;
  lastDecisionAt: Date | null;
  // the direction the last deciding attempt saw; NULL after a no_signal or before any (#379)
  lastSignalAction: TradeAction | null;
}

export interface RunnableSessionsOptions {
  limit: number;
  // the session deadline (stopExpiredSessions' own): a session past it is never runnable
  maxDurationMs: number;
  // the sessions the caller holds back in memory
  exclude?: readonly string[];
}

// started_at + maxDurationMs passed, on the database clock: stopExpiredSessions stops these, the
// scan skips them and the history flags them, all with the same boundary
const pastDeadline = (maxDurationMs: number) =>
  sql`${tradingSessions.startedAt} < ${millisecondsAgo(maxDurationMs)}`;

// Active sessions within the deadline whose account has no live intent —
// trade_intents_active_account_idx's own predicate, so a bot trade on the account holds the
// session as the index would. The deadline predicate keeps a session the capped expiry sweep left
// over from a new trade. The least recently decided first, never-decided before all.
export async function listRunnableSessions(
  db: Db,
  { limit, maxDurationMs, exclude = [] }: RunnableSessionsOptions,
): Promise<RunnableSession[]> {
  return db
    .select({
      id: tradingSessions.id,
      brokerAccountId: tradingSessions.brokerAccountId,
      mode: tradingSessions.mode,
      settings: sql<unknown>`${tradingSessions.settings}`,
      startedAt: tradingSessions.startedAt,
      lastDecisionAt: tradingSessions.lastDecisionAt,
      lastSignalAction: tradingSessions.lastSignalAction,
    })
    .from(tradingSessions)
    .where(
      and(
        eq(tradingSessions.status, TradingSessionStatus.Active),
        sql`not ${pastDeadline(maxDurationMs)}`,
        sql`not exists (
          select 1 from ${tradeIntents}
           where ${tradeIntents.brokerAccountId} = ${tradingSessions.brokerAccountId}
             and ${tradeIntents.status} not in (${sqlLiteralList(TERMINAL_TRADE_INTENT_STATUSES)})
        )`,
        exclude.length === 0 ? undefined : notInArray(tradingSessions.id, [...exclude]),
      ),
    )
    .orderBy(sql`${tradingSessions.lastDecisionAt} asc nulls first`, asc(tradingSessions.createdAt))
    .limit(limit);
}

export interface StoppedSession {
  id: string;
  brokerAccountId: string;
}

const stoppedBy = (reason: TradingSessionStopReason) => ({
  status: TradingSessionStatus.Stopped,
  stopReason: reason,
  endedAt: sql`now()`,
  lastDecisionAt: sql`now()`,
  updatedAt: sql`now()`,
});

const stoppedColumns = {
  id: tradingSessions.id,
  brokerAccountId: tradingSessions.brokerAccountId,
};

// One statement on the database clock; `status = active` in the WHERE is the CAS, so a session
// another writer stopped first keeps its reason.
export async function stopExpiredSessions(
  db: Db,
  { maxDurationMs, limit }: { maxDurationMs: number; limit: number },
): Promise<StoppedSession[]> {
  const active = eq(tradingSessions.status, TradingSessionStatus.Active);
  return db
    .update(tradingSessions)
    .set(stoppedBy(TradingSessionStopReason.Timeout))
    .where(
      and(
        active,
        sql`${tradingSessions.id} in (
          select ${tradingSessions.id} from ${tradingSessions}
           where ${active} and ${pastDeadline(maxDurationMs)}
           limit ${limit}
        )`,
      ),
    )
    .returning(stoppedColumns);
}

// Every active session while the global trading switch is closed (#144); the orchestrator's tick
// (#287) runs it. Only a person starts a stopped session again.
export async function stopPausedSessions(
  db: Db,
  { limit }: { limit: number },
): Promise<StoppedSession[]> {
  const active = eq(tradingSessions.status, TradingSessionStatus.Active);
  return db
    .update(tradingSessions)
    .set(stoppedBy(TradingSessionStopReason.KillSwitch))
    .where(
      and(
        active,
        sql`${tradingSessions.id} in (
          select ${tradingSessions.id} from ${tradingSessions}
           where ${active} and not ${tradingOpenSql}
           limit ${limit}
        )`,
      ),
    )
    .returning(stoppedColumns);
}

// A session whose account is halted, or with an intent in manual_review. The halt is the
// reconciliation pass's write (haltAccountForManualReview, Rule 25); the second predicate covers
// a manual_review intent on an account an operator already un-halted.
export async function stopHaltedSessions(
  db: Db,
  { limit }: { limit: number },
): Promise<StoppedSession[]> {
  const active = eq(tradingSessions.status, TradingSessionStatus.Active);
  return db
    .update(tradingSessions)
    .set(stoppedBy(TradingSessionStopReason.ManualReview))
    .where(
      and(
        active,
        sql`${tradingSessions.id} in (
          select ${tradingSessions.id} from ${tradingSessions}
           where ${active}
             and (
               exists (
                 select 1 from ${brokerAccounts}
                  where ${brokerAccounts.id} = ${tradingSessions.brokerAccountId}
                    and ${brokerAccounts.tradingHalted}
               )
               or exists (
                 select 1 from ${tradeIntents}
                  where ${tradeIntents.tradingSessionId} = ${tradingSessions.id}
                    and ${tradeIntents.status} = ${literal(TradeIntentStatus.ManualReview)}
               )
             )
           limit ${limit}
        )`,
      ),
    )
    .returning(stoppedColumns);
}

export interface SessionHistoryIntent {
  id: string;
  action: TradeAction;
  status: TradeIntentStatus;
  amount: DecimalString;
  // the linked broker trade's profit; null until it closed, or without a linked trade
  profit: DecimalString | null;
  lastError: TradeIntentFailureReason | null;
}

export interface SessionHistory {
  telegramUserId: string;
  // started_at + maxDurationMs passed, on the database clock at this read
  expired: boolean;
  intents: SessionHistoryIntent[];
}

// The session's own intents in creation order: a bot trade on the same account (NULL session) is
// neither a step nor a rejection of the session.
export async function readSessionHistory(
  db: Db,
  sessionId: string,
  { maxDurationMs }: { maxDurationMs: number },
): Promise<SessionHistory | undefined> {
  const [owner] = await db
    .select({
      telegramUserId: users.telegramUserId,
      expired: sql<boolean>`${pastDeadline(maxDurationMs)}`,
    })
    .from(tradingSessions)
    .innerJoin(brokerAccounts, eq(brokerAccounts.id, tradingSessions.brokerAccountId))
    .innerJoin(users, eq(users.id, brokerAccounts.userId))
    .where(eq(tradingSessions.id, sessionId));
  if (owner === undefined) return undefined;
  const intents = await db
    .select({
      id: tradeIntents.id,
      action: tradeIntents.action,
      status: tradeIntents.status,
      amount: tradeIntents.amount,
      profit: brokerTrades.profit,
      lastError: tradeIntents.lastError,
    })
    .from(tradeIntents)
    .leftJoin(brokerTrades, eq(brokerTrades.intentId, tradeIntents.id))
    .where(eq(tradeIntents.tradingSessionId, sessionId))
    .orderBy(asc(tradeIntents.createdAt), asc(tradeIntents.id));
  return { telegramUserId: owner.telegramUserId.toString(), expired: owner.expired, intents };
}

// CAS on status = active: a second stop finds nothing and the first reason stays
export async function stopTradingSession(
  db: Db,
  { id, reason }: { id: string; reason: TradingSessionStopReason },
): Promise<TradingSessionRow | undefined> {
  const [row] = await db
    .update(tradingSessions)
    .set(stoppedBy(reason))
    .where(and(eq(tradingSessions.id, id), eq(tradingSessions.status, TradingSessionStatus.Active)))
    .returning();
  return row;
}

// Every active session of the owner in one statement (#122): owner scope is the predicate
// (Rule 13), so another user's id stops nothing; `status = active` is the CAS (Rule 28), so a
// session another writer stopped first keeps its reason and is not returned. No limit: a user has
// at most one active session per account (trading_sessions_active_account_idx).
export async function stopUserSessions(
  db: Db,
  { telegramUserId }: { telegramUserId: string },
): Promise<StoppedSession[]> {
  const active = eq(tradingSessions.status, TradingSessionStatus.Active);
  return db
    .update(tradingSessions)
    .set(stoppedBy(TradingSessionStopReason.UserStopped))
    .where(
      and(
        active,
        sql`${tradingSessions.id} in (
          select ${tradingSessions.id} from ${tradingSessions}
            join ${brokerAccounts} on ${brokerAccounts.id} = ${tradingSessions.brokerAccountId}
            join ${users} on ${users.id} = ${brokerAccounts.userId}
           where ${active}
             and ${users.telegramUserId} = ${BigInt(telegramUserId)}
        )`,
      ),
    )
    .returning(stoppedColumns);
}

// Moves the scan's order key of a session that stays active. signalAction: undefined leaves the
// column, null clears it, an action sets it (#379, the pause after two losses).
export async function markSessionDecision(
  db: Db,
  { id, signalAction }: { id: string; signalAction?: TradeAction | null },
): Promise<void> {
  await db
    .update(tradingSessions)
    .set({
      lastDecisionAt: sql`now()`,
      updatedAt: sql`now()`,
      ...(signalAction === undefined ? {} : { lastSignalAction: signalAction }),
    })
    .where(
      and(eq(tradingSessions.id, id), eq(tradingSessions.status, TradingSessionStatus.Active)),
    );
}

export interface CreateSessionIntentInput {
  sessionId: string;
  // 1-based: the session's intents so far + 1
  step: number;
  telegramUserId: string;
  brokerAccountId: string;
  mode: TradeMode;
  assetId: number;
  amount: DecimalString;
  action: TradeAction;
  durationSec: number;
}

// createTradeIntent's own path: the step key makes a repeat a replay, and the session row is
// locked after the account (TradingSessionNotActiveError when it is no longer active)
export async function createSessionIntent(
  db: Db,
  input: CreateSessionIntentInput,
  options?: Pick<CreateTradeIntentOptions, 'demoOnly'>,
): Promise<CreateTradeIntentResult> {
  return createTradeIntent(
    db,
    {
      telegramUserId: input.telegramUserId,
      brokerAccountId: input.brokerAccountId,
      mode: input.mode,
      assetId: input.assetId,
      amount: input.amount,
      action: input.action,
      durationSec: input.durationSec,
      clientRequestId: `session:${input.sessionId}:${input.step}`,
    },
    { id: input.sessionId },
    options,
  );
}

export type TradingSessionStartRefusal =
  | typeof TradingSessionErrorCode.UserNotFound
  | typeof TradingSessionErrorCode.UserBlocked
  | typeof TradingSessionErrorCode.BrokerAccountNotFound
  | typeof TradingSessionErrorCode.AmbiguousBrokerAccount
  | typeof TradingSessionErrorCode.AccountNotConfirmed
  | typeof TradingSessionErrorCode.AccountRevoked
  | typeof TradingSessionErrorCode.AccountHalted
  | typeof TradingSessionErrorCode.ActiveSessionExists
  | typeof TradingSessionErrorCode.InsufficientTokens
  | typeof TradingSessionErrorCode.TradingPaused
  | typeof TradingSessionErrorCode.ModeNotAllowed;

export type TradingSessionStartCheck =
  | { ok: true; brokerAccountId: string; accessTokenExpiresAt: Date }
  | { ok: false; code: TradingSessionStartRefusal; activeSessionId?: string };

const refused = (code: TradingSessionStartRefusal): TradingSessionStartCheck => ({
  ok: false,
  code,
});

// The start route's refusals before it calls the broker for a balance (#283). Plain reads with no
// lock, the first refusal wins; createTradingSession re-checks the switch, the user, the account
// and the one active session, the tokens only here (docs/trading-session.md -> Routes).
// The closed switch first, as createInTransaction checks it before the user's account.
export async function checkTradingSessionStart(
  db: Db,
  { telegramUserId, brokerAccountId }: { telegramUserId: string; brokerAccountId?: string },
): Promise<TradingSessionStartCheck> {
  if (!isTradingOpen(await readTradingSwitch(db))) {
    return refused(TradingSessionErrorCode.TradingPaused);
  }
  const [user] = await db
    .select({
      id: users.id,
      status: users.status,
      balance: users.tokenBalance,
      reserved: users.tokenReserved,
      tradingMode: users.tradingMode,
    })
    .from(users)
    .where(eq(users.telegramUserId, BigInt(telegramUserId)));
  if (user === undefined) return refused(TradingSessionErrorCode.UserNotFound);
  if (user.status === UserStatus.Blocked) return refused(TradingSessionErrorCode.UserBlocked);
  // the route creates demo sessions only (#121, Rule 36): a user in real mode gets none, before
  // any account read. Not re-read in createTradingSession's transaction: a switch to real between
  // the two reads leaves a demo session trading demo money (docs/trading-session.md -> Routes).
  if (user.tradingMode !== TradeMode.Demo) return refused(TradingSessionErrorCode.ModeNotAllowed);

  const resolved = await resolveTradingAccount(db, user.id, brokerAccountId);
  if (!resolved.ok) return refused(resolved.code);

  const [account] = await db
    .select({
      status: brokerAccounts.status,
      tradingHalted: brokerAccounts.tradingHalted,
      accessTokenExpiresAt: brokerAccounts.accessTokenExpiresAt,
    })
    .from(brokerAccounts)
    .where(eq(brokerAccounts.id, resolved.brokerAccountId));
  // resolveTradingAccount just read this row, and broker_accounts rows are never deleted
  if (account === undefined) return refused(TradingSessionErrorCode.BrokerAccountNotFound);
  if (account.status === BrokerAccountStatus.Revoked) {
    return refused(TradingSessionErrorCode.AccountRevoked);
  }
  if (account.status === BrokerAccountStatus.Pending) {
    return refused(TradingSessionErrorCode.AccountNotConfirmed);
  }
  if (account.tradingHalted) return refused(TradingSessionErrorCode.AccountHalted);

  const activeSessionId = await activeSessionOf(db, resolved.brokerAccountId);
  if (activeSessionId !== undefined) {
    return { ok: false, code: TradingSessionErrorCode.ActiveSessionExists, activeSessionId };
  }

  if (user.balance - user.reserved < TOKENS_PER_INTENT) {
    return refused(TradingSessionErrorCode.InsufficientTokens);
  }
  return {
    ok: true,
    brokerAccountId: resolved.brokerAccountId,
    accessTokenExpiresAt: account.accessTokenExpiresAt,
  };
}

async function activeSessionOf(exec: DbExecutor, brokerAccountId: string) {
  const [row] = await exec
    .select({ id: tradingSessions.id })
    .from(tradingSessions)
    .where(
      and(
        eq(tradingSessions.brokerAccountId, brokerAccountId),
        eq(tradingSessions.status, TradingSessionStatus.Active),
      ),
    );
  return row?.id;
}

const SETTLED = literal(TradeIntentStatus.Settled);
// the aggregate always returns a row; this only satisfies the destructuring's undefined
const ZERO_PROFIT = '0.00000000' as DecimalString;

// The session's result, over trade_intents joined to broker_trades: summed by Postgres at the
// column's scale, never in JS (Rule 2), '0.00000000' with none. The view's counters and the
// summary card's result are this one fragment (#337, #318).
const sessionProfitSumSql = sql<DecimalString>`coalesce(sum(${brokerTrades.profit}) filter (where ${tradeIntents.status} = ${SETTLED}), round(0, ${sql.raw(String(MONEY_SCALE))}))`;

// The account's balance in the session's mode (#337): the newest observation is the REST read or
// that mode's socket event, whichever is later (greatest() skips a NULL event). It is current
// when no settle row of this session's intents in token_ledger - the database clock of a
// settlement - is newer than it; with no settlement at all it is current.
const isRealSession = sql`${tradingSessions.mode} = ${literal(TradeMode.Real)}`;
const sessionAvailable = sql<DecimalString | null>`case when ${isRealSession} then ${brokerBalanceSnapshots.realAvailable} else ${brokerBalanceSnapshots.demoAvailable} end`;
const sessionObservedAt = sql`greatest(${brokerBalanceSnapshots.restObservedAt}, case when ${isRealSession} then ${brokerBalanceSnapshots.realEventAt} else ${brokerBalanceSnapshots.demoEventAt} end)`;
const sessionBalanceCurrent = sql<boolean>`not exists (
  select 1 from ${tokenLedger}
    join ${tradeIntents} on ${tradeIntents.id} = ${tokenLedger.intentId}
   where ${tradeIntents.tradingSessionId} = ${tradingSessions.id}
     and ${tokenLedger.kind} = ${literal(TokenLedgerKind.Settle)}
     and ${tokenLedger.createdAt} > ${sessionObservedAt}
)`;

// The session as the owner's bot sees it (#283). Scoped by the owner: another user's session and
// a missing id are both undefined (Rule 13). The row, the counters and the last intent come from
// one REPEATABLE READ snapshot, so the counters never disagree with lastIntent.
export async function readTradingSessionView(
  db: Db,
  id: string,
  telegramUserId: string,
): Promise<TradingSessionView | undefined> {
  return db.transaction(
    async (tx) => {
      const [session] = await tx
        .select({
          id: tradingSessions.id,
          mode: tradingSessions.mode,
          status: tradingSessions.status,
          stopReason: tradingSessions.stopReason,
          settings: sql<unknown>`${tradingSessions.settings}`,
          startedAt: tradingSessions.startedAt,
          endedAt: tradingSessions.endedAt,
          available: sessionAvailable,
          ageSec: nullableAgeSec(sessionObservedAt),
          current: sessionBalanceCurrent,
        })
        .from(tradingSessions)
        .innerJoin(brokerAccounts, eq(brokerAccounts.id, tradingSessions.brokerAccountId))
        .innerJoin(users, eq(users.id, brokerAccounts.userId))
        .leftJoin(
          brokerBalanceSnapshots,
          eq(brokerBalanceSnapshots.brokerAccountId, tradingSessions.brokerAccountId),
        )
        .where(and(eq(tradingSessions.id, id), eq(users.telegramUserId, BigInt(telegramUserId))));
      if (session === undefined) return undefined;

      // a settled intent always has its broker trade (settleIntent writes both); one without it
      // would count in settled and in none of won/lost/tied
      const [counts] = await tx
        .select({
          settled: sql<number>`count(*) filter (where ${tradeIntents.status} = ${SETTLED})::int`,
          rejected: sql<number>`count(*) filter (where ${tradeIntents.status} = ${literal(TradeIntentStatus.Rejected)})::int`,
          won: sql<number>`count(*) filter (where ${tradeIntents.status} = ${SETTLED} and ${brokerTrades.profit} > 0)::int`,
          lost: sql<number>`count(*) filter (where ${tradeIntents.status} = ${SETTLED} and ${brokerTrades.profit} < 0)::int`,
          tied: sql<number>`count(*) filter (where ${tradeIntents.status} = ${SETTLED} and ${brokerTrades.profit} = 0)::int`,
          profit: sessionProfitSumSql,
        })
        .from(tradeIntents)
        .leftJoin(brokerTrades, eq(brokerTrades.intentId, tradeIntents.id))
        .where(eq(tradeIntents.tradingSessionId, id));

      const [last] = await tx
        .select()
        .from(tradeIntents)
        .where(eq(tradeIntents.tradingSessionId, id))
        .orderBy(desc(tradeIntents.createdAt), desc(tradeIntents.id))
        .limit(1);

      const parsed = safeParseTradingSessionSettings(session.settings);
      const settings = parsed.success ? parsed.data : null;
      return {
        id: session.id,
        mode: session.mode,
        status: session.status,
        stopReason: session.stopReason ?? null,
        settings,
        startedAt: session.startedAt.toISOString(),
        endedAt: session.endedAt === null ? null : session.endedAt.toISOString(),
        trades: {
          planned: settings === null ? 0 : settings.trades,
          settled: counts?.settled ?? 0,
          rejected: counts?.rejected ?? 0,
          won: counts?.won ?? 0,
          lost: counts?.lost ?? 0,
          tied: counts?.tied ?? 0,
          profit: counts?.profit ?? ZERO_PROFIT,
        },
        lastIntent: last === undefined ? null : toTradeIntentView(last, telegramUserId),
        balance:
          session.available === null || session.ageSec === null
            ? null
            : { available: session.available, ageSec: session.ageSec, current: session.current },
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

// The finished session's summary card, claimed at most once (#318, docs/bot-session.md → The
// summary card). One CAS UPDATE sets summary_sent_at only when every condition holds: the
// owner's session (Rule 13, a foreign id reads as a missing one), stopped, not sent before, no
// intent of it outside the terminal statuses, and at least one settled intent with its broker
// trade. Any miss is undefined and writes nothing. The rows the card draws are read after it in
// the same transaction; they cannot change any more: terminal intents have no edges and a
// stopped session never runs again.
export async function claimSessionSummary(
  db: Db,
  { id, telegramUserId }: { id: string; telegramUserId: string },
): Promise<SessionSummary | undefined> {
  return db.transaction(async (tx) => {
    const settled = and(
      eq(tradeIntents.tradingSessionId, id),
      eq(tradeIntents.status, TradeIntentStatus.Settled),
    );
    const [claimed] = await tx
      .update(tradingSessions)
      .set({ summarySentAt: sql`now()` })
      .where(
        and(
          eq(tradingSessions.id, id),
          eq(tradingSessions.status, TradingSessionStatus.Stopped),
          isNull(tradingSessions.summarySentAt),
          sql`exists (
            select 1 from ${brokerAccounts}
              join ${users} on ${users.id} = ${brokerAccounts.userId}
             where ${brokerAccounts.id} = ${tradingSessions.brokerAccountId}
               and ${users.telegramUserId} = ${BigInt(telegramUserId)}
          )`,
          sql`not exists (
            select 1 from ${tradeIntents}
             where ${tradeIntents.tradingSessionId} = ${tradingSessions.id}
               and ${tradeIntents.status} not in (${sqlLiteralList(TERMINAL_TRADE_INTENT_STATUSES)})
          )`,
          sql`exists (
            select 1 from ${tradeIntents}
              join ${brokerTrades} on ${brokerTrades.intentId} = ${tradeIntents.id}
             where ${tradeIntents.tradingSessionId} = ${tradingSessions.id}
               and ${tradeIntents.status} = ${SETTLED}
          )`,
        ),
      )
      .returning({ id: tradingSessions.id });
    if (claimed === undefined) return undefined;

    // broker_trades_settlement_check: close_price and profit are set exactly on a closed trade,
    // and a settled intent's trade is closed (settleIntent writes both)
    const rows = await tx
      .select({
        profit: brokerTrades.profit,
        openPrice: brokerTrades.openPrice,
        closePrice: brokerTrades.closePrice,
      })
      .from(tradeIntents)
      .innerJoin(brokerTrades, eq(brokerTrades.intentId, tradeIntents.id))
      .where(settled)
      .orderBy(asc(tradeIntents.createdAt), asc(tradeIntents.id));
    const [sum] = await tx
      .select({ result: sessionProfitSumSql })
      .from(tradeIntents)
      .innerJoin(brokerTrades, eq(brokerTrades.intentId, tradeIntents.id))
      .where(settled);
    return {
      result: sum?.result ?? ZERO_PROFIT,
      trades: rows.map((row) => {
        if (row.profit === null || row.closePrice === null) {
          throw new Error(`settled intent of session ${id} has an open broker trade`);
        }
        return { profit: row.profit, openPrice: row.openPrice, closePrice: row.closePrice };
      }),
    };
  });
}

// The account a session trades on, read by its owner only (Rule 13): the view route refreshes its
// balance (#337). A foreign telegram id and a missing session both read undefined.
export async function readTradingSessionAccount(
  db: Db,
  id: string,
  telegramUserId: string,
): Promise<{ brokerAccountId: string } | undefined> {
  const [row] = await db
    .select({ brokerAccountId: tradingSessions.brokerAccountId })
    .from(tradingSessions)
    .innerJoin(brokerAccounts, eq(brokerAccounts.id, tradingSessions.brokerAccountId))
    .innerJoin(users, eq(users.id, brokerAccounts.userId))
    .where(and(eq(tradingSessions.id, id), eq(users.telegramUserId, BigInt(telegramUserId))));
  return row;
}

// the account's active session as its owner sees it; undefined when none, or when it ended
// between the two reads
export async function readActiveTradingSessionView(
  db: Db,
  brokerAccountId: string,
  telegramUserId: string,
): Promise<TradingSessionView | undefined> {
  const id = await activeSessionOf(db, brokerAccountId);
  return id === undefined ? undefined : readTradingSessionView(db, id, telegramUserId);
}
