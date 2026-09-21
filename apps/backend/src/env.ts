const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export interface Env {
  databaseUrl: string;
  redisUrl: string;
  port: number;
  logLevel: LogLevel;
}

type Source = Record<string, string | undefined>;

export function parseEnv(source: Source): Env {
  return {
    databaseUrl: requireUrl(source, 'DATABASE_URL', ['postgres:', 'postgresql:']),
    redisUrl: requireUrl(source, 'REDIS_URL', ['redis:', 'rediss:']),
    port: optional(source, 'PORT', 3000, parsePort),
    logLevel: optional(source, 'LOG_LEVEL', 'info', parseLogLevel),
  };
}

function requireUrl(source: Source, name: string, protocols: string[]): string {
  const value = source[name];
  if (value === undefined) throw new Error(`Missing required env ${name}`);
  if (value === '') throw new Error(`Env ${name} must not be empty`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Env ${name} is not a valid URL`);
  }
  if (!protocols.includes(url.protocol)) {
    throw new Error(`Env ${name} must use one of: ${protocols.join(' ')}`);
  }
  return value;
}

function optional<T>(
  source: Source,
  name: string,
  fallback: T,
  parse: (raw: string, name: string) => T,
): T {
  const value = source[name];
  if (value === undefined) return fallback;
  if (value === '') throw new Error(`Env ${name} must not be empty`);
  return parse(value, name);
}

function parsePort(raw: string, name: string): number {
  if (!/^\d+$/.test(raw)) throw new Error(`Env ${name} must be an integer`);
  const port = Number(raw);
  if (port < 1 || port > 65535) throw new Error(`Env ${name} must be between 1 and 65535`);
  return port;
}

function parseLogLevel(raw: string, name: string): LogLevel {
  if (!isLogLevel(raw)) throw new Error(`Env ${name} must be one of: ${LOG_LEVELS.join(' ')}`);
  return raw;
}

function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}
