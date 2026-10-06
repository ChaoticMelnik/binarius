import { Redis } from 'ioredis';
import { Pool } from 'pg';
import pino from 'pino';
import { errorLogFields, closeAll, logOptions } from '@binarius/shared';
import { createBrokerRestClient } from '@binarius/broker-rest';
import { createDb, listLinkedBrokerTradeIds, OutboxTopic } from '@binarius/db';
import { createBackendAccessTokenSource } from './broker/access-token';
import { parseEnv } from './env';
import {
  CATCHUP_ATTEMPT_TIMEOUT_MS,
  CATCHUP_BATCH_SIZE,
  CATCHUP_GRACE_MS,
  CATCHUP_MAX_TRADE_PAGES,
  CATCHUP_STALLED_RETRY_MS,
  CATCHUP_TICK_MS,
  CATCHUP_TRADES_PAGE_SIZE,
  RECONCILE_ATTEMPT_TIMEOUT_MS,
  RECONCILE_BATCH_SIZE,
  RECONCILE_MAX_TRADE_PAGES,
  RECONCILE_RETRY_MS,
  RECONCILE_TICK_MS,
  RECONCILE_TRADES_PAGE_SIZE,
  RECONCILE_WINDOW_AFTER_MS,
  RECONCILE_WINDOW_BEFORE_MS,
  SHUTDOWN_PHASE1_BUDGET_MS,
  SHUTDOWN_PHASE2_BUDGET_MS,
  STALE_SUBMITTING_MS,
  SWEEP_BATCH_SIZE,
  SWEEP_INTERVAL_MS,
} from './intents/config';
import { startIntentConsumer } from './intents/consumer';
import { notConfiguredExecutor, realTradingGate } from './intents/executor';
import { processIntentJob } from './intents/processor';
import { createReconciliationPass, processReconciliationJob } from './intents/reconciliation';
import { createRestReconciler } from './intents/rest-reconciler';
import { createSettlementCatchup } from './intents/settlement-catchup';
import { startSweeper } from './intents/sweeper';

const env = parseEnv(process.env);

const logger = pino(logOptions(env.logLevel));

const pool = new Pool({ connectionString: env.databaseUrl });
const db = createDb(pool);
// BullMQ's blocking connection must not cap retries per command
const redis = new Redis(env.redisUrl, { maxRetriesPerRequest: null });

pool.on('error', (error) => logger.error(errorLogFields(error), 'postgres pool error'));
redis.on('error', (error) => logger.warn(errorLogFields(error), 'redis connection error'));

// ARCH-01 replaces the inner executor with the broker socket client; the gate stays outside it
const executor = realTradingGate(notConfiguredExecutor, {
  realTradingEnabled: env.realTradingEnabled,
});

const consumer = startIntentConsumer({
  topic: OutboxTopic.TradingIntents,
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

// The broker's REST API for the trade lists, and the backend's token route for the token: the
// worker holds no broker credentials of its own (#90)
const brokerRest = createBrokerRestClient({ baseUrl: env.brokerApiBaseUrl });
const tokens = createBackendAccessTokenSource({
  baseUrl: env.backendUrl,
  token: env.internalApiToken,
});

const pass = createReconciliationPass({
  db,
  reconciler: createRestReconciler({
    rest: brokerRest,
    tokens,
    linkedTradeIds: (brokerAccountId, brokerTradeIds) =>
      listLinkedBrokerTradeIds(db, { brokerAccountId, brokerTradeIds }),
    logger,
    config: {
      windowBeforeMs: RECONCILE_WINDOW_BEFORE_MS,
      windowAfterMs: RECONCILE_WINDOW_AFTER_MS,
      pageSize: RECONCILE_TRADES_PAGE_SIZE,
      maxPages: RECONCILE_MAX_TRADE_PAGES,
    },
  }),
  logger,
  config: {
    tickMs: RECONCILE_TICK_MS,
    retryMs: RECONCILE_RETRY_MS,
    attemptTimeoutMs: RECONCILE_ATTEMPT_TIMEOUT_MS,
    batchSize: RECONCILE_BATCH_SIZE,
  },
});

const reconciliationConsumer = startIntentConsumer({
  topic: OutboxTopic.TradingReconciliation,
  connection: redis,
  logger,
  concurrency: env.workerConcurrency,
  processor: (payload) =>
    processReconciliationJob({ db, logger }, payload),
});

// accepted intents whose close_trade.success never arrived (#101 is the main path)
const catchup = createSettlementCatchup({
  db,
  rest: brokerRest,
  tokens,
  logger,
  config: {
    tickMs: CATCHUP_TICK_MS,
    graceMs: CATCHUP_GRACE_MS,
    batchSize: CATCHUP_BATCH_SIZE,
    pageSize: CATCHUP_TRADES_PAGE_SIZE,
    maxPages: CATCHUP_MAX_TRADE_PAGES,
    attemptTimeoutMs: CATCHUP_ATTEMPT_TIMEOUT_MS,
    stalledRetryMs: CATCHUP_STALLED_RETRY_MS,
  },
});

const sweeper = startSweeper({
  db,
  logger,
  intervalMs: SWEEP_INTERVAL_MS,
  olderThanMs: STALE_SUBMITTING_MS,
  limit: SWEEP_BATCH_SIZE,
});

let shuttingDown = false;

// Phase 1 drains both consumers (active jobs finish, new ones are not taken) and then the
// dead-letter writes those jobs may have started — in that order, or a `failed` event fired
// by the drain would register its write after the wait — and stops the reconciliation pass
// (its attempt in flight plus one outcome write) and the settlement catch-up (its attempt in
// flight). Phase 2 closes the connections and runs
// only if phase 1 finished cleanly: closing them under an outcome write would abort it. A
// drain that overruns or fails exits hard; the intent stays submitting (the sweeper resolves
// it after the restart) or reconciling (the pass takes it again once its lease lapses).
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  sweeper.stop();
  const drained = await closeAll(
    [
      () => consumer.worker.close().then(() => consumer.drainDeadLetters()),
      () =>
        reconciliationConsumer.worker.close().then(() => reconciliationConsumer.drainDeadLetters()),
      () => pass.stop(),
      () => catchup.stop(),
    ],
    SHUTDOWN_PHASE1_BUDGET_MS,
  );
  if (!drained) {
    logger.error('shutdown: active jobs did not finish within the budget, exiting without cleanup');
    process.exit(1);
  }
  const cleaned = await closeAll(
    [
      () => consumer.dlq.close(),
      () => reconciliationConsumer.dlq.close(),
      () => redis.quit(),
      () => pool.end(),
    ],
    SHUTDOWN_PHASE2_BUDGET_MS,
  );
  if (!cleaned) logger.error('shutdown: a connection did not close cleanly');
  process.exit(cleaned ? 0 : 1);
}

process.once('SIGTERM', (signal) => void shutdown(signal));
process.once('SIGINT', (signal) => void shutdown(signal));

logger.info({ concurrency: env.workerConcurrency }, 'trading-worker started');
// after the consumers: the first tick picks up the reconciling intents a dead process left
pass.start();
catchup.start();
