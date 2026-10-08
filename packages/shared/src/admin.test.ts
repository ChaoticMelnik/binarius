import { describe, expect, it } from 'vitest';
import {
  ADMIN_ACTIVE_WINDOW_MINUTES,
  ADMIN_LOGIN_BUDGET_MS,
  ADMIN_PAGE_SIZE,
  ADMIN_SEARCH_MAX_LENGTH,
  adminMeSchema,
  adminOverviewResponseSchema,
  adminUserResponseSchema,
  adminUsersQuerySchema,
  adminUsersResponseSchema,
  adminUsersSearchParams,
  adminConfirmRequestSchema,
  adminConfirmResponseSchema,
  adminLoginRequestSchema,
  logoutResponseSchema,
  revokeSessionResponseSchema,
  safeParseAdminUsersQuery,
  STAFF_LOGIN_PATTERN,
  STAFF_PASSWORD_MAX_LENGTH,
  STAFF_SESSION_TOKEN_PATTERN,
  staffLoginSchema,
  staffSessionsResponseSchema,
  staffSessionViewSchema,
} from './admin';
import { TradeIntentStatus } from './trading';
import { STAFF_LOGIN_CORPUS } from './testing';

const ZERO_BY_STATUS = Object.fromEntries(Object.values(TradeIntentStatus).map((s) => [s, 0]));

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

const CURSOR = '00000000-0000-4000-8000-0000000000aa';
const ME = {
  staffId: '00000000-0000-4000-8000-000000000002',
  login: 'ada',
  sessionId: '00000000-0000-4000-8000-000000000003',
};
const AT = '2026-10-07T08:00:00.000Z';

describe('adminUsersQuerySchema', () => {
  it('takes neither key as an empty query', () => {
    expect(adminUsersQuerySchema.parse({})).toEqual({});
  });

  it('trims before it measures, so blanks are refused', () => {
    expect(adminUsersQuerySchema.safeParse({ q: '   ' }).success).toBe(false);
    expect(adminUsersQuerySchema.parse({ q: '  ada  ' })).toEqual({ q: 'ada' });
  });

  it('bounds q at ADMIN_SEARCH_MAX_LENGTH', () => {
    const at = adminUsersQuerySchema.safeParse({ q: 'a'.repeat(ADMIN_SEARCH_MAX_LENGTH) });
    const over = adminUsersQuerySchema.safeParse({ q: 'a'.repeat(ADMIN_SEARCH_MAX_LENGTH + 1) });
    expect([ADMIN_SEARCH_MAX_LENGTH, at.success, over.success]).toEqual([256, true, false]);
  });

  it.each([
    ['a bell', 'a\x07b'],
    ['a zero-width space', 'a\u200bb'],
    ['an array', ['a', 'b']],
  ])('refuses q with %s', (_label, q) => {
    expect(adminUsersQuerySchema.safeParse({ q }).success).toBe(false);
  });

  it('accepts LIKE metacharacters and cyrillic as plain text', () => {
    expect(adminUsersQuerySchema.parse({ q: '50%_д@x' })).toEqual({ q: '50%_д@x' });
  });

  it('refuses a cursor that is not a uuid', () => {
    expect(adminUsersQuerySchema.safeParse({ cursor: 'bad' }).success).toBe(false);
  });

  it('strips keys it does not declare', () => {
    expect(adminUsersQuerySchema.parse({ q: 'a', utm_source: 'x' })).toEqual({ q: 'a' });
  });
});

describe('adminUsersSearchParams', () => {
  it('round-trips a query through its own serialization', () => {
    const query = { q: 'a&b+c#д', cursor: CURSOR };
    const params = adminUsersSearchParams(query);
    expect(String(params)).toBe(`q=a%26b%2Bc%23%D0%B4&cursor=${CURSOR}`);
    expect(safeParseAdminUsersQuery(Object.fromEntries(params)).data).toEqual(query);
  });

  it('writes keys in the schema order, whatever order the caller used', () => {
    expect([...adminUsersSearchParams({ cursor: CURSOR, q: 'x' })].map(([k]) => k)).toEqual([
      'q',
      'cursor',
    ]);
  });

  it('writes nothing for an empty query', () => {
    expect(adminUsersSearchParams({}).size).toBe(0);
  });
});

describe('admin read responses', () => {
  const listItem = {
    id: '00000000-0000-4000-8000-000000000010',
    telegramUserId: '4242',
    displayName: 'Ada',
    status: 'active',
    tokenBalance: '5',
    createdAt: AT,
    updatedAt: AT,
  };
  const users = { me: ME, users: [listItem], nextCursor: CURSOR };

  const account = {
    id: '00000000-0000-4000-8000-000000000020',
    brokerUserId: 'broker-7',
    email: 'ada@example.com',
    isPartnerClient: true,
    status: 'active',
    authRevokedReason: 'refresh_expired',
    tradingHalted: true,
    haltedReason: 'trade_mismatch',
    accessTokenExpiresAt: AT,
    tokenRotatedAt: AT,
    createdAt: AT,
    updatedAt: AT,
  };
  const detail = {
    id: listItem.id,
    telegramUserId: '4242',
    displayName: 'Ada',
    languageCode: 'ru',
    status: 'active',
    acquisitionSource: 'ads',
    acquiredAt: AT,
    telegramBlockedAt: AT,
    notificationLevel: 'all',
    demoStake: '1.5',
    tokens: { balance: '5', reserved: '2', available: '3' },
    createdAt: AT,
    updatedAt: AT,
  };
  const intents = { recent: [], total: 0, active: 0 };
  const user = { me: ME, user: detail, brokerAccounts: [account], intents };

  const overview = {
    me: ME,
    overview: {
      users: { total: 3, today: 1, blocked: 0, withActiveBrokerAccount: 1, activeNow: 2 },
      intents: { total: 4, today: 0, byStatus: { ...ZERO_BY_STATUS, settled: 4 }, active: 0 },
      activeWindowMinutes: ADMIN_ACTIVE_WINDOW_MINUTES,
      dayStartsAt: '2026-10-07T00:00:00.000Z',
      asOf: AT,
    },
  };

  it('accept their samples', () => {
    expect(adminUsersResponseSchema.safeParse(users).success).toBe(true);
    expect(adminUserResponseSchema.safeParse(user).success).toBe(true);
    expect(adminOverviewResponseSchema.safeParse(overview).success).toBe(true);
  });

  // a user created by the OAuth login has only its Telegram id; an account may never have been
  // revoked, halted or rotated
  it('accept every nullable column as null', () => {
    const bare = {
      ...detail,
      displayName: null,
      languageCode: null,
      acquisitionSource: null,
      acquiredAt: null,
      telegramBlockedAt: null,
      demoStake: null,
    };
    const fresh = {
      ...account,
      email: null,
      authRevokedReason: null,
      tradingHalted: false,
      haltedReason: null,
      tokenRotatedAt: null,
    };
    expect(
      adminUserResponseSchema.safeParse({ me: ME, user: bare, brokerAccounts: [fresh], intents })
        .success,
    ).toBe(true);
    expect(
      adminUsersResponseSchema.safeParse({ ...users, users: [{ ...listItem, displayName: null }] })
        .success,
    ).toBe(true);
  });

  it.each([
    ['the users response', { ...users, extra: 1 }, adminUsersResponseSchema],
    ['me', { ...users, me: { ...ME, extra: 1 } }, adminUsersResponseSchema],
    ['a list row', { ...users, users: [{ ...listItem, extra: 1 }] }, adminUsersResponseSchema],
    ['the user response', { ...user, extra: 1 }, adminUserResponseSchema],
    ['the user', { ...user, user: { ...detail, accessTokenEnc: 'x' } }, adminUserResponseSchema],
    [
      'an account',
      { ...user, brokerAccounts: [{ ...account, refreshTokenHash: 'x' }] },
      adminUserResponseSchema,
    ],
    ['the overview response', { ...overview, extra: 1 }, adminOverviewResponseSchema],
    [
      'the overview',
      { ...overview, overview: { ...overview.overview, extra: 1 } },
      adminOverviewResponseSchema,
    ],
    [
      'the overview users',
      {
        ...overview,
        overview: { ...overview.overview, users: { ...overview.overview.users, extra: 1 } },
      },
      adminOverviewResponseSchema,
    ],
  ] as const)('refuse an extra key in %s', (_label, body, schema) => {
    expect(schema.safeParse(body).success).toBe(false);
  });

  it('refuse tokens whose available is not balance - reserved', () => {
    const bad = {
      ...user,
      user: { ...detail, tokens: { balance: '5', reserved: '2', available: '5' } },
    };
    expect(adminUserResponseSchema.safeParse(bad).success).toBe(false);
  });

  it('refuse an active window other than the constant', () => {
    expect(ADMIN_ACTIVE_WINDOW_MINUTES).toBe(15);
    const bad = { ...overview, overview: { ...overview.overview, activeWindowMinutes: 14 } };
    expect(adminOverviewResponseSchema.safeParse(bad).success).toBe(false);
  });

  it('refuse a negative count', () => {
    const bad = {
      ...overview,
      overview: { ...overview.overview, intents: { ...overview.overview.intents, total: -1 } },
    };
    expect(adminOverviewResponseSchema.safeParse(bad).success).toBe(false);
  });

  it('refuse a next cursor that is not a uuid, and a page over ADMIN_PAGE_SIZE', () => {
    expect(adminUsersResponseSchema.safeParse({ ...users, nextCursor: 'bad' }).success).toBe(false);
    const over = Array.from({ length: ADMIN_PAGE_SIZE + 1 }, () => listItem);
    expect(adminUsersResponseSchema.safeParse({ ...users, users: over }).success).toBe(false);
  });

  describe('the trading section and the overview breakdown (#330)', () => {
    it('refuse a user response without intents, an overview without byStatus or active', () => {
      const without = (value: object, key: string) => {
        const rest: Record<string, unknown> = { ...value };
        delete rest[key];
        return rest;
      };
      expect(adminUserResponseSchema.safeParse(without(user, 'intents')).success).toBe(false);
      for (const key of ['byStatus', 'active']) {
        const intents = without(overview.overview.intents, key);
        const body = { ...overview, overview: { ...overview.overview, intents } };
        expect(adminOverviewResponseSchema.safeParse(body).success).toBe(false);
      }
    });

    it.each([
      ['the user intents', { ...user, intents: { ...intents, extra: 1 } }, adminUserResponseSchema],
      [
        'the overview intents',
        {
          ...overview,
          overview: { ...overview.overview, intents: { ...overview.overview.intents, extra: 1 } },
        },
        adminOverviewResponseSchema,
      ],
      [
        'the overview breakdown',
        {
          ...overview,
          overview: {
            ...overview.overview,
            intents: {
              ...overview.overview.intents,
              byStatus: { ...overview.overview.intents.byStatus, bogus: 0 },
            },
          },
        },
        adminOverviewResponseSchema,
      ],
    ] as const)('refuse an extra key in %s', (_label, body, schema) => {
      expect(schema.safeParse(body).success).toBe(false);
    });
  });

  it('share the sessions response me', () => {
    expect(staffSessionsResponseSchema.shape.me).toBe(adminMeSchema);
  });
});
