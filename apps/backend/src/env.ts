import type { LogLevel } from 'fastify';
import {
  DATABASE_URL_RULES,
  REDIS_URL_RULES,
  HTTPS_ONLY_RULES,
  assertOriginSpelling,
  parseBoundedIntegerEnv,
  parseInternalTokenEnv,
  parseLogLevelEnv,
  parseLoopbackOrHttpsUrlEnv,
  parseNoWhitespaceEnv,
  parseUrlEnv,
  readEnv,
  type EnvSource,
} from '@binarius/shared';
import { OAUTH_CALLBACK_PATH } from '@binarius/shared/oauth';
import {
  DEFAULT_BROKER_PAIRS_TTL_MS,
  MAX_BROKER_PAIRS_TTL_MS,
  MIN_BROKER_PAIRS_TTL_MS,
} from '@binarius/broker-rest';
import {
  DEFAULT_BALANCE_POLL_PER_MINUTE,
  DEFAULT_SIGNAL_SCAN_PER_MINUTE,
} from '@binarius/shared/broker-budget';
import {
  DEFAULT_BALANCE_RECONCILE_INTERVAL_MS,
  MAX_BALANCE_POLL_PER_MINUTE,
  MAX_BALANCE_RECONCILE_INTERVAL_MS,
  MAX_SIGNAL_SCAN_PER_MINUTE,
  MIN_BALANCE_POLL_PER_MINUTE,
  MIN_BALANCE_RECONCILE_INTERVAL_MS,
  MIN_SIGNAL_SCAN_PER_MINUTE,
} from './timing';

// the compose probe timeout (3s) is sized above this ceiling
const MIN_HEALTH_TIMEOUT_MS = 500;
const MAX_HEALTH_TIMEOUT_MS = 2500;

// AES-256-GCM: the cipher refuses anything else, and a short key would fail at the first login
const TOKEN_ENCRYPTION_KEY_BYTES = 32;
// the key id the all-zero development key is only usable with
const DEV_TOKEN_ENCRYPTION_KEY_ID = 'dev';
// The broker's authorize page reduces its `ref` to this shape, and its email login takes
// `partner_code` only in it: the whole partner link is refused there with a 400.
const PARTNER_CODE = /^[A-Za-z0-9_-]{1,64}$/;

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
  brokerPairsTtlMs: number;
  balanceReconcileIntervalMs: number;
  balancePollMaxPerMinute: number;
  signalScanMaxPerMinute: number;
  brokerOauthRedirectUri: string;
  brokerPartnerRef: string;
  tokenEncryptionKey: Buffer;
  tokenEncryptionKeyId: string;
  telegramBotToken: string;
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
    brokerPairsTtlMs: parseBoundedIntegerEnv(
      readEnv(source, 'BROKER_PAIRS_TTL_MS', String(DEFAULT_BROKER_PAIRS_TTL_MS)),
      'BROKER_PAIRS_TTL_MS',
      MIN_BROKER_PAIRS_TTL_MS,
      MAX_BROKER_PAIRS_TTL_MS,
    ),
    balanceReconcileIntervalMs: parseBoundedIntegerEnv(
      readEnv(
        source,
        'BALANCE_RECONCILE_INTERVAL_MS',
        String(DEFAULT_BALANCE_RECONCILE_INTERVAL_MS),
      ),
      'BALANCE_RECONCILE_INTERVAL_MS',
      MIN_BALANCE_RECONCILE_INTERVAL_MS,
      MAX_BALANCE_RECONCILE_INTERVAL_MS,
    ),
    balancePollMaxPerMinute: parseBoundedIntegerEnv(
      readEnv(source, 'BALANCE_POLL_MAX_PER_MINUTE', String(DEFAULT_BALANCE_POLL_PER_MINUTE)),
      'BALANCE_POLL_MAX_PER_MINUTE',
      MIN_BALANCE_POLL_PER_MINUTE,
      MAX_BALANCE_POLL_PER_MINUTE,
    ),
    signalScanMaxPerMinute: parseBoundedIntegerEnv(
      readEnv(source, 'SIGNAL_SCAN_MAX_PER_MINUTE', String(DEFAULT_SIGNAL_SCAN_PER_MINUTE)),
      'SIGNAL_SCAN_MAX_PER_MINUTE',
      MIN_SIGNAL_SCAN_PER_MINUTE,
      MAX_SIGNAL_SCAN_PER_MINUTE,
    ),
    brokerOauthRedirectUri: parseRedirectUri(source),
    brokerPartnerRef: parsePartnerCode(readEnv(source, 'BROKER_PARTNER_REF'), 'BROKER_PARTNER_REF'),
    ...parseBotTokens(source),
    ...parseTokenEncryption(source),
  };
}

// The broker redirects to apps/web's callback page, so a path other than OAUTH_CALLBACK_PATH would
// send every login to a page nothing serves (until #314 the backend also derived the Mini App's
// login page from this URI's origin). The redirect target is a local page during development; it
// never leaves the machine. The value is sent to the broker byte for byte and the broker compares
// it with the registered spelling, so the raw string is held to the bare spelling as well: URL
// parsing would otherwise pass a trailing "\r" from a CRLF .env, a query or a dot-segment as the
// same path.
function parseRedirectUri(source: EnvSource): string {
  const value = parseLoopbackOrHttpsUrlEnv(
    readEnv(source, 'BROKER_OAUTH_REDIRECT_URI'),
    'BROKER_OAUTH_REDIRECT_URI',
  );
  if (new URL(value).pathname !== OAUTH_CALLBACK_PATH) {
    throw new Error(
      `Env BROKER_OAUTH_REDIRECT_URI must end with ${OAUTH_CALLBACK_PATH}, the page apps/web serves`,
    );
  }
  assertOriginSpelling(value, 'BROKER_OAUTH_REDIRECT_URI', OAUTH_CALLBACK_PATH);
  return value;
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
  const adminWebToken = parseInternalTokenEnv(
    readEnv(source, 'ADMIN_WEB_TOKEN'),
    'ADMIN_WEB_TOKEN',
  );
  if (adminWebToken === internalApiToken) {
    throw new Error(
      'Env ADMIN_WEB_TOKEN must differ from INTERNAL_API_TOKEN: the same value would open the whole internal API to the web process',
    );
  }
  return { internalApiToken, adminWebToken };
}

// Both bot tokens, validated together because the pair is what matters. TELEGRAM_BOT_TOKEN is the
// public bot apps/bot polls; this process only sends on it (the push after the OAuth callback)
// and never polls it. ADMIN_BOT_TOKEN is the staff bot this process polls: one value in both is
// two pollers on one bot, which Telegram settles with a 409 to one of them, and the staff bot
// would be reachable from the public bot's chats.
function parseBotTokens(source: EnvSource): Pick<Env, 'telegramBotToken' | 'adminBotToken'> {
  const telegramBotToken = parseNoWhitespaceEnv(
    readEnv(source, 'TELEGRAM_BOT_TOKEN'),
    'TELEGRAM_BOT_TOKEN',
  );
  const adminBotToken = parseNoWhitespaceEnv(readEnv(source, 'ADMIN_BOT_TOKEN'), 'ADMIN_BOT_TOKEN');
  if (telegramBotToken === adminBotToken) {
    throw new Error(
      'Env TELEGRAM_BOT_TOKEN must differ from ADMIN_BOT_TOKEN: one value in both is two pollers on one bot',
    );
  }
  return { telegramBotToken, adminBotToken };
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

function parsePartnerCode(raw: string, name: string): string {
  if (!PARTNER_CODE.test(raw)) {
    throw new Error(
      `Env ${name} must be the short partner code ([A-Za-z0-9_-], 1-64 chars), not the partner link`,
    );
  }
  return raw;
}

const parsePort = (raw: string, name: string): number =>
  parseBoundedIntegerEnv(raw, name, 1, 65535);

const parseTimeout = (raw: string, name: string): number =>
  parseBoundedIntegerEnv(raw, name, MIN_HEALTH_TIMEOUT_MS, MAX_HEALTH_TIMEOUT_MS);
