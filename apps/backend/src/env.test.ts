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
    });
  });

  it('accepts explicit optional variables', () => {
    const env = parseEnv({ ...valid, PORT: '8080', LOG_LEVEL: 'debug' });
    expect(env.port).toBe(8080);
    expect(env.logLevel).toBe('debug');
  });

  it('accepts the postgresql and rediss schemes', () => {
    expect(() =>
      parseEnv({ DATABASE_URL: 'postgresql://h/db', REDIS_URL: 'rediss://h:6380' }),
    ).not.toThrow();
  });

  it.each(['DATABASE_URL', 'REDIS_URL'])('rejects missing %s', (name) => {
    const source: Record<string, string | undefined> = { ...valid, [name]: undefined };
    expect(() => parseEnv(source)).toThrow(`Missing required env ${name}`);
  });

  it.each(['DATABASE_URL', 'REDIS_URL'])('rejects empty %s', (name) => {
    expect(() => parseEnv({ ...valid, [name]: '' })).toThrow(`Env ${name} must not be empty`);
  });

  it('rejects a malformed URL', () => {
    expect(() => parseEnv({ ...valid, DATABASE_URL: 'not a url' })).toThrow(
      'Env DATABASE_URL is not a valid URL',
    );
  });

  it('rejects a wrong scheme', () => {
    expect(() => parseEnv({ ...valid, REDIS_URL: 'http://localhost:6379' })).toThrow(
      'Env REDIS_URL must use one of: redis: rediss:',
    );
  });

  it.each(['0', '70000', 'abc', '80.5'])('rejects PORT=%s', (port) => {
    expect(() => parseEnv({ ...valid, PORT: port })).toThrow(/Env PORT must/);
  });

  it('rejects an empty PORT instead of defaulting it', () => {
    expect(() => parseEnv({ ...valid, PORT: '' })).toThrow('Env PORT must not be empty');
  });

  it.each(['', 'verbose'])('rejects LOG_LEVEL=%j', (level) => {
    expect(() => parseEnv({ ...valid, LOG_LEVEL: level })).toThrow(/Env LOG_LEVEL must/);
  });
});
