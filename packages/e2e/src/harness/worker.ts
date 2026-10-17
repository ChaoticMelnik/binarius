import { Redis } from 'ioredis';
import { Pool } from 'pg';
import { createDb } from '@binarius/db';
import {
  createWorker,
  TEST_WORKER_TUNING,
  type Env,
  type TradingWorker,
} from '@binarius/trading-worker/e2e';
import { INTERNAL_API_TOKEN } from './env';
import type { LogSink } from './logs';

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
    testing: { tuning: TEST_WORKER_TUNING, queuePrefix: deps.queuePrefix },
  });
  worker.start();
  return worker;
}
