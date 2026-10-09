import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import type pino from 'pino';
import { closeAll, TRADING_INTENTS_DEAD_LETTER_QUEUE } from '@binarius/shared';
import { createBrokerRestClient } from '@binarius/broker-rest';
import {
  acquireSessionLease,
  applyBalanceEvent,
  listLinkedBrokerTradeIds,
  listSessionCandidates,
  OutboxTopic,
  releaseSessionLeases,
  renewSessionLeases,
  settleClosedTrades,
  stopTrading,
  upsertBalanceSnapshot,
  type Db,
} from '@binarius/db';
import { createBackendAccessTokenSource, type AccessTokenSource } from './broker/access-token';
import { SESSION_MANAGER_CONFIG, type SessionManagerConfig } from './broker/session-config';
import { createBrokerSessionManager } from './broker/session-manager';
import type { BrokerSocketTiming } from './broker/socket-config';
import { noTradeSessions } from './broker/trade-session';
import { createCircuitBreaker } from './circuit-breaker/breaker';
import { observeExecutor } from './circuit-breaker/observe-executor';
import type { Env } from './env';
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
import { createBalanceCheck } from './intents/balance-check';
import type { DeadLetter } from './dead-letter';
import { startIntentConsumer } from './intents/consumer';
import { processIntentJob } from './intents/processor';
import { createReconciliationPass, processReconciliationJob } from './intents/reconciliation';
import { createRestReconciler } from './intents/rest-reconciler';
import { createSettlementCatchup } from './intents/settlement-catchup';
import { startSweeper } from './intents/sweeper';
import { createTradeCommandExecutor } from './intents/trade-command-executor';
import {
  createBackendPairsSource,
  createBackendSignalSource,
  type PairsSource,
  type SignalSource,
} from './trading-session/backend';
import { TRADING_SESSION_CONFIG, type SessionOrchestratorConfig } from './trading-session/config';
import { createSessionOrchestrator } from './trading-session/orchestrator';

// scripts/deploy-worker.sh waits for this line before it stops the old container (#95)
const WORKER_READY_MSG = 'trading-worker started';

// 'dirty': phase 1 overran or failed and phase 2 did not run, so the process must exit 1 without
// closing the connections under a write in flight
export type ShutdownResult = 'clean' | 'dirty';

export interface TradingWorker {
  // logs WORKER_READY_MSG, then starts the timers; the consumers already take jobs
  start(): void;
  // every call after the first returns the first one's result
  shutdown(signal: string): Promise<ShutdownResult>;
}

// The timers and budgets the production constants set; a test shortens them (two workers in one
// process, worker.handoff.db.test.ts). Production passes none.
export interface WorkerTuning {
  sessions: SessionManagerConfig;
  socketTiming?: Partial<BrokerSocketTiming>;
  orchestrator: SessionOrchestratorConfig;
  staleSubmittingMs: number;
  sweepIntervalMs: number;
  reconcileTickMs: number;
  reconcileRetryMs: number;
  catchupTickMs: number;
  catchupGraceMs: number;
  phase1BudgetMs: number;
  phase2BudgetMs: number;
}

const PRODUCTION_TUNING: WorkerTuning = {
  sessions: SESSION_MANAGER_CONFIG,
  orchestrator: TRADING_SESSION_CONFIG,
  staleSubmittingMs: STALE_SUBMITTING_MS,
  sweepIntervalMs: SWEEP_INTERVAL_MS,
  reconcileTickMs: RECONCILE_TICK_MS,
  reconcileRetryMs: RECONCILE_RETRY_MS,
  catchupTickMs: CATCHUP_TICK_MS,
  catchupGraceMs: CATCHUP_GRACE_MS,
  phase1BudgetMs: SHUTDOWN_PHASE1_BUDGET_MS,
  phase2BudgetMs: SHUTDOWN_PHASE2_BUDGET_MS,
};

export interface WorkerTestSeams {
  tuning?: Partial<WorkerTuning>;
  // a BullMQ key prefix, so a suite's queues do not meet another file's on a shared Redis
  queuePrefix?: string;
  // in place of the backend's routes (the token, the signal, the pairs)
  tokens?: AccessTokenSource;
  signals?: SignalSource;
  pairs?: PairsSource;
}

export interface WorkerDeps {
  env: Env;
  db: Db;
  pool: Pool;
  redis: Redis;
  logger: pino.Logger;
  testing?: WorkerTestSeams;
}

export function createWorker({
  env,
  db,
  pool,
  redis,
  logger,
  testing = {},
}: WorkerDeps): TradingWorker {
  const tuning: WorkerTuning = { ...PRODUCTION_TUNING, ...testing.tuning };
  const prefix = testing.queuePrefix === undefined ? {} : { prefix: testing.queuePrefix };

  // The broker's REST API for the trade lists and the REST open, and the backend's token route for
  // the token: the worker holds no broker credentials of its own (#90)
  const brokerRest = createBrokerRestClient({ baseUrl: env.brokerApiBaseUrl });
  const tokens =
    testing.tokens ??
    createBackendAccessTokenSource({ baseUrl: env.backendUrl, token: env.internalApiToken });

  // The broker sessions only with BROKER_WS_URL set (docs/broker-session.md); unset, every order
  // goes over REST. A writer that throws leaves its event in the consumers' dead-letter queue (#92):
  // its own instance, because the manager is built before the consumers.
  const sessionDeadLetters = new Queue<DeadLetter>(TRADING_INTENTS_DEAD_LETTER_QUEUE, {
    connection: redis,
    ...prefix,
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
              upsertBalanceSnapshot(db, {
                brokerAccountId,
                user,
                requested: false,
                eventAt: modes,
              }),
            balanceEvent: (brokerAccountId, mode, balance) =>
              applyBalanceEvent(db, { brokerAccountId, mode, balance }),
            closedTrades: (brokerAccountId, trades) =>
              settleClosedTrades(db, { brokerAccountId, trades }),
          },
          lossObserver: {
            lost: (accountId) => breaker.socketLost(accountId),
            ready: (accountId) => breaker.socketReady(accountId),
          },
          logger,
          config: tuning.sessions,
          ...(tuning.socketTiming === undefined ? {} : { timing: tuning.socketTiming }),
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
    ...prefix,
    processor: (payload) =>
      processIntentJob(
        {
          db,
          executor,
          logger,
          config: {
            intentMaxAgeMs: env.intentMaxAgeMs,
            submitAckTimeoutMs: env.submitAckTimeoutMs,
            staleSubmittingMs: tuning.staleSubmittingMs,
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
      tickMs: tuning.reconcileTickMs,
      retryMs: tuning.reconcileRetryMs,
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
    ...prefix,
    processor: (payload) => processReconciliationJob({ db, logger }, payload),
  });

  // accepted intents whose close_trade.success never arrived or was dropped at a session's stop
  const catchup = createSettlementCatchup({
    db,
    rest: brokerRest,
    tokens,
    logger,
    config: {
      tickMs: tuning.catchupTickMs,
      graceMs: tuning.catchupGraceMs,
      batchSize: CATCHUP_BATCH_SIZE,
      pageSize: CATCHUP_TRADES_PAGE_SIZE,
      maxPages: CATCHUP_MAX_TRADE_PAGES,
      attemptTimeoutMs: CATCHUP_ATTEMPT_TIMEOUT_MS,
      stalledRetryMs: CATCHUP_STALLED_RETRY_MS,
    },
  });

  // the demo sessions (docs/trading-session.md): their signal and pairs come from the backend
  const backend = { baseUrl: env.backendUrl, token: env.internalApiToken };
  const tradingSessions = createSessionOrchestrator({
    db,
    signals: testing.signals ?? createBackendSignalSource(backend),
    pairs: testing.pairs ?? createBackendPairsSource(backend),
    logger,
    config: tuning.orchestrator,
  });

  const sweeper = startSweeper({
    db,
    logger,
    intervalMs: tuning.sweepIntervalMs,
    olderThanMs: tuning.staleSubmittingMs,
    limit: SWEEP_BATCH_SIZE,
  });

  // Phase 1 drains both consumers (active jobs finish, new ones are not taken) and then the
  // dead-letter writes those jobs may have started — in that order, or a `failed` event fired by
  // the drain would register its write after the wait — and stops the reconciliation pass (its
  // attempt in flight plus one outcome write), the settlement catch-up (its attempt in flight) and
  // the trading session orchestrator (its attempt in flight; an attempt cut by the stop writes
  // nothing). The broker sessions stop after the intents drain, so our own shutdown never cuts a
  // submit waiting on its socket; their stop is bounded by tuning.sessions.stopBudgetMs
  // (SESSION_STOP_BUDGET_MS in production). Phase 2 closes the connections and runs only if phase
  // 1 finished cleanly: closing them under an outcome write would abort it. A drain that overruns
  // or fails is 'dirty' and the process exits hard; the intent stays submitting (the sweeper
  // resolves it after the restart) or reconciling (the pass takes it again once its lease lapses).
  async function runShutdown(signal: string): Promise<ShutdownResult> {
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
          reconciliationConsumer.worker
            .close()
            .then(() => reconciliationConsumer.drainDeadLetters()),
        () => pass.stop(),
        () => catchup.stop(),
        () => tradingSessions.stop(),
        // no trip starts after it; a trip in flight is one stopTrading transaction
        () => breaker.stop(),
      ],
      tuning.phase1BudgetMs,
    );
    if (!drained) {
      logger.error(
        'shutdown: active jobs did not finish within the budget, exiting without cleanup',
      );
      return 'dirty';
    }
    const cleaned = await closeAll(
      [
        () => consumer.dlq.close(),
        () => reconciliationConsumer.dlq.close(),
        () => sessionDeadLetters.close(),
        () => redis.quit(),
        () => pool.end(),
      ],
      tuning.phase2BudgetMs,
    );
    if (!cleaned) logger.error('shutdown: a connection did not close cleanly');
    return cleaned ? 'clean' : 'dirty';
  }

  let shutdownRun: Promise<ShutdownResult> | undefined;

  return {
    start() {
      logger.info(
        {
          concurrency: env.workerConcurrency,
          sessions: sessions !== undefined,
          ...(sessions === undefined ? {} : { sessionOwnerId }),
        },
        WORKER_READY_MSG,
      );
      // after the consumers: the first tick picks up the reconciling intents a dead process left
      pass.start();
      catchup.start();
      tradingSessions.start();
      sessions?.start();
    },
    shutdown(signal) {
      shutdownRun ??= runShutdown(signal);
      return shutdownRun;
    },
  };
}
