import type { LogLevel } from 'fastify';
import {
  DATABASE_URL_RULES,
  REDIS_URL_RULES,
  parseBoundedIntegerEnv,
  parseInternalTokenEnv,
  parseLogLevelEnv,
  parseUrlEnv,
  readEnv,
  type EnvSource,
  type UrlEnvRules,
} from '@binarius/shared';

// the compose probe timeout (3s) is sized above this ceiling
const MIN_HEALTH_TIMEOUT_MS = 500;
const MAX_HEALTH_TIMEOUT_MS = 2500;

// AES-256-GCM: the cipher refuses anything else, and a short key would fail at the first login
const TOKEN_ENCRYPTION_KEY_BYTES = 32;
// the key id the all-zero development key is only usable with
const DEV_TOKEN_ENCRYPTION_KEY_ID = 'dev';
// the broker is reached over the public internet, and an authorize page served over http would
// hand the authorization code to anyone on the path
const HTTPS_ONLY_RULES: UrlEnvRules = { protocols: ['https:'], allowIpv6Literal: false };
const REDIRECT_URI_RULES: UrlEnvRules = { protocols: ['https:', 'http:'], allowIpv6Literal: false };
// the redirect target is a local page during development; it never leaves the machine
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);

export interface Env {
  databaseUrl: string;
  redisUrl: string;
  port: number;
  logLevel: LogLevel;
  healthTimeoutMs: number;
  internalApiToken: string;
  brokerClientId: string;
  brokerClientSecret: string;
  brokerOauthAuthorizeUrl: string;
  brokerApiBaseUrl: string;
  brokerOauthRedirectUri: string;
  brokerPartnerRef: string;
  tokenEncryptionKey: Buffer;
  tokenEncryptionKeyId: string;
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
    internalApiToken: parseInternalTokenEnv(
      readEnv(source, 'INTERNAL_API_TOKEN'),
      'INTERNAL_API_TOKEN',
    ),
    brokerClientId: readEnv(source, 'BROKER_CLIENT_ID'),
    brokerClientSecret: readEnv(source, 'BROKER_CLIENT_SECRET'),
    brokerOauthAuthorizeUrl: parseUrlEnv(
      readEnv(source, 'BROKER_OAUTH_AUTHORIZE_URL'),
      'BROKER_OAUTH_AUTHORIZE_URL',
      HTTPS_ONLY_RULES,
    ),
    brokerApiBaseUrl: parseUrlEnv(
      readEnv(source, 'BROKER_API_BASE_URL'),
      'BROKER_API_BASE_URL',
      HTTPS_ONLY_RULES,
    ),
    brokerOauthRedirectUri: parseRedirectUri(
      readEnv(source, 'BROKER_OAUTH_REDIRECT_URI'),
      'BROKER_OAUTH_REDIRECT_URI',
    ),
    brokerPartnerRef: readEnv(source, 'BROKER_PARTNER_REF'),
    ...parseTokenEncryption(source),
  };
}

function parseRedirectUri(raw: string, name: string): string {
  const value = parseUrlEnv(raw, name, REDIRECT_URI_RULES);
  const url = new URL(value);
  if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(`Env ${name} may only use http for ${[...LOOPBACK_HOSTS].join(' or ')}`);
  }
  return value;
}

// The two are validated together because the pair is what matters. The all-zero key is
// published in this repository, so it is accepted only alongside the key id that marks it as
// development. Any other id with that key is refused: that combination is what a half-finished
// rotation looks like, and it would silently encrypt real tokens under a key anyone can read.
function parseTokenEncryption(
  source: EnvSource,
): Pick<Env, 'tokenEncryptionKey' | 'tokenEncryptionKeyId'> {
  const tokenEncryptionKey = parseEncryptionKey(
    readEnv(source, 'TOKEN_ENCRYPTION_KEY'),
    'TOKEN_ENCRYPTION_KEY',
  );
  const tokenEncryptionKeyId = parseKeyId(
    readEnv(source, 'TOKEN_ENCRYPTION_KEY_ID'),
    'TOKEN_ENCRYPTION_KEY_ID',
  );
  if (
    tokenEncryptionKey.equals(Buffer.alloc(TOKEN_ENCRYPTION_KEY_BYTES)) &&
    tokenEncryptionKeyId !== DEV_TOKEN_ENCRYPTION_KEY_ID
  ) {
    throw new Error(
      `Env TOKEN_ENCRYPTION_KEY is the published development key, which is only allowed with TOKEN_ENCRYPTION_KEY_ID=${DEV_TOKEN_ENCRYPTION_KEY_ID}`,
    );
  }
  return { tokenEncryptionKey, tokenEncryptionKeyId };
}

function parseEncryptionKey(raw: string, name: string): Buffer {
  const key = Buffer.from(raw, 'base64');
  if (key.byteLength !== TOKEN_ENCRYPTION_KEY_BYTES) {
    throw new Error(`Env ${name} must decode to ${TOKEN_ENCRYPTION_KEY_BYTES} bytes of base64`);
  }
  return key;
}

// the cipher joins key id, account id and field with '|' to bind a ciphertext to its place,
// so a key id containing the separator would make that binding ambiguous
function parseKeyId(raw: string, name: string): string {
  if (raw.includes('|')) throw new Error(`Env ${name} must not contain |`);
  if (/\s/.test(raw)) throw new Error(`Env ${name} must not contain whitespace`);
  return raw;
}

const parsePort = (raw: string, name: string): number =>
  parseBoundedIntegerEnv(raw, name, 1, 65535);

const parseTimeout = (raw: string, name: string): number =>
  parseBoundedIntegerEnv(raw, name, MIN_HEALTH_TIMEOUT_MS, MAX_HEALTH_TIMEOUT_MS);
