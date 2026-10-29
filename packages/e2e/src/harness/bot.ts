import type { Update, User } from 'grammy/types';
import {
  BOT_INFO,
  createBackendClient,
  createBot,
  createIntentTracker,
  createSessionResumer,
  createSessionTracker,
  createShownSignals,
  createSignalWaiter,
  INTENT_TRACK_DEADLINE_MS,
  INTENT_TRACK_FIRST_POLL_MS,
  INTENT_TRACK_POLL_MS,
  SESSION_RESUME_GAP_MS,
  SESSION_RESUME_INTERVAL_MS,
  SESSION_TRACK_DEADLINE_MS,
  SIGNAL_WAIT_CAPTION_EDITS_PER_TICK,
  SIGNAL_WAIT_CAPTION_MS,
  SIGNAL_WAIT_EDIT_FAILURES_MAX,
  SIGNAL_WAIT_EDIT_GAP_MS,
  SIGNAL_WAIT_MAX_MS,
  SIGNAL_WAIT_POLL_MS,
  SIGNAL_WAIT_POLL_OFFSET_MS,
  SIGNAL_WAIT_SHUTDOWN_BUDGET_MS,
  SIGNALS_LIST_TTL_MS,
  startUpdate,
  textUpdate,
  USER,
} from '@binarius/bot/e2e';
import type { ShownSignalStart } from '@binarius/shared';
import { BOT_TOKEN, INTERNAL_API_TOKEN } from './env';
import type { LogSink } from './logs';
import { findButton, pressUpdate, type createTelegram, type TelegramSide } from './telegram';

// the session tracker's polls, shortened so the run sees the status message move (production:
// 3 s and 10 s); its deadline and resume gap are production's
export const E2E_BOT_TUNING = { sessionFirstPollMs: 200, sessionPollMs: 300 } as const;

export interface E2eBot {
  telegram: TelegramSide;
  // each sends a new update as USER (or `from`) and returns it, for replay
  start(payload?: string): Promise<Update>;
  startAs(from: User, payload?: string): Promise<Update>;
  send(text: string): Promise<Update>;
  sendAs(from: User, text: string): Promise<Update>;
  // presses the newest button in USER's chat whose label matches, on the message that carries it
  press(label: string | ((label: string) => boolean)): Promise<Update>;
  // Telegram's re-delivery: the same update, its update_id and callback_query.id, a second time
  replay(update: Update): Promise<void>;
  // the shown directions the starts took (#829), in order
  shownTaken: ShownSignalStart[];
  stop(): Promise<void>;
}

// apps/bot/src/index.ts without polling: updates go to bot.handleUpdate, Telegram is the
// transformer of createTelegram, the backend is the real client over HTTP. The resumer is built
// (createBot requires it) and not started: no restart happens in the run.
export function startE2eBot(deps: {
  backendUrl: string;
  logs: LogSink;
  telegram: ReturnType<typeof createTelegram>;
}): E2eBot {
  const logger = deps.logs.logger;
  const backend = createBackendClient({ baseUrl: deps.backendUrl, token: INTERNAL_API_TOKEN });
  const intentTracker = createIntentTracker({
    backend,
    logger,
    firstPollMs: INTENT_TRACK_FIRST_POLL_MS,
    pollMs: INTENT_TRACK_POLL_MS,
    deadlineMs: INTENT_TRACK_DEADLINE_MS,
  });
  const sessionTracker = createSessionTracker({
    backend,
    logger,
    firstPollMs: E2E_BOT_TUNING.sessionFirstPollMs,
    pollMs: E2E_BOT_TUNING.sessionPollMs,
    deadlineMs: SESSION_TRACK_DEADLINE_MS,
    resumeGapMs: SESSION_RESUME_GAP_MS,
  });
  const sessionResumer = createSessionResumer({
    backend,
    tracker: sessionTracker,
    logger,
    intervalMs: SESSION_RESUME_INTERVAL_MS,
  });
  // the directions the bot showed (#829), one store for the waiter and the bot, as index.ts; the
  // takes are kept for the run's oracle
  const store = createShownSignals();
  const shownTaken: ShownSignalStart[] = [];
  const shownSignals = {
    ...store,
    take(telegramUserId: number, assetId: number) {
      const taken = store.take(telegramUserId, assetId);
      if (taken !== undefined) shownTaken.push(taken);
      return taken;
    },
  };
  // the wait for a signal (#664) at production's bounds
  const signalWaiter = createSignalWaiter({
    backend,
    logger,
    shownSignals,
    pollMs: SIGNAL_WAIT_POLL_MS,
    pollOffsetMs: SIGNAL_WAIT_POLL_OFFSET_MS,
    listTtlMs: SIGNALS_LIST_TTL_MS,
    maxMs: SIGNAL_WAIT_MAX_MS,
    editGapMs: SIGNAL_WAIT_EDIT_GAP_MS,
    captionMs: SIGNAL_WAIT_CAPTION_MS,
    captionEditsPerTick: SIGNAL_WAIT_CAPTION_EDITS_PER_TICK,
    editFailuresMax: SIGNAL_WAIT_EDIT_FAILURES_MAX,
    shutdownBudgetMs: SIGNAL_WAIT_SHUTDOWN_BUDGET_MS,
  });
  const bot = createBot({
    token: BOT_TOKEN,
    backend,
    logger,
    botInfo: BOT_INFO,
    intentTracker,
    sessionTracker,
    sessionResumer,
    signalWaiter,
    shownSignals,
  });
  const telegram = deps.telegram.bot(bot);
  const handle = async (update: Update) => {
    await bot.handleUpdate(update);
    return update;
  };
  const startText = (payload?: string) => (payload === undefined ? '/start' : `/start ${payload}`);

  return {
    telegram,
    shownTaken,
    start: (payload) => handle(startUpdate(startText(payload))),
    startAs: (from, payload) => handle(startUpdate(startText(payload), 'private', from)),
    send: (text) => handle(textUpdate(text)),
    sendAs: (from, text) => handle(textUpdate(text, 'private', from)),
    async press(label) {
      const match = typeof label === 'string' ? (text: string) => text === label : label;
      const button = findButton(telegram, match, USER.id);
      if (button === undefined) throw new Error(`no button ${String(label)} on the bot's messages`);
      return handle(pressUpdate(button));
    },
    async replay(update) {
      await bot.handleUpdate(update);
    },
    async stop() {
      await sessionTracker.stop();
      await intentTracker.stop();
      await sessionResumer.stop();
      await signalWaiter.stop();
    },
  };
}
