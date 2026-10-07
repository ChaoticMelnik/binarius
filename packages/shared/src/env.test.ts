import { describe, expect, it } from 'vitest';
import {
  DATABASE_URL_RULES,
  REDIS_URL_RULES,
  assertOriginSpelling,
  parseBooleanEnv,
  parseBoundedIntegerEnv,
  parseEnumEnv,
  parseIntegerEnv,
  parseInternalTokenEnv,
  parseLogLevelEnv,
  parseLoopbackOrHttpsUrlEnv,
  parseNoWhitespaceEnv,
  parseOriginEnv,
  parseRealTradingEnabledEnv,
  parseUrlEnv,
  readEnv,
} from './env';
import { OAUTH_CALLBACK_PATH } from './oauth';

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

describe('parseBooleanEnv', () => {
  it.each([
    ['true', true],
    ['false', false],
  ])('reads %s', (raw, expected) => {
    expect(parseBooleanEnv(raw, 'X')).toBe(expected);
  });

  it.each(['TRUE', '1', 'yes'])('refuses %s', (raw) => {
    expect(() => parseBooleanEnv(raw, 'X')).toThrow('Env X must be one of: true false');
  });
});

describe('parseRealTradingEnabledEnv', () => {
  it('is false without the variable', () => {
    expect(parseRealTradingEnabledEnv({})).toBe(false);
  });

  it('reads true', () => {
    expect(parseRealTradingEnabledEnv({ REAL_TRADING_ENABLED: 'true' })).toBe(true);
  });

  it('refuses an empty value', () => {
    expect(() => parseRealTradingEnabledEnv({ REAL_TRADING_ENABLED: '' })).toThrow(
      'Env REAL_TRADING_ENABLED must not be empty',
    );
  });

  it('names the variable when the value is not a boolean', () => {
    expect(() => parseRealTradingEnabledEnv({ REAL_TRADING_ENABLED: 'yes' })).toThrow(
      'Env REAL_TRADING_ENABLED must be one of: true false',
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

const ACCEPTED_ORIGIN_ROWS = [
  ['https://Admin.Example', 'https://admin.example'],
  ['https://admin.example', 'https://admin.example'],
  ['HTTPS://admin.example', 'https://admin.example'],
  ['http://127.0.0.1:3001', 'http://127.0.0.1:3001'],
  ['http://localhost:3001', 'http://localhost:3001'],
  ['https://admin.example:443', 'https://admin.example'],
] as const;

describe('parseOriginEnv', () => {
  it.each(ACCEPTED_ORIGIN_ROWS)('normalises %s to %s', (raw, origin) => {
    expect(parseOriginEnv(raw, 'WEB_PUBLIC_URL')).toBe(origin);
  });

  it('refuses http for a host that is not this machine', () => {
    expect(() => parseOriginEnv('http://admin.example', 'WEB_PUBLIC_URL')).toThrow(
      'Env WEB_PUBLIC_URL may only use http for 127.0.0.1 or localhost',
    );
  });

  it.each(['https://admin.example/path', 'https://admin.example/?a=1', 'https://admin.example/#x'])(
    'refuses %s rather than dropping what it carries',
    (raw) => {
      expect(() => parseOriginEnv(raw, 'WEB_PUBLIC_URL')).toThrow(
        'Env WEB_PUBLIC_URL must be an origin without a path, query or fragment',
      );
    },
  );

  it('refuses credentials', () => {
    expect(() => parseOriginEnv('https://user:pass@admin.example', 'WEB_PUBLIC_URL')).toThrow(
      'Env WEB_PUBLIC_URL must not carry credentials',
    );
  });

  // URL parsing strips these, so they are visible only in the raw value
  it.each([
    'https://admin.example ',
    'https://admin.example\t',
    'https://admin.example\r',
    'https://admin.example\n',
    ' https://admin.example',
    '\thttps://admin.example',
    'https://admin.ex\tample',
    'https://admin.example\x01',
    'https://admin\u200b.example',
  ])('refuses %j, which carries whitespace, a control or a format character', (raw) => {
    expect(() => parseOriginEnv(raw, 'WEB_PUBLIC_URL')).toThrow(
      'Env WEB_PUBLIC_URL must not contain whitespace, control or invisible format characters',
    );
  });

  // each normalises away in URL.origin, yet breaks or changes compose's
  // `${WEB_PUBLIC_URL}/oauth/callback`
  it.each([
    'https://admin.example/',
    'http://127.0.0.1:3001/',
    'https://admin.example?',
    'https://admin.example#',
    'https://admin.example\\',
    'https://admin.example/..',
    'https://admin.example/.',
    'https:admin.example',
    'https:/admin.example',
    'https:\\\\admin.example',
    'https://admin%2eexample',
    'https://@admin.example',
    'https://admin.example:',
  ])('refuses %j, which is not spelled scheme://host[:port]', (raw) => {
    expect(() => parseOriginEnv(raw, 'WEB_PUBLIC_URL')).toThrow(
      'Env WEB_PUBLIC_URL must be spelled scheme://host[:port] and nothing else (no "/", "?", "#", "\\", "%", "@" or dot-segments): compose appends /oauth/callback to it',
    );
  });

  // compose builds the default BROKER_OAUTH_REDIRECT_URI as `${WEB_PUBLIC_URL}/oauth/callback`:
  // every accepted origin must concatenate into a redirect the backend accepts, on this origin
  it.each(ACCEPTED_ORIGIN_ROWS.map(([raw]) => raw))(
    '%s concatenates into an accepted redirect on the same origin',
    (raw) => {
      const redirect = raw + OAUTH_CALLBACK_PATH;
      expect(() =>
        assertOriginSpelling(redirect, 'BROKER_OAUTH_REDIRECT_URI', OAUTH_CALLBACK_PATH),
      ).not.toThrow();
      expect(new URL(redirect).href).toBe(
        parseOriginEnv(raw, 'WEB_PUBLIC_URL') + OAUTH_CALLBACK_PATH,
      );
    },
  );
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
