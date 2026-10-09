import {
  DATABASE_URL_RULES,
  HTTPS_ONLY_RULES,
  REDIS_URL_RULES,
  parseBoundedIntegerEnv,
  parseInternalTokenEnv,
  parseLogLevelEnv,
  parseUrlEnv,
  readEnv,
  type EnvSource,
  type LogLevel,
  type UrlEnvRules,
} from '@binarius/shared';
import {
  CIRCUIT_BREAKER_FAILURE_PERCENT,
  CIRCUIT_BREAKER_MIN_FAILURES,
  CIRCUIT_BREAKER_WINDOW_MS,
  MAX_CIRCUIT_BREAKER_MIN_FAILURES,
  MAX_CIRCUIT_BREAKER_WINDOW_MS,
  SOCKET_LOSS_GRACE_MS,
} from './circuit-breaker/config';
import { MAX_SUBMIT_ACK_TIMEOUT_MS } from './intents/config';

const MIN_INTENT_MAX_AGE_MS = 1_000;
const MAX_INTENT_MAX_AGE_MS = 600_000;
const MIN_SUBMIT_ACK_TIMEOUT_MS = 500;
const MAX_WORKER_CONCURRENCY = 100;
// the backend is reached over the compose network in plain http, as the bot reaches it
export const BACKEND_URL_RULES: UrlEnvRules = {
  protocols: ['http:', 'https:'],
  allowIpv6Literal: false,
};
export const BROKER_WS_URL_RULES: UrlEnvRules = {
  protocols: ['https:', 'wss:'],
  allowIpv6Literal: false,
};

export interface Env {
  databaseUrl: string;
  redisUrl: string;
  logLevel: LogLevel;
  intentMaxAgeMs: number;
  submitAckTimeoutMs: number;
  workerConcurrency: number;
  // the token route (#90): the worker holds no broker credentials of its own
  backendUrl: string;
  internalApiToken: string;
  // the broker REST API the reconciler and the settlement catch-up read trades from
  brokerApiBaseUrl: string;
  // the broker Socket.IO server; set, the worker keeps broker sessions (docs/broker-session.md),
  // unset, every order goes over REST
  brokerWsUrl: string | undefined;
  // the circuit breaker's thresholds (#96, circuit-breaker/config.ts); the window stays longer
  // than the socket loss grace
  circuitBreaker: { windowMs: number; minFailures: number; failurePercent: number };
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
    // readEnv refuses '', while an absent variable leaves the sessions off
    brokerWsUrl:
      source.BROKER_WS_URL === undefined
        ? undefined
        : parseUrlEnv(readEnv(source, 'BROKER_WS_URL'), 'BROKER_WS_URL', BROKER_WS_URL_RULES),
    circuitBreaker: {
      windowMs: parseBoundedIntegerEnv(
        readEnv(source, 'CIRCUIT_BREAKER_WINDOW_MS', String(CIRCUIT_BREAKER_WINDOW_MS)),
        'CIRCUIT_BREAKER_WINDOW_MS',
        SOCKET_LOSS_GRACE_MS + 1,
        MAX_CIRCUIT_BREAKER_WINDOW_MS,
      ),
      minFailures: parseBoundedIntegerEnv(
        readEnv(source, 'CIRCUIT_BREAKER_MIN_FAILURES', String(CIRCUIT_BREAKER_MIN_FAILURES)),
        'CIRCUIT_BREAKER_MIN_FAILURES',
        1,
        MAX_CIRCUIT_BREAKER_MIN_FAILURES,
      ),
      failurePercent: parseBoundedIntegerEnv(
        readEnv(source, 'CIRCUIT_BREAKER_FAILURE_PERCENT', String(CIRCUIT_BREAKER_FAILURE_PERCENT)),
        'CIRCUIT_BREAKER_FAILURE_PERCENT',
        1,
        100,
      ),
    },
  };
}
