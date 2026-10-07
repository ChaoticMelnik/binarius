import { and, asc, eq, notInArray, sql } from 'drizzle-orm';
import {
  BrokerAccountStatus,
  TradeIntentStatus,
  TradingSessionStopReason,
  UserStatus,
  type DecimalString,
  type TradeAction,
  type TradeIntentFailureReason,
  type TradeMode,
  type TradingSessionSettings,
} from '@binarius/shared';
import type { Db } from './client';
import { brokerAccounts } from './schema/broker-accounts';
import { brokerTrades } from './schema/broker-trades';
import { literal, sqlLiteralList } from './schema/columns';
import { TERMINAL_TRADE_INTENT_STATUSES, tradeIntents } from './schema/trade-intents';
import { TradingSessionStatus, tradingSessions } from './schema/trading-sessions';
import { users } from './schema/users';
import {
  createTradeIntent,
  millisecondsAgo,
  uniqueViolation,
  type CreateTradeIntentResult,
  type TradePolicy,
} from './trade-intent-ops';

// The session orchestrator's operations (#130; the orchestrator is #287; docs/trading-session.md). Lock order: the creator
// takes users → broker_accounts, as intent creation does; the stops and the decision mark lock
// session rows and nothing after them, so they never wait on a lock a creator holds while it
// waits on theirs.

export type TradingSessionRow = typeof tradingSessions.$inferSelect;

export const TradingSessionErrorCode = {
  AccountNotFound: 'account_not_found',
  AccountNotActive: 'account_not_active',
  AccountHalted: 'account_halted',
  UserNotActive: 'user_not_active',
  ActiveSessionExists: 'active_session_exists',
} as const;
export type TradingSessionErrorCode =
  (typeof TradingSessionErrorCode)[keyof typeof TradingSessionErrorCode];

export class TradingSessionError extends Error {
  constructor(readonly code: TradingSessionErrorCode) {
    super(code);
    this.name = 'TradingSessionError';
  }
}

export interface CreateTradingSessionInput {
  brokerAccountId: string;
  mode: TradeMode;
  settings: TradingSessionSettings;
}

export async function createTradingSession(
  db: Db,
  input: CreateTradingSessionInput,
): Promise<TradingSessionRow> {
  try {
    return await db.transaction(async (tx) => {
      const [account] = await tx
        .select({ userId: brokerAccounts.userId })
        .from(brokerAccounts)
        .where(eq(brokerAccounts.id, input.brokerAccountId));
      if (account === undefined) {
        throw new TradingSessionError(TradingSessionErrorCode.AccountNotFound);
      }
      // a lock, not a read: a block committed between a read and the insert would leave an
      // active session for a blocked user
      const user = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, account.userId), eq(users.status, UserStatus.Active)))
        .for('no key update');
      if (user.length === 0) throw new TradingSessionError(TradingSessionErrorCode.UserNotActive);
      const [locked] = await tx
        .select({ status: brokerAccounts.status, tradingHalted: brokerAccounts.tradingHalted })
        .from(brokerAccounts)
        .where(eq(brokerAccounts.id, input.brokerAccountId))
        .for('no key update');
      if (locked?.status !== BrokerAccountStatus.Active) {
        throw new TradingSessionError(TradingSessionErrorCode.AccountNotActive);
      }
      if (locked.tradingHalted) {
        throw new TradingSessionError(TradingSessionErrorCode.AccountHalted);
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
      throw new TradingSessionError(TradingSessionErrorCode.ActiveSessionExists);
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
}

export interface RunnableSessionsOptions {
  limit: number;
  // the sessions the caller holds back in memory
  exclude?: readonly string[];
}

// Active sessions whose account has no live intent — trade_intents_active_account_idx's own
// predicate, so a bot trade on the account holds the session as the index would. The least
// recently decided first, never-decided before all.
export async function listRunnableSessions(
  db: Db,
  { limit, exclude = [] }: RunnableSessionsOptions,
): Promise<RunnableSession[]> {
  return db
    .select({
      id: tradingSessions.id,
      brokerAccountId: tradingSessions.brokerAccountId,
      mode: tradingSessions.mode,
      settings: sql<unknown>`${tradingSessions.settings}`,
      startedAt: tradingSessions.startedAt,
      lastDecisionAt: tradingSessions.lastDecisionAt,
    })
    .from(tradingSessions)
    .where(
      and(
        eq(tradingSessions.status, TradingSessionStatus.Active),
        sql`not exists (
          select 1 from ${tradeIntents}
           where ${tradeIntents.brokerAccountId} = ${tradingSessions.brokerAccountId}
             and ${tradeIntents.status} not in (${sqlLiteralList(TERMINAL_TRADE_INTENT_STATUSES)})
        )`,
        notInArray(tradingSessions.id, [...exclude]),
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
           where ${active} and ${tradingSessions.startedAt} < ${millisecondsAgo(maxDurationMs)}
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
  status: TradeIntentStatus;
  amount: DecimalString;
  // the linked broker trade's profit; null until it closed, or without a linked trade
  profit: DecimalString | null;
  lastError: TradeIntentFailureReason | null;
}

export interface SessionHistory {
  telegramUserId: string;
  intents: SessionHistoryIntent[];
}

// The session's own intents in creation order: a bot trade on the same account (NULL session) is
// neither a step nor a rejection of the session.
export async function readSessionHistory(
  db: Db,
  sessionId: string,
): Promise<SessionHistory | undefined> {
  const [owner] = await db
    .select({ telegramUserId: users.telegramUserId })
    .from(tradingSessions)
    .innerJoin(brokerAccounts, eq(brokerAccounts.id, tradingSessions.brokerAccountId))
    .innerJoin(users, eq(users.id, brokerAccounts.userId))
    .where(eq(tradingSessions.id, sessionId));
  if (owner === undefined) return undefined;
  const intents = await db
    .select({
      id: tradeIntents.id,
      status: tradeIntents.status,
      amount: tradeIntents.amount,
      profit: brokerTrades.profit,
      lastError: tradeIntents.lastError,
    })
    .from(tradeIntents)
    .leftJoin(brokerTrades, eq(brokerTrades.intentId, tradeIntents.id))
    .where(eq(tradeIntents.tradingSessionId, sessionId))
    .orderBy(asc(tradeIntents.createdAt), asc(tradeIntents.id));
  return { telegramUserId: owner.telegramUserId.toString(), intents };
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

// moves the scan's order key of a session that stays active
export async function markSessionDecision(db: Db, { id }: { id: string }): Promise<void> {
  await db
    .update(tradingSessions)
    .set({ lastDecisionAt: sql`now()`, updatedAt: sql`now()` })
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

export const sessionClientRequestId = (sessionId: string, step: number): string =>
  `session:${sessionId}:${step}`;

// createTradeIntent's own path: the step key makes a repeat a replay, and the session row is
// locked after the account (TradingSessionNotActiveError when it is no longer active)
export async function createSessionIntent(
  db: Db,
  input: CreateSessionIntentInput,
  policy: TradePolicy,
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
      clientRequestId: sessionClientRequestId(input.sessionId, input.step),
    },
    policy,
    { id: input.sessionId },
  );
}
