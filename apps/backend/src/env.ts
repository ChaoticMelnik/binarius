import type { LogLevel } from 'fastify';
import {
  DATABASE_URL_RULES,
  REDIS_URL_RULES,
  parseBoundedIntegerEnv,
  parseLogLevelEnv,
  parseUrlEnv,
  readEnv,
  type EnvSource,
  type UrlEnvRules,
} from '@binarius/shared';

// the compose probe timeout (3s) is sized above this ceiling
const MIN_HEALTH_TIMEOUT_MS = 500;
const MAX_HEALTH_TIMEOUT_MS = 2500;

// shared with the bot; short or whitespace-padded values are misconfigurations, not secrets
const MIN_INTERNAL_TOKEN_LENGTH = 16;
// AES-256-GCM: the cipher refuses anything else, and a short key would fail at the first login
const TOKEN_ENCRYPTION_KEY_BYTES = 32;
const HTTPS_URL_RULES: UrlEnvRules = { protocols: ['https:', 'http:'], allowIpv6Literal: false };

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
    internalApiToken: parseInternalToken(
      readEnv(source, 'INTERNAL_API_TOKEN'),
      'INTERNAL_API_TOKEN',
    ),
    brokerClientId: readEnv(source, 'BROKER_CLIENT_ID'),
    brokerClientSecret: readEnv(source, 'BROKER_CLIENT_SECRET'),
    brokerOauthAuthorizeUrl: parseUrlEnv(
      readEnv(source, 'BROKER_OAUTH_AUTHORIZE_URL'),
      'BROKER_OAUTH_AUTHORIZE_URL',
      HTTPS_URL_RULES,
    ),
    brokerApiBaseUrl: parseUrlEnv(
      readEnv(source, 'BROKER_API_BASE_URL'),
      'BROKER_API_BASE_URL',
      HTTPS_URL_RULES,
    ),
    brokerOauthRedirectUri: parseUrlEnv(
      readEnv(source, 'BROKER_OAUTH_REDIRECT_URI'),
      'BROKER_OAUTH_REDIRECT_URI',
      HTTPS_URL_RULES,
    ),
    brokerPartnerRef: readEnv(source, 'BROKER_PARTNER_REF'),
    tokenEncryptionKey: parseEncryptionKey(
      readEnv(source, 'TOKEN_ENCRYPTION_KEY'),
      'TOKEN_ENCRYPTION_KEY',
    ),
    tokenEncryptionKeyId: parseKeyId(
      readEnv(source, 'TOKEN_ENCRYPTION_KEY_ID'),
      'TOKEN_ENCRYPTION_KEY_ID',
    ),
  };
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
