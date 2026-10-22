import { and, asc, eq, isNull, notInArray, sql } from 'drizzle-orm';
import {
  SessionTradeResult,
  TradeIntentStatus,
  type TradeAction,
  TradingSessionStatus,
  TradingSessionStopReason,
  type DecimalString,
  type TradeMode,
} from '@binarius/shared';
import type { Db } from './client';
import { h1SessionSql } from './h1-ops';
import { brokerAccounts } from './schema/broker-accounts';
import { BrokerTradeStatus, brokerTrades } from './schema/broker-trades';
import { literal, sqlLiteralList } from './schema/columns';
import { TERMINAL_TRADE_INTENT_STATUSES, tradeIntents } from './schema/trade-intents';
import { tradingSessions } from './schema/trading-sessions';
import { users } from './schema/users';
import type { Tx } from './trade-intent-ops';

// The session notices' state (#464, docs/bot-session.md → Trade messages): the backend's sender
// sends every settled trade of a session - one message per martingale cycle, edited step by step
// (#551, below) - and, once the session is finished, closes its notices (final_notice_sent_at).
// The summary is then the bot's, one message (#537); the backend sends its text only as the
// fallback, below. Two marks: final_notice_sent_at «the notices are closed», set once and never
// cleared; summary_sent_at «the summary step is closed», won by one CAS of three writers (the
// bot's claimSessionSummary, claimSessionFinalNotice closing a session with nothing to send,
// claimSummaryFallback) and cleared only by releaseSummaryFallback on its own claimedAt.
// A session's trades are strictly sequential (one non-terminal intent per account,
// Rule 7), so settlement order is creation order and a cursor «the first k settled trades are
// claimed» is the whole state; trade_intents is only read (Rule 6). Every claim is a CAS before
// the Telegram call: at most once, never twice (the mailing engine's rule). Each operation locks
// only its own trading_sessions row, by its UPDATE, and reads trade_intents and broker_trades
// without a lock (Rule 5), as markSessionDecision and claimSessionSummary do.
//
// A martingale cycle is one message (#551): its first trade sends it, every later trade of the
// same cycle edits it. Which message that is, and from which trade it shows, is the session's
// cycle message (cycle_message_id, cycle_message_from): the claim returns it, and only
// recordSessionCycleMessage writes it, after a new message went through. An edit never changes
// it, so an edit whose outcome is unknown leaves it pointing at the message the next step edits
// again with every block.
//
// The open trade's block (#700): once a trade of the session is open at the broker, its block
// without a result goes into the cycle message, and its settlement edits the block into its
// result by the cursor above. Which open trade's block was claimed is open_notice_intent_id,
// written by claimSessionOpenNotice's CAS before the Telegram call: at most once, never repeated,
// even when its send's outcome is unknown - the trade's result still comes by the cursor. H1
// sessions (#670) get no open block.

const SETTLED = literal(TradeIntentStatus.Settled);
const ACCEPTED = literal(TradeIntentStatus.Accepted);

// A settled trade of the session: a settled intent with its broker trade (settleIntent writes
// both). The same count the view's `settled` and the backfill (0050) take.
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

// The session's open trade (#700): its accepted intent whose broker trade is open - markIntentAccepted
// writes both in one transaction. At most one by trade_intents_active_account_idx (Rule 7); NULL
// when none. One fragment for the list and the claim.
const openTradeSql = sql<string | null>`(
  select ${tradeIntents.id} from ${tradeIntents}
    join ${brokerTrades} on ${brokerTrades.intentId} = ${tradeIntents.id}
   where ${tradeIntents.tradingSessionId} = ${tradingSessions.id}
     and ${tradeIntents.status} = ${ACCEPTED}
     and ${brokerTrades.status} = ${literal(BrokerTradeStatus.Open)}
   order by ${tradeIntents.createdAt} desc, ${tradeIntents.id} desc
   limit 1
)`;

// The list's filter (#660): a settled trade past the cursor, the open trade's block still to be
// claimed (an H1 session gets none - the sender's isH1Settings, this its SQL twin) or the finish,
// as one aggregate over the session's intents - one index scan per candidate instead of a
// subquery per fact. The select list keeps settledCountSql, openTradeSql and finishedSql: the
// sender reads them, and the claims decide. At most one open intent per session (Rule 7), so «an
// open trade other than the claimed one exists» is «the open trade is not the claimed one». Over
// no intent at all the aggregate is one row: count 0, bool_or NULL - a stopped session without
// intents is finished, as finishedSql's not exists has it.
const sessionNoticeDueSql = sql<boolean>`(
  select count(*) filter (where ${tradeIntents.status} = ${SETTLED} and ${brokerTrades.intentId} is not null) > ${tradingSessions.notifiedTrades}
      or (${tradingSessions.status} = ${literal(TradingSessionStatus.Stopped)}
          and not coalesce(bool_or(${tradeIntents.status} not in (${sqlLiteralList(TERMINAL_TRADE_INTENT_STATUSES)})), false))
      or (coalesce(bool_or(${tradeIntents.status} = ${ACCEPTED} and ${brokerTrades.status} = ${literal(BrokerTradeStatus.Open)}
                           and ${tradeIntents.id} is distinct from ${tradingSessions.openNoticeIntentId}), false)
          and not coalesce(${h1SessionSql}, false))
    from ${tradeIntents} left join ${brokerTrades} on ${brokerTrades.intentId} = ${tradeIntents.id}
   where ${tradeIntents.tradingSessionId} = ${tradingSessions.id}
)`;

// The waiting message (#536, docs/bot-session.md → The waiting message). Its slot is the latest
// message of the session it stands under (#587): the cycle message or the bot's recorded status
// message, whichever is newer (Telegram's message ids grow within a chat), 0 before either. An
// edit of a step keeps it; a new cycle message or a relaunch's status message leaves it behind;
// the waiting message's delete, or its hand-over to the bot at a stop by its «⏹», frees it. The
// fragments below alone decide what the sender does with it.
const sessionSlotSql = sql<number>`greatest(coalesce(${tradingSessions.cycleMessageId}, 0), coalesce(${tradingSessions.statusMessageId}, 0))`;

// The fragment both the list and the claim take: an active session with no live waiting message,
// whose slot was not claimed yet, under a message of the session - the bot's recorded status
// message (#567) or a claimed trade, whose message goes only after the session's, recorded or not
// - so the waiting message never stands above the session's message.
const waitingClaimableSql = sql`(${tradingSessions.status} = ${literal(TradingSessionStatus.Active)} and ${tradingSessions.waitingMessageId} is null and ${tradingSessions.waitingAfterMessage} is distinct from ${sessionSlotSql} and (${tradingSessions.statusMessageId} is not null or ${tradingSessions.notifiedTrades} > 0))`;

// due: a waiting message is to be sent; nothing goes to a user who blocked the bot (Rule 19)
const waitingDueSql = sql<boolean>`(${waitingClaimableSql} and ${users.telegramBlockedAt} is null)`;

// stale: the live waiting message is to be deleted - the session stopped, or a newer message of
// the session went out under it and the user can be reached: a blocked user's active session keeps
// its waiting message's id until the user is reachable again (#587), so it is not listed each tick
const waitingStaleSql = sql<boolean>`(${tradingSessions.waitingMessageId} is not null and (${tradingSessions.status} = ${literal(TradingSessionStatus.Stopped)} or (${tradingSessions.waitingAfterMessage} <> ${sessionSlotSql} and ${users.telegramBlockedAt} is null)))`;

export interface PendingSessionNotice {
  sessionId: string;
  mode: TradeMode;
  status: TradingSessionStatus;
  // the final mark decides by it whether the bot has a summary to send (#537)
  stopReason: TradingSessionStopReason | null;
  // raw: the sender parses it
  settings: unknown;
  // the cursor: settled trades claimed so far
  notifiedTrades: number;
  settled: number;
  // the session's open trade's intent, and the intent whose open block was claimed (#700)
  openIntentId: string | null;
  openNoticeIntentId: string | null;
  finished: boolean;
  // the owner's, by the session's account: no id comes from outside (Rule 13)
  telegramUserId: bigint;
  // users.telegram_blocked_at is set: nothing can be delivered (Rule 19)
  telegramBlocked: boolean;
  // the live waiting message's id, NULL when there is none
  waitingMessageId: number | null;
  waitingDue: boolean;
  waitingStale: boolean;
}

// The sessions with something to send: notices not closed yet, and a settled trade past the
// cursor, an open trade's block to claim (#700), a finished session, or a waiting message to send
// or to delete. Oldest first, on
// trading_sessions_notice_pending_idx. `exclude`: the sessions the sender holds back after a turn
// that threw (#660), ids from its own lists.
export async function listPendingSessionNotices(
  db: Db,
  { limit, exclude }: { limit: number; exclude: readonly string[] },
): Promise<PendingSessionNotice[]> {
  const rows = await db
    .select({
      sessionId: tradingSessions.id,
      mode: tradingSessions.mode,
      settings: sql<unknown>`${tradingSessions.settings}`,
      notifiedTrades: tradingSessions.notifiedTrades,
      settled: settledCountSql,
      openIntentId: openTradeSql,
      openNoticeIntentId: tradingSessions.openNoticeIntentId,
      finished: finishedSql,
      telegramUserId: users.telegramUserId,
      telegramBlocked: sql<boolean>`${users.telegramBlockedAt} is not null`,
      status: tradingSessions.status,
      stopReason: tradingSessions.stopReason,
      waitingMessageId: tradingSessions.waitingMessageId,
      waitingDue: waitingDueSql,
      waitingStale: waitingStaleSql,
    })
    .from(tradingSessions)
    .innerJoin(brokerAccounts, eq(brokerAccounts.id, tradingSessions.brokerAccountId))
    .innerJoin(users, eq(users.id, brokerAccounts.userId))
    .where(
      and(
        isNull(tradingSessions.finalNoticeSentAt),
        exclude.length === 0 ? undefined : notInArray(tradingSessions.id, [...exclude]),
        sql`(${sessionNoticeDueSql} or ${waitingDueSql} or ${waitingStaleSql})`,
      ),
    )
    .orderBy(asc(tradingSessions.createdAt), asc(tradingSessions.id))
    .limit(limit);
  return rows;
}

// A settled trade as its message needs it. `outcome` is the figure after «→»: a win's stake plus
// its profit, what came back to the account (#684, reverting #539), a loss's or a tie's profit; the
// lines no longer add up to the session's result, which stays the sum of the profits (#337).
// `result` the class by the sign of the profit, as the view's counters compare it. The stake is the
// intent's amount, equal to the broker trade's (Rule 15).
export interface SessionTradeNoticeRow {
  amount: DecimalString;
  outcome: DecimalString;
  result: SessionTradeResult;
  openPrice: number;
  closePrice: number;
  assetId: number;
}

// The message the session's cycle is shown in: Telegram's message_id, and the index of the first
// trade it shows (in the cursor's order, from 0), settled or open: an open trade's block takes the
// index its trade gets once it settles (#700)
export interface SessionCycleMessage {
  messageId: number;
  from: number;
}

export interface ClaimedSessionTrade {
  // the session's settled trades up to the claimed one, in order: the claimed one is the last;
  // their classes give its cycle and step, and the trades of its cycle are its message's blocks
  trades: SessionTradeNoticeRow[];
  cycleMessage: SessionCycleMessage | null;
}

// a settled trade's class by the sign of its profit; the trade log's steps read it too (#666)
export const tradeResultSql = sql<SessionTradeResult>`case when ${brokerTrades.profit} > 0 then ${literal(SessionTradeResult.Won)} when ${brokerTrades.profit} < 0 then ${literal(SessionTradeResult.Lost)} else ${literal(SessionTradeResult.Tied)} end`;

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
      .returning({
        messageId: tradingSessions.cycleMessageId,
        from: tradingSessions.cycleMessageFrom,
      });
    if (won === undefined) return undefined;

    return {
      trades: await readSettledTrades(tx, sessionId, claimed + 1),
      cycleMessage: cycleMessageOf(won),
    };
  });
}

// The session's first `count` settled trades in the cursor's order, in the claim's transaction;
// a settled trade cannot change any more.
async function readSettledTrades(
  tx: Tx,
  sessionId: string,
  count: number,
): Promise<SessionTradeNoticeRow[]> {
  // broker_trades_settlement_check: a closed trade has its close price and profit
  const rows = await tx
    .select({
      amount: tradeIntents.amount,
      outcome: sql<DecimalString>`case when ${brokerTrades.profit} > 0 then ${tradeIntents.amount} + ${brokerTrades.profit} else ${brokerTrades.profit} end`,
      result: tradeResultSql,
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
    .limit(count);
  if (rows.length !== count) {
    throw new Error(`session ${sessionId} lost its settled trade ${count - 1}`);
  }
  return rows.map(({ closePrice, ...row }) => {
    if (closePrice === null) {
      throw new Error(`settled intent of session ${sessionId} has an open broker trade`);
    }
    return { ...row, closePrice };
  });
}

// trading_sessions_cycle_message_pair_check: both or neither
const cycleMessageOf = (row: {
  messageId: number | null;
  from: number | null;
}): SessionCycleMessage | null =>
  row.messageId === null || row.from === null ? null : { messageId: row.messageId, from: row.from };

// The open trade as its block needs it (#700): the intent's stake, direction and asset, the
// broker trade's open price.
export interface SessionOpenNoticeRow {
  amount: DecimalString;
  action: TradeAction;
  openPrice: number;
  assetId: number;
}

export interface ClaimedSessionOpen {
  // the session's settled trades, all claimed: the open trade's block stands below theirs
  trades: SessionTradeNoticeRow[];
  open: SessionOpenNoticeRow;
  cycleMessage: SessionCycleMessage | null;
}

// Claims the open trade's block (#700): one CAS marks `intentId` on the session, only while it is
// not marked already, the notices are not closed, the session has `settled` settled trades and
// the cursor claimed them all (so the block stands below all their blocks), and `intentId` is
// still the session's open trade. Undefined when the CAS lost: another sender, the cursor moved, or the trade settled since
// the list - its result block then comes by the cursor. The rows are read in the same transaction.
export async function claimSessionOpenNotice(
  db: Db,
  { sessionId, intentId, settled }: { sessionId: string; intentId: string; settled: number },
): Promise<ClaimedSessionOpen | undefined> {
  return db.transaction(async (tx) => {
    const [won] = await tx
      .update(tradingSessions)
      .set({ openNoticeIntentId: intentId })
      .where(
        and(
          eq(tradingSessions.id, sessionId),
          sql`${tradingSessions.openNoticeIntentId} is distinct from ${intentId}`,
          isNull(tradingSessions.finalNoticeSentAt),
          eq(tradingSessions.notifiedTrades, settled),
          sql`${settledCountSql} = ${settled}`,
          sql`${openTradeSql} = ${intentId}`,
        ),
      )
      .returning({
        messageId: tradingSessions.cycleMessageId,
        from: tradingSessions.cycleMessageFrom,
      });
    if (won === undefined) return undefined;

    const [open] = await tx
      .select({
        amount: tradeIntents.amount,
        action: tradeIntents.action,
        openPrice: brokerTrades.openPrice,
        assetId: tradeIntents.assetId,
      })
      .from(tradeIntents)
      .innerJoin(brokerTrades, eq(brokerTrades.intentId, tradeIntents.id))
      .where(eq(tradeIntents.id, intentId));
    if (open === undefined) throw new Error(`session ${sessionId} lost its open trade ${intentId}`);
    return {
      trades: settled === 0 ? [] : await readSettledTrades(tx, sessionId, settled),
      open,
      cycleMessage: cycleMessageOf(won),
    };
  });
}

// Takes the open block's claim back after a send Telegram certainly did not deliver (429, a
// definite refusal), so the block goes again while its trade is open: only its own intent. False
// otherwise.
export async function releaseSessionOpenNotice(
  db: Db,
  { sessionId, intentId }: { sessionId: string; intentId: string },
): Promise<boolean> {
  const rows = await db
    .update(tradingSessions)
    .set({ openNoticeIntentId: null })
    .where(and(eq(tradingSessions.id, sessionId), eq(tradingSessions.openNoticeIntentId, intentId)))
    .returning({ id: tradingSessions.id });
  return rows.length > 0;
}

// Records the new message a claimed block was sent in as the session's cycle message (#551): one
// CAS, only while the cursor still stands where the claim left it - `cursor`, right after a
// claimed trade (`claimed + 1`), or the open block's `settled` with its intent still marked
// (`openIntentId`, #700) - and no summary was sent, so a sender whose claim was overtaken never
// moves it. Called only after Telegram answered the send with the message's id. False when
// refused.
export async function recordSessionCycleMessage(
  db: Db,
  {
    sessionId,
    cursor,
    openIntentId,
    messageId,
    from,
  }: {
    sessionId: string;
    cursor: number;
    openIntentId?: string;
    messageId: number;
    from: number;
  },
): Promise<boolean> {
  const rows = await db
    .update(tradingSessions)
    .set({ cycleMessageId: messageId, cycleMessageFrom: from })
    .where(
      and(
        eq(tradingSessions.id, sessionId),
        eq(tradingSessions.notifiedTrades, cursor),
        isNull(tradingSessions.finalNoticeSentAt),
        openIntentId === undefined
          ? undefined
          : eq(tradingSessions.openNoticeIntentId, openIntentId),
      ),
    )
    .returning({ id: tradingSessions.id });
  return rows.length > 0;
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

// An H1 session's summary (#707, docs/bot-session.md → An H1 session): the first `to` settled
// trades in the cursor's order, counted by class, and their profit summed in numeric (Rule 2)
export interface SessionTradeTotals {
  won: number;
  lost: number;
  tied: number;
  result: DecimalString;
}

export interface ClaimedSessionTrades {
  totals: SessionTradeTotals;
  cycleMessage: SessionCycleMessage | null;
}

// Claims the settled trades from + 1 .. to of a session at once (#707): one CAS raises the cursor
// from `from` to `to`, only while no summary was sent and `to` trades are settled; the batch twin
// of claimSessionTradeNotice for the H1 summary, edited every H1_NOTICE_EVERY_TRADES trades.
// Undefined when the CAS lost. The totals are read in the same transaction.
export async function claimSessionTradeNotices(
  db: Db,
  { sessionId, from, to }: { sessionId: string; from: number; to: number },
): Promise<ClaimedSessionTrades | undefined> {
  return db.transaction(async (tx) => {
    const [won] = await tx
      .update(tradingSessions)
      .set({ notifiedTrades: to })
      .where(
        and(
          eq(tradingSessions.id, sessionId),
          eq(tradingSessions.notifiedTrades, from),
          isNull(tradingSessions.finalNoticeSentAt),
          sql`${settledCountSql} >= ${to}`,
        ),
      )
      .returning({
        messageId: tradingSessions.cycleMessageId,
        from: tradingSessions.cycleMessageFrom,
      });
    if (won === undefined) return undefined;

    const first = tx
      .select({ profit: brokerTrades.profit })
      .from(tradeIntents)
      .innerJoin(brokerTrades, eq(brokerTrades.intentId, tradeIntents.id))
      .where(
        and(
          eq(tradeIntents.tradingSessionId, sessionId),
          eq(tradeIntents.status, TradeIntentStatus.Settled),
        ),
      )
      .orderBy(asc(tradeIntents.createdAt), asc(tradeIntents.id))
      .limit(to)
      .as('first');
    const [totals] = await tx
      .select({
        trades: sql<number>`count(*)::int`,
        won: sql<number>`(count(*) filter (where ${first.profit} > 0))::int`,
        lost: sql<number>`(count(*) filter (where ${first.profit} < 0))::int`,
        tied: sql<number>`(count(*) filter (where ${first.profit} = 0))::int`,
        result: sql<DecimalString>`coalesce(sum(${first.profit}), 0)::text`,
      })
      .from(first);
    if (totals === undefined || totals.trades !== to) {
      throw new Error(`session ${sessionId} lost a settled trade of the first ${to}`);
    }
    // trading_sessions_cycle_message_pair_check: both or neither
    const cycleMessage =
      won.messageId === null || won.from === null
        ? null
        : { messageId: won.messageId, from: won.from };
    return {
      totals: { won: totals.won, lost: totals.lost, tied: totals.tied, result: totals.result },
      cycleMessage,
    };
  });
}

// Puts a claimed batch back (`to` → `from`): only for a send Telegram certainly did not deliver.
// False when the cursor moved or the summary was sent.
export async function releaseSessionTradeNotices(
  db: Db,
  { sessionId, from, to }: { sessionId: string; from: number; to: number },
): Promise<boolean> {
  const rows = await db
    .update(tradingSessions)
    .set({ notifiedTrades: from })
    .where(
      and(
        eq(tradingSessions.id, sessionId),
        eq(tradingSessions.notifiedTrades, to),
        isNull(tradingSessions.finalNoticeSentAt),
      ),
    )
    .returning({ id: tradingSessions.id });
  return rows.length > 0;
}

// Closes the session's notices (#537): one CAS sets final_notice_sent_at only on a finished
// session whose every settled trade was claimed first and whose waiting message is gone (#536),
// so the bot's summary comes after every message of the backend. `closeSummary` - the session has
// nothing to send (no settled trade and not the no-signal stop, or a user who blocked the bot,
// Rule 19) - closes the summary step in the same UPDATE: a process dying between two statements
// would leave a row nobody can claim at the head of the fallback's list.
export async function claimSessionFinalNotice(
  db: Db,
  { sessionId, closeSummary }: { sessionId: string; closeSummary: boolean },
): Promise<boolean> {
  const rows = await db
    .update(tradingSessions)
    .set({
      finalNoticeSentAt: sql`now()`,
      ...(closeSummary ? { summarySentAt: sql`now()` } : {}),
    })
    .where(
      and(
        eq(tradingSessions.id, sessionId),
        isNull(tradingSessions.finalNoticeSentAt),
        finishedSql,
        sql`${tradingSessions.notifiedTrades} = ${settledCountSql}`,
        isNull(tradingSessions.waitingMessageId),
      ),
    )
    .returning({ id: tradingSessions.id });
  return rows.length > 0;
}

// The fallback's claimable rows (#537, docs/bot-session.md → The fallback): notices closed, the
// summary step open, and a summary to send - a settled trade or the no-signal stop. One fragment
// for the list and the claim.
const summaryFallbackClaimableSql = sql`(${tradingSessions.finalNoticeSentAt} is not null and ${tradingSessions.summarySentAt} is null and (exists (
  select 1 from ${tradeIntents}
    join ${brokerTrades} on ${brokerTrades.intentId} = ${tradeIntents.id}
   where ${tradeIntents.tradingSessionId} = ${tradingSessions.id}
     and ${tradeIntents.status} = ${SETTLED}
) or ${tradingSessions.stopReason} = ${literal(TradingSessionStopReason.NoSignalTimeout)}))`;

export interface SummaryFallbackSession {
  sessionId: string;
  // the owner's, by the session's account: no id comes from outside (Rule 13)
  telegramUserId: bigint;
  // users.telegram_blocked_at is set: nothing can be delivered (Rule 19)
  telegramBlocked: boolean;
}

// The sessions whose summary the backend sends as a text (#537): claimable, and either without a
// status message the bot could track (status_message_id NULL: at once) or with the mark older
// than `graceMs` by the database's clock, the bot not having claimed it. Oldest mark first, on
// trading_sessions_summary_fallback_idx. Not scoped by a user: the sender's internal list.
// `exclude` as listPendingSessionNotices's (#660).
export async function listSummaryFallback(
  db: Db,
  { limit, graceMs, exclude }: { limit: number; graceMs: number; exclude: readonly string[] },
): Promise<SummaryFallbackSession[]> {
  return db
    .select({
      sessionId: tradingSessions.id,
      telegramUserId: users.telegramUserId,
      telegramBlocked: sql<boolean>`${users.telegramBlockedAt} is not null`,
    })
    .from(tradingSessions)
    .innerJoin(brokerAccounts, eq(brokerAccounts.id, tradingSessions.brokerAccountId))
    .innerJoin(users, eq(users.id, brokerAccounts.userId))
    .where(
      and(
        summaryFallbackClaimableSql,
        exclude.length === 0 ? undefined : notInArray(tradingSessions.id, [...exclude]),
        sql`(${tradingSessions.statusMessageId} is null or ${tradingSessions.finalNoticeSentAt} < now() - make_interval(secs => ${graceMs / 1000}))`,
      ),
    )
    .orderBy(asc(tradingSessions.finalNoticeSentAt), asc(tradingSessions.id))
    .limit(limit);
}

// The fallback's at-most-once claim before the send: one CAS on a claimable row. Its claimedAt -
// the release's key - or undefined when the CAS lost (the bot claimed first, or nothing to send).
// claimedAt is the column's text, not a Date: a Date holds milliseconds, the column microseconds,
// and the release compares them exactly.
export async function claimSummaryFallback(
  db: Db,
  { sessionId }: { sessionId: string },
): Promise<{ claimedAt: string } | undefined> {
  const [won] = await db
    .update(tradingSessions)
    .set({ summarySentAt: sql`now()` })
    .where(and(eq(tradingSessions.id, sessionId), summaryFallbackClaimableSql))
    .returning({ claimedAt: sql<string | null>`${tradingSessions.summarySentAt}::text` });
  if (won === undefined) return undefined;
  if (won.claimedAt === null) throw new Error(`session ${sessionId} claimed no summary mark`);
  return { claimedAt: won.claimedAt };
}

// Takes the fallback's claim back after a send Telegram certainly did not deliver (429, a definite
// refusal), so the text goes again: only the mark its own claim wrote. False otherwise.
export async function releaseSummaryFallback(
  db: Db,
  { sessionId, claimedAt }: { sessionId: string; claimedAt: string },
): Promise<boolean> {
  const rows = await db
    .update(tradingSessions)
    .set({ summarySentAt: null })
    .where(
      and(
        eq(tradingSessions.id, sessionId),
        sql`${tradingSessions.summarySentAt} = ${claimedAt}::timestamptz`,
      ),
    )
    .returning({ id: tradingSessions.id });
  return rows.length > 0;
}

// Claims the waiting message's slot before the send (#536): one CAS on a claimable session sets
// the slot to its latest message, so at most one waiting message of unknown fate exists:
// none goes out while one is live or its slot claimed on the session's latest message (cycle or
// status). The slot, or undefined when the CAS lost (another sender, or nothing to claim).
export async function claimSessionWaiting(
  db: Db,
  { sessionId }: { sessionId: string },
): Promise<{ slot: number } | undefined> {
  const [won] = await db
    .update(tradingSessions)
    .set({ waitingAfterMessage: sessionSlotSql })
    .where(
      and(
        eq(tradingSessions.id, sessionId),
        waitingClaimableSql,
        isNull(tradingSessions.finalNoticeSentAt),
      ),
    )
    .returning({ slot: tradingSessions.waitingAfterMessage });
  if (won === undefined) return undefined;
  if (won.slot === null) throw new Error(`session ${sessionId} claimed no waiting slot`);
  return { slot: won.slot };
}

// Records the sent waiting message's id on its slot: one CAS, only while the slot is still the
// claimed one without an id and the session is active. False when refused: the sender then
// deletes its own message.
export async function recordSessionWaitingMessage(
  db: Db,
  { sessionId, slot, messageId }: { sessionId: string; slot: number; messageId: number },
): Promise<boolean> {
  const rows = await db
    .update(tradingSessions)
    .set({ waitingMessageId: messageId })
    .where(
      and(
        eq(tradingSessions.id, sessionId),
        eq(tradingSessions.waitingAfterMessage, slot),
        isNull(tradingSessions.waitingMessageId),
        eq(tradingSessions.status, TradingSessionStatus.Active),
      ),
    )
    .returning({ id: tradingSessions.id });
  return rows.length > 0;
}

// Frees a claimed slot after a send Telegram certainly did not deliver (429, a definite refusal),
// so the waiting message goes again. False when an id was recorded or the slot moved.
export async function releaseSessionWaiting(
  db: Db,
  { sessionId, slot }: { sessionId: string; slot: number },
): Promise<boolean> {
  const rows = await db
    .update(tradingSessions)
    .set({ waitingAfterMessage: null })
    .where(
      and(
        eq(tradingSessions.id, sessionId),
        eq(tradingSessions.waitingAfterMessage, slot),
        isNull(tradingSessions.waitingMessageId),
      ),
    )
    .returning({ id: tradingSessions.id });
  return rows.length > 0;
}

// Drops the waiting message's id after its delete (or once it cannot be deleted) and frees its
// slot: one CAS on that id. An active session is due again, whatever becomes of the cycle message
// sent next. False when the id is not that one. The sender calls it, and the stop route on a 409
// for the message its body handed over (#587), after the owner-scoped read.
export async function clearSessionWaitingMessage(
  db: Db,
  { sessionId, messageId }: { sessionId: string; messageId: number },
): Promise<boolean> {
  const rows = await db
    .update(tradingSessions)
    .set({ waitingMessageId: null, waitingAfterMessage: null })
    .where(and(eq(tradingSessions.id, sessionId), eq(tradingSessions.waitingMessageId, messageId)))
    .returning({ id: tradingSessions.id });
  return rows.length > 0;
}

// The sender's check right before a Telegram call on the waiting message: a value read earlier
// may have been taken over by the stop route since (#587 round 1). No lock: a read of the
// session's own row, as the list's.
export async function readSessionWaitingMessage(
  db: Db,
  { sessionId }: { sessionId: string },
): Promise<{ waitingMessageId: number | null; status: TradingSessionStatus } | undefined> {
  const [row] = await db
    .select({ waitingMessageId: tradingSessions.waitingMessageId, status: tradingSessions.status })
    .from(tradingSessions)
    .where(eq(tradingSessions.id, sessionId));
  return row;
}
