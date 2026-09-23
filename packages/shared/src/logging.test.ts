import { describe, expect, it } from 'vitest';
import { LOG_REDACT_PATHS } from './logging';

// structural only: whether pino honours these paths is proven by
// apps/trading-worker/src/logging.test.ts against the real logger
describe('LOG_REDACT_PATHS', () => {
  it('lists every secret key at depths 0 through 5, plus the request header', () => {
    expect(LOG_REDACT_PATHS).toContain('req.headers.authorization');
    for (const key of ['authorization', 'token', 'accessToken', 'refreshToken', 'password']) {
      expect(LOG_REDACT_PATHS).toContain(key);
      expect(LOG_REDACT_PATHS).toContain(`*.${key}`);
      expect(LOG_REDACT_PATHS).toContain(`*.*.*.*.*.${key}`);
      expect(LOG_REDACT_PATHS).not.toContain(`*.*.*.*.*.*.${key}`);
    }
    expect(LOG_REDACT_PATHS).toHaveLength(1 + 5 * 6);
  });
});
