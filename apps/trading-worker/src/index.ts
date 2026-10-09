import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import pino from 'pino';
import {
  errorLogFields,
  closeAll,
  logOptions,
  TRADING_INTENTS_DEAD_LETTER_QUEUE,
} from '@binarius/shared';
import { createBrokerRestClient } from '@binarius/broker-rest';
import {
  acquireSessionLease,
  applyBalanceEvent,
  createDb,
  listLinkedBrokerTradeIds,
  listSessionCandidates,
  OutboxTopic,
  releaseSessionLeases,
  renewSessionLeases,
  settleClosedTrades,
  stopTrading,
  upsertBalanceSnapshot,
} from '@binarius/db';
import { createBackendAccessTokenSource } from './broker/access-token';
import { SESSION_MANAGER_CONFIG } from './broker/session-config';
import { createBrokerSessionManager } from './broker/session-manager';
import { noTradeSessions } from './broker/trade-session';
import { parseEnv } from './env';
import {
  BALANCE_CHECK_TIMEOUT_MS,
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
import { createCircuitBreaker } from './circuit-breaker/breaker';
import { SOCKET_LOSS_GRACE_MS } from './circuit-breaker/config';
import { observeExecutor } from './circuit-breaker/observe-executor';
import { createBalanceCheck } from './intents/balance-check';
import type { DeadLetter } from './dead-letter';
import { startIntentConsumer } from './intents/consumer';
import { processIntentJob } from './intents/processor';
import { createReconciliationPass, processReconciliationJob } from './intents/reconciliation';
import { createRestReconciler } from './intents/rest-reconciler';
import { createSettlementCatchup } from './intents/settlement-catchup';
import { startSweeper } from './intents/sweeper';
import { createTradeCommandExecutor } from './intents/trade-command-executor';
import { createBackendPairsSource, createBackendSignalSource } from './trading-session/backend';
import { TRADING_SESSION_CONFIG } from './trading-session/config';
import { createSessionOrchestrator } from './trading-session/orchestrator';

const env = parseEnv(process.env);

const logger = pino(logOptions(env.logLevel));

const pool = new Pool({ connectionString: env.databaseUrl });
const db = createDb(pool);
// BullMQ's blocking connection must not cap retries per command
const redis = new Redis(env.redisUrl, { maxRetriesPerRequest: null });

pool.on('error', (error) => logger.error(errorLogFields(error), 'postgres pool error'));
redis.on('error', (error) => logger.warn(errorLogFields(error), 'redis connection error'));

// The broker's REST API for the trade lists and the REST open, and the backend's token route for
// the token: the worker holds no broker credentials of its own (#90)
const brokerRest = createBrokerRestClient({ baseUrl: env.brokerApiBaseUrl });
const tokens = createBackendAccessTokenSource({
  baseUrl: env.backendUrl,
  token: env.internalApiToken,
});

// The broker sessions only with BROKER_WS_URL set (docs/broker-session.md); unset, every order
// goes over REST. A writer that throws leaves its event in the consumers' dead-letter queue (#92):
// its own instance, because the manager is built before the consumers.
const sessionDeadLetters = new Queue<DeadLetter>(TRADING_INTENTS_DEAD_LETTER_QUEUE, {
  connection: redis,
});
// this process's lease owner (#93): a fresh id per start, so a restarted container inherits no
// lease it cannot prove it still fences
const sessionOwnerId = randomUUID();
// the circuit breaker (#96, docs/runbook-broker-outage.md): closes the global switch when the
// broker stops answering submits or the sessions are lost; never opens it
const breaker = createCircuitBreaker({
  stopTrading: (input) => stopTrading(db, input),
  logger,
  config: env.circuitBreaker,
  runningSessions: () => sessions?.running ?? 0,
});
const sessions =
  env.brokerWsUrl === undefined
    ? undefined
    : createBrokerSessionManager({
        url: env.brokerWsUrl,
        deadLetters: sessionDeadLetters,
        leases: {
          acquire: (accountId, ttlMs) =>
            acquireSessionLease(db, { accountId, ownerId: sessionOwnerId, ttlMs }),
          renew: (accountIds, ttlMs) =>
            renewSessionLeases(db, { ownerId: sessionOwnerId, accountIds, ttlMs }),
          release: () => releaseSessionLeases(db, { ownerId: sessionOwnerId }),
        },
        candidates: (options) =>
          listSessionCandidates(db, { ...options, ownerId: sessionOwnerId }),
        tokens,
        writers: {
          snapshot: (brokerAccountId, user, modes) =>
            upsertBalanceSnapshot(db, { brokerAccountId, user, requested: false, eventAt: modes }),
          balanceEvent: (brokerAccountId, mode, balance) =>
            applyBalanceEvent(db, { brokerAccountId, mode, balance }),
          closedTrades: (brokerAccountId, trades) =>
            settleClosedTrades(db, { brokerAccountId, trades }),
        },
        lossObserver: {
          lost: (accountId) => breaker.socketLost(accountId),
          graceMs: SOCKET_LOSS_GRACE_MS,
        },
        logger,
        config: SESSION_MANAGER_CONFIG,
      });

// every submit's answer feeds the breaker's REST signal; the executor itself is untouched
const executor = observeExecutor(
  createTradeCommandExecutor({
    sessions: sessions ?? noTradeSessions,
    rest: brokerRest,
    tokens,
    logger,
  }),
  breaker,
);

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
  balanceCheck: createBalanceCheck({ db, rest: brokerRest, tokens, logger }),
  logger,
  config: {
    tickMs: RECONCILE_TICK_MS,
    retryMs: RECONCILE_RETRY_MS,
    attemptTimeoutMs: RECONCILE_ATTEMPT_TIMEOUT_MS,
    batchSize: RECONCILE_BATCH_SIZE,
    balanceCheckTimeoutMs: BALANCE_CHECK_TIMEOUT_MS,
  },
});

const reconciliationConsumer = startIntentConsumer({
  topic: OutboxTopic.TradingReconciliation,
  connection: redis,
  logger,
  concurrency: env.workerConcurrency,
  processor: (payload) => processReconciliationJob({ db, logger }, payload),
});

// accepted intents whose close_trade.success never arrived or was dropped at a session's stop
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

// the demo sessions (docs/trading-session.md): their signal and pairs come from the backend
const tradingSessions = createSessionOrchestrator({
  db,
  signals: createBackendSignalSource({ baseUrl: env.backendUrl, token: env.internalApiToken }),
  pairs: createBackendPairsSource({ baseUrl: env.backendUrl, token: env.internalApiToken }),
  logger,
  config: TRADING_SESSION_CONFIG,
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
// flight), and the trading session orchestrator (its attempt in flight; an attempt cut by the
// stop writes nothing). The broker sessions stop after the intents drain, so our own shutdown never cuts a
// submit waiting on its socket; their stop is bounded by SESSION_STOP_BUDGET_MS. Phase 2 closes the connections and runs
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
      () =>
        consumer.worker
          .close()
          .then(() => consumer.drainDeadLetters())
          .then(() => sessions?.stop()),
      () =>
        reconciliationConsumer.worker.close().then(() => reconciliationConsumer.drainDeadLetters()),
      () => pass.stop(),
      () => catchup.stop(),
      () => tradingSessions.stop(),
      // no trip starts after it; a trip in flight is one stopTrading transaction
      () => breaker.stop(),
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
      () => sessionDeadLetters.close(),
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

logger.info(
  {
    concurrency: env.workerConcurrency,
    sessions: sessions !== undefined,
    ...(sessions === undefined ? {} : { sessionOwnerId }),
  },
  'trading-worker started',
);
// after the consumers: the first tick picks up the reconciling intents a dead process left
pass.start();
catchup.start();
tradingSessions.start();
sessions?.start();
