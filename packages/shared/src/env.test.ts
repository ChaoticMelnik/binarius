import { describe, expect, it } from 'vitest';
import {
  DATABASE_URL_RULES,
  REDIS_URL_RULES,
  parseBoundedIntegerEnv,
  parseEnumEnv,
  parseIntegerEnv,
  parseInternalTokenEnv,
  parseLogLevelEnv,
  parseLoopbackOrHttpsUrlEnv,
  parseNoWhitespaceEnv,
  parseOriginEnv,
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

describe('parseLoopbackOrHttpsUrlEnv', () => {
  it.each(['https://binodex.app/oauth/callback', 'http://127.0.0.1:3000/oauth/callback'])(
    'returns %s unchanged',
    (raw) => {
      expect(parseLoopbackOrHttpsUrlEnv(raw, 'BROKER_OAUTH_REDIRECT_URI')).toBe(raw);
    },
  );

  // quoted verbatim: apps/backend/src/env.test.ts asserts this exact sentence
  it('refuses http for anything but this machine', () => {
    expect(() =>
      parseLoopbackOrHttpsUrlEnv('http://binodex.app/oauth/callback', 'BROKER_OAUTH_REDIRECT_URI'),
    ).toThrow('Env BROKER_OAUTH_REDIRECT_URI may only use http for 127.0.0.1 or localhost');
  });

  it.each(['ftp://binodex.app', 'not-a-url'])('refuses %j', (raw) => {
    expect(() => parseLoopbackOrHttpsUrlEnv(raw, 'X')).toThrow('Env X');
  });
});

describe('parseOriginEnv', () => {
  it.each([
    ['https://Admin.Example/', 'https://admin.example'],
    ['https://admin.example', 'https://admin.example'],
    ['http://127.0.0.1:3001', 'http://127.0.0.1:3001'],
    ['http://localhost:3001/', 'http://localhost:3001'],
    ['https://admin.example:443/', 'https://admin.example'],
  ])('normalises %s to %s', (raw, origin) => {
    expect(parseOriginEnv(raw, 'ADMIN_PUBLIC_URL')).toBe(origin);
  });

  it('refuses http for a host that is not this machine', () => {
    expect(() => parseOriginEnv('http://admin.example', 'ADMIN_PUBLIC_URL')).toThrow(
      'Env ADMIN_PUBLIC_URL may only use http for 127.0.0.1 or localhost',
    );
  });

  it.each(['https://admin.example/path', 'https://admin.example/?a=1', 'https://admin.example/#x'])(
    'refuses %s rather than dropping what it carries',
    (raw) => {
      expect(() => parseOriginEnv(raw, 'ADMIN_PUBLIC_URL')).toThrow(
        'Env ADMIN_PUBLIC_URL must be an origin without a path, query or fragment',
      );
    },
  );

  it('refuses credentials', () => {
    expect(() => parseOriginEnv('https://user:pass@admin.example', 'ADMIN_PUBLIC_URL')).toThrow(
      'Env ADMIN_PUBLIC_URL must not carry credentials',
    );
  });
});

// The helper's contract, stated next to it. The oracles that carry weight are the callers' own
// tests in apps/backend, apps/bot and parseInternalTokenEnv above: this describe has no isolating
// mutation by construction, because every caller checks the same behaviour through the same
// function and the same message.
describe('parseNoWhitespaceEnv', () => {
  it.each([' x', 'x y', 'x\n', 'x\t'])('rejects %j', (raw) => {
    expect(() => parseNoWhitespaceEnv(raw, 'SOME_TOKEN')).toThrow(
      'Env SOME_TOKEN must not contain whitespace',
    );
  });

  it('returns a clean value unchanged', () => {
    expect(parseNoWhitespaceEnv('123:abc-DEF_ghi', 'SOME_TOKEN')).toBe('123:abc-DEF_ghi');
  });
});
