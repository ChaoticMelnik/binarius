import { describe, expect, it } from 'vitest';
import { parseEnv } from './env';

const KEY = Buffer.alloc(32, 7).toString('base64');

const valid = {
  DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  INTERNAL_API_TOKEN: 'internal-token-for-tests',
  BROKER_CLIENT_ID: 'client-id',
  BROKER_CLIENT_SECRET: 'client-secret',
  BROKER_OAUTH_AUTHORIZE_URL: 'https://binodex.app/oauth/authorize',
  BROKER_API_BASE_URL: 'https://binodex.app',
  BROKER_OAUTH_REDIRECT_URI: 'https://bot.example/oauth/callback',
  BROKER_PARTNER_REF: 'partner-ref',
  TOKEN_ENCRYPTION_KEY: KEY,
  TOKEN_ENCRYPTION_KEY_ID: 'dev',
};

describe('parseEnv', () => {
  it('applies defaults for optional variables', () => {
    expect(parseEnv(valid)).toEqual({
      databaseUrl: valid.DATABASE_URL,
      redisUrl: valid.REDIS_URL,
      port: 3000,
      logLevel: 'info',
      healthTimeoutMs: 2000,
      internalApiToken: valid.INTERNAL_API_TOKEN,
      brokerClientId: valid.BROKER_CLIENT_ID,
      brokerClientSecret: valid.BROKER_CLIENT_SECRET,
      brokerOauthAuthorizeUrl: valid.BROKER_OAUTH_AUTHORIZE_URL,
      brokerApiBaseUrl: valid.BROKER_API_BASE_URL,
      brokerOauthRedirectUri: valid.BROKER_OAUTH_REDIRECT_URI,
      brokerPartnerRef: valid.BROKER_PARTNER_REF,
      tokenEncryptionKey: Buffer.from(KEY, 'base64'),
      tokenEncryptionKeyId: valid.TOKEN_ENCRYPTION_KEY_ID,
    });
  });

  it('accepts explicit optional variables', () => {
    const env = parseEnv({
      ...valid,
      PORT: '8080',
      LOG_LEVEL: 'debug',
      HEALTH_TIMEOUT_MS: '2500',
    });
    expect(env.port).toBe(8080);
    expect(env.logLevel).toBe('debug');
    expect(env.healthTimeoutMs).toBe(2500);
  });

  it('accepts the postgresql and rediss schemes', () => {
    const env = parseEnv({
      ...valid,
      DATABASE_URL: 'postgresql://h/db',
      REDIS_URL: 'rediss://h:6380',
    });
    expect(env.databaseUrl).toBe('postgresql://h/db');
    expect(env.redisUrl).toBe('rediss://h:6380');
  });

  it.each([
    'DATABASE_URL',
    'REDIS_URL',
    'INTERNAL_API_TOKEN',
    'BROKER_CLIENT_ID',
    'BROKER_CLIENT_SECRET',
    'BROKER_OAUTH_AUTHORIZE_URL',
    'BROKER_API_BASE_URL',
    'BROKER_OAUTH_REDIRECT_URI',
    'BROKER_PARTNER_REF',
    'TOKEN_ENCRYPTION_KEY',
    'TOKEN_ENCRYPTION_KEY_ID',
  ])('rejects missing %s', (name) => {
    const source: Record<string, string | undefined> = { ...valid, [name]: undefined };
    expect(() => parseEnv(source)).toThrow(`Missing required env ${name}`);
  });

  it.each([
    'DATABASE_URL',
    'REDIS_URL',
    'PORT',
    'LOG_LEVEL',
    'HEALTH_TIMEOUT_MS',
    'INTERNAL_API_TOKEN',
  ])('rejects empty %s instead of defaulting it', (name) => {
    expect(() => parseEnv({ ...valid, [name]: '' })).toThrow(`Env ${name} must not be empty`);
  });

  it.each([
    ['not a url', 'Env DATABASE_URL is not a valid URL'],
    ['http://localhost:5432/db', 'Env DATABASE_URL must use one of: postgres: postgresql:'],
    ['postgres://', 'Env DATABASE_URL must include a host'],
    [
      'postgres://u:p@[::1]:5432/db',
      'Env DATABASE_URL: IPv6 literal hosts are not supported, use a hostname',
    ],
    ['postgres://u:bad%FF@localhost/db', 'Env DATABASE_URL: credentials must be percent-encoded'],
  ])('rejects DATABASE_URL=%s', (url, message) => {
    expect(() => parseEnv({ ...valid, DATABASE_URL: url })).toThrow(message);
  });

  it.each([
    ['redis://', 'Env REDIS_URL must include a host'],
    ['redis:localhost', 'Env REDIS_URL must include a host'],
    ['http://localhost:6379', 'Env REDIS_URL must use one of: redis: rediss:'],
    ['redis://:bad%FF@localhost:6379', 'Env REDIS_URL: credentials must be percent-encoded'],
  ])('rejects REDIS_URL=%s', (url, message) => {
    expect(() => parseEnv({ ...valid, REDIS_URL: url })).toThrow(message);
  });

  it('accepts an IPv6 literal host for REDIS_URL (ioredis strips the brackets itself)', () => {
    expect(parseEnv({ ...valid, REDIS_URL: 'redis://[::1]:6379' }).redisUrl).toBe(
      'redis://[::1]:6379',
    );
  });

  it.each([
    ['0', 'Env PORT must be between 1 and 65535'],
    ['70000', 'Env PORT must be between 1 and 65535'],
    ['abc', 'Env PORT must be an integer'],
    ['80.5', 'Env PORT must be an integer'],
  ])('rejects PORT=%s', (port, message) => {
    expect(() => parseEnv({ ...valid, PORT: port })).toThrow(message);
  });

  it('rejects an unknown LOG_LEVEL', () => {
    expect(() => parseEnv({ ...valid, LOG_LEVEL: 'verbose' })).toThrow(
      'Env LOG_LEVEL must be one of: fatal error warn info debug trace silent',
    );
  });

  it.each([
    ['abc', 'Env HEALTH_TIMEOUT_MS must be an integer'],
    ['100', 'Env HEALTH_TIMEOUT_MS must be between 500 and 2500'],
    ['2501', 'Env HEALTH_TIMEOUT_MS must be between 500 and 2500'],
    ['2147483648', 'Env HEALTH_TIMEOUT_MS must be between 500 and 2500'],
  ])('rejects HEALTH_TIMEOUT_MS=%s', (value, message) => {
    expect(() => parseEnv({ ...valid, HEALTH_TIMEOUT_MS: value })).toThrow(message);
  });

  it.each(['500', '2500'])('accepts the HEALTH_TIMEOUT_MS boundary %s', (value) => {
    expect(parseEnv({ ...valid, HEALTH_TIMEOUT_MS: value }).healthTimeoutMs).toBe(Number(value));
  });
});

describe('INTERNAL_API_TOKEN', () => {
  it.each([
    ['short-token', 'Env INTERNAL_API_TOKEN must be at least 16 characters'],
    ['has a space in it!', 'Env INTERNAL_API_TOKEN must not contain whitespace'],
    ['trailing-newline-token\n', 'Env INTERNAL_API_TOKEN must not contain whitespace'],
  ])('rejects %j', (token, message) => {
    expect(() => parseEnv({ ...valid, INTERNAL_API_TOKEN: token })).toThrow(message);
  });

  it('accepts the 16-character boundary', () => {
    expect(parseEnv({ ...valid, INTERNAL_API_TOKEN: 'x'.repeat(16) }).internalApiToken).toBe(
      'x'.repeat(16),
    );
  });
});

describe('broker OAuth configuration', () => {
  it.each([
    [
      'BROKER_OAUTH_AUTHORIZE_URL',
      'not-a-url',
      'Env BROKER_OAUTH_AUTHORIZE_URL is not a valid URL',
    ],
    [
      'BROKER_API_BASE_URL',
      'ftp://binodex.app',
      'Env BROKER_API_BASE_URL must use one of: https: http:',
    ],
    [
      'BROKER_OAUTH_REDIRECT_URI',
      'https://[::1]/cb',
      'Env BROKER_OAUTH_REDIRECT_URI: IPv6 literal hosts are not supported, use a hostname',
    ],
  ])('rejects %s=%s', (name, value, message) => {
    expect(() => parseEnv({ ...valid, [name]: value })).toThrow(message);
  });

  it.each([
    [Buffer.alloc(31, 1).toString('base64'), 'must decode to 32 bytes'],
    [Buffer.alloc(33, 1).toString('base64'), 'must decode to 32 bytes'],
    ['not base64 at all!!', 'must decode to 32 bytes'],
  ])('rejects a token encryption key of the wrong size (%s)', (key, message) => {
    expect(() => parseEnv({ ...valid, TOKEN_ENCRYPTION_KEY: key })).toThrow(message);
  });

  it.each([
    ['dev|rotated', 'Env TOKEN_ENCRYPTION_KEY_ID must not contain |'],
    ['dev key', 'Env TOKEN_ENCRYPTION_KEY_ID must not contain whitespace'],
  ])('rejects a key id the cipher cannot bind (%s)', (keyId, message) => {
    expect(() => parseEnv({ ...valid, TOKEN_ENCRYPTION_KEY_ID: keyId })).toThrow(message);
  });
});
