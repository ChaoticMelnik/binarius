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
  deregisterWorkerProcess,
  heartbeatWorkerProcess,
  listLinkedBrokerTradeIds,
  listSessionCandidates,
  OutboxTopic,
  releaseSessionLease,
  releaseSessionLeases,
  renewSessionLeases,
  settleClosedTrades,
  stopTrading,
  upsertBalanceSnapshot,
  type Db,
} from '@binarius/db';
import type { BrokerSocketTiming } from '@binarius/broker-socket';
import { createBackendAccessTokenSource, type AccessTokenSource } from './broker/access-token';
import { SESSION_MANAGER_CONFIG, type SessionManagerConfig } from './broker/session-config';
import { createBrokerSessionManager } from './broker/session-manager';
import { noTradeSessions } from './broker/trade-session';
import { createCircuitBreaker } from './circuit-breaker/breaker';
import { observeExecutor } from './circuit-breaker/observe-executor';
import type { Env } from './env';
import { createCapacityReporter } from './fleet/capacity';
import { FLEET_CONFIG, type FleetConfig } from './fleet/config';
import { createFleetRegistry } from './fleet/registry';
import {
  BALANCE_CHECK_TIMEOUT_MS,
  CATCHUP_ATTEMPT_TIMEOUT_MS,
  CATCHUP_BATCH_SIZE,
  CATCHUP_GRACE_MS,
  CATCHUP_MAX_TRADE_PAGES,
  CATCHUP_STALLED_RETRY_MS,
  CATCHUP_TICK_MS,
  CATCHUP_TRADES_PAGE_SIZE,
  INTENT_RECOVERY_DELAY_MS,
  INTENT_ROUTER_DRAIN_POLL_MS,
  INTENT_ROUTER_DRAIN_TAIL_MS,
  INTENT_ROUTER_STOP_BUDGET_MS,
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
import { processIntentJob, type ProcessOutcome, type ProcessorDeps } from './intents/processor';
import { createReconciliationPass, processReconciliationJob } from './intents/reconciliation';
import { createRestReconciler } from './intents/rest-reconciler';
import {
  createIntentRouter,
  INTENT_DIRECT_JOB,
  ownIntentQueueName,
  type IntentRouterConfig,
} from './intents/router';
import { createSettlementCatchup } from './intents/settlement-catchup';
import { startSweeper } from './intents/sweeper';
import { createTradeCommandExecutor } from './intents/trade-command-executor';
import { createBackendPairsSource, type PairsSource } from './trading-session/backend';
import { TRADING_SESSION_CONFIG, type SessionOrchestratorConfig } from './trading-session/config';
import { createSessionOrchestrator } from './trading-session/orchestrator';

// scripts/deploy-worker.sh waits for this line before it stops the old container (#95)
const WORKER_READY_MSG = 'trading-worker started';

// the job outcomes that leave the intent terminal: they wake the trading sessions (#696); an
// outcome added later fails tsc here
const JOB_OUTCOME_ENDS_INTENT = {
  accepted: false,
  rejected: true,
  unknown: false,
  expired: true,
  stale_unknown: false,
  forwarded: false,
  noop: false,
} as const satisfies Record<ProcessOutcome, boolean>;

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
  // production: SESSION_MANAGER_CONFIG with maxSessions from env MAX_SESSIONS_PER_WORKER
  sessions: SessionManagerConfig;
  fleet: FleetConfig;
  intentRouter: IntentRouterConfig;
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

const PRODUCTION_TUNING: Omit<WorkerTuning, 'sessions'> = {
  fleet: FLEET_CONFIG,
  intentRouter: {
    recoveryDelayMs: INTENT_RECOVERY_DELAY_MS,
    stopBudgetMs: INTENT_ROUTER_STOP_BUDGET_MS,
    drainPollMs: INTENT_ROUTER_DRAIN_POLL_MS,
    drainTailMs: INTENT_ROUTER_DRAIN_TAIL_MS,
  },
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
  // in place of the backend's routes (the token, the pairs)
  tokens?: AccessTokenSource;
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
  const tuning: WorkerTuning = {
    ...PRODUCTION_TUNING,
    sessions: { ...SESSION_MANAGER_CONFIG, maxSessions: env.maxSessionsPerWorker },
    ...testing.tuning,
  };
  const prefix = testing.queuePrefix === undefined ? {} : { prefix: testing.queuePrefix };

  // The broker's REST API for the trade lists and the REST open, and the backend's token route for
  // the token: the worker holds no broker credentials of its own (#90)
  const brokerRest = createBrokerRestClient({ baseUrl: env.brokerApiBaseUrl, logger });
  const tokens =
    testing.tokens ??
    createBackendAccessTokenSource({
      baseUrl: env.backendUrl,
      token: env.internalApiToken,
      logger,
    });

  // the trading sessions (docs/trading-session.md): their pairs catalog comes from the backend.
  // Built ahead of the writers below: every write here that ends an intent or halts its account
  // wakes it after its commit (#696)
  const backend = { baseUrl: env.backendUrl, token: env.internalApiToken };
  const tradingSessions = createSessionOrchestrator({
    db,
    pairs: testing.pairs ?? createBackendPairsSource(backend),
    logger,
    config: tuning.orchestrator,
  });

  // The broker sessions only with BROKER_WS_URL set (docs/broker-session.md); unset, every order
  // goes over REST. A writer that throws leaves its event in the consumers' dead-letter queue (#92):
  // its own instance, because the manager is built before the consumers.
  const sessionDeadLetters = new Queue<DeadLetter>(TRADING_INTENTS_DEAD_LETTER_QUEUE, {
    connection: redis,
    ...prefix,
  });
  // this process's id (#93, #94): the owner of its leases and of its worker_processes row, a fresh
  // one per start, so a restarted container inherits no lease it cannot prove it still fences
  const ownerId = randomUUID();
  // which accounts' sockets are ours (docs/worker-capacity.md): rendezvous over the live processes
  const registry = createFleetRegistry({
    ownerId,
    ops: {
      heartbeat: ({ ttlMs, pruneAfterMs }) =>
        heartbeatWorkerProcess(db, { ownerId, ttlMs, pruneAfterMs }),
      deregister: () => deregisterWorkerProcess(db, { ownerId }),
    },
    config: tuning.fleet,
    logger,
  });
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
            acquire: (accountId, ttlMs) => acquireSessionLease(db, { accountId, ownerId, ttlMs }),
            renew: (accountIds, ttlMs) => renewSessionLeases(db, { ownerId, accountIds, ttlMs }),
            release: () => releaseSessionLeases(db, { ownerId }),
            releaseOne: (accountId, acquiredAt) =>
              releaseSessionLease(db, { accountId, ownerId, acquiredAt }),
          },
          owns: (accountId) => registry.owns(accountId),
          candidates: (options) => listSessionCandidates(db, { ...options, ownerId }),
          tokens,
          writers: {
            snapshot: (brokerAccountId, user, eventAt) =>
              upsertBalanceSnapshot(db, { brokerAccountId, user, requested: false, eventAt }),
            balanceEvent: (brokerAccountId, mode, balance) =>
              applyBalanceEvent(db, { brokerAccountId, mode, balance }),
            closedTrades: async (brokerAccountId, trades) => {
              const outcomes = await settleClosedTrades(db, { brokerAccountId, trades });
              if (outcomes.some((outcome) => outcome.result === 'settled')) tradingSessions.wake();
              return outcomes;
            },
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

  // a shared job of an account another live process owns goes to that process's own queue
  // before the take (#347, docs/trade-intent-transport.md → Routing to the owner)
  const router = createIntentRouter({
    ownerId,
    registry,
    connection: redis,
    ...prefix,
    logger,
    config: tuning.intentRouter,
  });
  const intentProcessor =
    (forward: ProcessorDeps['forward']) =>
    async (payload: unknown): Promise<ProcessOutcome> => {
      const outcome = await processIntentJob(
        {
          db,
          executor,
          logger,
          config: {
            intentMaxAgeMs: env.intentMaxAgeMs,
            submitAckTimeoutMs: env.submitAckTimeoutMs,
            staleSubmittingMs: tuning.staleSubmittingMs,
            demoOnly: env.demoOnly,
          },
          ...(forward === undefined ? {} : { forward }),
        },
        payload,
      );
      if (JOB_OUTCOME_ENDS_INTENT[outcome]) tradingSessions.wake();
      return outcome;
    };
  const forwarding = intentProcessor((intent) => router.forward(intent));
  const local = intentProcessor(undefined);
  const consumer = startIntentConsumer({
    topic: OutboxTopic.TradingIntents,
    connection: redis,
    logger,
    concurrency: env.workerConcurrency,
    ...prefix,
    // a job requeued by a stopping process is processed where it lands
    processor: (payload, name) =>
      name === INTENT_DIRECT_JOB ? local(payload) : forwarding(payload),
  });
  // our own queue: jobs forwarded to us and our insurance jobs. Never forwarded again: one hop
  const ownConsumer = startIntentConsumer({
    topic: OutboxTopic.TradingIntents,
    queueName: ownIntentQueueName(ownerId),
    connection: redis,
    logger,
    concurrency: env.workerConcurrency,
    ...prefix,
    processor: (payload) => local(payload),
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
    onIntentEnded: () => tradingSessions.wake(),
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
    onIntentEnded: () => tradingSessions.wake(),
  });

  const capacity = createCapacityReporter({
    ownerId,
    registry,
    ...(sessions === undefined ? {} : { sessions }),
    cap: tuning.sessions.maxSessions,
    logger,
    intervalMs: tuning.fleet.capacityLogMs,
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
    const shutdownStartedAt = performance.now();
    logger.info({ signal }, 'shutting down');
    sweeper.stop();
    capacity.stop();
    const closed = Promise.all([consumer.worker.close(), ownConsumer.worker.close()]);
    const deregistered = closed
      .then(() => Promise.all([consumer.drainDeadLetters(), ownConsumer.drainDeadLetters()]))
      .then(() => sessions?.stop())
      // after our leases went back: a successor that takes our accounts meets no lease busy
      .then(() => registry.stop());
    // the router's cut leaves its final pass and close a budget of their own inside phase 1
    const notAfter =
      shutdownStartedAt + tuning.phase1BudgetMs - 2 * tuning.intentRouter.stopBudgetMs;
    const drained = await closeAll(
      [
        () => deregistered,
        // no job of ours forwards or runs while our own queue drains to the shared one; a peer
        // names us until its next heartbeat after our deregister, so the drain outlasts it
        () => closed.then(() => router.stop({ deregistered, notAfter })),
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
        () => ownConsumer.dlq.close(),
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
          ownerId,
          // a report of the env the processor and the orchestrator were built with (#396), not a
          // gate: the consumers already take jobs
          demoOnly: env.demoOnly,
        },
        WORKER_READY_MSG,
      );
      // first: its heartbeat is out before the manager's first tick, which owns nothing until it
      // answers (one tick's delay for the sockets at start)
      registry.start();
      // after the consumers: the first tick picks up the reconciling intents a dead process left
      pass.start();
      catchup.start();
      tradingSessions.start();
      sessions?.start();
      capacity.start();
    },
    shutdown(signal) {
      shutdownRun ??= runShutdown(signal);
      return shutdownRun;
    },
  };
}
