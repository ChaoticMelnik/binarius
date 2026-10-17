import type { FastifyBaseLogger } from 'fastify';
import { GrammyError } from 'grammy';
import {
  deleteRefusal,
  editRefusal,
  errorLogFields,
  safeParseTradingSessionSettings,
  TradingSessionStatus,
  TradingSessionStopReason,
  type TelegramHtml,
  type TradingSessionSettings,
  telegramErrorFields,
} from '@binarius/shared';
import {
  claimSessionFinalNotice,
  claimSessionTradeNotice,
  claimSessionWaiting,
  clearSessionWaitingMessage,
  listPendingSessionNotices,
  recordSessionCycleMessage,
  recordSessionWaitingMessage,
  releaseSessionFinalNotice,
  releaseSessionTradeNotice,
  releaseSessionWaiting,
  type Db,
  type PendingSessionNotice,
} from '@binarius/db';
import type { PairsCatalog } from '@binarius/broker-rest';
import type { ClientPush, ClientPushMessage } from '../auth/client-push';
import type { BalanceReconciler } from '../broker/balance-reconciler';
import { createSendPacer } from '../mailing/engine';
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
  sessionSummaryMessage,
  sessionWaitingMessage,
  type SessionCycleNotice,
} from './session-notice-messages';
import { readFinishedSessionView } from './session-view';

// docs/bot-session.md → Trade messages (#464). One loop in the backend process sends every
// settled trade of every session to the session's owner, without sound and in the trades' order,
// and once the session is finished one summary with sound. A martingale cycle is one message
// (#551): its first trade sends it, every later trade of the cycle edits it to show its block
// too. Each trade is claimed by a CAS before the Telegram call (session-notice-ops.ts): a call
// whose outcome is unknown is never repeated for that trade, so a trade's block can be lost but
// a message never doubled by a retry; the next step's edit shows every block of its cycle again.
// Under them stands the waiting message with its «⏹» (#536): deleted before a new message of the
// session (a cycle message, or a relaunch's status message, #587) and sent again after it, deleted
// once the session stopped, before the summary - unless its «⏹» stopped the session: the stop
// route then hands it to the bot, which draws its reply in place of it (#587), and the summary
// follows with no delete. The bot's restart and a backend restart send nothing twice: the cursor,
// the cycle message and the waiting message are in trading_sessions.

export interface SessionNoticeConfig {
  tickMs: number;
  scan: number;
  perSecond: number;
  maxAttempts: number;
}

const DEFAULT_SESSION_NOTICE_CONFIG: SessionNoticeConfig = {
  tickMs: SESSION_NOTICE_TICK_MS,
  scan: SESSION_NOTICE_SCAN,
  perSecond: SESSION_NOTICE_SEND_PER_SECOND,
  maxAttempts: SESSION_NOTICE_MAX_ATTEMPTS,
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
  // Ends the loop and waits for the tick in flight: no claim and no summary's balance read starts
  // after it; the call in flight completes or times out (timing.ts).
  stop(): Promise<void>;
}

// What a send's failure means: Telegram refused it for good to this user (403), asked to wait
// (429, not delivered), refused this message (another 4xx, not delivered), or left the outcome
// unknown (5xx, a timeout, the transport): it may have been delivered.
type Failure =
  { kind: 'forbidden' } | { kind: 'wait'; ms: number } | { kind: 'refused' } | { kind: 'unknown' };

function failureOf(error: unknown): Failure {
  if (!(error instanceof GrammyError) || error.error_code >= 500) return { kind: 'unknown' };
  if (error.error_code === 403) return { kind: 'forbidden' };
  if (error.error_code === 429) {
    return { kind: 'wait', ms: (error.parameters.retry_after ?? 1) * 1000 };
  }
  return { kind: 'refused' };
}

// how a trade's turn ended for the session: on to its next trade, skip the session this tick, or
// pause the whole sender (Telegram asked to wait)
type Step = 'next' | 'skip' | 'pause';

// how a delete of the waiting message ended: its id dropped (deleted, already gone, or never to
// be deleted), kept for the next tick (outcome unknown), kept while the user is unreachable and
// the session active (#587: deleted first once the user is reachable again), or Telegram asked to
// wait
type Removal =
  { kind: 'cleared' } | { kind: 'kept' } | { kind: 'blocked' } | { kind: 'wait'; ms: number };

// The memory's mirror of waitingDueSql once a step freed the slot or left it behind; the SQL
// decides, so a wrong hint costs one refused claim or one tick.
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
    const key = `${session.sessionId}:${claimed}`;
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

    // A new message: the cycle message from now on, recorded only once Telegram answered with its
    // id. An id that is not a positive integer is not recorded: the next step sends anew. The
    // waiting message is deleted first (#536), on the pace this call came with, and its slot
    // freed, so whatever becomes of the new message, the waiting message is due under it; the new
    // message then takes a pace of its own. A delete that did not clear puts the trade back, so
    // no new message goes out under a waiting message that may still be there; one that found the
    // user unreachable sends nothing more (Rule 19), the trade counting as sent and the waiting
    // message's id kept, so it is deleted first once the user is reachable (#587).
    const sendNew = async (text: TelegramHtml, from: number): Promise<Step> => {
      if (session.waitingMessageId !== null) {
        const removal = await removeWaiting(session, session.waitingMessageId);
        if (removal.kind === 'blocked') return 'next';
        if (removal.kind !== 'cleared') {
          // nothing was sent: the trade goes again after the pause, or next tick after the delete
          await releaseSessionTradeNotice(db, { sessionId: session.sessionId, claimed });
          return removal.kind === 'wait' ? pauseFor(removal.ms) : 'skip';
        }
        // the delete found the user unreachable: nothing more is delivered (Rule 19), the trade
        // counts as sent
        if (session.telegramBlocked) return 'next';
        await pace();
      }
      let messageId: number;
      try {
        messageId = await push.sendSessionTrade(session.telegramUserId, text);
      } catch (error) {
        return failed(session, claimed, error, 'sendMessage');
      }
      attempts.delete(key);
      if (!Number.isInteger(messageId) || messageId <= 0) {
        logger.warn(fields, 'session trade notice not recorded: no message id');
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
        logger.info(
          { ...fields, from: notice.from },
          'session trade notice split: the cycle message is full',
        );
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
        // deleted by the user or no longer editable: the same blocks in a new message, now
        logger.warn(
          { ...fields, ...telegramErrorFields(error, 'editMessageText') },
          'session trade notice edited anew: the cycle message is gone',
        );
        await pace();
        return sendNew(notice.text, notice.from);
      }
      return failed(session, claimed, error, 'editMessageText');
    }
  }

  // How a trade's send or edit that failed ends: Telegram refused it for good to this user (403),
  // asked to wait (429) or refused this call (another 4xx), each certainly not shown; or the
  // outcome is unknown, and the trade stays claimed.
  async function failed(
    session: PendingSessionNotice,
    claimed: number,
    error: unknown,
    method: 'sendMessage' | 'editMessageText',
  ): Promise<Step> {
    const failure = failureOf(error);
    const logged = {
      sessionId: session.sessionId,
      claimed,
      ...errorLogFields(error),
      ...telegramErrorFields(error, method),
    };
    switch (failure.kind) {
      case 'forbidden':
        logger.warn(logged, 'session trade notice refused: the user is unreachable');
        await recordTelegramSendFailure({ db, log: logger }, session.telegramUserId, error);
        session.telegramBlocked = true;
        return 'next';
      case 'wait':
        await releaseSessionTradeNotice(db, { sessionId: session.sessionId, claimed });
        return pauseFor(failure.ms);
      case 'refused':
        if (mayRetry(`${session.sessionId}:${claimed}`)) {
          logger.warn(logged, 'session trade notice refused');
          await releaseSessionTradeNotice(db, { sessionId: session.sessionId, claimed });
          return 'skip';
        }
        logger.warn(logged, 'session trade notice dropped');
        return 'next';
      case 'unknown':
        logger.warn(
          logged,
          method === 'editMessageText'
            ? 'session trade notice edit outcome unknown'
            : 'session trade notice outcome unknown',
        );
        return 'next';
    }
  }

  // Deletes the waiting message (#536), drops its id and frees its slot, so an active session is
  // due again. Nothing is called for a user who blocked the bot (Rule 19): a stopped session's id
  // is dropped without a call, so the summary can be claimed; an active session's is kept (#587),
  // so once the user is reachable the message still in the chat is deleted before anything new is
  // sent, never a second «⏹» beside it. The caller has taken the pace.
  async function removeWaiting(session: PendingSessionNotice, messageId: number): Promise<Removal> {
    const fields = { sessionId: session.sessionId };
    const clear = async (): Promise<Removal> => {
      attempts.delete(`${session.sessionId}:delete:${String(messageId)}`);
      await clearSessionWaitingMessage(db, { sessionId: session.sessionId, messageId });
      session.waitingMessageId = null;
      session.waitingDue = true;
      return { kind: 'cleared' };
    };
    const unreachable = (): Promise<Removal> =>
      session.status === TradingSessionStatus.Stopped
        ? clear()
        : Promise.resolve({ kind: 'blocked' });
    if (session.telegramBlocked) return unreachable();
    try {
      await push.deleteSessionWaiting(session.telegramUserId, messageId);
      return await clear();
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
      const failure = failureOf(error);
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
  // chat with its «⏹» (docs/bot-session.md, risk 65). Once recorded, the message is the sender's
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
      const failure = failureOf(error);
      const logged = {
        ...fields,
        ...errorLogFields(error),
        ...telegramErrorFields(error, 'sendMessage'),
      };
      switch (failure.kind) {
        case 'forbidden':
          // certainly not delivered: the slot is freed, due again once the user is reachable
          logger.warn(logged, 'session waiting message refused: the user is unreachable');
          await recordTelegramSendFailure({ db, log: logger }, session.telegramUserId, error);
          await releaseSessionWaiting(db, { sessionId: session.sessionId, slot: claim.slot });
          session.telegramBlocked = true;
          return 'next';
        case 'wait':
          await releaseSessionWaiting(db, { sessionId: session.sessionId, slot: claim.slot });
          return pauseFor(failure.ms);
        case 'refused':
          if (mayRetry(key)) {
            logger.warn(logged, 'session waiting message refused');
            await releaseSessionWaiting(db, { sessionId: session.sessionId, slot: claim.slot });
            return 'skip';
          }
          logger.warn(logged, 'session waiting message dropped');
          return 'next';
        case 'unknown':
          // it may have been delivered: the slot stays claimed, never a second one on it
          logger.warn(logged, 'session waiting message outcome unknown');
          return 'next';
      }
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

  async function sendSummary(session: PendingSessionNotice): Promise<Step> {
    // a summary does not start after stop(): its view reads the balance (up to
    // TRADING_ACCESS_REFRESH_BUDGET_MS), which would add to the step in flight (timing.ts)
    if (stopped) return 'skip';
    const fields = { sessionId: session.sessionId };
    const telegramUserId = String(session.telegramUserId);
    const view = await readFinishedSessionView({ db, balance }, session.sessionId, telegramUserId);
    if (view === undefined) return 'skip';
    // no settled trade: no result to report (#337, #318), the mark alone — but a session the
    // no-signal limit stopped tells why with the way to another pair, trades or not (#509)
    if (view.trades.settled === 0 && view.stopReason !== TradingSessionStopReason.NoSignalTimeout) {
      await claimSessionFinalNotice(db, { sessionId: session.sessionId });
      return 'next';
    }
    let message: ClientPushMessage;
    try {
      const assetId = view.settings?.assetId ?? view.lastIntent?.assetId ?? 0;
      message = sessionSummaryMessage(view, pairOf(catalog.read(), assetId).label);
    } catch (error) {
      // a bug, before the claim: the session stays pending, and its card waits for the summary
      logger.error({ ...fields, ...errorLogFields(error) }, 'session summary not built');
      return 'skip';
    }
    if (!session.telegramBlocked) await pace();
    if (stopped) return 'skip';
    if (!(await claimSessionFinalNotice(db, { sessionId: session.sessionId }))) return 'skip';
    if (session.telegramBlocked) return 'next';
    try {
      await push.sendSessionSummary(session.telegramUserId, message);
      attempts.delete(`${session.sessionId}:summary`);
      return 'next';
    } catch (error) {
      const failure = failureOf(error);
      const logged = {
        ...fields,
        ...errorLogFields(error),
        ...telegramErrorFields(error, 'sendMessage'),
      };
      switch (failure.kind) {
        case 'forbidden':
          logger.warn(logged, 'session summary refused: the user is unreachable');
          await recordTelegramSendFailure({ db, log: logger }, session.telegramUserId, error);
          return 'next';
        case 'wait':
          await releaseSessionFinalNotice(db, { sessionId: session.sessionId });
          return pauseFor(failure.ms);
        case 'refused':
          if (mayRetry(`${session.sessionId}:summary`)) {
            logger.warn(logged, 'session summary refused');
            await releaseSessionFinalNotice(db, { sessionId: session.sessionId });
            return 'skip';
          }
          logger.warn(logged, 'session summary dropped');
          return 'next';
        case 'unknown':
          logger.warn(logged, 'session summary outcome unknown');
          return 'next';
      }
    }
  }

  // every trade past the cursor in order, then the stale waiting message's delete, then the
  // summary of a finished session or the waiting message due; the first step that does not go
  // ends the session's turn, so its later trades never overtake it and the waiting message is
  // the last message of the turn
  async function serve(session: PendingSessionNotice): Promise<Step> {
    const parsed = safeParseTradingSessionSettings(session.settings);
    const settings = parsed.success ? parsed.data : null;
    for (let claimed = session.notifiedTrades; claimed < session.settled; claimed += 1) {
      const step = await sendTrade(session, settings, claimed);
      if (step !== 'next') return step;
    }
    if (session.waitingStale && session.waitingMessageId !== null) {
      const step = await deleteStaleWaiting(session);
      if (step !== 'next') return step;
    }
    // a finished session's trades are all settled or rejected: none appears after the list's read
    if (session.finished) return sendSummary(session);
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
