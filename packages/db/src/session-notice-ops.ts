import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import {
  SessionTradeResult,
  TradeIntentStatus,
  TradingSessionStatus,
  TradingSessionStopReason,
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

const SETTLED = literal(TradeIntentStatus.Settled);

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
// cursor, a finished session, or a waiting message to send or to delete. Oldest first, on
// trading_sessions_notice_pending_idx.
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
        sql`(${settledCountSql} > ${tradingSessions.notifiedTrades} or ${finishedSql} or ${waitingDueSql} or ${waitingStaleSql})`,
      ),
    )
    .orderBy(asc(tradingSessions.createdAt), asc(tradingSessions.id))
    .limit(limit);
  return rows;
}

// A settled trade as its message needs it. `outcome` is the figure after «→»: the broker trade's
// profit (#539), so the lines of a session add up to its result; `result` the class by the sign
// of the profit, as the view's counters compare it. The stake is the intent's amount, equal to the
// broker trade's (Rule 15).
export interface SessionTradeNoticeRow {
  amount: DecimalString;
  outcome: DecimalString;
  result: SessionTradeResult;
  openPrice: number;
  closePrice: number;
  assetId: number;
}

// The message the session's cycle is shown in: Telegram's message_id, and the index of the first
// settled trade it shows (in the cursor's order, from 0)
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

    // broker_trades_settlement_check: a closed trade has its close price and profit
    const rows = await tx
      .select({
        amount: tradeIntents.amount,
        outcome: sql<DecimalString>`${brokerTrades.profit}`,
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
      .limit(claimed + 1);
    if (rows.length !== claimed + 1) {
      throw new Error(`session ${sessionId} lost its settled trade ${claimed}`);
    }
    const trades = rows.map(({ closePrice, ...row }) => {
      if (closePrice === null) {
        throw new Error(`settled intent of session ${sessionId} has an open broker trade`);
      }
      return { ...row, closePrice };
    });
    // trading_sessions_cycle_message_pair_check: both or neither
    const cycleMessage =
      won.messageId === null || won.from === null
        ? null
        : { messageId: won.messageId, from: won.from };
    return { trades, cycleMessage };
  });
}

// Records the new message the claimed trade was sent in as the session's cycle message (#551):
// one CAS, only while the cursor still stands right after that trade (`claimed + 1`) and no
// summary was sent, so a sender whose claim was overtaken never moves it. Called only after
// Telegram answered the send with the message's id. False when refused.
export async function recordSessionCycleMessage(
  db: Db,
  {
    sessionId,
    claimed,
    messageId,
    from,
  }: { sessionId: string; claimed: number; messageId: number; from: number },
): Promise<boolean> {
  const rows = await db
    .update(tradingSessions)
    .set({ cycleMessageId: messageId, cycleMessageFrom: from })
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
export async function listSummaryFallback(
  db: Db,
  { limit, graceMs }: { limit: number; graceMs: number },
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
