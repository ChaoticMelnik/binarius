import type { LogLevel } from 'fastify';
import {
  DATABASE_URL_RULES,
  REDIS_URL_RULES,
  parseIntegerEnv,
  parseLogLevelEnv,
  parseUrlEnv,
  readEnv,
  type EnvSource,
} from '@binarius/shared';

// the compose probe timeout (3s) is sized above this ceiling
const MIN_HEALTH_TIMEOUT_MS = 500;
const MAX_HEALTH_TIMEOUT_MS = 2500;

export interface Env {
  databaseUrl: string;
  redisUrl: string;
  port: number;
  logLevel: LogLevel;
  healthTimeoutMs: number;
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
  };
}

function parsePort(raw: string, name: string): number {
  const port = parseIntegerEnv(raw, name);
  if (port < 1 || port > 65535) throw new Error(`Env ${name} must be between 1 and 65535`);
  return port;
}

function parseTimeout(raw: string, name: string): number {
  const ms = parseIntegerEnv(raw, name);
  if (ms < MIN_HEALTH_TIMEOUT_MS || ms > MAX_HEALTH_TIMEOUT_MS) {
    throw new Error(
      `Env ${name} must be between ${MIN_HEALTH_TIMEOUT_MS} and ${MAX_HEALTH_TIMEOUT_MS}`,
    );
  }
  return ms;
}
