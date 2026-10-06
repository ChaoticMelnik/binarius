import { describe, expect, it } from 'vitest';
import {
  ACCESS_TOKEN_PATH,
  AccessTokenRefusal,
  accessTokenPath,
  safeParseAccessTokenRefusalResponse,
  safeParseAccessTokenRequest,
  safeParseAccessTokenResponse,
} from './access-token';

describe('access token route contract (#90)', () => {
  it('builds the path the route pattern describes', () => {
    const id = '0b8f3c62-7a1e-4d2b-9a55-3c1f2e4d5a6b';
    expect(accessTokenPath(id)).toBe(ACCESS_TOKEN_PATH.replace(':id', id));
  });

  it.each([true, false])('round-trips mayRefresh: %s', (mayRefresh) => {
    const parsed = safeParseAccessTokenRequest({ mayRefresh });
    expect(parsed.success && parsed.data).toEqual({ mayRefresh });
  });

  it.each([
    ['an empty body', {}],
    ['a string flag', { mayRefresh: 'true' }],
    ['an extra key', { mayRefresh: true, accountId: 'x' }],
    ['null', null],
  ])('refuses a request with %s', (_name, input) => {
    expect(safeParseAccessTokenRequest(input).success).toBe(false);
  });

  it('round-trips a token response', () => {
    const parsed = safeParseAccessTokenResponse({ accessToken: 'tok' });
    expect(parsed.success && parsed.data).toEqual({ accessToken: 'tok' });
  });

  it.each([
    ['an empty token', { accessToken: '' }],
    ['a missing token', {}],
    ['an extra key', { accessToken: 'tok', refreshToken: 'r' }],
  ])('refuses a token response with %s', (_name, input) => {
    expect(safeParseAccessTokenResponse(input).success).toBe(false);
  });

  it.each(Object.values(AccessTokenRefusal))('round-trips the refusal %s', (error) => {
    const parsed = safeParseAccessTokenRefusalResponse({ error });
    expect(parsed.success && parsed.data).toEqual({ error });
  });

  it.each([
    ['an unknown code', { error: 'internal' }],
    ['an extra key', { error: 'user_blocked', revokedReason: 'refresh_expired' }],
  ])('refuses a refusal with %s', (_name, input) => {
    expect(safeParseAccessTokenRefusalResponse(input).success).toBe(false);
  });
});
