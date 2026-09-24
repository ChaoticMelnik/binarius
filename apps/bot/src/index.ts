import pino from 'pino';
import { LOG_REDACT_PATHS } from '@binarius/shared';
import { createBackendClient } from './backend-client';
import { createBot } from './bot';
import { parseEnv } from './env';
import { runBot } from './lifecycle';

const env = parseEnv(process.env);

const logger = pino({ level: env.logLevel, redact: [...LOG_REDACT_PATHS] });

const backend = createBackendClient({ baseUrl: env.backendUrl, token: env.internalApiToken });

const bot = createBot({
  token: env.telegramBotToken,
  backend,
  logger,
  welcomeVideoFileId: env.welcomeVideoFileId,
});

runBot({ bot, logger, exit: (code) => process.exit(code) });
