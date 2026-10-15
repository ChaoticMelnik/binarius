import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import {
  SessionTradeResult,
  TradeIntentStatus,
  TradingSessionStatus,
  type DecimalString,
  type TradeMode,
} from '@binarius/shared';
import type { Db } from './client';
import { brokerAccounts } from './schema/broker-accounts';
import { brokerTrades } from './schema/broker-trades';
import { literal, sqlLiteralList } from './schema/columns';
import { TERMINAL_TRADE_INTENT_STATUSES, tradeIntents } from './schema/trade-intents';
import { tradingSessions } from './schema/trading-sessions';
import { users } from './schema/users';

// The session notices' state (#464, docs/bot-session.md → Trade messages): the backend's sender
// sends every settled trade of a session as its own message and, once the session is finished,
// one summary. A session's trades are strictly sequential (one non-terminal intent per account,
// Rule 7), so settlement order is creation order and a cursor «the first k settled trades are
// claimed» is the whole state; trade_intents is only read (Rule 6). Every claim is a CAS before
// the Telegram call: at most once, never twice (the mailing engine's rule). Each operation locks
// only its own trading_sessions row, by its UPDATE, and reads trade_intents and broker_trades
// without a lock (Rule 5), as markSessionDecision and claimSessionSummary do.

const SETTLED = literal(TradeIntentStatus.Settled);

// A settled trade of the session: a settled intent with its broker trade (settleIntent writes
// both). The same count the view's `settled` and the backfill (0049) take.
const settledCountSql = sql<number>`(
  select count(*)::int from ${tradeIntents}
    join ${brokerTrades} on ${brokerTrades.intentId} = ${tradeIntents.id}
   where ${tradeIntents.tradingSessionId} = ${tradingSessions.id}
     and ${tradeIntents.status} = ${SETTLED}
)`;

// Nothing of the session can move any more: stopped, and no intent of it outside the terminal
// statuses. The SQL twin of isTradingSessionFinished, as claimSessionSummary spells it; a trade
// on manual review keeps the session unfinished.
const finishedSql = sql<boolean>`(${tradingSessions.status} = ${literal(TradingSessionStatus.Stopped)} and not exists (
  select 1 from ${tradeIntents}
   where ${tradeIntents.tradingSessionId} = ${tradingSessions.id}
     and ${tradeIntents.status} not in (${sqlLiteralList(TERMINAL_TRADE_INTENT_STATUSES)})
))`;

export interface PendingSessionNotice {
  sessionId: string;
  mode: TradeMode;
  // raw: the sender parses it
  settings: unknown;
  // the cursor: settled trades claimed so far
  notifiedTrades: number;
  settled: number;
  finished: boolean;
  // the owner's, by the session's account: no id comes from outside (Rule 13)
  telegramUserId: bigint;
  // users.telegram_blocked_at is set: nothing can be delivered (Rule 19)
  telegramBlocked: boolean;
}

// The sessions with something to send: no summary yet, and a settled trade past the cursor or a
// finished session. Oldest first, on trading_sessions_notice_pending_idx.
export async function listPendingSessionNotices(
  db: Db,
  { limit }: { limit: number },
): Promise<PendingSessionNotice[]> {
  const rows = await db
    .select({
      sessionId: tradingSessions.id,
      mode: tradingSessions.mode,
      settings: sql<unknown>`${tradingSessions.settings}`,
      notifiedTrades: tradingSessions.notifiedTrades,
      settled: settledCountSql,
      finished: finishedSql,
      telegramUserId: users.telegramUserId,
      telegramBlocked: sql<boolean>`${users.telegramBlockedAt} is not null`,
    })
    .from(tradingSessions)
    .innerJoin(brokerAccounts, eq(brokerAccounts.id, tradingSessions.brokerAccountId))
    .innerJoin(users, eq(users.id, brokerAccounts.userId))
    .where(
      and(
        isNull(tradingSessions.finalNoticeSentAt),
        sql`(${settledCountSql} > ${tradingSessions.notifiedTrades} or ${finishedSql})`,
      ),
    )
    .orderBy(asc(tradingSessions.createdAt), asc(tradingSessions.id))
    .limit(limit);
  return rows;
}

// A settled trade as its message needs it. `outcome` is the figure after «→» (the owner's
// sample, #464): the whole payout of a win, the loss of a loss, the stake of a tie, by Postgres in
// numeric (Rule 2); `result` the class by the sign of the profit, as the view's counters compare
// it. The stake is the intent's amount, equal to the broker trade's (Rule 15).
export interface SessionTradeNoticeRow {
  amount: DecimalString;
  outcome: DecimalString;
  result: SessionTradeResult;
  openPrice: number;
  closePrice: number;
  assetId: number;
}

export interface ClaimedSessionTrade {
  trade: SessionTradeNoticeRow;
  // the classes of the session's settled trades up to this one, in order (for its cycle and step)
  results: SessionTradeResult[];
}

const resultSql = sql<SessionTradeResult>`case when ${brokerTrades.profit} > 0 then ${literal(SessionTradeResult.Won)} when ${brokerTrades.profit} < 0 then ${literal(SessionTradeResult.Lost)} else ${literal(SessionTradeResult.Tied)} end`;
const outcomeSql = sql<DecimalString>`case when ${brokerTrades.profit} > 0 then ${tradeIntents.amount} + ${brokerTrades.profit} when ${brokerTrades.profit} < 0 then ${brokerTrades.profit} else ${tradeIntents.amount} end`;

// Claims the session's (claimed + 1)-th settled trade: one CAS raises the cursor from `claimed`,
// only while no summary was sent and that trade exists. Undefined when the CAS lost (another
// sender took it, or the cursor moved). The trade is read in the same transaction; a settled
// trade cannot change any more.
export async function claimSessionTradeNotice(
  db: Db,
  { sessionId, claimed }: { sessionId: string; claimed: number },
): Promise<ClaimedSessionTrade | undefined> {
  return db.transaction(async (tx) => {
    const [won] = await tx
      .update(tradingSessions)
      .set({ notifiedTrades: claimed + 1 })
      .where(
        and(
          eq(tradingSessions.id, sessionId),
          eq(tradingSessions.notifiedTrades, claimed),
          isNull(tradingSessions.finalNoticeSentAt),
          sql`${settledCountSql} > ${claimed}`,
        ),
      )
      .returning({ id: tradingSessions.id });
    if (won === undefined) return undefined;

    // broker_trades_settlement_check: a closed trade has its close price and profit
    const rows = await tx
      .select({
        amount: tradeIntents.amount,
        outcome: outcomeSql,
        result: resultSql,
        openPrice: brokerTrades.openPrice,
        closePrice: brokerTrades.closePrice,
        assetId: tradeIntents.assetId,
      })
      .from(tradeIntents)
      .innerJoin(brokerTrades, eq(brokerTrades.intentId, tradeIntents.id))
      .where(
        and(
          eq(tradeIntents.tradingSessionId, sessionId),
          eq(tradeIntents.status, TradeIntentStatus.Settled),
        ),
      )
      .orderBy(asc(tradeIntents.createdAt), asc(tradeIntents.id))
      .limit(claimed + 1);
    const last = rows[claimed];
    if (last === undefined)
      throw new Error(`session ${sessionId} lost its settled trade ${claimed}`);
    if (last.closePrice === null) {
      throw new Error(`settled intent of session ${sessionId} has an open broker trade`);
    }
    return {
      trade: { ...last, closePrice: last.closePrice },
      results: rows.map((row) => row.result),
    };
  });
}

// Puts a claimed trade back (`claimed + 1` → `claimed`): only for a send Telegram certainly did
// not deliver (429, a definite refusal). False when the cursor moved or the summary was sent.
export async function releaseSessionTradeNotice(
  db: Db,
  { sessionId, claimed }: { sessionId: string; claimed: number },
): Promise<boolean> {
  const rows = await db
    .update(tradingSessions)
    .set({ notifiedTrades: claimed })
    .where(
      and(
        eq(tradingSessions.id, sessionId),
        eq(tradingSessions.notifiedTrades, claimed + 1),
        isNull(tradingSessions.finalNoticeSentAt),
      ),
    )
    .returning({ id: tradingSessions.id });
  return rows.length > 0;
}

// The summary's at-most-once claim: one CAS sets final_notice_sent_at only on a finished session
// whose every settled trade was claimed first, so the summary is the last message. A finished
// session with no settled trade is granted too: the sender then sends nothing (no result to
// report, as #337 and #318).
export async function claimSessionFinalNotice(
  db: Db,
  { sessionId }: { sessionId: string },
): Promise<boolean> {
  const rows = await db
    .update(tradingSessions)
    .set({ finalNoticeSentAt: sql`now()` })
    .where(
      and(
        eq(tradingSessions.id, sessionId),
        isNull(tradingSessions.finalNoticeSentAt),
        finishedSql,
        sql`${tradingSessions.notifiedTrades} = ${settledCountSql}`,
      ),
    )
    .returning({ id: tradingSessions.id });
  return rows.length > 0;
}

// Takes the summary mark back after a send Telegram certainly did not deliver (429, a definite
// refusal), so the summary goes again: only while the card (#318), which waits for the mark, has
// not been claimed on it. False otherwise, and the summary stays sent as far as the cursor goes.
export async function releaseSessionFinalNotice(
  db: Db,
  { sessionId }: { sessionId: string },
): Promise<boolean> {
  const rows = await db
    .update(tradingSessions)
    .set({ finalNoticeSentAt: null })
    .where(
      and(
        eq(tradingSessions.id, sessionId),
        isNotNull(tradingSessions.finalNoticeSentAt),
        isNull(tradingSessions.summarySentAt),
      ),
    )
    .returning({ id: tradingSessions.id });
  return rows.length > 0;
}
