import pino from 'pino';
import { BOT_TEXTS_REFRESH_MS, createBotTextRefresher, logOptions } from '@binarius/shared';
import { backendErrorFields, createBackendClient } from './backend-client';
import { createBot } from './bot';
import { parseEnv } from './env';
import { createIntentTracker } from './intent-tracker';
import { runBot } from './lifecycle';
import { createSessionTracker } from './session-tracker';
import { setBotTextSource } from './texts';
import {
  BACKEND_REQUEST_TIMEOUT_MS,
  INTENT_TRACK_DEADLINE_MS,
  INTENT_TRACK_FIRST_POLL_MS,
  INTENT_TRACK_POLL_MS,
  SESSION_TRACK_DEADLINE_MS,
  SESSION_TRACK_FIRST_POLL_MS,
  SESSION_TRACK_POLL_MS,
} from './timing';

const env = parseEnv(process.env);

const logger = pino(logOptions(env.logLevel));

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
  intentTracker,
  sessionTracker,
});

runBot({
  bot,
  tracker: intentTracker,
  sessionTracker,
  botTexts,
  logger,
  exit: (code) => process.exit(code),
});
