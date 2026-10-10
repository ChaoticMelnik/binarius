import { Redis } from 'ioredis';
import { Pool } from 'pg';
import {
  BOT_TEXTS_REFRESH_MS,
  BROKER_RATE_LIMIT_PER_MINUTE,
  brokerGetsPerMinute,
  closeAll,
  createBotTextRefresher,
  errorLogFields,
  SIGNAL_SCAN_INTERVALS,
} from '@binarius/shared';
import { createBrokerRestClient, createPairsCatalog } from '@binarius/broker-rest';
import { createDb, createTokenCipher, listBotTextOverrides } from '@binarius/db';
import { createCachedSignalFeed, createSignalFeed } from '@binarius/signal';
import { createAdminBot } from './admin/telegram';
import { createBotProfileApi } from './bot-texts/publish';
import { buildApp } from './app';
import type { TradingRoutesDeps } from './trading/routes';
import { createClientPush } from './auth/client-push';
import { createMailingEngine } from './mailing/engine';
import { setBotTextSource } from './auth/texts';
import { INIT_DATA_MAX_AGE_MS } from './auth/oauth-timing';
import { createInitDataVerifier } from './auth/telegram-init-data';
import { ensureFreshAccessToken } from './auth/token-service';
import { createBalanceReconciler } from './broker/balance-reconciler';
import { createBrokerOAuthClient } from './broker/oauth-client';
import { parseEnv } from './env';
import { createBullmqPublisher } from './outbox/bullmq';
import { OutboxPublisher } from './outbox/publisher';
import { createScanPacer } from './signal/pacer';
import { createSignalScanner } from './signal/scanner';
import {
  BOT_TEXTS_LOAD_BUDGET_MS,
  SHUTDOWN_PHASE1_BUDGET_MS,
  SHUTDOWN_PHASE2_BUDGET_MS,
  SIGNAL_CACHE_MAX_TTL_MS,
  SIGNAL_FETCH_BUDGET_MS,
  SIGNAL_SCAN_BACKOFF_MAX_MS,
  SIGNAL_SCAN_BACKOFF_MIN_MS,
  SIGNAL_SCAN_CONCURRENCY,
  SIGNAL_SCAN_LOG_MS,
  SIGNAL_SCAN_SLACK_MS,
  signalScanCapacity,
  signalScanPairs,
  signalScanPerMinute,
} from './timing';

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

// One REST client for the process: the pairs catalog and the balance reconciler. It adds
// /v1/broker/... to the same base the OAuth client uses.
const brokerRest = createBrokerRestClient({ baseUrl: env.brokerApiBaseUrl });

// The route reads it from the first request on; it is warmed before listen() and refreshed by its
// own timer every BROKER_PAIRS_TTL_MS (docs/pairs-catalog.md).
const pairsCatalog = createPairsCatalog({
  client: brokerRest,
  ttlMs: env.brokerPairsTtlMs,
  // the app's logger does not exist yet, and this one is first used by the warm-up below
  logger: { warn: (object, message) => app.log.warn(object, message) },
});

// POST /trading/signal (docs/signal.md -> POST /trading/signal): one public chart GET per
// (asset, interval) per candle at most, on the same REST client. No timer: nothing to stop.
const signalFeed = createCachedSignalFeed(
  createSignalFeed({
    rest: brokerRest,
    // the app's logger does not exist yet, and this one is first used by a request
    logger: {
      info: (object, message) => app.log.info(object, message),
      warn: (object, message) => app.log.warn(object, message),
    },
  }),
  { fetchBudgetMs: SIGNAL_FETCH_BUDGET_MS, maxTtlMs: SIGNAL_CACHE_MAX_TTL_MS },
);

// The background scan of the top pairs (docs/signal.md -> The scanner), one scanner per interval,
// each on its own pacer and share of the ceiling (#382): through the same cache, so a manual
// analysis of a scanned pair in that candle costs no second GET. Started with the other loops
// after listen(), stopped in phase 1.
const signalScanners = SIGNAL_SCAN_INTERVALS.map((interval) => {
  const pairs = signalScanPairs(env.signalScanMaxPerMinute, interval);
  return createSignalScanner({
    interval,
    feed: signalFeed,
    catalog: pairsCatalog,
    pacer: createScanPacer({
      perMinute: signalScanPerMinute(env.signalScanMaxPerMinute, interval),
      capacity: signalScanCapacity(env.signalScanMaxPerMinute, interval),
      backoffMinMs: SIGNAL_SCAN_BACKOFF_MIN_MS,
      backoffMaxMs: SIGNAL_SCAN_BACKOFF_MAX_MS,
      now: Date.now,
    }),
    // the app's logger does not exist yet, and this one is first used by the first scan
    logger: {
      info: (object, message) => app.log.info(object, message),
      warn: (object, message) => app.log.warn(object, message),
    },
    now: Date.now,
    maxPairs: pairs,
    slackMs: SIGNAL_SCAN_SLACK_MS,
    concurrency: SIGNAL_SCAN_CONCURRENCY,
    logEveryMs: SIGNAL_SCAN_LOG_MS,
  });
});

// created before the app so the routes can hold it; polling starts after listen()
const adminBot = createAdminBot({
  token: env.adminBotToken,
  db,
  // the app's logger does not exist yet, and this one is only used once polling is running
  logger: {
    info: (object, message) => app.log.info(object, message),
    warn: (object, message) => app.log.warn(object, message),
    error: (object, message) => app.log.error(object, message),
  },
});

// The public bot's token for what the backend sends a user on its own: the link push and the
// mailings (auth/client-push.ts).
const clientPush = createClientPush({ token: env.telegramBotToken });

// One function, two consumers: the worker's token route (#90) and the balance reconciler. The app's
// logger is read at call time, after buildApp.
const accessToken: TradingRoutesDeps['accessToken'] = (accountId, options) =>
  ensureFreshAccessToken({ db, broker, cipher, logger: app.log }, accountId, options);

const app = buildApp({
  checkPostgres: () => pool.query('SELECT 1'),
  checkRedis: () => redis.ping(),
  logLevel: env.logLevel,
  checkTimeoutMs: env.healthTimeoutMs,
  trading: {
    db,
    internalApiToken: env.internalApiToken,
    onIntentQueued: () => publisher.wake(),
    // the reconciler needs the app's logger, so it is created after the app
    balance: { refresh: (accountId, options) => balanceReconciler.refresh(accountId, options) },
    accessToken,
    demoOnly: env.demoOnly,
  },
  pairs: {
    catalog: pairsCatalog,
    internalApiToken: env.internalApiToken,
  },
  sessions: {
    db,
    catalog: pairsCatalog,
    balance: { refresh: (accountId, options) => balanceReconciler.refresh(accountId, options) },
    internalApiToken: env.internalApiToken,
    demoOnly: env.demoOnly,
  },
  signal: {
    feed: signalFeed,
    catalog: pairsCatalog,
    internalApiToken: env.internalApiToken,
  },
  signals: {
    scanners: signalScanners,
    internalApiToken: env.internalApiToken,
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
    clientPush,
    initDataVerifier: createInitDataVerifier({
      botToken: env.telegramBotToken,
      maxAgeMs: INIT_DATA_MAX_AGE_MS,
    }),
  },
  users: {
    db,
    internalApiToken: env.internalApiToken,
  },
  admin: {
    db,
    adminWebToken: env.adminWebToken,
    telegram: adminBot,
    botProfileApi: createBotProfileApi({ token: env.telegramBotToken }),
  },
});

const publisher = new OutboxPublisher({ db, jobs, logger: app.log });

// docs/mailing.md: the first-session reminders (#202); started with the other loops after
// listen(), stopped in phase 1
const mailing = createMailingEngine({ db, push: clientPush, logger: app.log });

// docs/broker-balance.md: refreshed on demand by POST /trading/access and every
// BALANCE_RECONCILE_INTERVAL_MS over the accounts in work, the latter never exchanging a token
const balanceReconciler = createBalanceReconciler({
  db,
  client: brokerRest,
  accessToken,
  logger: app.log,
  config: {
    intervalMs: env.balanceReconcileIntervalMs,
    maxPerMinute: env.balancePollMaxPerMinute,
  },
});

// docs/signal.md -> The budget: the defaults fit the broker's per-IP window (checked at import);
// ceilings raised over it are the operator's choice, said once here
const brokerGets = brokerGetsPerMinute({
  balancePollPerMinute: env.balancePollMaxPerMinute,
  signalScanPerMinute: env.signalScanMaxPerMinute,
});
if (brokerGets > BROKER_RATE_LIMIT_PER_MINUTE) {
  app.log.warn(
    { brokerGetsPerMinute: brokerGets, limit: BROKER_RATE_LIMIT_PER_MINUTE },
    'broker budget over the per-IP limit',
  );
}

// the push's texts with their overrides (docs/bot-texts.md → Loading)
const botTexts = createBotTextRefresher({
  load: () => listBotTextOverrides(db),
  intervalMs: BOT_TEXTS_REFRESH_MS,
  budgetMs: BOT_TEXTS_LOAD_BUDGET_MS,
  apply: setBotTextSource,
  logger: app.log,
});

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
    [
      () => app.close(),
      () => publisher.stop(),
      () => adminBot.stop(),
      () => Promise.resolve(pairsCatalog.stop()),
      () => Promise.all(signalScanners.map((scanner) => scanner.stop())),
      () => balanceReconciler.stop(),
      () => botTexts.stop(),
      () => mailing.stop(),
    ],
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

// A failed warm-up is logged as a warn and the route answers 503 until a tick succeeds.
const warmed = await pairsCatalog.refresh();
// A SIGTERM during the warm-up or during listen() has already started phase 1, and no start()
// may run after its stop(): the publisher would restart its loop on the pool phase 2 closes. So
// each await is followed by a fresh check.
if (!shuttingDown) {
  pairsCatalog.start();
  app.log.info({ warmed }, 'pairs catalog started');
  await app.listen({ port: env.port, host: '0.0.0.0' });
  // #397's manager greps this line for "demoOnly":true before it drives a stand
  app.log.info({ demoOnly: env.demoOnly }, 'backend started');
}
if (!shuttingDown) {
  publisher.start();
  balanceReconciler.start();
  for (const scanner of signalScanners) scanner.start();
  botTexts.start();
  mailing.start();
  // A failed start is logged and leaves isPolling() false; it does not stop the process, and
  // every staff login then answers 503 with a row in audit_log saying why.
  adminBot.start();
}
