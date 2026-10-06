import {
  DATABASE_URL_RULES,
  HTTPS_ONLY_RULES,
  REDIS_URL_RULES,
  parseBoundedIntegerEnv,
  parseInternalTokenEnv,
  parseLogLevelEnv,
  parseRealTradingEnabledEnv,
  parseUrlEnv,
  readEnv,
  type EnvSource,
  type LogLevel,
  type UrlEnvRules,
} from '@binarius/shared';
import { MAX_SUBMIT_ACK_TIMEOUT_MS } from './intents/config';

const MIN_INTENT_MAX_AGE_MS = 1_000;
const MAX_INTENT_MAX_AGE_MS = 600_000;
const MIN_SUBMIT_ACK_TIMEOUT_MS = 500;
const MAX_WORKER_CONCURRENCY = 100;
// the backend is reached over the compose network in plain http, as the bot reaches it
const BACKEND_URL_RULES: UrlEnvRules = { protocols: ['http:', 'https:'], allowIpv6Literal: false };

export interface Env {
  databaseUrl: string;
  redisUrl: string;
  logLevel: LogLevel;
  intentMaxAgeMs: number;
  submitAckTimeoutMs: number;
  workerConcurrency: number;
  realTradingEnabled: boolean;
  // the token route (#90): the worker holds no broker credentials of its own
  backendUrl: string;
  internalApiToken: string;
  // the broker REST API the reconciler and the settlement catch-up read trades from
  brokerApiBaseUrl: string;
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
    realTradingEnabled: parseRealTradingEnabledEnv(source),
    backendUrl: parseUrlEnv(readEnv(source, 'BACKEND_URL'), 'BACKEND_URL', BACKEND_URL_RULES),
    internalApiToken: parseInternalTokenEnv(
      readEnv(source, 'INTERNAL_API_TOKEN'),
      'INTERNAL_API_TOKEN',
    ),
    brokerApiBaseUrl: parseUrlEnv(
      readEnv(source, 'BROKER_API_BASE_URL'),
      'BROKER_API_BASE_URL',
      HTTPS_ONLY_RULES,
    ),
  };
}
