import type { FastifyBaseLogger } from 'fastify';
import { GrammyError } from 'grammy';
import {
  editRefusal,
  errorLogFields,
  safeParseTradingSessionSettings,
  TradingSessionStopReason,
  type TelegramHtml,
  type TradingSessionSettings,
} from '@binarius/shared';
import {
  claimSessionFinalNotice,
  claimSessionTradeNotice,
  listPendingSessionNotices,
  recordSessionCycleMessage,
  releaseSessionFinalNotice,
  releaseSessionTradeNotice,
  type Db,
  type PendingSessionNotice,
} from '@binarius/db';
import type { PairsCatalog } from '@binarius/broker-rest';
import type { ClientPush, ClientPushMessage } from '../auth/client-push';
import type { BalanceReconciler } from '../broker/balance-reconciler';
import { createSendPacer } from '../mailing/engine';
import { telegramErrorFields } from '../telegram-logging';
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
// The bot's restart, a backend restart and «🔄 Обновить» send nothing twice: the cursor and the
// cycle message are in trading_sessions.

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
  push: Pick<ClientPush, 'sendSessionTrade' | 'editSessionTrade' | 'sendSessionSummary'>;
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
  // the definite refusals of one send, by `${sessionId}:${claimed}` or `${sessionId}:summary`;
  // in memory: a restart gives each send its attempts again, which is a bounded retry, never a
  // second delivery
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
    // id. An id that is not a positive integer is not recorded: the next step sends anew.
    const sendNew = async (text: TelegramHtml, from: number): Promise<Step> => {
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
      await recordSessionCycleMessage(db, {
        sessionId: session.sessionId,
        claimed,
        messageId,
        from,
      });
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

  // every trade past the cursor in order, then the summary of a finished session; the first trade
  // that does not go ends the session's turn, so its later trades never overtake it
  async function serve(session: PendingSessionNotice): Promise<Step> {
    const parsed = safeParseTradingSessionSettings(session.settings);
    const settings = parsed.success ? parsed.data : null;
    for (let claimed = session.notifiedTrades; claimed < session.settled; claimed += 1) {
      const step = await sendTrade(session, settings, claimed);
      if (step !== 'next') return step;
    }
    // a finished session's trades are all settled or rejected: none appears after the list's read
    return session.finished ? sendSummary(session) : 'next';
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
