import pino from 'pino';
import { logOptions } from '@binarius/shared';
import { createBackendClient } from './backend-client';
import { createBot } from './bot';
import { parseEnv } from './env';
import { createIntentTracker } from './intent-tracker';
import { runBot } from './lifecycle';
import {
  INTENT_TRACK_DEADLINE_MS,
  INTENT_TRACK_FIRST_POLL_MS,
  INTENT_TRACK_POLL_MS,
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

const bot = createBot({
  token: env.telegramBotToken,
  backend,
  logger,
  welcomeVideoFileId: env.welcomeVideoFileId,
  intentTracker,
});

runBot({ bot, tracker: intentTracker, logger, exit: (code) => process.exit(code) });
