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

  // #281: the fingerprint of a token the broker refused
  it('round-trips a request with a refused token', () => {
    const refusedToken = 'a'.repeat(64);
    const parsed = safeParseAccessTokenRequest({ mayRefresh: false, refusedToken });
    expect(parsed.success && parsed.data).toEqual({ mayRefresh: false, refusedToken });
  });

  it.each([
    ['an empty body', {}],
    ['a string flag', { mayRefresh: 'true' }],
    ['an extra key', { mayRefresh: true, accountId: 'x' }],
    ['null', null],
    ['a refused token of 63 characters', { mayRefresh: true, refusedToken: 'a'.repeat(63) }],
    ['a refused token in upper case', { mayRefresh: true, refusedToken: 'A'.repeat(64) }],
    ['a refused token that is not hex', { mayRefresh: true, refusedToken: 'g'.repeat(64) }],
    ['an empty refused token', { mayRefresh: true, refusedToken: '' }],
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
