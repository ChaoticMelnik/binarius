import {
  DATABASE_URL_RULES,
  REDIS_URL_RULES,
  parseBoundedIntegerEnv,
  parseLogLevelEnv,
  parseUrlEnv,
  readEnv,
  type EnvSource,
  type LogLevel,
} from '@binarius/shared';
import { MAX_SUBMIT_ACK_TIMEOUT_MS } from './intents/config';

const MIN_INTENT_MAX_AGE_MS = 1_000;
const MAX_INTENT_MAX_AGE_MS = 600_000;
const MIN_SUBMIT_ACK_TIMEOUT_MS = 500;
const MAX_WORKER_CONCURRENCY = 100;

export interface Env {
  databaseUrl: string;
  redisUrl: string;
  logLevel: LogLevel;
  intentMaxAgeMs: number;
  submitAckTimeoutMs: number;
  workerConcurrency: number;
}

export function parseEnv(source: EnvSource): Env {
  return {
    databaseUrl: parseUrlEnv(readEnv(source, 'DATABASE_URL'), 'DATABASE_URL', DATABASE_URL_RULES),
    redisUrl: parseUrlEnv(readEnv(source, 'REDIS_URL'), 'REDIS_URL', REDIS_URL_RULES),
    logLevel: parseLogLevelEnv(readEnv(source, 'LOG_LEVEL', 'info'), 'LOG_LEVEL'),
    intentMaxAgeMs: parseBoundedIntegerEnv(
      readEnv(source, 'INTENT_MAX_AGE_MS', '60000'),
      'INTENT_MAX_AGE_MS',
      MIN_INTENT_MAX_AGE_MS,
      MAX_INTENT_MAX_AGE_MS,
    ),
    // capped below the stale-submitting threshold: a redelivered job must never declare an
    // intent unknown while its first worker could still be waiting for the broker
    submitAckTimeoutMs: parseBoundedIntegerEnv(
      readEnv(source, 'SUBMIT_ACK_TIMEOUT_MS', '10000'),
      'SUBMIT_ACK_TIMEOUT_MS',
      MIN_SUBMIT_ACK_TIMEOUT_MS,
      MAX_SUBMIT_ACK_TIMEOUT_MS,
    ),
    workerConcurrency: parseBoundedIntegerEnv(
      readEnv(source, 'WORKER_CONCURRENCY', '5'),
      'WORKER_CONCURRENCY',
      1,
      MAX_WORKER_CONCURRENCY,
    ),
  };
}
