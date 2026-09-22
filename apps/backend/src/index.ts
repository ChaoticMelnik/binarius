import { Redis } from 'ioredis';
import { Pool } from 'pg';
import { buildApp } from './app';
import { parseEnv } from './env';
import { closeAll } from './shutdown';

const env = parseEnv(process.env);

// drivers give up before the app-level race in /health, so the logged reason is the driver's
const driverTimeoutMs = env.healthTimeoutMs - 200;

const pool = new Pool({
  connectionString: env.databaseUrl,
  connectionTimeoutMillis: driverTimeoutMs,
  query_timeout: driverTimeoutMs,
});

// no lazyConnect: with the offline queue disabled, a lazy client rejects the very command
// that would have opened the connection, so the first /health always reported redis down
const redis = new Redis(env.redisUrl, {
  enableOfflineQueue: false,
  commandTimeout: driverTimeoutMs,
  maxRetriesPerRequest: 1,
});

const app = buildApp({
  checkPostgres: () => pool.query('SELECT 1'),
  checkRedis: () => redis.ping(),
  logLevel: env.logLevel,
  checkTimeoutMs: env.healthTimeoutMs,
});

// an unhandled 'error' on either client would crash the process instead of degrading /health
pool.on('error', (error) => app.log.error({ err: error }, 'postgres pool error'));
redis.on('error', (error) => app.log.warn({ err: error }, 'redis connection error'));

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  await closeAll([
    () => app.close(),
    () => pool.end(),
    // quit() rejects while disconnected because the offline queue is disabled
    () => redis.quit().catch(() => redis.disconnect()),
  ]);
  process.exit(0);
}

process.once('SIGTERM', (signal) => void shutdown(signal));
process.once('SIGINT', (signal) => void shutdown(signal));

await app.listen({ port: env.port, host: '0.0.0.0' });
