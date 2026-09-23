import { describe, expect, it } from 'vitest';
import { LOG_REDACT_PATHS } from './logging';

describe('LOG_REDACT_PATHS', () => {
  it('covers each secret key at depth one and two, plus the request header', () => {
    expect(LOG_REDACT_PATHS).toContain('req.headers.authorization');
    for (const key of ['authorization', 'token', 'accessToken', 'refreshToken', 'password']) {
      expect(LOG_REDACT_PATHS).toContain(`*.${key}`);
      expect(LOG_REDACT_PATHS).toContain(`*.*.${key}`);
    }
  });
});
