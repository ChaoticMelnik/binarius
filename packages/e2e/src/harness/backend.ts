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
  createH1Driver,
  createH1Scanner,
  createInitDataVerifier,
  createScanPacer,
  createSecondSeries,
  createSessionNoticeListener,
  createSessionNoticeSender,
  DEPOSIT_INIT_DATA_MAX_AGE_MS,
  ensureFreshAccessToken,
  H1_SCANNER_LOG_MS,
  H1_SECOND_CLOSE_MARGIN_MS,
  H1_SERIES_CAPACITY_SEC,
  H1_SERIES_TICK_MS,
  H1_START_SECOND_MAX_AGE_MS,
  INIT_DATA_MAX_AGE_MS,
  OutboxPublisher,
  SIGNAL_CACHE_MAX_TTL_MS,
  SIGNAL_FETCH_BUDGET_MS,
  SIGNAL_SCAN_BACKOFF_MAX_MS,
  SIGNAL_SCAN_BACKOFF_MIN_MS,
  SESSION_NOTICE_TICK_MS,
  signalRestCapacity,
  unusedAdminDeps,
  unusedDepositDeps,
  unusedPaymentsDeps,
  type TradingRoutesDeps,
} from '@binarius/backend/e2e';
import { createBrokerRestClient, createPairsCatalog } from '@binarius/broker-rest';
import {
  createSessionIntent,
  createTokenCipher,
  listActiveH1Sessions,
  readSessionBalance,
  readSessionHistory,
  recordSignalDecision,
  SESSION_NOTICE_CHANNEL,
  setLastAnalysis,
  stopTradingSession,
  type Db,
} from '@binarius/db';
import { SessionStakeStrategy } from '@binarius/shared';
import { DEFAULT_SIGNAL_SCAN_PER_MINUTE } from '@binarius/shared/broker-budget';
import { createCachedSignalFeed, createSignalFeed } from '@binarius/signal';
import {
  BOT_TOKEN,
  E2E_PAIR,
  E2E_POSTBACK_SECRET,
  INTERNAL_API_TOKEN,
  MOCK_OAUTH,
  PARTNER_REF,
  REDIRECT_URI,
} from './env';
import { startH1Pump } from './h1';
import type { LogSink } from './logs';
import type { createTelegram, TelegramSide } from './telegram';

// The test's settings for the backend's loops; production's constants are not touched
// (docs/e2e-demo-cycle.md → Components)
export const E2E_BACKEND_TUNING = {
  // the publisher's poll, woken by every queued intent anyway (onIntentQueued)
  publisherPollMs: 50,
  // the session messages' tick, pace and gap per chat (production: SESSION_NOTICE_TICK_MS,
  // SESSION_NOTICE_SEND_PER_SECOND, SESSION_NOTICE_CHAT_GAP_MS); the gap no longer than the tick,
  // as in production (#660). The tick is production's (#723): a message within a second of its
  // trade is the wake's, not a short tick's
  noticeTickMs: SESSION_NOTICE_TICK_MS,
  noticePerSecond: 50,
  noticeChatGapMs: 100,
  // one warm-up before listen(), as index.ts does; nothing in the run waits for a second refresh
  pairsTtlMs: 60_000,
  // the reconciler is not started: the routes call refresh() themselves
  balanceIntervalMs: 60_000,
  balanceMaxPerMinute: 100,
  // the H1 driver's submit budget (#828): the run's take of an intent is not timed, as in
  // session-routes.db.test.ts H1-R10; its scan reads the active sessions once a second
  h1SubmitBudgetMs: 5_000,
  h1ScanMs: 1_000,
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

  // index.ts's H1 parts (#828, docs/h1.md) on a second series the pump fills, since the run has
  // no data socket: the scanner serves the signals list and the analysis's `h1`, the driver trades
  // every session the bot starts
  const seconds = createSecondSeries({
    capacitySec: H1_SERIES_CAPACITY_SEC,
    closeMarginMs: H1_SECOND_CLOSE_MARGIN_MS,
  });
  const streaming = () => true;
  const h1Scanner = createH1Scanner({
    series: seconds,
    catalog: pairsCatalog,
    streaming,
    logger: log,
    config: { logMs: H1_SCANNER_LOG_MS, maxAgeMs: H1_START_SECOND_MAX_AGE_MS },
  });
  const h1Driver = createH1Driver({
    series: seconds,
    catalog: pairsCatalog,
    streaming,
    sessions: {
      list: () => listActiveH1Sessions(db),
      history: (id, options) => readSessionHistory(db, id, options),
      balance: (id, options) => readSessionBalance(db, id, options),
      createIntent: (input) => createSessionIntent(db, input, { demoOnly: false }),
      stop: (id, reason) => stopTradingSession(db, { id, reason }),
      record: (input) => recordSignalDecision(db, input),
    },
    wake: () => publisher.wake(),
    logger: log,
    config: {
      scanMs: E2E_BACKEND_TUNING.h1ScanMs,
      tickMs: H1_SERIES_TICK_MS,
      logMs: 60_000,
      submitBudgetMs: E2E_BACKEND_TUNING.h1SubmitBudgetMs,
      startMaxAgeMs: H1_START_SECOND_MAX_AGE_MS,
    },
  });

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
      internalApiToken: INTERNAL_API_TOKEN,
      demoOnly: false,
      stakeStrategy: SessionStakeStrategy.Martingale,
      // the trade log as in production (#666)
      decisions: { record: (input) => recordSignalDecision(db, input) },
      h1Driver,
    },
    signal: {
      feed: signalFeed,
      catalog: pairsCatalog,
      internalApiToken: INTERNAL_API_TOKEN,
      lastAnalysis: {
        set: (telegramUserId, analysis) => setLastAnalysis(db, telegramUserId, analysis),
      },
      ticks: undefined,
      h1: h1Scanner,
    },
    signals: { scanner: h1Scanner, internalApiToken: INTERNAL_API_TOKEN },
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
      chatGapMs: E2E_BACKEND_TUNING.noticeChatGapMs,
    },
  });
  const sessionNoticeListener = createSessionNoticeListener({
    pool,
    channel: SESSION_NOTICE_CHANNEL,
    onNotification: (sessionId) => {
      sessionNotices.wake();
      h1Driver.notice(sessionId);
    },
    logger: app.log,
  });

  await pairsCatalog.refresh();
  pairsCatalog.start();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;
  publisher.start();
  sessionNotices.start();
  sessionNoticeListener.start();
  // listening before the pump's history goes in, so its last seconds are decided at once
  h1Scanner.start();
  h1Driver.start();
  const pump = startH1Pump({ series: seconds, assetId: E2E_PAIR.id, digits: E2E_PAIR.digits });

  return {
    url: `http://127.0.0.1:${port}`,
    push,
    async stop() {
      await app.close();
      h1Scanner.stop();
      await h1Driver.stop();
      pump.stop();
      await publisher.stop();
      pairsCatalog.stop();
      await balanceReconciler.stop();
      await sessionNoticeListener.stop();
      await sessionNotices.stop();
      await jobs.close();
      await queueRedis.quit();
    },
  };
}
