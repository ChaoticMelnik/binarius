import type { Update, User } from 'grammy/types';
import {
  BOT_INFO,
  createBackendClient,
  createBot,
  createIntentTracker,
  createSessionResumer,
  createSessionTracker,
  INTENT_TRACK_DEADLINE_MS,
  INTENT_TRACK_FIRST_POLL_MS,
  INTENT_TRACK_POLL_MS,
  SESSION_RESUME_GAP_MS,
  SESSION_RESUME_INTERVAL_MS,
  SESSION_TRACK_DEADLINE_MS,
  startUpdate,
  textUpdate,
  USER,
} from '@binarius/bot/e2e';
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
  const bot = createBot({
    token: BOT_TOKEN,
    backend,
    logger,
    botInfo: BOT_INFO,
    intentTracker,
    sessionTracker,
    sessionResumer,
  });
  const telegram = deps.telegram.bot(bot);
  const handle = async (update: Update) => {
    await bot.handleUpdate(update);
    return update;
  };
  const startText = (payload?: string) => (payload === undefined ? '/start' : `/start ${payload}`);

  return {
    telegram,
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
    },
  };
}
