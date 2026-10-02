import pino from 'pino';
import { logOptions } from '@binarius/shared';
import { createBackendClient } from './backend-client';
import { createBot } from './bot';
import { parseEnv } from './env';
import { runBot } from './lifecycle';

const env = parseEnv(process.env);

const logger = pino(logOptions(env.logLevel));

const backend = createBackendClient({ baseUrl: env.backendUrl, token: env.internalApiToken });

const bot = createBot({
  token: env.telegramBotToken,
  backend,
  logger,
  welcomeVideoFileId: env.welcomeVideoFileId,
});

runBot({ bot, logger, exit: (code) => process.exit(code) });
