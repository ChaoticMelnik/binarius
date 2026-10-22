import type { FastifyBaseLogger } from 'fastify';
import { GrammyError } from 'grammy';
import {
  deleteRefusal,
  editRefusal,
  errorLogFields,
  H1_NOTICE_EVERY_TRADES,
  isH1Settings,
  safeParseTradingSessionSettings,
  SESSION_SUMMARY_FALLBACK_MS,
  TradingSessionStatus,
  TradingSessionStopReason,
  type H1SessionSettings,
  type TelegramHtml,
  type TradingSessionSettings,
  telegramErrorFields,
} from '@binarius/shared';
import {
  claimSessionFinalNotice,
  claimSessionTradeNotice,
  claimSessionTradeNotices,
  claimSessionWaiting,
  claimSummaryFallback,
  clearSessionWaitingMessage,
  listPendingSessionNotices,
  listSummaryFallback,
  readSessionWaitingMessage,
  recordSessionCycleMessage,
  recordSessionWaitingMessage,
  releaseSessionTradeNotice,
  releaseSessionTradeNotices,
  releaseSessionWaiting,
  releaseSummaryFallback,
  type Db,
  type PendingSessionNotice,
  type SummaryFallbackSession,
} from '@binarius/db';
import type { PairsCatalog } from '@binarius/broker-rest';
import type { ClientPush, ClientPushMessage } from '../auth/client-push';
import type { BalanceReconciler } from '../broker/balance-reconciler';
import { createSendPacer, sendFailureOf } from '../mailing/engine';
import {
  SESSION_NOTICE_MAX_ATTEMPTS,
  SESSION_NOTICE_SCAN,
  SESSION_NOTICE_SEND_PER_SECOND,
  SESSION_NOTICE_TICK_MS,
} from '../timing';
import { recordTelegramSendFailure } from '../users/telegram-delivery';
import {
  pairOf,
  sessionCycleMessage,
  sessionH1ProgressMessage,
  sessionSummaryMessage,
  sessionWaitingMessage,
  type SessionCycleNotice,
} from './session-notice-messages';
import { readFinishedSessionView } from './session-view';

// docs/bot-session.md → Trade messages (#464). One loop in the backend process sends every
// settled trade of every session to the session's owner, without sound and in the trades' order,
// and once the session is finished sets its final mark: the notices are closed, and the summary
// is the bot's one message with sound (#537). The text summary goes from here only as the
// fallback sender (serveFallback), when the bot cannot send it. A martingale cycle is one message
// (#551): its first trade sends it, every later trade of the cycle edits it to show its block
// too. Each trade is claimed by a CAS before the Telegram call (session-notice-ops.ts): a call
// whose outcome is unknown is never repeated for that trade, so a trade's block can be lost but
// a message never doubled by a retry; the next step's edit shows every block of its cycle again.
// Under them stands the waiting message with its «⏹» (#536): deleted before a new message of the
// session (a cycle message, or a relaunch's status message, #587) and sent again after it, deleted
// once the session stopped, before the final mark - unless its «⏹» stopped the session: the stop
// route then hands it to the bot, which draws its reply in place of it (#587), and the mark
// follows with no delete. The sender re-reads the waiting message's id right before each delete,
// so a message the stop route took over is not deleted (#587 round 1; the call in flight: docs
// risk 82). A restart of the bot or the backend repeats no send by a retry: the cursor, the cycle
// message and the waiting message are in trading_sessions; a block can show twice only by the
// endings docs risk 35 names (a new message whose outcome was unknown, a second sender).

export interface SessionNoticeConfig {
  tickMs: number;
  scan: number;
  perSecond: number;
  maxAttempts: number;
  // the fallback's grace for a session the bot tracks (#537)
  summaryFallbackMs: number;
}

const DEFAULT_SESSION_NOTICE_CONFIG: SessionNoticeConfig = {
  tickMs: SESSION_NOTICE_TICK_MS,
  scan: SESSION_NOTICE_SCAN,
  perSecond: SESSION_NOTICE_SEND_PER_SECOND,
  maxAttempts: SESSION_NOTICE_MAX_ATTEMPTS,
  summaryFallbackMs: SESSION_SUMMARY_FALLBACK_MS,
};

export interface SessionNoticeSenderDeps {
  db: Db;
  push: Pick<
    ClientPush,
    | 'sendSessionTrade'
    | 'editSessionTrade'
    | 'sendSessionSummary'
    | 'sendSessionWaiting'
    | 'deleteSessionWaiting'
  >;
  catalog: Pick<PairsCatalog, 'read'>;
  balance: Pick<BalanceReconciler, 'refresh'>;
  logger: FastifyBaseLogger;
  config?: Partial<SessionNoticeConfig>;
  // the tests' clock and sleep, as the mailing engine's: monotonic by default
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface SessionNoticeSender {
  tick(): Promise<void>;
  start(): void;
  // Ends the loop and waits for the tick in flight: no claim and no fallback summary's balance read
  // starts after it; the call in flight completes or times out (timing.ts).
  stop(): Promise<void>;
}

// how a trade's turn ended for the session: on to its next trade, skip the session this tick, or
// pause the whole sender (Telegram asked to wait)
type Step = 'next' | 'skip' | 'pause';

// how a delete of the waiting message ended: its id dropped (deleted, already gone, never to be
// deleted, or taken over by the stop route), kept for the next tick (outcome unknown), kept while
// the user is unreachable and the session active (#587: deleted first once the user is reachable
// again), or Telegram asked to wait
type Removal =
  { kind: 'cleared' } | { kind: 'kept' } | { kind: 'blocked' } | { kind: 'wait'; ms: number };

// The memory's mirror of waitingDueSql once a step freed the slot or left it behind; the SQL
// decides, so a wrong hint costs one refused claim or one tick.
// A claimed notice's delivery: the trade's message (#551) or an H1 session's summary (#707)
interface Delivery {
  label: 'session trade notice' | 'session h1 notice';
  key: string;
  fields: Record<string, unknown>;
  // recordSessionCycleMessage's `claimed`: the cursor stands at claimed + 1 after the claim
  claimed: number;
  // puts the claim back: only for a send Telegram certainly did not deliver
  release: () => Promise<unknown>;
}

const waitingMayGo = (session: PendingSessionNotice): boolean =>
  session.status === TradingSessionStatus.Active && !session.telegramBlocked;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createSessionNoticeSender(deps: SessionNoticeSenderDeps): SessionNoticeSender {
  const { db, push, catalog, balance, logger } = deps;
  const config = { ...DEFAULT_SESSION_NOTICE_CONFIG, ...deps.config };
  const now = deps.now ?? (() => performance.now());
  const pace = createSendPacer({
    perSecond: config.perSecond,
    now,
    sleep: deps.sleep ?? defaultSleep,
  });
  // the definite refusals of one send, by `${sessionId}:${claimed}`, `${sessionId}:summary` or
  // `${sessionId}:waiting:${slot}`, and the unknown outcomes of a waiting message's delete, by
  // `${sessionId}:delete:${messageId}`; in memory: a restart gives each send its attempts again,
  // which is a bounded retry, never a second delivery
  const attempts = new Map<string, number>();
  let stopped = false;
  let pausedUntil = -Infinity;
  let ticking: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;

  const pauseFor = (ms: number): Step => {
    pausedUntil = now() + ms;
    logger.warn({ pauseMs: ms }, 'session notices paused: Telegram asked to wait');
    return 'pause';
  };

  // a refusal counted against its send; true when it may be tried again
  const mayRetry = (key: string): boolean => {
    const count = (attempts.get(key) ?? 0) + 1;
    if (count >= config.maxAttempts) {
      attempts.delete(key);
      return false;
    }
    attempts.set(key, count);
    return true;
  };

  async function sendTrade(
    session: PendingSessionNotice,
    settings: TradingSessionSettings | null,
    claimed: number,
  ): Promise<Step> {
    const fields = { sessionId: session.sessionId, claimed };
    if (!session.telegramBlocked) await pace();
    // after the pace, so a stop during its sleep claims nothing more
    if (stopped) return 'skip';
    const claim = await claimSessionTradeNotice(db, { sessionId: session.sessionId, claimed });
    // another sender took it, or the cursor moved: the session is read again next tick
    if (claim === undefined) return 'skip';
    // nothing can be delivered (Rule 19): the trade counts as sent
    if (session.telegramBlocked) return 'next';
    let notice: SessionCycleNotice;
    try {
      notice = sessionCycleMessage(
        claim,
        settings,
        pairOf(catalog.read(), claim.trades.at(-1)?.assetId ?? 0).digits,
      );
    } catch (error) {
      // a bug: the claimed trade is not sent again, the session waits for the next tick
      logger.error({ ...fields, ...errorLogFields(error) }, 'session trade notice not built');
      return 'skip';
    }
    return deliver(session, notice, {
      label: 'session trade notice',
      key: `${session.sessionId}:${claimed}`,
      fields,
      claimed,
      release: () => releaseSessionTradeNotice(db, { sessionId: session.sessionId, claimed }),
    });
  }

  // An H1 session's summary after `due` settled trades (#707, docs/bot-session.md → An H1
  // session): the trades from the cursor to `due` claimed at once, then the summary sent as the
  // session's one message, or its edit. `due` is a multiple of H1_NOTICE_EVERY_TRADES, or the
  // settled count of a finished session, so the final mark follows.
  async function sendH1Progress(
    session: PendingSessionNotice,
    settings: H1SessionSettings,
    due: number,
  ): Promise<Step> {
    const from = session.notifiedTrades;
    const fields = { sessionId: session.sessionId, from, to: due };
    if (!session.telegramBlocked) await pace();
    if (stopped) return 'skip';
    const claim = await claimSessionTradeNotices(db, {
      sessionId: session.sessionId,
      from,
      to: due,
    });
    if (claim === undefined) return 'skip';
    session.notifiedTrades = due;
    // nothing can be delivered (Rule 19): the trades count as sent
    if (session.telegramBlocked) return 'next';
    let notice: SessionCycleNotice;
    try {
      notice = sessionH1ProgressMessage(
        claim,
        settings,
        pairOf(catalog.read(), settings.assetId).label,
        due,
      );
    } catch (error) {
      logger.error({ ...fields, ...errorLogFields(error) }, 'session h1 notice not built');
      return 'skip';
    }
    return deliver(session, notice, {
      label: 'session h1 notice',
      key: `${session.sessionId}:h1:${String(due)}`,
      fields,
      claimed: due - 1,
      release: () =>
        releaseSessionTradeNotices(db, { sessionId: session.sessionId, from, to: due }),
    });
  }

  // A claimed notice's message (#551): a new message, or the edit of the session's cycle message.
  async function deliver(
    session: PendingSessionNotice,
    notice: SessionCycleNotice,
    { label, key, fields, claimed, release }: Delivery,
  ): Promise<Step> {
    const failure = {
      session,
      label,
      key,
      fields,
      release,
      afterForbidden: () => {
        session.telegramBlocked = true;
        return Promise.resolve();
      },
    } as const;

    // A new message: the cycle message from now on, recorded only once Telegram answered with its
    // id. An id that is not a positive integer is not recorded: the next step sends anew. The
    // waiting message is deleted first (#536), on the pace this call came with, and its slot
    // freed, so whatever becomes of the new message, the waiting message is due under it; the new
    // message then takes a pace of its own. A delete that did not clear puts the claim back, so
    // no new message goes out under a waiting message that may still be there; one that found the
    // user unreachable sends nothing more (Rule 19), the claim counting as sent and the waiting
    // message's id kept, so it is deleted first once the user is reachable (#587).
    const sendNew = async (text: TelegramHtml, from: number): Promise<Step> => {
      if (session.waitingMessageId !== null) {
        const removal = await removeWaiting(session, session.waitingMessageId);
        if (removal.kind === 'blocked') return 'next';
        if (removal.kind !== 'cleared') {
          // nothing was sent: the claim goes again after the pause, or next tick after the delete
          await release();
          return removal.kind === 'wait' ? pauseFor(removal.ms) : 'skip';
        }
        // the delete found the user unreachable: nothing more is delivered (Rule 19), the claim
        // counts as sent
        if (session.telegramBlocked) return 'next';
        await pace();
      }
      let messageId: number;
      try {
        messageId = await push.sendSessionTrade(session.telegramUserId, text);
      } catch (error) {
        return sendFailed({ ...failure, method: 'sendMessage', error });
      }
      attempts.delete(key);
      if (!Number.isInteger(messageId) || messageId <= 0) {
        logger.warn(fields, `${label} not recorded: no message id`);
        return 'next';
      }
      const recorded = await recordSessionCycleMessage(db, {
        sessionId: session.sessionId,
        claimed,
        messageId,
        from,
      });
      // a new cycle message: the waiting message is due under it
      if (recorded && session.waitingMessageId === null) session.waitingDue = true;
      return 'next';
    };

    if (notice.kind === 'send') {
      if (notice.split) {
        logger.info({ ...fields, from: notice.from }, `${label} split: the cycle message is full`);
      }
      return sendNew(notice.text, notice.from);
    }
    try {
      await push.editSessionTrade(session.telegramUserId, notice.messageId, notice.text);
      attempts.delete(key);
      return 'next';
    } catch (error) {
      const refusal = error instanceof GrammyError ? editRefusal(error) : undefined;
      // the same text again (an edit whose outcome was unknown went through): shown
      if (refusal === 'shown') {
        attempts.delete(key);
        return 'next';
      }
      if (refusal === 'gone') {
        // deleted by the user or no longer editable: the same text in a new message, now
        logger.warn(
          { ...fields, ...errorLogFields(error), ...telegramErrorFields(error, 'editMessageText') },
          `${label} edited anew: the cycle message is gone`,
        );
        await pace();
        return sendNew(notice.text, notice.from);
      }
      return sendFailed({ ...failure, method: 'editMessageText', error });
    }
  }

  // How a failed send ends, as docs → Every way a send ends has it for a trade's message or
  // edit, the fallback summary and the waiting message: 403 - the user marked unreachable, then the
  // caller's own bookkeeping (a released slot, the blocked flag), the send counting as done;
  // 429 - put back and the whole sender paused; another 4xx - put back and tried again on a
  // later tick, left as sent at maxAttempts; unknown - left as the claim wrote it.
  async function sendFailed({
    session,
    label,
    key,
    method,
    fields,
    error,
    release,
    afterForbidden,
  }: {
    session: Pick<PendingSessionNotice, 'telegramUserId'>;
    label: Delivery['label'] | 'session summary' | 'session waiting message';
    key: string;
    method: 'sendMessage' | 'editMessageText';
    fields: Record<string, unknown>;
    error: unknown;
    release: () => Promise<unknown>;
    afterForbidden?: () => Promise<void>;
  }): Promise<Step> {
    const failure = sendFailureOf(error);
    const logged = { ...fields, ...errorLogFields(error), ...telegramErrorFields(error, method) };
    switch (failure.kind) {
      case 'forbidden':
        logger.warn(logged, `${label} refused: the user is unreachable`);
        await recordTelegramSendFailure({ db, log: logger }, session.telegramUserId, error);
        await afterForbidden?.();
        return 'next';
      case 'wait':
        await release();
        return pauseFor(failure.ms);
      case 'refused':
        if (mayRetry(key)) {
          logger.warn(logged, `${label} refused`);
          await release();
          return 'skip';
        }
        logger.warn(logged, `${label} dropped`);
        return 'next';
      case 'unknown':
        logger.warn(
          logged,
          method === 'editMessageText'
            ? `${label} edit outcome unknown`
            : `${label} outcome unknown`,
        );
        return 'next';
    }
  }

  // Deletes the waiting message (#536), drops its id and frees its slot, so an active session is
  // due again. Nothing is called for a user who blocked the bot (Rule 19): a stopped session's id
  // is dropped without a call, so the notices can be closed; an active session's is kept (#587),
  // so once the user is reachable the message still in the chat is deleted before anything new is
  // sent, never a second «⏹» beside it. The caller has taken the pace. The row's id is re-read
  // right before the delete (#587 round 1): the caller's value comes from the tick's list, and in
  // between the «⏹» may have stopped the session and handed the message to the bot, which draws
  // its reply in place of it; another id or NULL is not deleted. A hand-over committed during the
  // delete call itself shows as a clear that finds the id gone, logged (docs risk 82).
  async function removeWaiting(session: PendingSessionNotice, messageId: number): Promise<Removal> {
    const fields = { sessionId: session.sessionId };
    const clear = async (afterDelete = false): Promise<Removal> => {
      attempts.delete(`${session.sessionId}:delete:${String(messageId)}`);
      const own = await clearSessionWaitingMessage(db, { sessionId: session.sessionId, messageId });
      if (afterDelete && !own) {
        logger.warn(fields, 'session waiting message deleted after the stop took it over');
      }
      session.waitingMessageId = null;
      session.waitingDue = true;
      return { kind: 'cleared' };
    };
    const unreachable = (): Promise<Removal> =>
      session.status === TradingSessionStatus.Stopped
        ? clear()
        : Promise.resolve({ kind: 'blocked' });
    if (session.telegramBlocked) return unreachable();
    const row = await readSessionWaitingMessage(db, { sessionId: session.sessionId });
    if (row?.waitingMessageId !== messageId) {
      attempts.delete(`${session.sessionId}:delete:${String(messageId)}`);
      session.waitingMessageId = null;
      if (row !== undefined) session.status = row.status;
      logger.info(fields, 'session waiting message taken over: not deleted');
      return { kind: 'cleared' };
    }
    try {
      await push.deleteSessionWaiting(session.telegramUserId, messageId);
      return await clear(true);
    } catch (error) {
      const logged = {
        ...fields,
        ...errorLogFields(error),
        ...telegramErrorFields(error, 'deleteMessage'),
      };
      const refusal = error instanceof GrammyError ? deleteRefusal(error) : undefined;
      if (refusal === 'gone') {
        // the user deleted it (or a bot before #587 did on a press of its «⏹»)
        logger.info(fields, 'session waiting message already gone');
        return clear();
      }
      if (refusal === 'forbidden') {
        // older than 48 h: it stays in the chat, nothing can change that
        logger.warn(logged, 'session waiting message not deleted');
        return clear();
      }
      const failure = sendFailureOf(error);
      switch (failure.kind) {
        case 'forbidden':
          logger.warn(logged, 'session waiting message refused: the user is unreachable');
          await recordTelegramSendFailure({ db, log: logger }, session.telegramUserId, error);
          session.telegramBlocked = true;
          return unreachable();
        case 'wait':
          return failure;
        case 'refused':
          logger.warn(logged, 'session waiting message not deleted');
          return clear();
        case 'unknown':
          // a delete is idempotent: tried again next tick, a bounded number of times
          if (mayRetry(`${session.sessionId}:delete:${String(messageId)}`)) {
            logger.warn(logged, 'session waiting message delete outcome unknown');
            return { kind: 'kept' };
          }
          logger.warn(logged, 'session waiting message delete dropped');
          return clear();
      }
    }
  }

  // The stale waiting message's own step (#536): the session stopped, or a newer message of the
  // session went out under it. A message the user cannot be reached for stays (#587).
  async function deleteStaleWaiting(session: PendingSessionNotice): Promise<Step> {
    const messageId = session.waitingMessageId;
    if (messageId === null) return 'next';
    if (!session.telegramBlocked) await pace();
    if (stopped) return 'skip';
    const removal = await removeWaiting(session, messageId);
    if (removal.kind === 'wait') return pauseFor(removal.ms);
    return removal.kind === 'kept' ? 'skip' : 'next';
  }

  // The waiting message's send (#536): its slot claimed first, so at most one goes out while none
  // is live; its id recorded after. A record the CAS refuses (the session stopped meanwhile, or
  // another sender recorded first) deletes the message just sent; a failed delete leaves it in the
  // chat with its «⏹» (docs/bot-session.md, risk 81). Once recorded, the message is the sender's
  // to delete, or the bot's to draw on when its «⏹» stops the session (the stop route takes it
  // over, #587).
  async function sendWaiting(session: PendingSessionNotice): Promise<Step> {
    const fields = { sessionId: session.sessionId };
    await pace();
    if (stopped) return 'skip';
    const claim = await claimSessionWaiting(db, { sessionId: session.sessionId });
    if (claim === undefined) return 'skip';
    const key = `${session.sessionId}:waiting:${String(claim.slot)}`;
    let messageId: number;
    try {
      messageId = await push.sendSessionWaiting(
        session.telegramUserId,
        sessionWaitingMessage(session.sessionId),
      );
    } catch (error) {
      // 403: certainly not delivered, the slot is freed, due again once the user is reachable;
      // unknown: it may have been delivered, the slot stays claimed, never a second one on it
      const release = () =>
        releaseSessionWaiting(db, { sessionId: session.sessionId, slot: claim.slot });
      return sendFailed({
        session,
        label: 'session waiting message',
        key,
        method: 'sendMessage',
        fields,
        error,
        release,
        afterForbidden: async () => {
          await release();
          session.telegramBlocked = true;
        },
      });
    }
    attempts.delete(key);
    if (!Number.isInteger(messageId) || messageId <= 0) {
      logger.warn(fields, 'session waiting message not recorded: no message id');
      return 'next';
    }
    const recorded = await recordSessionWaitingMessage(db, {
      sessionId: session.sessionId,
      slot: claim.slot,
      messageId,
    });
    if (recorded) return 'next';
    await pace();
    try {
      await push.deleteSessionWaiting(session.telegramUserId, messageId);
      logger.info(fields, 'session waiting message removed: not recorded');
    } catch (error) {
      logger.warn(
        { ...fields, ...errorLogFields(error), ...telegramErrorFields(error, 'deleteMessage') },
        'session waiting message not removed',
      );
    }
    return 'next';
  }

  // The finished session's final mark (#537): every trade's message went and the waiting message
  // is gone, so the bot's summary may follow. One statement, no view read and no balance GET; a
  // session with nothing to send - no settled trade and not the no-signal stop, or a user who
  // blocked the bot (Rule 19) - closes its summary step in the same UPDATE.
  async function closeNotices(session: PendingSessionNotice): Promise<Step> {
    if (stopped) return 'skip';
    const closeSummary =
      session.telegramBlocked ||
      (session.settled === 0 && session.stopReason !== TradingSessionStopReason.NoSignalTimeout);
    await claimSessionFinalNotice(db, { sessionId: session.sessionId, closeSummary });
    return 'next';
  }

  // The fallback text summary (#537, docs/bot-session.md → The fallback): a session the bot does
  // not track (no status message) or did not claim within the grace. The same claim the bot's
  // takes, so one of the two sends; a send Telegram certainly did not deliver takes back only this
  // claim's mark. A summary that cannot be built closes the step, so the row leaves the list.
  async function serveFallback(session: SummaryFallbackSession): Promise<Step> {
    // its view reads the balance (up to TRADING_ACCESS_REFRESH_BUDGET_MS), which would add to the
    // step in flight (timing.ts)
    if (stopped) return 'skip';
    const { sessionId } = session;
    const fields = { sessionId };
    // nothing can be delivered (Rule 19): the claim alone - no view read, no balance GET
    if (session.telegramBlocked) {
      await claimSummaryFallback(db, { sessionId });
      return 'next';
    }
    const telegramUserId = String(session.telegramUserId);
    const view = await readFinishedSessionView({ db, balance }, sessionId, telegramUserId);
    if (view === undefined) return 'skip';
    let message: ClientPushMessage;
    try {
      const assetId = view.settings?.assetId ?? view.lastIntent?.assetId ?? 0;
      message = sessionSummaryMessage(view, pairOf(catalog.read(), assetId).label);
    } catch (error) {
      logger.error({ ...fields, ...errorLogFields(error) }, 'session summary not built');
      await claimSummaryFallback(db, { sessionId });
      return 'next';
    }
    await pace();
    if (stopped) return 'skip';
    const claim = await claimSummaryFallback(db, { sessionId });
    // the bot claimed first, or the row is no longer claimable
    if (claim === undefined) return 'skip';
    const key = `${sessionId}:summary`;
    try {
      await push.sendSessionSummary(session.telegramUserId, message);
      attempts.delete(key);
      return 'next';
    } catch (error) {
      return sendFailed({
        session,
        label: 'session summary',
        key,
        method: 'sendMessage',
        fields,
        error,
        release: () => releaseSummaryFallback(db, { sessionId, claimedAt: claim.claimedAt }),
      });
    }
  }

  // every trade past the cursor in order (an H1 session: its summary, when due), then the stale
  // waiting message's delete, then the final mark of a finished session or the waiting message
  // due; the first step that does not go ends the session's turn, so its later trades never
  // overtake it and the waiting message is the last message of the turn
  async function serve(session: PendingSessionNotice): Promise<Step> {
    const parsed = safeParseTradingSessionSettings(session.settings);
    const settings = parsed.success ? parsed.data : null;
    if (settings !== null && isH1Settings(settings)) {
      // every H1_NOTICE_EVERY_TRADES settled trades, and at the finish the rest (#707)
      const due = session.finished
        ? session.settled
        : Math.floor(session.settled / H1_NOTICE_EVERY_TRADES) * H1_NOTICE_EVERY_TRADES;
      if (due > session.notifiedTrades) {
        const step = await sendH1Progress(session, settings, due);
        if (step !== 'next') return step;
      }
    } else {
      for (let claimed = session.notifiedTrades; claimed < session.settled; claimed += 1) {
        const step = await sendTrade(session, settings, claimed);
        if (step !== 'next') return step;
      }
    }
    if (session.waitingStale && session.waitingMessageId !== null) {
      const step = await deleteStaleWaiting(session);
      if (step !== 'next') return step;
    }
    // a finished session's trades are all settled or rejected: none appears after the list's read
    if (session.finished) return closeNotices(session);
    return session.waitingDue && waitingMayGo(session) ? sendWaiting(session) : 'next';
  }

  async function runTick(): Promise<void> {
    if (now() < pausedUntil) return;
    const pending = await listPendingSessionNotices(db, { limit: config.scan });
    for (const session of pending) {
      if (stopped) return;
      let step: Step;
      try {
        step = await serve(session);
      } catch (error) {
        // a statement or a refresh that threw: what was claimed stays claimed, the rest waits
        logger.error(
          { sessionId: session.sessionId, ...errorLogFields(error) },
          'session notices failed for a session',
        );
        continue;
      }
      if (step === 'pause') return;
    }
    if (stopped) return;
    // the fallback after the notices, so a mark this tick set is listed on the same tick
    const fallback = await listSummaryFallback(db, {
      limit: config.scan,
      graceMs: config.summaryFallbackMs,
    });
    for (const session of fallback) {
      if (stopped) return;
      let step: Step;
      try {
        step = await serveFallback(session);
      } catch (error) {
        logger.error(
          { sessionId: session.sessionId, ...errorLogFields(error) },
          'session notices failed for a session',
        );
        continue;
      }
      if (step === 'pause') return;
    }
  }

  // a tick longer than its interval makes the next one a no-op
  function tick(): Promise<void> {
    if (stopped) return Promise.resolve();
    ticking ??= runTick()
      .catch((error: unknown) => logger.error(errorLogFields(error), 'session notice tick failed'))
      .finally(() => {
        ticking = undefined;
      });
    return ticking;
  }

  return {
    tick,
    start() {
      if (stopped || timer !== undefined) return;
      timer = setInterval(() => void tick(), config.tickMs);
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      timer = undefined;
      await ticking;
    },
  };
}
