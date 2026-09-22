import type { LogLevel } from 'fastify';

const LOG_LEVELS = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
] as const satisfies readonly LogLevel[];

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

type Source = Record<string, string | undefined>;

interface UrlRules {
  protocols: readonly string[];
  allowIpv6Literal: boolean;
}

// pg-connection-string passes bracketed IPv6 hosts through to the socket; ioredis strips them
const DATABASE_URL_RULES: UrlRules = {
  protocols: ['postgres:', 'postgresql:'],
  allowIpv6Literal: false,
};
const REDIS_URL_RULES: UrlRules = { protocols: ['redis:', 'rediss:'], allowIpv6Literal: true };

export function parseEnv(source: Source): Env {
  return {
    databaseUrl: parseUrl(read(source, 'DATABASE_URL'), 'DATABASE_URL', DATABASE_URL_RULES),
    redisUrl: parseUrl(read(source, 'REDIS_URL'), 'REDIS_URL', REDIS_URL_RULES),
    port: parsePort(read(source, 'PORT', '3000'), 'PORT'),
    logLevel: parseLogLevel(read(source, 'LOG_LEVEL', 'info'), 'LOG_LEVEL'),
    healthTimeoutMs: parseTimeout(read(source, 'HEALTH_TIMEOUT_MS', '2000'), 'HEALTH_TIMEOUT_MS'),
  };
}

// `??` keeps '' distinct from undefined: an explicitly empty variable is an error, not a default
function read(source: Source, name: string, fallback?: string): string {
  const value = source[name] ?? fallback;
  if (value === undefined) throw new Error(`Missing required env ${name}`);
  if (value === '') throw new Error(`Env ${name} must not be empty`);
  return value;
}

function parseUrl(raw: string, name: string, rules: UrlRules): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Env ${name} is not a valid URL`);
  }
  if (!rules.protocols.includes(url.protocol)) {
    throw new Error(`Env ${name} must use one of: ${rules.protocols.join(' ')}`);
  }
  if (url.hostname === '') throw new Error(`Env ${name} must include a host`);
  if (!rules.allowIpv6Literal && url.hostname.startsWith('[')) {
    throw new Error(`Env ${name}: IPv6 literal hosts are not supported, use a hostname`);
  }
  try {
    decodeURIComponent(url.username);
    decodeURIComponent(url.password);
  } catch {
    throw new Error(`Env ${name}: credentials must be percent-encoded`);
  }
  return raw;
}

function parseInteger(raw: string, name: string): number {
  if (!/^\d+$/.test(raw)) throw new Error(`Env ${name} must be an integer`);
  return Number(raw);
}

function parsePort(raw: string, name: string): number {
  const port = parseInteger(raw, name);
  if (port < 1 || port > 65535) throw new Error(`Env ${name} must be between 1 and 65535`);
  return port;
}

function parseTimeout(raw: string, name: string): number {
  const ms = parseInteger(raw, name);
  if (ms < MIN_HEALTH_TIMEOUT_MS || ms > MAX_HEALTH_TIMEOUT_MS) {
    throw new Error(
      `Env ${name} must be between ${MIN_HEALTH_TIMEOUT_MS} and ${MAX_HEALTH_TIMEOUT_MS}`,
    );
  }
  return ms;
}

function parseLogLevel(raw: string, name: string): LogLevel {
  const level = LOG_LEVELS.find((candidate) => candidate === raw);
  if (level === undefined) throw new Error(`Env ${name} must be one of: ${LOG_LEVELS.join(' ')}`);
  return level;
}
