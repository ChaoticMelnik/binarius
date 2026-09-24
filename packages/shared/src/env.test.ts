import { describe, expect, it } from 'vitest';
import {
  DATABASE_URL_RULES,
  REDIS_URL_RULES,
  parseBoundedIntegerEnv,
  parseEnumEnv,
  parseIntegerEnv,
  parseInternalTokenEnv,
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

describe('parseInternalTokenEnv', () => {
  it('rejects a token shorter than the floor', () => {
    expect(() => parseInternalTokenEnv('a'.repeat(15), 'INTERNAL_API_TOKEN')).toThrow(
      'Env INTERNAL_API_TOKEN must be at least 16 characters',
    );
  });

  it.each([' abcdefghijklmnop', 'abcdefgh ijklmnop', 'abcdefghijklmnop\n'])(
    'rejects whitespace in %j',
    (raw) => {
      expect(() => parseInternalTokenEnv(raw, 'INTERNAL_API_TOKEN')).toThrow(
        'Env INTERNAL_API_TOKEN must not contain whitespace',
      );
    },
  );

  it('accepts the shortest allowed token unchanged', () => {
    expect(parseInternalTokenEnv('a'.repeat(16), 'INTERNAL_API_TOKEN')).toBe('a'.repeat(16));
  });
});

describe('parseBoundedIntegerEnv', () => {
  it.each(['499', '2501'])('rejects %s outside 500-2500', (raw) => {
    expect(() => parseBoundedIntegerEnv(raw, 'X', 500, 2500)).toThrow(
      'Env X must be between 500 and 2500',
    );
  });

  it.each(['500', '2500'])('accepts the boundary %s', (raw) => {
    expect(parseBoundedIntegerEnv(raw, 'X', 500, 2500)).toBe(Number(raw));
  });

  it('rejects a non-integer before checking the bounds', () => {
    expect(() => parseBoundedIntegerEnv('1e3', 'X', 0, 10_000)).toThrow('Env X must be an integer');
  });
});
