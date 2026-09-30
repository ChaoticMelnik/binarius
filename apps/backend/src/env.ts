import type { LogLevel } from 'fastify';
import {
  DATABASE_URL_RULES,
  REDIS_URL_RULES,
  parseBoundedIntegerEnv,
  parseInternalTokenEnv,
  parseLogLevelEnv,
  parseLoopbackOrHttpsUrlEnv,
  parseNoWhitespaceEnv,
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
  adminBotToken: string;
  adminWebToken: string;
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
    ...parseSharedSecrets(source),
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
    // the redirect target is a local page during development; it never leaves the machine
    brokerOauthRedirectUri: parseLoopbackOrHttpsUrlEnv(
      readEnv(source, 'BROKER_OAUTH_REDIRECT_URI'),
      'BROKER_OAUTH_REDIRECT_URI',
    ),
    brokerPartnerRef: readEnv(source, 'BROKER_PARTNER_REF'),
    // Its own bot, not the one apps/bot runs: two pollers on one token would fight over
    // getUpdates (409), and the staff bot must not be reachable from the public bot's chats.
    adminBotToken: parseNoWhitespaceEnv(readEnv(source, 'ADMIN_BOT_TOKEN'), 'ADMIN_BOT_TOKEN'),
    ...parseTokenEncryption(source),
  };
}

// Both bearers this process accepts, validated together because what matters is the pair.
// internalBearerAuth is the same comparator on both sides, so one value in both variables makes
// the web process's narrow secret open POST /trading/intents, GET /trading/intents/:id,
// POST /users/start and the auth scope as well — the one boundary in this feature that a single
// .env typo removes. ADMIN_WEB_TOKEN opens /admin/* and nothing else, and the reads and the
// revoke behind it additionally require a staff session.
function parseSharedSecrets(source: EnvSource): Pick<Env, 'internalApiToken' | 'adminWebToken'> {
  const internalApiToken = parseInternalTokenEnv(
    readEnv(source, 'INTERNAL_API_TOKEN'),
    'INTERNAL_API_TOKEN',
  );
  const adminWebToken = parseInternalTokenEnv(readEnv(source, 'ADMIN_WEB_TOKEN'), 'ADMIN_WEB_TOKEN');
  if (adminWebToken === internalApiToken) {
    throw new Error(
      'Env ADMIN_WEB_TOKEN must differ from INTERNAL_API_TOKEN: the same value would open the whole internal API to the web process',
    );
  }
  return { internalApiToken, adminWebToken };
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
  return parseNoWhitespaceEnv(raw, name);
}

const parsePort = (raw: string, name: string): number =>
  parseBoundedIntegerEnv(raw, name, 1, 65535);

const parseTimeout = (raw: string, name: string): number =>
  parseBoundedIntegerEnv(raw, name, MIN_HEALTH_TIMEOUT_MS, MAX_HEALTH_TIMEOUT_MS);
