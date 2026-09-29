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

// The bearer the bot presents to the backend's internal API. Both processes parse it here, so
// one of them cannot start with a value the other would have refused; short or whitespace-padded
// values are misconfigurations, not secrets.
export const MIN_INTERNAL_TOKEN_LENGTH = 16;

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

// A URL that is either https, or http pointed at this machine. Two variables need exactly
// this rule — the OAuth redirect the broker delivers to, and the origin the admin pages are
// served from — and the wording of the refusal is quoted by both suites.
const LOOPBACK_OR_HTTPS_RULES: UrlEnvRules = {
  protocols: ['https:', 'http:'],
  allowIpv6Literal: false,
};
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost'];

export function parseLoopbackOrHttpsUrlEnv(raw: string, name: string): string {
  const value = parseUrlEnv(raw, name, LOOPBACK_OR_HTTPS_RULES);
  const url = new URL(value);
  if (url.protocol === 'http:' && !LOOPBACK_HOSTS.includes(url.hostname)) {
    throw new Error(`Env ${name} may only use http for ${LOOPBACK_HOSTS.join(' or ')}`);
  }
  return value;
}

// An origin, for comparing against a browser's `Origin` header and for deciding whether a
// cookie may be marked Secure. The value is normalised through `URL.origin` — the header is
// normalised too, so `https://Admin.Example/` and `https://admin.example` are one origin — and
// anything an origin cannot carry is refused rather than silently dropped: a path, a query, a
// fragment or credentials in the variable means it was meant to be something else.
export function parseOriginEnv(raw: string, name: string): string {
  const value = parseLoopbackOrHttpsUrlEnv(raw, name);
  const url = new URL(value);
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error(`Env ${name} must be an origin without a path, query or fragment`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error(`Env ${name} must not carry credentials`);
  }
  return url.origin;
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

export function parseInternalTokenEnv(raw: string, name: string): string {
  if (/\s/.test(raw)) throw new Error(`Env ${name} must not contain whitespace`);
  if (raw.length < MIN_INTERNAL_TOKEN_LENGTH) {
    throw new Error(`Env ${name} must be at least ${MIN_INTERNAL_TOKEN_LENGTH} characters`);
  }
  return raw;
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
