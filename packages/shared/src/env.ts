export type EnvSource = Record<string, string | undefined>;

export interface UrlEnvRules {
  protocols: readonly string[];
  allowIpv6Literal: boolean;
}

// pg-connection-string passes bracketed IPv6 hosts through to the socket; ioredis strips them
export const DATABASE_URL_RULES: UrlEnvRules = {
  protocols: ['postgres:', 'postgresql:'],
  allowIpv6Literal: false,
};
export const REDIS_URL_RULES: UrlEnvRules = {
  protocols: ['redis:', 'rediss:'],
  allowIpv6Literal: true,
};

// pino levels; fastify's LogLevel is the same union
export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

// `??` keeps '' distinct from undefined: an explicitly empty variable is an error, not a default
export function readEnv(source: EnvSource, name: string, fallback?: string): string {
  const value = source[name] ?? fallback;
  if (value === undefined) throw new Error(`Missing required env ${name}`);
  if (value === '') throw new Error(`Env ${name} must not be empty`);
  return value;
}

export function parseUrlEnv(raw: string, name: string, rules: UrlEnvRules): string {
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

export function parseIntegerEnv(raw: string, name: string): number {
  if (!/^\d+$/.test(raw)) throw new Error(`Env ${name} must be an integer`);
  return Number(raw);
}

export function parseEnumEnv<T extends string>(raw: string, name: string, values: readonly T[]): T {
  const value = values.find((candidate) => candidate === raw);
  if (value === undefined) throw new Error(`Env ${name} must be one of: ${values.join(' ')}`);
  return value;
}

export function parseLogLevelEnv(raw: string, name: string): LogLevel {
  return parseEnumEnv(raw, name, LOG_LEVELS);
}

export function parseBoundedIntegerEnv(
  raw: string,
  name: string,
  min: number,
  max: number,
): number {
  const value = parseIntegerEnv(raw, name);
  if (value < min || value > max) throw new Error(`Env ${name} must be between ${min} and ${max}`);
  return value;
}
