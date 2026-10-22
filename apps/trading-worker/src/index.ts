import { Redis } from 'ioredis';
import { Pool } from 'pg';
import pino from 'pino';
import { errorLogFields, logOptions } from '@binarius/shared';
import { checkSchemaAtStartup, createDb } from '@binarius/db';
import { parseEnv } from './env';
import { createWorker } from './worker';

const env = parseEnv(process.env);

const logger = pino(logOptions(env.logLevel));

const pool = new Pool({ connectionString: env.databaseUrl });
const db = createDb(pool);
// BullMQ's blocking connection must not cap retries per command
const redis = new Redis(env.redisUrl, { maxRetriesPerRequest: null });

pool.on('error', (error) => logger.error(errorLogFields(error), 'postgres pool error'));
redis.on('error', (error) => logger.warn(errorLogFields(error), 'redis connection error'));

// before anything reads a table: a schema behind this image would fail every pass at run time
if (!(await checkSchemaAtStartup(pool, logger))) process.exit(1);

// the composition and both shutdown phases live in worker.ts (#95)
const worker = createWorker({ env, db, pool, redis, logger });

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  process.exit((await worker.shutdown(signal)) === 'clean' ? 0 : 1);
}

process.once('SIGTERM', (signal) => void shutdown(signal));
process.once('SIGINT', (signal) => void shutdown(signal));

worker.start();
