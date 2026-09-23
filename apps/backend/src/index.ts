import { Redis } from 'ioredis';
import { Pool } from 'pg';
import { closeAll } from '@binarius/shared';
import { createDb } from '@binarius/db';
import { buildApp } from './app';
import { parseEnv } from './env';
import { createBullmqPublisher } from './outbox/bullmq';
import { OutboxPublisher } from './outbox/publisher';

const env = parseEnv(process.env);

// drivers are set to give up first so the logged reason is usually theirs; the /health race
// remains the outer bound (pg's connect and query timeouts are sequential)
const driverTimeoutMs = env.healthTimeoutMs - 200;

const pool = new Pool({
  connectionString: env.databaseUrl,
  connectionTimeoutMillis: driverTimeoutMs,
  query_timeout: driverTimeoutMs,
  // longer than the probe interval, otherwise most probes pay a fresh connect
  idleTimeoutMillis: 30_000,
});

// no lazyConnect: with the offline queue disabled, a lazy client rejects the very command
// that would have opened the connection, so the first /health always reported redis down
const redis = new Redis(env.redisUrl, {
  enableOfflineQueue: false,
  commandTimeout: driverTimeoutMs,
  maxRetriesPerRequest: 1,
});

// BullMQ gets its own client: it relies on the offline queue and forbids a per-command retry
// cap, both of which the health probe client deliberately has
const queueRedis = new Redis(env.redisUrl, { maxRetriesPerRequest: null });

const db = createDb(pool);
const jobs = createBullmqPublisher(queueRedis);

const app = buildApp({
  checkPostgres: () => pool.query('SELECT 1'),
  checkRedis: () => redis.ping(),
  logLevel: env.logLevel,
  checkTimeoutMs: env.healthTimeoutMs,
  trading: {
    db,
    internalApiToken: env.internalApiToken,
    onIntentQueued: () => publisher.wake(),
  },
});

const publisher = new OutboxPublisher({ db, jobs, logger: app.log });

// an unhandled 'error' on either client would crash the process instead of degrading /health
pool.on('error', (error) => app.log.error({ err: error }, 'postgres pool error'));
redis.on('error', (error) => app.log.warn({ err: error }, 'redis connection error'));
queueRedis.on('error', (error) => app.log.warn({ err: error }, 'queue redis connection error'));

let shuttingDown = false;

// Phase 1 stops intake (HTTP and the publisher loop, which finishes its current row); phase 2
// closes connections and runs only if phase 1 finished — closing the pool under the publisher's
// open transaction would abort it, so a stuck phase 1 exits hard and lets the outbox recover.
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  const drained = await closeAll([() => app.close(), () => publisher.stop()], 5000);
  if (!drained) {
    app.log.error('shutdown: intake did not stop within the budget, exiting without cleanup');
    process.exit(1);
  }
  await closeAll([
    () => jobs.close(),
    () => pool.end(),
    // quit() rejects while disconnected because the offline queue is disabled
    () => redis.quit().catch(() => redis.disconnect()),
    () => queueRedis.quit().catch(() => queueRedis.disconnect()),
  ]);
  process.exit(0);
}

process.once('SIGTERM', (signal) => void shutdown(signal));
process.once('SIGINT', (signal) => void shutdown(signal));

await app.listen({ port: env.port, host: '0.0.0.0' });
publisher.start();
