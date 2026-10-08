import { describe, expect, it } from 'vitest';
import {
  addressOrNull,
  authRevokedReasonSchema,
  emailAddressSchema,
  emailLoginCodeSchema,
  INIT_DATA_MAX_LENGTH,
  OAUTH_CALLBACK_BUDGET_MS,
  OAuthErrorCode,
  safeParseBrokerEmailSendCodeResponse,
  safeParseEmailLoginRequest,
  safeParseEmailLoginResponse,
  safeParseEmailSendCodeRequest,
  safeParseEmailSendCodeResponse,
  brokerAccountViewSchema,
  safeParseConfirmLoginResponse,
  parseOAuthTokenResponse,
  parseRefreshTokenResponse,
  parseWidgetSessionResponse,
  safeParseOAuthCallbackRequest,
  safeParseOAuthCallbackResponse,
  safeParseOAuthTokenResponse,
  safeParseRefreshTokenResponse,
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

  it.each([[''], [' \t ']])('stores the blank address %j as none', (email) => {
    expect(
      parseOAuthTokenResponse({ ...tokenWire, user: { ...tokenWire.user, email } }).user.email,
    ).toBeNull();
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

describe('addressOrNull', () => {
  it.each([
    [null, null],
    ['', null],
    [' \t ', null],
    [' x@y ', ' x@y '],
    ['x@y', 'x@y'],
  ])('turns a blank address into null: %j -> %j', (email, expected) => {
    expect(addressOrNull(email)).toBe(expected);
  });
});

const refreshWire = {
  access_token: 'a',
  refresh_token: 'r',
  token_type: 'Bearer',
  expires_in: 604800,
};

describe('refresh token response', () => {
  it('maps a pair that carries no user', () => {
    expect(parseRefreshTokenResponse(refreshWire)).toEqual({
      accessToken: 'a',
      refreshToken: 'r',
      tokenType: 'Bearer',
      expiresInSec: 604800,
    });
  });

  it('ignores a user the broker may add, rather than passing it on', () => {
    expect(parseRefreshTokenResponse({ ...refreshWire, user: tokenWire.user })).not.toHaveProperty(
      'user',
    );
  });

  it.each([
    ['refresh_token', undefined],
    ['refresh_token', ''],
    ['expires_in', -1],
    ['expires_in', '604800'],
  ])('rejects %s=%j', (field, value) => {
    expect(safeParseRefreshTokenResponse({ ...refreshWire, [field]: value }).success).toBe(false);
  });

  it('still requires the user on the code exchange', () => {
    expect(safeParseOAuthTokenResponse(refreshWire).success).toBe(false);
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
  it('parses the callback answer as the account view alone', () => {
    const account = {
      id: '3f2b0a4c-9d3e-4c1a-8b5e-2a6f7d8c9e01',
      brokerUserId: 'broker-1',
      email: null,
      isPartnerClient: true,
      status: 'pending',
      createdAt: '2026-09-23T09:21:52.000Z',
    };
    expect(safeParseOAuthCallbackResponse({ account })).toMatchObject({
      success: true,
      data: { account },
    });
    expect(safeParseOAuthCallbackResponse({}).success).toBe(false);
    expect(safeParseOAuthCallbackResponse({ account: { ...account, id: 'x' } }).success).toBe(
      false,
    );
  });

  it('bounds the callback fields to what the broker and Telegram can send', () => {
    const valid = { state: 'a'.repeat(43), code: 'c'.repeat(64), initData: 'i'.repeat(300) };
    expect(safeParseOAuthCallbackRequest(valid).success).toBe(true);
    expect(safeParseOAuthCallbackRequest({ ...valid, state: '' }).success).toBe(false);
    expect(safeParseOAuthCallbackRequest({ ...valid, state: 'a'.repeat(257) }).success).toBe(false);
    expect(safeParseOAuthCallbackRequest({ ...valid, code: 'c'.repeat(513) }).success).toBe(false);
    expect(safeParseOAuthCallbackRequest({ state: valid.state }).success).toBe(false);
  });

  it('requires the Mini App initData on the callback, up to INIT_DATA_MAX_LENGTH', () => {
    const valid = { state: 'a'.repeat(43), code: 'c'.repeat(64) };
    expect(safeParseOAuthCallbackRequest(valid).success).toBe(false);
    expect(safeParseOAuthCallbackRequest({ ...valid, initData: '' }).success).toBe(false);
    expect(
      safeParseOAuthCallbackRequest({ ...valid, initData: 'i'.repeat(INIT_DATA_MAX_LENGTH) })
        .success,
    ).toBe(true);
    expect(
      safeParseOAuthCallbackRequest({ ...valid, initData: 'i'.repeat(INIT_DATA_MAX_LENGTH + 1) })
        .success,
    ).toBe(false);
    expect(INIT_DATA_MAX_LENGTH).toBe(4096);
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

describe('OAUTH_CALLBACK_BUDGET_MS', () => {
  it('is the number both timing chains are sized against', () => {
    expect(
      OAUTH_CALLBACK_BUDGET_MS,
      'both chains compare against this number — the backend fits inside it (apps/backend/src/timing.test.ts), apps/web waits longer than it (apps/web/src/timing.test.ts). Change it together with them.',
    ).toBe(8_000);
  });
});

describe('confirm response (issue #10)', () => {
  const account = {
    id: '3f2b0a4c-9d3e-4c1a-8b5e-2a6f7d8c9e01',
    brokerUserId: 'broker-1',
    email: null,
    isPartnerClient: true,
    status: 'active',
    createdAt: '2026-09-23T09:21:52.000Z',
  };

  it.each([
    { granted: true, tokens: '7' },
    { granted: false, reason: 'not_partner_client' },
    { granted: false, reason: 'already_granted' },
  ])('accepts the grant %o', (grant) => {
    expect(safeParseConfirmLoginResponse({ account, grant })).toMatchObject({
      success: true,
      data: { account, grant },
    });
  });

  it.each([
    ['tokens of zero', { granted: true, tokens: '0' }],
    ['tokens with a leading zero', { granted: true, tokens: '007' }],
    ['tokens as a number', { granted: true, tokens: 7 }],
    ['a grant without tokens', { granted: true }],
    ['an unknown reason', { granted: false, reason: 'maybe_later' }],
    ['a refusal without a reason', { granted: false }],
  ])('rejects %s', (_label, grant) => {
    expect(safeParseConfirmLoginResponse({ account, grant }).success).toBe(false);
  });

  it('rejects a confirm response that carries no grant', () => {
    expect(safeParseConfirmLoginResponse({ account }).success).toBe(false);
  });
});

describe('email login contract (issue #162)', () => {
  it('trims the address before checking it and keeps its case', () => {
    expect(emailAddressSchema.parse('  Ada@Example.COM  ')).toBe('Ada@Example.COM');
  });

  it.each([
    ['a space inside', 'ada @example.com'],
    ['no domain dot', 'a@b'],
    ['no at sign', 'ada.example.com'],
    ['an empty string', '   '],
    ['255 characters', `${'a'.repeat(243)}@example.com`],
  ])('rejects an address with %s', (_label, value) => {
    expect(emailAddressSchema.safeParse(value).success).toBe(false);
  });

  it('accepts an address of exactly 254 characters', () => {
    const address = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(57)}.com`;
    expect(address).toHaveLength(254);
    expect(emailAddressSchema.safeParse(address).success).toBe(true);
  });

  it('bounds the code to 1-64 characters after trimming, in any shape', () => {
    expect(emailLoginCodeSchema.parse(' 123456 ')).toBe('123456');
    expect(emailLoginCodeSchema.parse('abcdef')).toBe('abcdef');
    expect(emailLoginCodeSchema.safeParse('   ').success).toBe(false);
    expect(emailLoginCodeSchema.safeParse('c'.repeat(65)).success).toBe(false);
  });

  it('keeps the address out of a validation issue', () => {
    const parsed = safeParseEmailSendCodeRequest({
      telegramUserId: '42',
      email: 'MARKER-ADDRESS',
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).not.toContain('MARKER-ADDRESS');
  });

  it('requires both identities on the requests', () => {
    expect(safeParseEmailSendCodeRequest({ telegramUserId: '42', email: 'a@b.co' }).success).toBe(
      true,
    );
    expect(safeParseEmailSendCodeRequest({ email: 'a@b.co' }).success).toBe(false);
    expect(
      safeParseEmailLoginRequest({ telegramUserId: '42', email: 'a@b.co', code: '1' }).success,
    ).toBe(true);
    expect(safeParseEmailLoginRequest({ telegramUserId: '42', email: 'a@b.co' }).success).toBe(
      false,
    );
  });

  it('answers send-code with a literal flag and login with an account and a grant', () => {
    expect(safeParseEmailSendCodeResponse({ codeSent: true }).success).toBe(true);
    expect(safeParseEmailSendCodeResponse({ codeSent: false }).success).toBe(false);
    expect(
      safeParseEmailLoginResponse({
        account: {
          id: '3f2b0a4c-9d3e-4c1a-8b5e-2a6f7d8c9e01',
          brokerUserId: 'broker-1',
          email: 'a@b.co',
          isPartnerClient: true,
          status: 'active',
          createdAt: '2026-10-01T09:21:52.000Z',
        },
        grant: { granted: true, tokens: '100' },
      }).success,
    ).toBe(true);
  });

  it.each([
    [{ status: true }, true],
    [{ status: true, extra: 1 }, true],
    [{ status: false }, false],
    [{}, false],
  ])('reads the broker send-code body %j as success=%s', (body, ok) => {
    expect(safeParseBrokerEmailSendCodeResponse(body).success).toBe(ok);
  });

  it('adds the two route codes', () => {
    expect(OAuthErrorCode.TooManyAttempts).toBe('too_many_attempts');
    expect(OAuthErrorCode.InvalidEmail).toBe('invalid_email');
  });
});
