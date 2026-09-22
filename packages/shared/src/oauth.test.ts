import { describe, expect, it } from 'vitest';
import {
  parseOAuthTokenResponse,
  parseWidgetSessionResponse,
  safeParseOAuthTokenResponse,
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
