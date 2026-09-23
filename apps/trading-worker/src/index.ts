import { Redis } from 'ioredis';
import { Pool } from 'pg';
import pino from 'pino';
import { closeAll } from '@binarius/shared';
import { createDb } from '@binarius/db';
import { parseEnv } from './env';
import {
  SHUTDOWN_BUDGET_MS,
  STALE_SUBMITTING_MS,
  SWEEP_BATCH_SIZE,
  SWEEP_INTERVAL_MS,
} from './intents/config';
import { startIntentConsumer } from './intents/consumer';
import { notConfiguredExecutor } from './intents/executor';
import { processIntentJob } from './intents/processor';
import { startSweeper } from './intents/sweeper';

const env = parseEnv(process.env);

const logger = pino({
  level: env.logLevel,
  redact: ['*.authorization', '*.token', '*.accessToken', '*.refreshToken', '*.password'],
});

const pool = new Pool({ connectionString: env.databaseUrl });
const db = createDb(pool);
// BullMQ's blocking connection must not cap retries per command
const redis = new Redis(env.redisUrl, { maxRetriesPerRequest: null });

pool.on('error', (error) => logger.error({ err: error }, 'postgres pool error'));
redis.on('error', (error) => logger.warn({ err: error }, 'redis connection error'));

// ARCH-01 replaces this with the broker socket client
const executor = notConfiguredExecutor;

const consumer = startIntentConsumer({
  connection: redis,
  logger,
  concurrency: env.workerConcurrency,
  processor: (payload) =>
    processIntentJob(
      {
        db,
        executor,
        logger,
        config: {
          intentMaxAgeMs: env.intentMaxAgeMs,
          submitAckTimeoutMs: env.submitAckTimeoutMs,
          staleSubmittingMs: STALE_SUBMITTING_MS,
        },
      },
      payload,
    ),
});

const sweeper = startSweeper({
  db,
  logger,
  intervalMs: SWEEP_INTERVAL_MS,
  olderThanMs: STALE_SUBMITTING_MS,
  limit: SWEEP_BATCH_SIZE,
});

let shuttingDown = false;

// Phase 1 drains the worker (active jobs finish, new ones are not taken); phase 2 closes the
// connections and runs only if the drain finished — closing them under a job's outcome write
// would abort it. A drain that overruns exits hard: the intent stays submitting and the
// sweeper resolves it after the restart.
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  sweeper.stop();
  const drained = await closeAll([() => consumer.worker.close()], SHUTDOWN_BUDGET_MS);
  if (!drained) {
    logger.error('shutdown: active jobs did not finish within the budget, exiting without cleanup');
    process.exit(1);
  }
  await closeAll([() => consumer.dlq.close(), () => redis.quit(), () => pool.end()]);
  process.exit(0);
}

process.once('SIGTERM', (signal) => void shutdown(signal));
process.once('SIGINT', (signal) => void shutdown(signal));

logger.info({ concurrency: env.workerConcurrency }, 'trading-worker started');
