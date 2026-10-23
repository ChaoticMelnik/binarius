import type { FastifyBaseLogger } from 'fastify';
import { GrammyError } from 'grammy';
import {
  deleteRefusal,
  editRefusal,
  errorLogFields,
  safeParseTradingSessionSettings,
  SESSION_SUMMARY_FALLBACK_MS,
  TradingSessionStatus,
  TradingSessionStopReason,
  type BotKeyboard,
  type TelegramHtml,
  type TradingSessionSettings,
  telegramErrorFields,
} from '@binarius/shared';
import {
  claimSessionFinalNotice,
  claimSessionOpenNotice,
  claimSessionTradeNotice,
  claimSessionWaiting,
  claimSummaryFallback,
  clearSessionWaitingMessage,
  listPendingSessionNotices,
  listSummaryFallback,
  readSessionWaitingMessage,
  recordSessionCycleMessage,
  recordSessionWaitingMessage,
  releaseSessionOpenNotice,
  releaseSessionTradeNotice,
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
  SESSION_NOTICE_CHAT_GAP_MS,
  SESSION_NOTICE_HOLD_MS,
  SESSION_NOTICE_MAX_ATTEMPTS,
  SESSION_NOTICE_SCAN,
  SESSION_NOTICE_SEND_PER_SECOND,
  SESSION_NOTICE_TICK_MS,
  SESSION_NOTICE_WAKE_GAP_MS,
} from '../timing';
import { recordTelegramSendFailure } from '../users/telegram-delivery';
import {
  pairOf,
  sessionCycleMessage,
  sessionCycleStopKeyboard,
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
// Under them stands the waiting message with its «⏹» (#536) while the session waits for a signal
// (#722: its latest decision is no_signal, session-notice-ops.ts): deleted before a new message of
// the session (a cycle message, or a relaunch's status message, #587) and sent again after it
// while the wait lasts, deleted once the session no longer waits - before the open trade's block,
// which carries the «⏹» itself, so two never stand together - or stopped, before the final mark -
// unless its «⏹» stopped the session: the stop route then hands it to the bot, which draws its
// reply in place of it (#587), and the mark follows with no delete. The sender re-reads the waiting message's id right before each delete,
// so a message the stop route took over is not deleted (#587 round 1; the call in flight: docs
// risk 82). A restart of the bot or the backend repeats no send by a retry: the cursor, the cycle
// message and the waiting message are in trading_sessions; a block can show twice only by the
// endings docs risk 35 names (a new message whose outcome was unknown, a second sender). A trade
// open at the broker shows first as its block without a result (#700), claimed the same way
// (open_notice_intent_id) below every settled trade's block; its settlement edits it into the
// result. An H1 session's messages are any session's (#775).
// One chat gets at most one step of the sender within the gap (#660, docs → Rate and timing): a
// send or an edit marks the chat, delivered or not; a step whose chat is cooling ends the turn
// before its pace and its claim, and goes on a later tick. The calls inside one step go one after
// the other, and a delete neither waits for the gap nor marks the chat. A turn that threw holds its
// session out of both lists for a while (#660), so a row that throws every tick cannot hold the
// head of the list; both maps are in memory, and a restart tries at once.
// A trade opened or settled wakes the sender (#723): transitionIntent notifies on the commit, the
// listener (session-notice-listener.ts) calls wake(), and the woken tick is the same tick as the
// interval's - the interval stays as the safety net for a lost notification. Woken ticks start at
// least wakeGapMs apart, so a storm of notifications costs at most a few ticks a second; a step
// skipped because its chat was cooling wakes the sender again at the end of that chat's gap.

export interface SessionNoticeConfig {
  tickMs: number;
  scan: number;
  perSecond: number;
  maxAttempts: number;
  // the fallback's grace for a session the bot tracks (#537)
  summaryFallbackMs: number;
  // one step per chat within it (#660); 0 turns the gap off
  chatGapMs: number;
  // how long a session whose turn threw is left out of the lists (#660)
  holdMs: number;
  // the least time between the starts of a tick and a woken tick after it (#723)
  wakeGapMs: number;
}

const DEFAULT_SESSION_NOTICE_CONFIG: SessionNoticeConfig = {
  tickMs: SESSION_NOTICE_TICK_MS,
  scan: SESSION_NOTICE_SCAN,
  perSecond: SESSION_NOTICE_SEND_PER_SECOND,
  maxAttempts: SESSION_NOTICE_MAX_ATTEMPTS,
  summaryFallbackMs: SESSION_SUMMARY_FALLBACK_MS,
  chatGapMs: SESSION_NOTICE_CHAT_GAP_MS,
  holdMs: SESSION_NOTICE_HOLD_MS,
  wakeGapMs: SESSION_NOTICE_WAKE_GAP_MS,
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
  // a tick now, or right after the one in flight, no sooner than wakeGapMs after the last tick's
  // start; calls before that tick merge into it, and after stop() it does nothing (#723)
  wake(): void;
  start(): void;
  // Ends the loop and waits for the tick in flight: no claim and no fallback summary's balance read
  // starts after it; the call in flight completes or times out (timing.ts).
  stop(): Promise<void>;
}

// how a trade's turn ended for the session: on to its next trade, skip the session this tick (a
// refused claim, a refusal to try again, or its chat cooling, #660), or pause the whole sender
// (Telegram asked to wait)
type Step = 'next' | 'skip' | 'pause';

// how a delete of the waiting message ended: its id dropped (deleted, already gone, never to be
// deleted, or taken over by the stop route), kept for the next tick (outcome unknown), kept while
// the user is unreachable and the session active (#587: deleted first once the user is reachable
// again), or Telegram asked to wait
type Removal =
  { kind: 'cleared' } | { kind: 'kept' } | { kind: 'blocked' } | { kind: 'wait'; ms: number };

// The memory's mirror of waitingDueSql once a step freed the slot or left it behind; the SQL
// decides, so a wrong hint costs one refused claim or one tick.
// A claimed notice's delivery: the trade's message (#551) or the open trade's block (#700)
interface Delivery {
  label: 'session trade notice' | 'session open notice';
  key: string;
  fields: Record<string, unknown>;
  // where the claim left the cursor, and the open block's intent (#700): the record's CAS
  cursor: number;
  openIntentId?: string;
  // puts the claim back: only for a send Telegram certainly did not deliver
  release: () => Promise<unknown>;
  // the open block's «⏹» (#722): on its send, its edit and a new message after a gone edit; a
  // delivery without one is sent or edited without a keyboard, which takes the «⏹» off
  keyboard?: BotKeyboard;
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
  // the definite refusals of one send, by `${sessionId}:${claimed}`, `${sessionId}:open:${intentId}`,
  // `${sessionId}:summary` or `${sessionId}:waiting:${slot}`, and the unknown outcomes of a waiting message's delete, by
  // `${sessionId}:delete:${messageId}`; in memory: a restart gives each send its attempts again,
  // which is a bounded retry, never a second delivery
  const attempts = new Map<string, number>();
  let stopped = false;
  let pausedUntil = -Infinity;
  let ticking: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  // until when each chat is cooling, by telegramUserId, and each held session, by its id (#660)
  const chatNextAt = new Map<string, number>();
  const heldUntil = new Map<string, number>();
  // the wake (#723): wake() calls no tick has served yet, when the last tick started, the floor's
  // timer, and the timer for the earliest end of a gap this tick's skipped chats wait for
  let wakes = 0;
  let lastTickAt = -Infinity;
  let wakeTimer: NodeJS.Timeout | undefined;
  let wakeAt = Infinity;
  let coolingTimer: NodeJS.Timeout | undefined;
  let coolingAt = Infinity;
  let lastCoolingFiredAt = -Infinity;
  let coolingUntil: number | undefined;

  const chatOf = (telegramUserId: bigint) => String(telegramUserId);
  const cooling = (telegramUserId: bigint) => {
    const until = chatNextAt.get(chatOf(telegramUserId)) ?? -Infinity;
    if (now() >= until) return false;
    coolingUntil = Math.min(coolingUntil ?? Infinity, until);
    return true;
  };
  // after every send or edit to the chat, delivered or not
  const messaged = (telegramUserId: bigint) => {
    chatNextAt.set(chatOf(telegramUserId), now() + config.chatGapMs);
  };
  const prune = (map: Map<string, number>) => {
    for (const [key, until] of map) if (until <= now()) map.delete(key);
  };

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
    if (!session.telegramBlocked) {
      if (cooling(session.telegramUserId)) return 'skip';
      await pace();
    }
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
      cursor: claimed + 1,
      release: () => releaseSessionTradeNotice(db, { sessionId: session.sessionId, claimed }),
    });
  }

  // The open trade's block (#700): claimed below every settled trade's block, then sent or edited
  // into the cycle message as a trade's block is. A claim lost (the trade settled since the list,
  // another sender) skips the session this tick: its result comes by the cursor.
  async function sendOpen(
    session: PendingSessionNotice,
    settings: TradingSessionSettings | null,
    intentId: string,
  ): Promise<Step> {
    const fields = { sessionId: session.sessionId, intentId };
    if (!session.telegramBlocked) {
      if (cooling(session.telegramUserId)) return 'skip';
      await pace();
    }
    if (stopped) return 'skip';
    const claim = await claimSessionOpenNotice(db, {
      sessionId: session.sessionId,
      intentId,
      settled: session.settled,
    });
    if (claim === undefined) return 'skip';
    session.openNoticeIntentId = intentId;
    // nothing can be delivered (Rule 19): the block counts as sent
    if (session.telegramBlocked) return 'next';
    let notice: SessionCycleNotice;
    try {
      notice = sessionCycleMessage(
        claim,
        settings,
        pairOf(catalog.read(), claim.open.assetId).digits,
      );
    } catch (error) {
      // a bug: the block is not sent again, its trade's result comes by the cursor
      logger.error({ ...fields, ...errorLogFields(error) }, 'session open notice not built');
      return 'skip';
    }
    return deliver(session, notice, {
      label: 'session open notice',
      key: `${session.sessionId}:open:${intentId}`,
      fields,
      cursor: session.settled,
      openIntentId: intentId,
      release: () => releaseSessionOpenNotice(db, { sessionId: session.sessionId, intentId }),
      // a session the list read stopped gets no «⏹»: a stop after the read reaches the bot's 409
      ...(session.status === TradingSessionStatus.Active
        ? { keyboard: sessionCycleStopKeyboard(session.sessionId) }
        : {}),
    });
  }

  // A claimed notice's message (#551): a new message, or the edit of the session's cycle message.
  async function deliver(
    session: PendingSessionNotice,
    notice: SessionCycleNotice,
    { label, key, fields, cursor, openIntentId, release, keyboard }: Delivery,
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
    // message then takes a pace of its own. A delete that did not clear puts the block back, so
    // no new message goes out under a waiting message that may still be there; one that found the
    // user unreachable sends nothing more (Rule 19), the block counting as sent and the waiting
    // message's id kept, so it is deleted first once the user is reachable (#587).
    const sendNew = async (text: TelegramHtml, from: number): Promise<Step> => {
      if (session.waitingMessageId !== null) {
        const removal = await removeWaiting(session, session.waitingMessageId);
        if (removal.kind === 'blocked') return 'next';
        if (removal.kind !== 'cleared') {
          // nothing was sent: the block goes again after the pause, or next tick after the delete
          await release();
          return removal.kind === 'wait' ? pauseFor(removal.ms) : 'skip';
        }
        // the delete found the user unreachable: nothing more is delivered (Rule 19), the block
        // counts as sent
        if (session.telegramBlocked) return 'next';
        await pace();
      }
      let messageId: number;
      try {
        messageId = await push.sendSessionTrade(session.telegramUserId, text, keyboard);
      } catch (error) {
        return sendFailed({ ...failure, method: 'sendMessage', error });
      } finally {
        messaged(session.telegramUserId);
      }
      attempts.delete(key);
      if (!Number.isInteger(messageId) || messageId <= 0) {
        logger.warn(fields, `${label} not recorded: no message id`);
        return 'next';
      }
      const recorded = await recordSessionCycleMessage(db, {
        sessionId: session.sessionId,
        cursor,
        ...(openIntentId === undefined ? {} : { openIntentId }),
        messageId,
        from,
      });
      // a new cycle message: the waiting message is due under it while the session waits
      if (recorded && session.waitingMessageId === null) {
        session.waitingDue = session.waitingForSignal;
      }
      return 'next';
    };

    if (notice.kind === 'send') {
      if (notice.split) {
        logger.info({ ...fields, from: notice.from }, `${label} split: the cycle message is full`);
      }
      return sendNew(notice.text, notice.from);
    }
    try {
      await push.editSessionTrade(session.telegramUserId, notice.messageId, notice.text, keyboard);
      messaged(session.telegramUserId);
      attempts.delete(key);
      return 'next';
    } catch (error) {
      messaged(session.telegramUserId);
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
      session.waitingDue = session.waitingForSignal;
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

  // The stale waiting message's own step (#536): the session stopped, a newer message of the
  // session went out under it, or the session no longer waits for a signal (#722). A message the
  // user cannot be reached for stays (#587).
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
    if (cooling(session.telegramUserId)) return 'skip';
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
      messaged(session.telegramUserId);
    } catch (error) {
      messaged(session.telegramUserId);
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
    if (cooling(session.telegramUserId)) return 'skip';
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
      messaged(session.telegramUserId);
      attempts.delete(key);
      return 'next';
    } catch (error) {
      messaged(session.telegramUserId);
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

  // every trade past the cursor in order, then the stale
  // waiting message's delete, then the open trade's block (#700), then the final mark of a
  // finished session or the waiting message due; the first step that does not go ends the
  // session's turn, so its later trades never overtake it and the waiting message is the last
  // message of the turn. The delete goes before the open block (#722): the block carries the
  // session's «⏹», and an edit of the cycle message under a live waiting message would show two.
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
    const { openIntentId } = session;
    if (openIntentId !== null && openIntentId !== session.openNoticeIntentId) {
      const step = await sendOpen(session, settings, openIntentId);
      if (step !== 'next') return step;
    }
    // a finished session's trades are all settled or rejected: none appears after the list's read
    if (session.finished) return closeNotices(session);
    return session.waitingDue && waitingMayGo(session) ? sendWaiting(session) : 'next';
  }

  async function runTick(): Promise<void> {
    // before the first await and before the pause: a wake() after this line is the next tick's
    lastTickAt = now();
    const woken = wakes;
    wakes = 0;
    coolingUntil = undefined;
    if (now() < pausedUntil) {
      logger.debug({ woken, paused: true }, 'session notice tick');
      return;
    }
    prune(chatNextAt);
    prune(heldUntil);
    const exclude = [...heldUntil.keys()];
    const pending = await listPendingSessionNotices(db, { limit: config.scan, exclude });
    for (const session of pending) {
      if (stopped) return;
      let step: Step;
      try {
        step = await serve(session);
      } catch (error) {
        // a statement or a refresh that threw: what was claimed stays claimed, the rest waits, and
        // the session is held out of the lists for a while (#660)
        heldUntil.set(session.sessionId, now() + config.holdMs);
        logger.error(
          { sessionId: session.sessionId, holdMs: config.holdMs, ...errorLogFields(error) },
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
      exclude,
    });
    for (const session of fallback) {
      if (stopped) return;
      let step: Step;
      try {
        step = await serveFallback(session);
      } catch (error) {
        heldUntil.set(session.sessionId, now() + config.holdMs);
        logger.error(
          { sessionId: session.sessionId, holdMs: config.holdMs, ...errorLogFields(error) },
          'session notices failed for a session',
        );
        continue;
      }
      if (step === 'pause') return;
    }
    logger.debug(
      { pending: pending.length, fallback: fallback.length, woken },
      'session notice tick',
    );
  }

  // a woken tick at `at`, or sooner when one is already armed for sooner
  function armWake(at: number) {
    if (stopped) return;
    if (at <= now()) {
      clearTimeout(wakeTimer);
      wakeTimer = undefined;
      void tick();
      return;
    }
    if (wakeTimer !== undefined && wakeAt <= at) return;
    clearTimeout(wakeTimer);
    wakeAt = at;
    wakeTimer = setTimeout(
      () => {
        wakeTimer = undefined;
        void tick();
      },
      Math.max(0, Math.ceil(at - now())),
    );
  }

  // a wake at the end of a skipped chat's gap; an end at or before the last firing is not armed
  // again, so a timer that fired early cannot loop - the interval's tick serves it
  function armCooling(at: number) {
    if (stopped || at <= lastCoolingFiredAt) return;
    if (coolingTimer !== undefined && coolingAt <= at) return;
    clearTimeout(coolingTimer);
    coolingAt = at;
    coolingTimer = setTimeout(
      () => {
        coolingTimer = undefined;
        lastCoolingFiredAt = now();
        wake();
      },
      Math.max(0, Math.ceil(at - now())),
    );
  }

  function wake() {
    if (stopped) return;
    wakes += 1;
    if (ticking === undefined) armWake(lastTickAt + config.wakeGapMs);
  }

  // a tick longer than its interval makes the next one a no-op
  function tick(): Promise<void> {
    if (stopped) return Promise.resolve();
    ticking ??= runTick()
      .catch((error: unknown) => logger.error(errorLogFields(error), 'session notice tick failed'))
      .finally(() => {
        ticking = undefined;
        if (coolingUntil !== undefined) armCooling(coolingUntil);
        if (wakes > 0) armWake(lastTickAt + config.wakeGapMs);
      });
    return ticking;
  }

  return {
    tick,
    wake,
    start() {
      if (stopped || timer !== undefined) return;
      timer = setInterval(() => void tick(), config.tickMs);
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      timer = undefined;
      clearTimeout(wakeTimer);
      wakeTimer = undefined;
      clearTimeout(coolingTimer);
      coolingTimer = undefined;
      await ticking;
    },
  };
}
