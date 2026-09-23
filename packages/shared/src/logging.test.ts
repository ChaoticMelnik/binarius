import { describe, expect, it } from 'vitest';
import { errorIdentity, LOG_REDACT_PATHS } from './logging';

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
    ]) {
      expect(LOG_REDACT_PATHS).toContain(key);
      expect(LOG_REDACT_PATHS).toContain(`*.${key}`);
      expect(LOG_REDACT_PATHS).toContain(`*.*.*.*.*.${key}`);
      expect(LOG_REDACT_PATHS).not.toContain(`*.*.*.*.*.*.${key}`);
    }
    expect(LOG_REDACT_PATHS).toHaveLength(2 + 10 * 6);
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
