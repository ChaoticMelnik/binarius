import { Redis } from 'ioredis';
import { Pool } from 'pg';
import { closeAll, errorLogFields } from '@binarius/shared';
import { createDb, createTokenCipher } from '@binarius/db';
import { buildApp } from './app';
import { createBrokerOAuthClient } from './broker/oauth-client';
import { parseEnv } from './env';
import { createBullmqPublisher } from './outbox/bullmq';
import { OutboxPublisher } from './outbox/publisher';
import { SHUTDOWN_PHASE1_BUDGET_MS, SHUTDOWN_PHASE2_BUDGET_MS } from './timing';

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
const cipher = createTokenCipher({
  keyId: env.tokenEncryptionKeyId,
  key: env.tokenEncryptionKey,
});
const broker = createBrokerOAuthClient({
  baseUrl: env.brokerApiBaseUrl,
  clientId: env.brokerClientId,
  clientSecret: env.brokerClientSecret,
});

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
  auth: {
    db,
    cipher,
    broker,
    internalApiToken: env.internalApiToken,
    authorizeUrl: env.brokerOauthAuthorizeUrl,
    clientId: env.brokerClientId,
    redirectUri: env.brokerOauthRedirectUri,
    partnerRef: env.brokerPartnerRef,
  },
});

const publisher = new OutboxPublisher({ db, jobs, logger: app.log });

// an unhandled 'error' on either client would crash the process instead of degrading /health
pool.on('error', (error) => app.log.error(errorLogFields(error), 'postgres pool error'));
redis.on('error', (error) => app.log.warn(errorLogFields(error), 'redis connection error'));
queueRedis.on('error', (error) =>
  app.log.warn(errorLogFields(error), 'queue redis connection error'),
);

let shuttingDown = false;

// Phase 1 stops intake (HTTP and the publisher loop, which finishes its current row); phase 2
// closes connections and runs only if phase 1 finished — closing the pool under the publisher's
// open transaction would abort it, so a stuck or failed phase 1 exits hard and lets the outbox
// recover. A phase-2 failure is reported through the exit code too. Budgets: timing.ts.
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  const drained = await closeAll(
    [() => app.close(), () => publisher.stop()],
    SHUTDOWN_PHASE1_BUDGET_MS,
  );
  if (!drained) {
    app.log.error('shutdown: intake did not stop within the budget, exiting without cleanup');
    process.exit(1);
  }
  const cleaned = await closeAll(
    [
      () => jobs.close(),
      () => pool.end(),
      // quit() rejects while disconnected because the offline queue is disabled
      () => redis.quit().catch(() => redis.disconnect()),
      () => queueRedis.quit().catch(() => queueRedis.disconnect()),
    ],
    SHUTDOWN_PHASE2_BUDGET_MS,
  );
  if (!cleaned) app.log.error('shutdown: a connection did not close cleanly');
  process.exit(cleaned ? 0 : 1);
}

process.once('SIGTERM', (signal) => void shutdown(signal));
process.once('SIGINT', (signal) => void shutdown(signal));

await app.listen({ port: env.port, host: '0.0.0.0' });
publisher.start();
