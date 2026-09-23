import type { LogLevel } from 'fastify';
import {
  DATABASE_URL_RULES,
  REDIS_URL_RULES,
  parseBoundedIntegerEnv,
  parseLogLevelEnv,
  parseUrlEnv,
  readEnv,
  type EnvSource,
} from '@binarius/shared';

// the compose probe timeout (3s) is sized above this ceiling
const MIN_HEALTH_TIMEOUT_MS = 500;
const MAX_HEALTH_TIMEOUT_MS = 2500;

// shared with the bot; short or whitespace-padded values are misconfigurations, not secrets
const MIN_INTERNAL_TOKEN_LENGTH = 16;

export interface Env {
  databaseUrl: string;
  redisUrl: string;
  port: number;
  logLevel: LogLevel;
  healthTimeoutMs: number;
  internalApiToken: string;
}

export function parseEnv(source: EnvSource): Env {
  return {
    databaseUrl: parseUrlEnv(readEnv(source, 'DATABASE_URL'), 'DATABASE_URL', DATABASE_URL_RULES),
    redisUrl: parseUrlEnv(readEnv(source, 'REDIS_URL'), 'REDIS_URL', REDIS_URL_RULES),
    port: parsePort(readEnv(source, 'PORT', '3000'), 'PORT'),
    logLevel: parseLogLevelEnv(readEnv(source, 'LOG_LEVEL', 'info'), 'LOG_LEVEL'),
    healthTimeoutMs: parseTimeout(
      readEnv(source, 'HEALTH_TIMEOUT_MS', '2000'),
      'HEALTH_TIMEOUT_MS',
    ),
    internalApiToken: parseInternalToken(
      readEnv(source, 'INTERNAL_API_TOKEN'),
      'INTERNAL_API_TOKEN',
    ),
  };
}

function parseInternalToken(raw: string, name: string): string {
  if (/\s/.test(raw)) throw new Error(`Env ${name} must not contain whitespace`);
  if (raw.length < MIN_INTERNAL_TOKEN_LENGTH) {
    throw new Error(`Env ${name} must be at least ${MIN_INTERNAL_TOKEN_LENGTH} characters`);
  }
  return raw;
}

const parsePort = (raw: string, name: string): number =>
  parseBoundedIntegerEnv(raw, name, 1, 65535);

const parseTimeout = (raw: string, name: string): number =>
  parseBoundedIntegerEnv(raw, name, MIN_HEALTH_TIMEOUT_MS, MAX_HEALTH_TIMEOUT_MS);
