import pino from 'pino';
import {
  BOT_TEXTS_REFRESH_MS,
  cashierUrlOf,
  createBotTextRefresher,
  logOptions,
} from '@binarius/shared';
import { backendErrorFields, createBackendClient } from './backend-client';
import { createBot } from './bot';
import { parseEnv } from './env';
import { createIntentTracker } from './intent-tracker';
import { runBot } from './lifecycle';
import { createSessionResumer } from './session-resume';
import { createSessionTracker } from './session-tracker';
import { setBotTextSource } from './texts';
import {
  BACKEND_REQUEST_TIMEOUT_MS,
  INTENT_TRACK_DEADLINE_MS,
  INTENT_TRACK_FIRST_POLL_MS,
  INTENT_TRACK_POLL_MS,
  SESSION_RESUME_GAP_MS,
  SESSION_RESUME_INTERVAL_MS,
  SESSION_TRACK_DEADLINE_MS,
  SESSION_TRACK_FIRST_POLL_MS,
  SESSION_TRACK_POLL_MS,
} from './timing';

const env = parseEnv(process.env);

const logger = pino(logOptions(env.logLevel));

// Telegram opens a Mini App over https only: local dev runs without «💳 Пополнить» (#27)
const cashierUrl = cashierUrlOf(env.webPublicUrl);
if (cashierUrl === undefined) logger.warn('cashier button off: WEB_PUBLIC_URL is not https');
// the promo card needs a channel to get its file id from (#538): none, no «📤 Поделиться»
if (env.shareStorageChatId === undefined) {
  logger.warn('share button off: SHARE_STORAGE_CHAT_ID is not set');
}

const backend = createBackendClient({ baseUrl: env.backendUrl, token: env.internalApiToken });

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
  firstPollMs: SESSION_TRACK_FIRST_POLL_MS,
  pollMs: SESSION_TRACK_POLL_MS,
  deadlineMs: SESSION_TRACK_DEADLINE_MS,
  resumeGapMs: SESSION_RESUME_GAP_MS,
});

// tracks the sessions again after a restart (#567); createBot hands it the session composer's resume
const sessionResumer = createSessionResumer({
  backend,
  tracker: sessionTracker,
  logger,
  intervalMs: SESSION_RESUME_INTERVAL_MS,
});

// the texts with their overrides, from the first load on (docs/bot-texts.md → Loading)
const botTexts = createBotTextRefresher({
  load: () => backend.readBotTexts(),
  intervalMs: BOT_TEXTS_REFRESH_MS,
  budgetMs: BACKEND_REQUEST_TIMEOUT_MS,
  apply: setBotTextSource,
  logger,
  failureFields: backendErrorFields,
});
botTexts.start();

const bot = createBot({
  token: env.telegramBotToken,
  backend,
  logger,
  welcomeVideoFileId: env.welcomeVideoFileId,
  cashierUrl,
  shareStorageChatId: env.shareStorageChatId,
  intentTracker,
  sessionTracker,
  sessionResumer,
});

runBot({
  bot,
  tracker: intentTracker,
  sessionTracker,
  // bot.api and the username are known once bot.init() ran, before onStart
  sessionResumer: {
    start: () => sessionResumer.start(bot.api, bot.botInfo.username),
    stop: () => sessionResumer.stop(),
  },
  botTexts,
  logger,
  exit: (code) => process.exit(code),
});
