import { describe, expect, it } from 'vitest';
import {
  DATABASE_URL_RULES,
  REDIS_URL_RULES,
  parseEnumEnv,
  parseIntegerEnv,
  parseLogLevelEnv,
  parseUrlEnv,
  readEnv,
} from './env';

describe('readEnv', () => {
  it('returns the value or the fallback', () => {
    expect(readEnv({ A: 'x' }, 'A')).toBe('x');
    expect(readEnv({}, 'A', 'dflt')).toBe('dflt');
  });

  it('rejects a missing variable without a fallback', () => {
    expect(() => readEnv({}, 'A')).toThrow('Missing required env A');
  });

  it('rejects an empty variable instead of defaulting it', () => {
    expect(() => readEnv({ A: '' }, 'A', 'dflt')).toThrow('Env A must not be empty');
  });
});

describe('parseUrlEnv', () => {
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
    expect(() => parseUrlEnv(url, 'DATABASE_URL', DATABASE_URL_RULES)).toThrow(message);
  });

  it('accepts both postgres schemes and returns the raw value', () => {
    expect(parseUrlEnv('postgresql://h/db', 'DATABASE_URL', DATABASE_URL_RULES)).toBe(
      'postgresql://h/db',
    );
  });

  it('accepts an IPv6 literal host where the rules allow it', () => {
    expect(parseUrlEnv('redis://[::1]:6379', 'REDIS_URL', REDIS_URL_RULES)).toBe(
      'redis://[::1]:6379',
    );
  });
});

describe('parseIntegerEnv', () => {
  it.each(['abc', '80.5', '-1', ''])('rejects %j', (raw) => {
    expect(() => parseIntegerEnv(raw, 'PORT')).toThrow('Env PORT must be an integer');
  });

  it('parses digits', () => {
    expect(parseIntegerEnv('8080', 'PORT')).toBe(8080);
  });
});

describe('parseEnumEnv', () => {
  it('returns the matching member', () => {
    expect(parseEnumEnv('b', 'X', ['a', 'b'] as const)).toBe('b');
  });

  it('lists the allowed values on mismatch', () => {
    expect(() => parseEnumEnv('c', 'X', ['a', 'b'] as const)).toThrow('Env X must be one of: a b');
  });

  it('rejects an unknown log level', () => {
    expect(() => parseLogLevelEnv('verbose', 'LOG_LEVEL')).toThrow(
      'Env LOG_LEVEL must be one of: fatal error warn info debug trace silent',
    );
  });
});
