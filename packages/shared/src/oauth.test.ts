import { describe, expect, it } from 'vitest';
import {
  authRevokedReasonSchema,
  brokerAccountViewSchema,
  parseOAuthTokenResponse,
  parseWidgetSessionResponse,
  safeParseOAuthCallbackRequest,
  safeParseOAuthTokenResponse,
  safeParseStartLoginRequest,
  safeParseWidgetSessionResponse,
  toWidgetSessionRequestWire,
} from './oauth';

const tokenWire = {
  access_token: 'a',
  refresh_token: 'r',
  token_type: 'Bearer',
  expires_in: 604800,
  user: { id: 7, email: 'x@y', is_partner_client: true, extra: 'kept on the wire' },
};

describe('OAuth token response', () => {
  it('maps to camelCase with the user id as a string', () => {
    expect(parseOAuthTokenResponse(tokenWire)).toEqual({
      accessToken: 'a',
      refreshToken: 'r',
      tokenType: 'Bearer',
      expiresInSec: 604800,
      user: { id: '7', email: 'x@y', isPartnerClient: true },
    });
  });

  it.each([
    ['access_token', ''],
    ['expires_in', -1],
    ['expires_in', '604800'],
    ['user', { id: 7, email: 'x@y' }],
  ])('rejects %s=%j', (field, value) => {
    expect(safeParseOAuthTokenResponse({ ...tokenWire, [field]: value }).success).toBe(false);
  });
});

describe('Widget session', () => {
  it('encodes the request and maps the response', () => {
    expect(toWidgetSessionRequestWire({ origin: 'https://app.example', mode: 'real' })).toEqual({
      origin: 'https://app.example',
      mode: 'real',
    });
    expect(parseWidgetSessionResponse({ session: 's', expires_in: 60 })).toEqual({
      session: 's',
      expiresInSec: 60,
    });
  });

  it.each([{ session: '', expires_in: 60 }, { session: 's' }, { session: 's', expires_in: 1.5 }])(
    'rejects %j',
    (value) => {
      expect(safeParseWidgetSessionResponse(value).success).toBe(false);
    },
  );
});

describe('login flow contract (issue #9)', () => {
  it('accepts a start request with a telegram id and rejects anything else', () => {
    expect(safeParseStartLoginRequest({ telegramUserId: '42' }).success).toBe(true);
    expect(safeParseStartLoginRequest({ telegramUserId: 42 }).success).toBe(false);
    expect(safeParseStartLoginRequest({ telegramUserId: '0' }).success).toBe(false);
    expect(safeParseStartLoginRequest({}).success).toBe(false);
  });

  it('bounds the callback fields to what the broker can send', () => {
    const valid = { state: 'a'.repeat(43), code: 'c'.repeat(64) };
    expect(safeParseOAuthCallbackRequest(valid).success).toBe(true);
    expect(safeParseOAuthCallbackRequest({ ...valid, state: '' }).success).toBe(false);
    expect(safeParseOAuthCallbackRequest({ ...valid, state: 'a'.repeat(257) }).success).toBe(false);
    expect(safeParseOAuthCallbackRequest({ ...valid, code: 'c'.repeat(513) }).success).toBe(false);
    expect(safeParseOAuthCallbackRequest({ state: valid.state }).success).toBe(false);
  });

  it('lists exactly the four revocation reasons this flow may write', () => {
    expect(authRevokedReasonSchema.options).toEqual([
      'refresh_invalid_grant',
      'refresh_outcome_unknown',
      'refresh_expired',
      'storage_inconsistent',
    ]);
  });

  it('keeps the account view free of anything token-shaped', () => {
    const view = {
      id: '3f2b0a4c-9d3e-4c1a-8b5e-2a6f7d8c9e01',
      brokerUserId: 'broker-1',
      email: null,
      isPartnerClient: false,
      status: 'active',
      createdAt: '2026-09-23T09:21:52.000Z',
    };
    expect(brokerAccountViewSchema.parse(view)).toEqual(view);
    expect(Object.keys(brokerAccountViewSchema.shape).sort()).toEqual([
      'brokerUserId',
      'createdAt',
      'email',
      'id',
      'isPartnerClient',
      'status',
    ]);
    // false is a legitimate value of the wire field, not a missing one
    expect(brokerAccountViewSchema.parse({ ...view, isPartnerClient: false }).isPartnerClient).toBe(
      false,
    );
  });
});
