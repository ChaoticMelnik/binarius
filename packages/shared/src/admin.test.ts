import { describe, expect, it } from 'vitest';
import {
  ADMIN_LOGIN_BUDGET_MS,
  adminConfirmRequestSchema,
  adminConfirmResponseSchema,
  adminLoginRequestSchema,
  logoutResponseSchema,
  revokeSessionResponseSchema,
  STAFF_LOGIN_PATTERN,
  STAFF_PASSWORD_MAX_LENGTH,
  STAFF_SESSION_TOKEN_PATTERN,
  staffLoginSchema,
  staffSessionsResponseSchema,
  staffSessionViewSchema,
} from './admin';
import { STAFF_LOGIN_CORPUS } from './testing';

const CLIENT = { ip: '203.0.113.7', userAgent: 'Mozilla/5.0' };

describe('staffLoginSchema', () => {
  it.each(STAFF_LOGIN_CORPUS)('$label is valid=$valid', ({ value, valid }) => {
    expect(staffLoginSchema.safeParse(value).success).toBe(valid);
  });

  // the CHECK in packages/db is built from this source, so a character that cannot survive
  // being inlined as a SQL literal would produce a constraint nobody can read back
  it('is inlinable as a SQL literal', () => {
    expect(STAFF_LOGIN_PATTERN.source).not.toMatch(/['\\]/);
  });
});

describe('adminLoginRequestSchema', () => {
  it('accepts a well-formed request', () => {
    const parsed = adminLoginRequestSchema.safeParse({
      login: 'ada',
      password: 'correct horse battery staple',
      ...CLIENT,
    });
    expect(parsed.success).toBe(true);
  });

  it('bounds the password before it can reach the KDF', () => {
    const at = adminLoginRequestSchema.safeParse({
      login: 'ada',
      password: 'p'.repeat(STAFF_PASSWORD_MAX_LENGTH),
      ...CLIENT,
    });
    const over = adminLoginRequestSchema.safeParse({
      login: 'ada',
      password: 'p'.repeat(STAFF_PASSWORD_MAX_LENGTH + 1),
      ...CLIENT,
    });
    expect([at.success, over.success]).toEqual([true, false]);
  });

  it.each([
    ['empty password', { login: 'ada', password: '', ...CLIENT }],
    ['empty ip', { login: 'ada', password: 'x', ip: '', userAgent: 'ua' }],
    ['ip over 64', { login: 'ada', password: 'x', ip: 'a'.repeat(65), userAgent: 'ua' }],
    ['user agent over 512', { login: 'ada', password: 'x', ip: '1', userAgent: 'a'.repeat(513) }],
    ['missing ip', { login: 'ada', password: 'x', userAgent: 'ua' }],
  ])('rejects %s', (_label, body) => {
    expect(adminLoginRequestSchema.safeParse(body).success).toBe(false);
  });

  // an empty user agent is what a client that sends no header looks like, and refusing it
  // would make the header a requirement for logging in
  it('accepts an empty user agent', () => {
    const parsed = adminLoginRequestSchema.safeParse({
      login: 'ada',
      password: 'x',
      ip: '203.0.113.7',
      userAgent: '',
    });
    expect(parsed.success).toBe(true);
  });
});

describe('adminConfirmRequestSchema', () => {
  const base = { challengeId: '00000000-0000-4000-8000-000000000000', ...CLIENT };

  it.each(['000000', '123456', '007007'])('accepts the six-digit code %s', (code) => {
    expect(adminConfirmRequestSchema.safeParse({ ...base, code }).success).toBe(true);
  });

  it.each(['12345', '1234567', '12345a', ' 123456', '123456\n', ''])(
    'rejects %j as a code',
    (code) => {
      expect(adminConfirmRequestSchema.safeParse({ ...base, code }).success).toBe(false);
    },
  );

  it('rejects a challenge id that is not a uuid', () => {
    const parsed = adminConfirmRequestSchema.safeParse({
      ...base,
      challengeId: 'not-a-uuid',
      code: '123456',
    });
    expect(parsed.success).toBe(false);
  });
});

describe('wire views', () => {
  const view = {
    id: '00000000-0000-4000-8000-000000000001',
    login: 'ada',
    displayName: null,
    ip: '203.0.113.7',
    userAgent: 'Mozilla/5.0',
    createdAt: '2026-09-29T08:00:00.000Z',
    lastSeenAt: '2026-09-29T08:30:00.000Z',
    expiresAt: '2026-09-30T08:00:00.000Z',
    current: true,
  };

  // the allowlist is the point of the view: a projection that grew a column has to fail here
  it('projects exactly the wire keys of a staff session', () => {
    const parsed = staffSessionViewSchema.parse(view);
    expect(Object.keys(parsed).sort()).toEqual([
      'createdAt',
      'current',
      'displayName',
      'expiresAt',
      'id',
      'ip',
      'lastSeenAt',
      'login',
      'userAgent',
    ]);
  });

  it.each(['tokenHash', 'staffId', 'telegramUserId', 'passwordHash'])('strips %s', (key) => {
    const parsed = staffSessionViewSchema.parse({ ...view, [key]: 'leaked' });
    expect(parsed).not.toHaveProperty(key);
  });

  it('keeps the sessions response to the owner facts web renders', () => {
    const parsed = staffSessionsResponseSchema.parse({
      me: {
        staffId: '00000000-0000-4000-8000-000000000002',
        login: 'ada',
        sessionId: view.id,
        telegramUserId: '4242',
      },
      sessions: [view],
    });
    expect(Object.keys(parsed.me).sort()).toEqual(['login', 'sessionId', 'staffId']);
  });

  it('pins the session token shape so a malformed one never reaches a cookie', () => {
    const token = 'a'.repeat(43);
    expect(STAFF_SESSION_TOKEN_PATTERN.test(token)).toBe(true);
    expect(
      adminConfirmResponseSchema.safeParse({
        sessionToken: 'a'.repeat(42),
        expiresAt: view.expiresAt,
      }).success,
    ).toBe(false);
    expect(
      adminConfirmResponseSchema.safeParse({ sessionToken: token, expiresAt: view.expiresAt })
        .success,
    ).toBe(true);
  });

  it('accepts only the successful shapes of revoke and logout', () => {
    expect(revokeSessionResponseSchema.safeParse({ revoked: true, current: false }).success).toBe(
      true,
    );
    expect(revokeSessionResponseSchema.safeParse({ revoked: false, current: false }).success).toBe(
      false,
    );
    expect(logoutResponseSchema.safeParse({ loggedOut: true }).success).toBe(true);
    expect(logoutResponseSchema.safeParse({ loggedOut: false }).success).toBe(false);
  });
});

describe('ADMIN_LOGIN_BUDGET_MS', () => {
  // `> 0` let 1 through, which nothing in either chain would survive. Both processes size
  // against this number from opposite sides, and neither imports the other's constants.
  it('is the number both timing chains are sized against', () => {
    expect(
      ADMIN_LOGIN_BUDGET_MS,
      'both chains compare against this number — the backend fits inside it (admin/timing.test.ts), apps/web waits longer than it (apps/web/src/timing.test.ts). Change it together with them.',
    ).toBe(6_000);
  });
});
