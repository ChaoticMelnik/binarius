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
  BROKER_API_BASE_URL: 'https://api.binodex.app',
  BROKER_OAUTH_REDIRECT_URI: 'https://bot.example/oauth/callback',
  BROKER_PARTNER_REF: 'partner-ref',
  TOKEN_ENCRYPTION_KEY: KEY,
  TOKEN_ENCRYPTION_KEY_ID: 'dev',
  TELEGRAM_BOT_TOKEN: '5678:public-bot-token',
  ADMIN_BOT_TOKEN: '1234:admin-bot-token',
  ADMIN_WEB_TOKEN: 'admin-web-token-for-tests',
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
      telegramBotToken: valid.TELEGRAM_BOT_TOKEN,
      adminBotToken: valid.ADMIN_BOT_TOKEN,
      adminWebToken: valid.ADMIN_WEB_TOKEN,
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
      'ftp://api.binodex.app',
      'Env BROKER_API_BASE_URL must use one of: https:',
    ],
    // the broker is reached over the internet: plaintext there would expose the code in flight
    [
      'BROKER_API_BASE_URL',
      'http://api.binodex.app',
      'Env BROKER_API_BASE_URL must use one of: https:',
    ],
    [
      'BROKER_OAUTH_AUTHORIZE_URL',
      'http://binodex.app/oauth/authorize',
      'Env BROKER_OAUTH_AUTHORIZE_URL must use one of: https:',
    ],
    [
      'BROKER_OAUTH_REDIRECT_URI',
      'http://bot.example/oauth/callback',
      'Env BROKER_OAUTH_REDIRECT_URI may only use http for 127.0.0.1 or localhost',
    ],
    [
      'BROKER_OAUTH_REDIRECT_URI',
      'https://[::1]/cb',
      'Env BROKER_OAUTH_REDIRECT_URI: IPv6 literal hosts are not supported, use a hostname',
    ],
  ])('rejects %s=%s', (name, value, message) => {
    expect(() => parseEnv({ ...valid, [name]: value })).toThrow(message);
  });

  // the link is what the partner cabinet hands out, so it is the likeliest wrong value
  it.each(['https://bdclick.app/smart/zr7IA7', 'zr7IA7/', 'zr7 IA7', 'zr7IA7\n', 'a'.repeat(65)])(
    'rejects %j as a partner code',
    (value) => {
      expect(() => parseEnv({ ...valid, BROKER_PARTNER_REF: value })).toThrow(
        'Env BROKER_PARTNER_REF must be the short partner code ([A-Za-z0-9_-], 1-64 chars), not the partner link',
      );
    },
  );

  it.each(['zr7IA7', 'a', '_-', 'a'.repeat(64), 'ci-partner-ref', 'partner-ref'])(
    'accepts %j as a partner code',
    (value) => {
      expect(parseEnv({ ...valid, BROKER_PARTNER_REF: value }).brokerPartnerRef).toBe(value);
    },
  );

  // the redirect target during development is a page on this machine, which no proxy sees
  it.each(['http://127.0.0.1:3000/oauth/callback', 'http://localhost:3000/oauth/callback'])(
    'accepts %s as a loopback redirect',
    (value) => {
      expect(parseEnv({ ...valid, BROKER_OAUTH_REDIRECT_URI: value }).brokerOauthRedirectUri).toBe(
        value,
      );
    },
  );

  // compose substitutes this key so the stack starts with no secret management at all; it is
  // usable only under the key id compose pairs it with
  it('accepts the published development key only under the dev key id', () => {
    const devKey = Buffer.alloc(32).toString('base64');
    expect(
      parseEnv({ ...valid, TOKEN_ENCRYPTION_KEY: devKey, TOKEN_ENCRYPTION_KEY_ID: 'dev' })
        .tokenEncryptionKey,
    ).toEqual(Buffer.alloc(32));
    expect(() =>
      parseEnv({ ...valid, TOKEN_ENCRYPTION_KEY: devKey, TOKEN_ENCRYPTION_KEY_ID: 'prod-1' }),
    ).toThrow('is the published development key');
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

describe('the staff-login variables', () => {
  it.each(['ADMIN_BOT_TOKEN', 'ADMIN_WEB_TOKEN'] as const)('requires %s', (name) => {
    const without: Record<string, string> = { ...valid };
    delete without[name];
    expect(() => parseEnv(without)).toThrow(`Missing required env ${name}`);
  });

  // a token pasted out of BotFather's message, or out of a password manager, with the newline
  it.each(['1234:token\n', '1234: token', ' 1234:token'])(
    'refuses a bot token carrying whitespace (%j)',
    (ADMIN_BOT_TOKEN) => {
      expect(() => parseEnv({ ...valid, ADMIN_BOT_TOKEN })).toThrow(
        'Env ADMIN_BOT_TOKEN must not contain whitespace',
      );
    },
  );

  it('refuses an empty bot token', () => {
    expect(() => parseEnv({ ...valid, ADMIN_BOT_TOKEN: '' })).toThrow(
      'Env ADMIN_BOT_TOKEN must not be empty',
    );
  });

  // the same rules the internal token is held to: it is a shared secret, just a narrower one
  it.each(['short', 'has whitespace in it '])(
    'refuses a weak web token (%j)',
    (ADMIN_WEB_TOKEN) => {
      expect(() => parseEnv({ ...valid, ADMIN_WEB_TOKEN })).toThrow('Env ADMIN_WEB_TOKEN');
    },
  );

  // internalBearerAuth is the same comparator on both sides, so one value in both variables
  // would let the web process's narrow secret open the whole internal API. The pair the fixture
  // declares is already asserted by `applies defaults for optional variables`; this is the
  // refusal, which is the half nothing enforced before.
  it('refuses ADMIN_WEB_TOKEN equal to INTERNAL_API_TOKEN', () => {
    expect(() => parseEnv({ ...valid, ADMIN_WEB_TOKEN: valid.INTERNAL_API_TOKEN })).toThrow(
      'Env ADMIN_WEB_TOKEN must differ from INTERNAL_API_TOKEN',
    );
  });
});

describe('the public bot token', () => {
  // the push after the OAuth callback (#128) sends on it
  it('requires TELEGRAM_BOT_TOKEN', () => {
    const without: Record<string, string> = { ...valid };
    delete without.TELEGRAM_BOT_TOKEN;
    expect(() => parseEnv(without)).toThrow('Missing required env TELEGRAM_BOT_TOKEN');
  });

  it.each(['', '5678:token\n', ' 5678:token'])('refuses an unusable value (%j)', (value) => {
    expect(() => parseEnv({ ...valid, TELEGRAM_BOT_TOKEN: value })).toThrow(
      'Env TELEGRAM_BOT_TOKEN must not',
    );
  });

  // one value in both is two pollers on one bot: Telegram answers 409 to one of them, and the
  // staff bot would answer in the public bot's chats
  it('refuses TELEGRAM_BOT_TOKEN equal to ADMIN_BOT_TOKEN', () => {
    expect(() => parseEnv({ ...valid, TELEGRAM_BOT_TOKEN: valid.ADMIN_BOT_TOKEN })).toThrow(
      'Env TELEGRAM_BOT_TOKEN must differ from ADMIN_BOT_TOKEN',
    );
  });
});
