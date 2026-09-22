import { describe, expect, it } from 'vitest';
import { parseEnv } from './env';

const valid = {
  DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
};

describe('parseEnv', () => {
  it('applies defaults for optional variables', () => {
    expect(parseEnv(valid)).toEqual({
      databaseUrl: valid.DATABASE_URL,
      redisUrl: valid.REDIS_URL,
      port: 3000,
      logLevel: 'info',
      healthTimeoutMs: 2000,
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
    const env = parseEnv({ DATABASE_URL: 'postgresql://h/db', REDIS_URL: 'rediss://h:6380' });
    expect(env.databaseUrl).toBe('postgresql://h/db');
    expect(env.redisUrl).toBe('rediss://h:6380');
  });

  it.each(['DATABASE_URL', 'REDIS_URL'])('rejects missing %s', (name) => {
    const source: Record<string, string | undefined> = { ...valid, [name]: undefined };
    expect(() => parseEnv(source)).toThrow(`Missing required env ${name}`);
  });

  it.each(['DATABASE_URL', 'REDIS_URL', 'PORT', 'LOG_LEVEL', 'HEALTH_TIMEOUT_MS'])(
    'rejects empty %s instead of defaulting it',
    (name) => {
      expect(() => parseEnv({ ...valid, [name]: '' })).toThrow(`Env ${name} must not be empty`);
    },
  );

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
    ['100', 'Env HEALTH_TIMEOUT_MS must be at least 500'],
  ])('rejects HEALTH_TIMEOUT_MS=%s', (value, message) => {
    expect(() => parseEnv({ ...valid, HEALTH_TIMEOUT_MS: value })).toThrow(message);
  });
});
