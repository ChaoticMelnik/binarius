import { describe, expect, it } from 'vitest';
import {
  errorIdentity,
  errorLogFields,
  LOG_ERROR_KEYS,
  LOG_REDACT_PATHS,
  LOG_SERIALIZERS,
  logOptions,
  positionalErrorHook,
  serializeError,
  UNNAMED_ERROR_MESSAGE,
} from './logging';

// structural only: whether pino honours these paths is proven by
// apps/trading-worker/src/logging.test.ts against the real logger
describe('LOG_REDACT_PATHS', () => {
  it('lists every secret key at depths 0 through 5, plus the request header', () => {
    expect(LOG_REDACT_PATHS).toContain('req.headers.authorization');
    for (const key of [
      'authorization',
      'token',
      'accessToken',
      'refreshToken',
      'password',
      'access_token',
      'refresh_token',
      'client_secret',
      'state',
      'authorizationCode',
      'initData',
      'sessionToken',
      'x-staff-session',
      'cookie',
    ]) {
      expect(LOG_REDACT_PATHS).toContain(key);
      expect(LOG_REDACT_PATHS).toContain(`*.${key}`);
      expect(LOG_REDACT_PATHS).toContain(`*.*.*.*.*.${key}`);
      expect(LOG_REDACT_PATHS).not.toContain(`*.*.*.*.*.*.${key}`);
    }
    expect(LOG_REDACT_PATHS).toHaveLength(2 + 14 * 6);
  });

  // `code` is the most overloaded key name in the stack: SQLSTATE, libuv errno and Fastify's
  // FST_ERR_* all travel under it, and blanking them would cost the diagnostics this project
  // logs errors by. The authorization code is covered where it actually appears instead.
  it('redacts the authorization code as a request field, not as a bare key', () => {
    expect(LOG_REDACT_PATHS).toContain('req.body.code');
    expect(LOG_REDACT_PATHS).not.toContain('code');
    expect(LOG_REDACT_PATHS).not.toContain('*.code');
    expect(LOG_REDACT_PATHS).not.toContain('err.code');
  });
});

describe('errorIdentity', () => {
  it('keeps the name and a string code, and nothing else', () => {
    const error = Object.assign(new TypeError('secret-bearing message'), {
      code: 'ECONNRESET',
      config: { headers: { authorization: 'Bearer leaked' } },
    });
    expect(errorIdentity(error)).toEqual({ name: 'TypeError', code: 'ECONNRESET' });
  });

  it('omits a non-string code and names a non-error throw by its type', () => {
    expect(errorIdentity(Object.assign(new Error('x'), { code: 42 }))).toEqual({ name: 'Error' });
    expect(errorIdentity('boom')).toEqual({ name: 'string' });
    expect(errorIdentity(null)).toEqual({ name: 'object' });
  });
});

// pino runs the serializers over values that already went through errorIdentity, so its own
// output has to pass unchanged — and nothing else that merely carries a `name` may
describe('errorIdentity on objects that are not errors', () => {
  it('keeps an inherited error name and a subclass name', () => {
    class MyErr extends Error {
      constructor() {
        super('secret');
        this.name = 'MyErr';
      }
    }
    expect(errorIdentity(new TypeError('x'))).toStrictEqual({ name: 'TypeError' });
    expect(errorIdentity(new MyErr())).toStrictEqual({ name: 'MyErr' });
  });

  it('passes its own output through unchanged, with and without a cause', () => {
    expect(errorIdentity({ name: 'TypeError', code: 'E1' })).toStrictEqual({
      name: 'TypeError',
      code: 'E1',
    });
    const nested = { name: 'Error', cause: { name: 'Error', code: '23505' } };
    expect(serializeError(nested)).toStrictEqual(nested);
    const bare = Object.assign(Object.create(null) as object, { name: 'E' });
    expect(errorIdentity(bare)).toStrictEqual({ name: 'E' });
  });

  it('names a record that merely has a name by its type', () => {
    expect(errorIdentity({ id: 1, name: 'Ivan Petrov', email: 'i@example.test' })).toStrictEqual(
      { name: 'object' },
    );
  });

  it('names a thrown plain object with a message by its type', () => {
    expect(errorIdentity({ name: 'X', message: 'y' })).toStrictEqual({ name: 'object' });
  });

  it('names a class instance with a name by its type', () => {
    class User {
      name = 'Ivan';
    }
    expect(errorIdentity(new User())).toStrictEqual({ name: 'object' });
  });

  it('names an object whose cause is not an identity by its type', () => {
    expect(errorIdentity({ name: 'E', cause: { name: 'x', detail: 'leak' } })).toStrictEqual({
      name: 'object',
    });
  });

  it('names an object with a non-string name or code by its type', () => {
    expect(errorIdentity({ name: 1 })).toStrictEqual({ name: 'object' });
    expect(errorIdentity({ name: 'E', code: 5 })).toStrictEqual({ name: 'object' });
  });

  it('names an object with a symbol key beside its name by its type', () => {
    expect(errorIdentity({ name: 'E', [Symbol('payload')]: 'leak' })).toStrictEqual({
      name: 'object',
    });
  });
});

describe('serializeError', () => {
  const leaky = () =>
    Object.assign(new TypeError('Bearer secret-in-message'), {
      code: 'E1',
      detail: 'secret-in-field',
      config: { headers: { authorization: 'Bearer secret-in-header' } },
      cause: Object.assign(new Error('secret-in-cause'), {
        code: '23505',
        detail: 'Key (email)=(victim@example.test) already exists.',
      }),
    });

  it('reduces an error to its identity and one level of cause', () => {
    expect(serializeError(leaky())).toStrictEqual({
      name: 'TypeError',
      code: 'E1',
      cause: { name: 'Error', code: '23505' },
    });
  });

  it('is idempotent', () => {
    expect(serializeError(serializeError(leaky()))).toStrictEqual(serializeError(leaky()));
    const identity = errorIdentity(leaky());
    expect(errorIdentity(identity)).toStrictEqual(identity);
  });

  it('omits an absent cause and names a non-error value by its type', () => {
    expect(serializeError(new Error('x', { cause: null }))).toStrictEqual({ name: 'Error' });
    expect(serializeError('boom')).toStrictEqual({ name: 'string' });
    expect(serializeError(new Error('x', { cause: 'text' }))).toStrictEqual({
      name: 'Error',
      cause: { name: 'string' },
    });
  });
});

describe('LOG_SERIALIZERS', () => {
  it('guards exactly the LOG_ERROR_KEYS, each with serializeError', () => {
    expect(Object.keys(LOG_SERIALIZERS).sort()).toStrictEqual([...LOG_ERROR_KEYS].sort());
    for (const key of LOG_ERROR_KEYS) expect(LOG_SERIALIZERS[key]).toBe(serializeError);
  });
});

describe('positionalErrorHook', () => {
  const run = (...args: unknown[]) => {
    const calls: { self: unknown; args: unknown[] }[] = [];
    const self = { logger: true };
    function method(this: unknown, ...received: unknown[]) {
      calls.push({ self: this, args: received });
    }
    positionalErrorHook.call(self, args, method);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.self).toBe(self);
    return calls[0]?.args;
  };

  it('wraps a positional error without a message and supplies a fixed one', () => {
    const error = new Error('secret');
    expect(run(error)).toStrictEqual([{ err: error }, UNNAMED_ERROR_MESSAGE]);
  });

  it('supplies a fixed message for { err } logged without one', () => {
    const obj = { err: new Error('secret'), reqId: 'r1' };
    expect(run(obj)).toStrictEqual([obj, UNNAMED_ERROR_MESSAGE]);
  });

  it('leaves calls that carry a message alone', () => {
    const error = new Error('secret');
    expect(run(error, 'given')).toStrictEqual([error, 'given']);
    expect(run({ err: error }, 'given')).toStrictEqual([{ err: error }, 'given']);
    expect(run({ err: error, msg: 'own' })).toStrictEqual([{ err: error, msg: 'own' }]);
  });

  it('leaves objects pino would not copy a message from alone', () => {
    expect(run({ err: null })).toStrictEqual([{ err: null }]);
    expect(run({ err: { name: 'Error' } })).toStrictEqual([{ err: { name: 'Error' } }]);
    expect(run('plain')).toStrictEqual(['plain']);
  });
});

describe('logOptions', () => {
  it('carries the level, the redact paths, the serializers and the hook', () => {
    const options = logOptions('debug');
    expect(options.level).toBe('debug');
    expect(options.redact).toStrictEqual([...LOG_REDACT_PATHS]);
    expect(options.redact).not.toBe(LOG_REDACT_PATHS);
    expect(options.serializers).toBe(LOG_SERIALIZERS);
    expect(options.hooks.logMethod).toBe(positionalErrorHook);
  });
});

describe('errorLogFields', () => {
  it('carries one level of cause, by identity', () => {
    const cause = Object.assign(new Error('duplicate key'), {
      code: '23505',
      detail: 'Key (email)=(victim@example.test) already exists.',
    });
    const error = Object.assign(new Error('Failed query: select $1'), {
      cause,
      params: ['secret'],
    });
    expect(errorLogFields(error)).toEqual({
      err: { name: 'Error' },
      cause: { name: 'Error', code: '23505' },
    });
  });

  // toStrictEqual, not toEqual: the latter ignores a key whose value is undefined, so an
  // implementation returning { err, cause: undefined } would pass while logging that key
  it('omits the cause entirely when there is none, rather than naming undefined', () => {
    expect(errorLogFields(new Error('plain'))).toStrictEqual({ err: { name: 'Error' } });
    expect(errorLogFields(new Error('explicit', { cause: undefined }))).toStrictEqual({
      err: { name: 'Error' },
    });
    expect(errorLogFields(new Error('null cause', { cause: null }))).toStrictEqual({
      err: { name: 'Error' },
    });
  });

  it('names a cause that is not an error by its type', () => {
    expect(errorLogFields(new Error('x', { cause: 'a string' }))).toEqual({
      err: { name: 'Error' },
      cause: { name: 'string' },
    });
  });

  it('does not walk past the first cause', () => {
    const deep = Object.assign(new Error('deep'), { code: 'DEEP' });
    const middle = new Error('middle', { cause: deep });
    const outer = new Error('outer', { cause: middle });
    expect(errorLogFields(outer)).toEqual({ err: { name: 'Error' }, cause: { name: 'Error' } });
  });
});
