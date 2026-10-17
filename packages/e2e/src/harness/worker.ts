import { Redis } from 'ioredis';
import { Pool } from 'pg';
import { createDb } from '@binarius/db';
import {
  createWorker,
  type Env,
  type TradingWorker,
  type WorkerTuning,
} from '@binarius/trading-worker/e2e';
import { SESSION_MAX_DURATION_MS, SESSION_NO_SIGNAL_TIMEOUT_MS } from '@binarius/shared';
import { INTERNAL_API_TOKEN } from './env';
import type { LogSink } from './logs';

// worker.handoff.db.test.ts's TUNING: production's order and chains with the waits a test can
// afford (a 100 ms orchestrator and session tick, no candle slack); leases keep production's TTL
export const E2E_WORKER_TUNING: Partial<WorkerTuning> = {
  sessions: {
    tickMs: 100,
    idleGraceMs: 60_000,
    retryMs: 300,
    refusalRetryMs: 1_500,
    maxSessions: 50,
    startConcurrency: 4,
    stopBudgetMs: 1_000,
    watchWindowMs: 600_000,
    leaseTtlMs: 30_000,
    leaseRenewMs: 6_000,
    leaseRenewTimeoutMs: 3_000,
    leaseFenceMs: 25_000,
    lossGraceMs: 2_000,
  },
  socketTiming: {
    connectTimeoutMs: 1_000,
    authTimeoutMs: 500,
    reconnectDelayMs: 20,
    reconnectDelayMaxMs: 40,
    jitter: 0,
  },
  orchestrator: {
    tickMs: 100,
    batchSize: 50,
    attemptTimeoutMs: 2_000,
    retryMs: 1_000,
    candleSlackMs: 0,
    maxDurationMs: SESSION_MAX_DURATION_MS,
    noSignalTimeoutMs: SESSION_NO_SIGNAL_TIMEOUT_MS,
  },
  staleSubmittingMs: 3_000,
  sweepIntervalMs: 100,
  reconcileTickMs: 100,
  reconcileRetryMs: 1_000,
  catchupTickMs: 1_000,
  catchupGraceMs: 10_000,
  phase1BudgetMs: 10_000,
  phase2BudgetMs: 4_000,
};

// apps/trading-worker/src/index.ts with the backend's real token, signal and pairs routes (no
// testing.tokens/signals/pairs seams) and the socket transport (BROKER_WS_URL set, as on the pilot)
export function startE2eWorker(deps: {
  databaseUrl: string;
  redisUrl: string;
  backendUrl: string;
  brokerUrl: string;
  queuePrefix: string;
  logs: LogSink;
}): TradingWorker {
  const env: Env = {
    databaseUrl: deps.databaseUrl,
    redisUrl: deps.redisUrl,
    logLevel: 'info',
    intentMaxAgeMs: 60_000,
    submitAckTimeoutMs: 5_000,
    workerConcurrency: 4,
    backendUrl: deps.backendUrl,
    internalApiToken: INTERNAL_API_TOKEN,
    brokerApiBaseUrl: deps.brokerUrl,
    brokerWsUrl: deps.brokerUrl,
    // no trip inside the run: the switch is not what this test covers
    circuitBreaker: { windowMs: 60_000, minFailures: 1_000, failurePercent: 100 },
    demoOnly: false,
  };
  const pool = new Pool({ connectionString: deps.databaseUrl });
  const worker = createWorker({
    env,
    db: createDb(pool),
    pool,
    redis: new Redis(deps.redisUrl, { maxRetriesPerRequest: null }),
    logger: deps.logs.logger,
    testing: { tuning: E2E_WORKER_TUNING, queuePrefix: deps.queuePrefix },
  });
  worker.start();
  return worker;
}
