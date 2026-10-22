import { Api } from 'grammy';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import {
  BOT_TEXTS_REFRESH_MS,
  BROKER_RATE_LIMIT_PER_MINUTE,
  CANDLE_CLOSE_SLACK_MS,
  brokerGetsPerMinute,
  cashierUrlOf,
  closeAll,
  createBotTextRefresher,
  errorLogFields,
  SERVICE_ACCOUNTS_MIN,
  SIGNAL_SCAN_INTERVALS,
} from '@binarius/shared';
import { createBrokerRestClient, createPairsCatalog } from '@binarius/broker-rest';
import { createBrokerSocketClient } from '@binarius/broker-socket';
import {
  checkSchemaAtStartup,
  createDb,
  createSessionIntent,
  createTokenCipher,
  listActiveH1Sessions,
  listBotTextOverrides,
  listServiceBrokerAccounts,
  readSessionHistory,
  recordSignalDecision,
  setLastAnalysis,
  stopTradingSession,
} from '@binarius/db';
import { createCachedSignalFeed, createSignalFeed } from '@binarius/signal';
import { createAdminBot } from './admin/telegram';
import { createBotProfileApi } from './bot-texts/publish';
import { buildApp } from './app';
import type { TradingRoutesDeps } from './trading/routes';
import { createClientPush } from './auth/client-push';
import { createMailingEngine } from './mailing/engine';
import { createDepositModeSwitcher } from './trading/deposit-mode-switch';
import { createSessionNoticeSender } from './trading/session-notices';
import { createStarReconciler } from './payments/star-reconciler';
import { setBotTextSource } from './auth/texts';
import { DEPOSIT_INIT_DATA_MAX_AGE_MS, INIT_DATA_MAX_AGE_MS } from './auth/oauth-timing';
import { createInitDataVerifier } from './auth/telegram-init-data';
import { ensureFreshAccessToken } from './auth/token-service';
import { createBalanceReconciler } from './broker/balance-reconciler';
import { createBrokerOAuthClient } from './broker/oauth-client';
import { createServiceAccountKeeper } from './broker/service-accounts';
import { parseEnv } from './env';
import { createMarketDataManager } from './market-data/manager';
import { createTickStore } from './market-data/ticks';
import { createSecondSeries } from './market-data/seconds';
import { createH1Shadow } from './h1/shadow';
import { createH1Driver } from './h1/driver';
import { createTradeLogKeeper } from './trade-log/keeper';
import { createCandleRing } from './market-data/ring';
import { createCandleSource, createPendingRequests } from './market-data/source';
import { createCandleBackfill } from './market-data/backfill';
import { createBullmqPublisher } from './outbox/bullmq';
import { OutboxPublisher } from './outbox/publisher';
import { createScanPacer, type SpareTokenSource } from './signal/pacer';
import { createSignalScanner } from './signal/scanner';
import {
  BOT_TEXTS_LOAD_BUDGET_MS,
  MARKET_DATA_ACCOUNT_RETRY_MS,
  MARKET_DATA_BACKFILL_ATTEMPTS,
  MARKET_DATA_BACKFILL_BUDGET_MS,
  MARKET_DATA_BACKFILL_CONCURRENCY,
  H1_SECOND_CLOSE_MARGIN_MS,
  TRADE_TICKS_AHEAD_MS,
  TRADE_TICKS_BUFFER_MS,
  TRADE_TICKS_MAX_PER_PAIR,
  H1_SERIES_CAPACITY_SEC,
  H1_SHADOW_LOG_MS,
  H1_SHADOW_TICK_MS,
  H1_DRIVER_LOG_MS,
  H1_DRIVER_SCAN_MS,
  MARKET_DATA_BACKFILL_POLL_MS,
  MARKET_DATA_BACKFILL_RETRY_MS,
  MARKET_DATA_BACKFILL_SCAN_MS,
  MARKET_DATA_FAILOVER_GRACE_MS,
  MARKET_DATA_LOG_MS,
  MARKET_DATA_PENDING_MAX,
  MARKET_DATA_RESERVE_READY_MS,
  MARKET_DATA_RING_CANDLES,
  MARKET_DATA_SKEW_MARGIN_MS,
  MARKET_DATA_TICK_MS,
  SERVICE_ACCOUNTS_TICK_MS,
  SERVICE_RENEWALS_PER_TICK,
  SERVICE_STALLED_RETRY_MS,
  SERVICE_TOKEN_RENEW_AHEAD_MS,
  SERVICE_TOKEN_ROTATION_GAP_MS,
  SHUTDOWN_PHASE1_BUDGET_MS,
  SHUTDOWN_PHASE2_BUDGET_MS,
  SIGNAL_CACHE_MAX_TTL_MS,
  SIGNAL_FETCH_BUDGET_MS,
  SIGNAL_SCAN_BACKOFF_MAX_MS,
  SIGNAL_SCAN_BACKOFF_MIN_MS,
  SIGNAL_SCAN_LOG_MS,
  signalRestCapacity,
  STARS_TELEGRAM_API_TIMEOUT_MS,
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
// The fetch clients log to the app's logger, which does not exist yet: nothing calls them before
// it does.
const fetchLogger = {
  error: (object: object, message: string) => app.log.error(object, message),
  warn: (object: object, message: string) => app.log.warn(object, message),
};

const broker = createBrokerOAuthClient({
  baseUrl: env.brokerApiBaseUrl,
  clientId: env.brokerClientId,
  clientSecret: env.brokerClientSecret,
  logger: fetchLogger,
});

// One REST client for the process: the pairs catalog and the balance reconciler. It adds
// /v1/broker/... to the same base the OAuth client uses.
const brokerRest = createBrokerRestClient({ baseUrl: env.brokerApiBaseUrl, logger: fetchLogger });

// The route reads it from the first request on; it is warmed before listen() and refreshed by its
// own timer every BROKER_PAIRS_TTL_MS (docs/pairs-catalog.md).
const pairsCatalog = createPairsCatalog({
  client: brokerRest,
  ttlMs: env.brokerPairsTtlMs,
  // the app's logger does not exist yet, and this one is first used by the warm-up below
  logger: {
    warn: (object, message) => app.log.warn(object, message),
    error: (object, message) => app.log.error(object, message),
    info: (object, message) => app.log.info(object, message),
  },
});

// docs/market-data.md: the candle ring and its refill requests (#404, #590), only with
// BROKER_WS_URL; built before the signal feed, which reads them through createCandleSource (#405)
const candleStore =
  env.brokerWsUrl === undefined
    ? undefined
    : {
        brokerWsUrl: env.brokerWsUrl,
        ring: createCandleRing({
          capacity: MARKET_DATA_RING_CANDLES,
          skewMarginMs: MARKET_DATA_SKEW_MARGIN_MS,
          intervals: SIGNAL_SCAN_INTERVALS,
        }),
        requests: createPendingRequests(MARKET_DATA_PENDING_MAX),
        // the newest tick per pair, answered with a session's decision record (#666), and the
        // window of ticks the trade log keeper captures around a decision (#668)
        ticks: createTickStore({
          bufferMs: TRADE_TICKS_BUFFER_MS,
          maxPerPair: TRADE_TICKS_MAX_PER_PAIR,
          aheadMs: TRADE_TICKS_AHEAD_MS,
        }),
        // the 1s closes the H1 shadow decides on (#669, docs/h1.md)
        seconds: createSecondSeries({
          capacitySec: H1_SERIES_CAPACITY_SEC,
          closeMarginMs: H1_SECOND_CLOSE_MARGIN_MS,
        }),
      };

// One pacer for every signal chart GET (docs/signal.md -> The budget, #405): tryTake for the
// feed's on-demand GETs without the source, tryTakeSpare for the candle backfill.
const signalPacer = createScanPacer({
  perMinute: env.signalScanMaxPerMinute,
  capacity: signalRestCapacity(env.signalScanMaxPerMinute),
  backoffMinMs: SIGNAL_SCAN_BACKOFF_MIN_MS,
  backoffMaxMs: SIGNAL_SCAN_BACKOFF_MAX_MS,
  now: Date.now,
});
// built only with BROKER_WS_URL; its streaming reads marketData, declared below: the feed reads the
// source on requests and the scanners on scans, both only after listen()
const marketDataSource =
  candleStore === undefined
    ? undefined
    : createCandleSource({
        ring: candleStore.ring,
        requests: candleStore.requests,
        streaming: () => marketData?.manager.streaming() ?? false,
      });

// POST /trading/signal (docs/signal.md -> POST /trading/signal): the data socket's window while it
// streams, otherwise one public chart GET per (asset, interval) per candle at most, on the same
// REST client and the signal pacer. No timer: nothing to stop.
const signalFeed = createCachedSignalFeed(
  createSignalFeed({
    rest: brokerRest,
    source: marketDataSource,
    pacer: signalPacer,
    // the app's logger does not exist yet, and this one is first used by a request
    logger: {
      info: (object, message) => app.log.info(object, message),
      warn: (object, message) => app.log.warn(object, message),
    },
  }),
  { fetchBudgetMs: SIGNAL_FETCH_BUDGET_MS, maxTtlMs: SIGNAL_CACHE_MAX_TTL_MS },
);

// The background scan of every eligible pair from the data socket's window (docs/signal.md ->
// The scanner, #405), one scanner per interval, through the same cache, so a manual analysis of a
// scanned pair in that candle is a hit. Without a streaming source it keeps no entry. Started with
// the other loops after listen(), stopped in phase 1.
const signalScanners = SIGNAL_SCAN_INTERVALS.map((interval) =>
  createSignalScanner({
    interval,
    feed: signalFeed,
    catalog: pairsCatalog,
    streaming: () => marketData?.manager.streaming() ?? false,
    // the app's logger does not exist yet, and this one is first used by the first scan
    logger: {
      info: (object, message) => app.log.info(object, message),
      warn: (object, message) => app.log.warn(object, message),
    },
    now: Date.now,
    slackMs: CANDLE_CLOSE_SLACK_MS,
    logEveryMs: SIGNAL_SCAN_LOG_MS,
  }),
);

// created before the app so the routes can hold it; polling starts after listen()
const adminBot = createAdminBot({
  token: env.adminBotToken,
  db,
  webPublicUrl: env.webPublicUrl,
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

// One function, three consumers: the worker's token route (#90), the balance reconciler and the
// cashier's widget session (#11). The app's logger is read at call time, after buildApp.
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
    signals: signalFeed,
    internalApiToken: env.internalApiToken,
    demoOnly: env.demoOnly,
    stakeStrategy: env.sessionStakeStrategy,
    decisions: { record: (input) => recordSignalDecision(db, input) },
    ticks: candleStore?.ticks,
  },
  signal: {
    feed: signalFeed,
    catalog: pairsCatalog,
    internalApiToken: env.internalApiToken,
    lastAnalysis: {
      set: (telegramUserId, analysis) => setLastAnalysis(db, telegramUserId, analysis),
    },
    ticks: candleStore?.ticks,
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
  payments: {
    db,
    internalApiToken: env.internalApiToken,
    notifyStaff: async (text) => {
      await adminBot.notifyStaff(text);
    },
  },
  admin: {
    db,
    adminWebToken: env.adminWebToken,
    telegram: adminBot,
    botProfileApi: createBotProfileApi({ token: env.telegramBotToken }),
  },
  deposit: {
    db,
    accessToken,
    rest: brokerRest,
    initDataVerifier: createInitDataVerifier({
      botToken: env.telegramBotToken,
      maxAgeMs: DEPOSIT_INIT_DATA_MAX_AGE_MS,
    }),
    // the reconciler is created after the app, as for trading
    balance: { refresh: (accountId, options) => balanceReconciler.refresh(accountId, options) },
    clientPush,
    demoOnly: env.demoOnly,
    webOrigin: env.webPublicUrl,
    platformOrigin: new URL(env.brokerOauthAuthorizeUrl).origin,
    clientId: env.brokerClientId,
    widgetOrigins: env.depositWidgetOrigins,
  },
  postbacks:
    env.postbackUrlSecret === undefined ? undefined : { db, secret: env.postbackUrlSecret },
});

const publisher = new OutboxPublisher({ db, jobs, logger: app.log });

// docs/mailing.md: the reminders and notifications (#202, #484, #576, #123); started with the other loops after
// listen(), stopped in phase 1
const mailing = createMailingEngine({
  db,
  push: clientPush,
  logger: app.log,
  cashierUrl: cashierUrlOf(env.webPublicUrl),
});

// docs/trading-mode.md → The automatic switch after a deposit (#686): switches a demo user to real
// once a deposit is theirs, and wakes the planner for the message. With DEMO_ONLY nobody is
// switched. Started with the other loops after listen(), stopped in phase 1 before the mailing
// engine, so its last wake finds the planner still running.
const depositModeSwitcher = createDepositModeSwitcher({
  db,
  demoOnly: env.demoOnly,
  logger: app.log,
  onSwitched: () => mailing.wakePlan(),
});

// docs/stars.md → Reconciliation (#117): credits a Stars payment whose successful_payment the bot
// lost; the public bot's token, read-only on Telegram's side (getStarTransactions), and pushes
// through the client push. Started with the other loops after listen(), stopped in phase 1.
const starsApi = new Api(env.telegramBotToken, {
  timeoutSeconds: STARS_TELEGRAM_API_TIMEOUT_MS / 1000,
});
const starReconciler = createStarReconciler({
  db,
  readTransactions: async (offset, limit) =>
    (await starsApi.getStarTransactions({ offset, limit })).transactions,
  push: clientPush,
  logger: app.log,
});

// docs/trade-log.md → The ticks around a decision, → Retention (#668): captures the ticks around
// each intent decision and a sample of the shadow ones (only with BROKER_WS_URL), and sweeps the
// decisions without a trade past their retention. Started after listen(), stopped in phase 1.
const tradeLogKeeper = createTradeLogKeeper({ db, ticks: candleStore?.ticks, logger: app.log });

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

// docs/service-accounts.md: the one timer that exchanges a token, and only a service account's
// (#391); it also tells the staff bot when fewer than SERVICE_ACCOUNTS_MIN of them work
const serviceAccounts = createServiceAccountKeeper({
  db,
  accessToken,
  notifyStaff: (text, signal) => adminBot.notifyStaff(text, signal),
  logger: app.log,
  config: {
    tickMs: SERVICE_ACCOUNTS_TICK_MS,
    renewAheadMs: SERVICE_TOKEN_RENEW_AHEAD_MS,
    rotationGapMs: SERVICE_TOKEN_ROTATION_GAP_MS,
    perTick: SERVICE_RENEWALS_PER_TICK,
    stalledRetryMs: SERVICE_STALLED_RETRY_MS,
    minWorking: SERVICE_ACCOUNTS_MIN,
  },
});

// docs/market-data.md: the data socket on a service account that builds the candle store's ring
// (#404) and its REST backfill (#590), read by the signal feed and the scanners (#405). Started with
// the other loops after listen(), stopped in phase 1.
function createMarketData(
  { brokerWsUrl, ring, requests, ticks, seconds }: NonNullable<typeof candleStore>,
  pacer: SpareTokenSource,
) {
  const backfill = createCandleBackfill({
    ring,
    requests,
    catalog: pairsCatalog,
    rest: brokerRest,
    pacer,
    // called by the backfill's timers only, which start after the manager below exists
    streaming: () => manager.streaming(),
    logger: app.log,
    config: {
      scanMs: MARKET_DATA_BACKFILL_SCAN_MS,
      pollMs: MARKET_DATA_BACKFILL_POLL_MS,
      retryMs: MARKET_DATA_BACKFILL_RETRY_MS,
      attempts: MARKET_DATA_BACKFILL_ATTEMPTS,
      budgetMs: MARKET_DATA_BACKFILL_BUDGET_MS,
      concurrency: MARKET_DATA_BACKFILL_CONCURRENCY,
      slackMs: CANDLE_CLOSE_SLACK_MS,
      candles: MARKET_DATA_RING_CANDLES,
    },
  });
  const manager = createMarketDataManager({
    listAccounts: () => listServiceBrokerAccounts(db),
    accessToken,
    catalog: pairsCatalog,
    openClient: (label) =>
      createBrokerSocketClient({ url: brokerWsUrl, logger: app.log.child({ socket: label }) }),
    ring,
    ticks,
    seconds,
    requests,
    backfill,
    logger: app.log,
    config: {
      tickMs: MARKET_DATA_TICK_MS,
      logMs: MARKET_DATA_LOG_MS,
      failoverGraceMs: MARKET_DATA_FAILOVER_GRACE_MS,
      reserveReadyMs: MARKET_DATA_RESERVE_READY_MS,
      accountRetryMs: MARKET_DATA_ACCOUNT_RETRY_MS,
    },
  });
  // docs/h1.md: the H1 shadow on the same series, unless H1_SHADOW=off (#669)
  const h1Shadow = env.h1Shadow
    ? createH1Shadow({
        series: seconds,
        catalog: pairsCatalog,
        streaming: () => manager.streaming(),
        record: (input) => recordSignalDecision(db, input),
        logger: app.log,
        config: {
          tickMs: H1_SHADOW_TICK_MS,
          logMs: H1_SHADOW_LOG_MS,
          capacitySec: H1_SERIES_CAPACITY_SEC,
        },
      })
    : undefined;
  // docs/h1.md -> The driver: the H1 sessions' intents on the same series (#707); no switch, with
  // no active H1 session it only listens. It advances the series too, so H1_SHADOW=off still
  // closes quiet seconds
  const h1Driver = createH1Driver({
    series: seconds,
    catalog: pairsCatalog,
    streaming: () => manager.streaming(),
    sessions: {
      list: () => listActiveH1Sessions(db),
      history: (id, options) => readSessionHistory(db, id, options),
      createIntent: (input) => createSessionIntent(db, input, { demoOnly: env.demoOnly }),
      stop: (id, reason) => stopTradingSession(db, { id, reason }),
      record: (input) => recordSignalDecision(db, input),
    },
    wake: () => publisher.wake(),
    logger: app.log,
    config: {
      scanMs: H1_DRIVER_SCAN_MS,
      tickMs: H1_SHADOW_TICK_MS,
      logMs: H1_DRIVER_LOG_MS,
      submitBudgetMs: env.h1SubmitBudgetMs,
    },
  });
  return { manager, backfill, h1Shadow, h1Driver };
}
const marketData =
  candleStore === undefined ? undefined : createMarketData(candleStore, signalPacer);

// docs/bot-session.md → Trade messages (#464): every settled trade of a session as its own silent
// message and the finished session's summary; started with the other loops after listen(),
// stopped in phase 1
const sessionNotices = createSessionNoticeSender({
  db,
  push: clientPush,
  catalog: pairsCatalog,
  balance: balanceReconciler,
  logger: app.log,
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
      async () => {
        await depositModeSwitcher.stop();
        await mailing.stop();
      },
      () => sessionNotices.stop(),
      () => starReconciler.stop(),
      () => serviceAccounts.stop(),
      () => tradeLogKeeper.stop(),
      async () => {
        await marketData?.h1Driver.stop();
        await marketData?.h1Shadow?.stop();
        await marketData?.backfill.stop();
        await marketData?.manager.stop();
      },
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

// before the warm-up and listen(): a schema behind this image would fail requests at run time
if (!(await checkSchemaAtStartup(pool, app.log))) process.exit(1);

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
  app.log.info({ enabled: env.postbackUrlSecret !== undefined }, 'postback route');
  app.log.info({ enabled: marketData !== undefined }, 'market data source');
  app.log.info({ enabled: marketData?.h1Shadow !== undefined }, 'h1 shadow');
  app.log.info(
    { enabled: marketData !== undefined, submitBudgetMs: env.h1SubmitBudgetMs },
    'h1 driver',
  );
  app.log.info({ capture: candleStore !== undefined }, 'trade log keeper');
  app.log.info({ demoOnly: env.demoOnly }, 'deposit mode switch');
}
if (!shuttingDown) {
  publisher.start();
  balanceReconciler.start();
  for (const scanner of signalScanners) scanner.start();
  botTexts.start();
  mailing.start();
  depositModeSwitcher.start();
  sessionNotices.start();
  starReconciler.start();
  serviceAccounts.start();
  marketData?.manager.start();
  marketData?.backfill.start();
  marketData?.h1Shadow?.start();
  marketData?.h1Driver.start();
  tradeLogKeeper.start();
  // A failed start is logged and leaves isPolling() false; it does not stop the process, and
  // every staff login then answers 503 with a row in audit_log saying why.
  adminBot.start();
}
