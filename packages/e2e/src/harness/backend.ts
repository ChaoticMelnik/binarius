import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Redis } from 'ioredis';
import type { Pool } from 'pg';
import {
  buildApp,
  createBalanceReconciler,
  createBrokerOAuthClient,
  createBullmqPublisher,
  createClientPush,
  createInitDataVerifier,
  createScanPacer,
  createSessionNoticeSender,
  DEPOSIT_INIT_DATA_MAX_AGE_MS,
  ensureFreshAccessToken,
  INIT_DATA_MAX_AGE_MS,
  OutboxPublisher,
  SIGNAL_CACHE_MAX_TTL_MS,
  SIGNAL_FETCH_BUDGET_MS,
  SIGNAL_SCAN_BACKOFF_MAX_MS,
  SIGNAL_SCAN_BACKOFF_MIN_MS,
  signalRestCapacity,
  unusedAdminDeps,
  unusedDepositDeps,
  unusedPaymentsDeps,
  unusedSignalsDeps,
  type TradingRoutesDeps,
} from '@binarius/backend/e2e';
import { createBrokerRestClient, createPairsCatalog } from '@binarius/broker-rest';
import { createTokenCipher, recordSignalDecision, setLastAnalysis, type Db } from '@binarius/db';
import { SessionStakeStrategy } from '@binarius/shared';
import { DEFAULT_SIGNAL_SCAN_PER_MINUTE } from '@binarius/shared/broker-budget';
import { createCachedSignalFeed, createSignalFeed } from '@binarius/signal';
import {
  BOT_TOKEN,
  E2E_POSTBACK_SECRET,
  INTERNAL_API_TOKEN,
  MOCK_OAUTH,
  PARTNER_REF,
  REDIRECT_URI,
} from './env';
import type { LogSink } from './logs';
import type { createTelegram, TelegramSide } from './telegram';

// The test's settings for the backend's loops; production's constants are not touched
// (docs/e2e-demo-cycle.md → Components)
export const E2E_BACKEND_TUNING = {
  // the publisher's poll, woken by every queued intent anyway (onIntentQueued)
  publisherPollMs: 50,
  // the session messages' tick and pace (production: 1 s and 25 per second)
  noticeTickMs: 200,
  noticePerSecond: 50,
  // one warm-up before listen(), as index.ts does; nothing in the run waits for a second refresh
  pairsTtlMs: 60_000,
  // the reconciler is not started: the routes call refresh() themselves
  balanceIntervalMs: 60_000,
  balanceMaxPerMinute: 100,
} as const;

export interface E2eBackend {
  url: string;
  push: TelegramSide;
  stop(): Promise<void>;
}

// apps/backend/src/index.ts as the demo cycle needs it: the same constructors and seams, one
// process. What is left out and why — docs/e2e-demo-cycle.md → Components.
export async function startE2eBackend(deps: {
  db: Db;
  pool: Pool;
  redisUrl: string;
  brokerUrl: string;
  queuePrefix: string;
  logs: LogSink;
  telegram: ReturnType<typeof createTelegram>;
}): Promise<E2eBackend> {
  const { db, pool, logs } = deps;
  const queueRedis = new Redis(deps.redisUrl, { maxRetriesPerRequest: null });
  const jobs = createBullmqPublisher(queueRedis, { prefix: deps.queuePrefix });
  const cipher = createTokenCipher({ keyId: 'e2e', key: randomBytes(32) });
  const log = logs.logger;

  const broker = createBrokerOAuthClient({
    baseUrl: deps.brokerUrl,
    clientId: MOCK_OAUTH.clientId,
    clientSecret: MOCK_OAUTH.clientSecret,
    logger: log,
  });
  const brokerRest = createBrokerRestClient({ baseUrl: deps.brokerUrl, logger: log });
  const pairsCatalog = createPairsCatalog({
    client: brokerRest,
    ttlMs: E2E_BACKEND_TUNING.pairsTtlMs,
    logger: log,
  });
  // index.ts's signal pacer; the run has no BROKER_WS_URL, so every chart GET takes a token (#405)
  const signalPacer = createScanPacer({
    perMinute: DEFAULT_SIGNAL_SCAN_PER_MINUTE,
    capacity: signalRestCapacity(DEFAULT_SIGNAL_SCAN_PER_MINUTE),
    backoffMinMs: SIGNAL_SCAN_BACKOFF_MIN_MS,
    backoffMaxMs: SIGNAL_SCAN_BACKOFF_MAX_MS,
    now: Date.now,
  });
  const signalFeed = createCachedSignalFeed(
    createSignalFeed({ rest: brokerRest, pacer: signalPacer, logger: log }),
    { fetchBudgetMs: SIGNAL_FETCH_BUDGET_MS, maxTtlMs: SIGNAL_CACHE_MAX_TTL_MS },
  );
  const clientPush = createClientPush({ token: BOT_TOKEN });
  const push = deps.telegram.push(clientPush);

  const accessToken: TradingRoutesDeps['accessToken'] = (accountId, options) =>
    ensureFreshAccessToken({ db, broker, cipher, logger: log }, accountId, options);
  const balance = {
    refresh: (...args: Parameters<TradingRoutesDeps['balance']['refresh']>) =>
      balanceReconciler.refresh(...args),
  };

  const app = buildApp({
    checkPostgres: () => pool.query('SELECT 1'),
    checkRedis: () => queueRedis.ping(),
    logLevel: 'info',
    checkTimeoutMs: 2_000,
    trading: {
      db,
      internalApiToken: INTERNAL_API_TOKEN,
      onIntentQueued: () => publisher.wake(),
      balance,
      accessToken,
      demoOnly: false,
    },
    pairs: { catalog: pairsCatalog, internalApiToken: INTERNAL_API_TOKEN },
    sessions: {
      db,
      catalog: pairsCatalog,
      balance,
      signals: signalFeed,
      internalApiToken: INTERNAL_API_TOKEN,
      demoOnly: false,
      stakeStrategy: SessionStakeStrategy.Martingale,
      // the trade log as in production (#666); no data socket in the run, so no tick
      decisions: { record: (input) => recordSignalDecision(db, input) },
      ticks: undefined,
    },
    signal: {
      feed: signalFeed,
      catalog: pairsCatalog,
      internalApiToken: INTERNAL_API_TOKEN,
      lastAnalysis: {
        set: (telegramUserId, analysis) => setLastAnalysis(db, telegramUserId, analysis),
      },
      ticks: undefined,
    },
    // the scanners are not built: the run takes the manual door, and a call here fails the test
    signals: unusedSignalsDeps(),
    auth: {
      db,
      cipher,
      broker,
      internalApiToken: INTERNAL_API_TOKEN,
      authorizeUrl: `${deps.brokerUrl}/oauth/authorize`,
      clientId: MOCK_OAUTH.clientId,
      redirectUri: REDIRECT_URI,
      partnerRef: PARTNER_REF,
      clientPush,
      initDataVerifier: createInitDataVerifier({
        botToken: BOT_TOKEN,
        maxAgeMs: INIT_DATA_MAX_AGE_MS,
      }),
    },
    users: { db, internalApiToken: INTERNAL_API_TOKEN },
    // on as in production with POSTBACK_URL_SECRET set (docs/e2e-demo-cycle.md → Components)
    postbacks: { db, secret: E2E_POSTBACK_SECRET },
    payments: unusedPaymentsDeps(),
    admin: unusedAdminDeps(),
    deposit: {
      ...unusedDepositDeps(),
      initDataVerifier: createInitDataVerifier({
        botToken: BOT_TOKEN,
        maxAgeMs: DEPOSIT_INIT_DATA_MAX_AGE_MS,
      }),
    },
    logDestination: { write: logs.write },
  });

  const publisher = new OutboxPublisher({
    db,
    jobs,
    logger: app.log,
    config: { pollMs: E2E_BACKEND_TUNING.publisherPollMs },
  });
  const balanceReconciler = createBalanceReconciler({
    db,
    client: brokerRest,
    accessToken,
    logger: app.log,
    config: {
      intervalMs: E2E_BACKEND_TUNING.balanceIntervalMs,
      maxPerMinute: E2E_BACKEND_TUNING.balanceMaxPerMinute,
    },
  });
  const sessionNotices = createSessionNoticeSender({
    db,
    push: clientPush,
    catalog: pairsCatalog,
    balance: balanceReconciler,
    logger: app.log,
    config: {
      tickMs: E2E_BACKEND_TUNING.noticeTickMs,
      perSecond: E2E_BACKEND_TUNING.noticePerSecond,
    },
  });

  await pairsCatalog.refresh();
  pairsCatalog.start();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;
  publisher.start();
  sessionNotices.start();

  return {
    url: `http://127.0.0.1:${port}`,
    push,
    async stop() {
      await app.close();
      await publisher.stop();
      pairsCatalog.stop();
      await balanceReconciler.stop();
      await sessionNotices.stop();
      await jobs.close();
      await queueRedis.quit();
    },
  };
}
