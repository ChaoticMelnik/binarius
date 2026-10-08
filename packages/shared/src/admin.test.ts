import { describe, expect, it } from 'vitest';
import {
  ADMIN_ACTIVE_WINDOW_MINUTES,
  ADMIN_AUDIT_PAYLOAD_PREVIEW_CHARS,
  adminAuditEntryViewSchema,
  adminAuditQuerySchema,
  adminAuditResponseSchema,
  adminAuditSearchParams,
  safeParseAdminAuditQuery,
  ADMIN_LOGIN_BUDGET_MS,
  ADMIN_PAGE_SIZE,
  ADMIN_SEARCH_MAX_LENGTH,
  adminMeSchema,
  ADMIN_USER_RECENT_LEDGER,
  adminLedgerEntrySchema,
  adminOverviewResponseSchema,
  adminTokensQuerySchema,
  adminTokensResponseSchema,
  adminTokensSearchParams,
  adminUserLedgerSectionSchema,
  adminUserResponseSchema,
  adminUsersQuerySchema,
  adminUsersResponseSchema,
  adminUsersSearchParams,
  adminConfirmRequestSchema,
  adminConfirmResponseSchema,
  adminLoginRequestSchema,
  logoutResponseSchema,
  revokeSessionResponseSchema,
  safeParseAdminChangePasswordRequest,
  safeParseAdminTokensQuery,
  safeParseChangePasswordResponse,
  safeParseAdminUsersQuery,
  STAFF_LOGIN_PATTERN,
  STAFF_PASSWORD_MAX_LENGTH,
  STAFF_SESSION_TOKEN_PATTERN,
  staffLoginSchema,
  staffSessionsResponseSchema,
  staffSessionViewSchema,
  tokenDeltaSchema,
} from './admin';
import {
  TokenLedgerKind,
  tokenLedgerKindSchema,
  TokenLedgerRefType,
  tokenLedgerRefTypeSchema,
} from './ledger';
import {
  AuditAction,
  auditActionSchema,
  AuditActorType,
  auditActorTypeSchema,
  AuditEntityType,
  auditEntityTypeSchema,
} from './audit';
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
  const ledger = { recent: [] };
  const user = { me: ME, user: detail, brokerAccounts: [account], intents, ledger };

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
      adminUserResponseSchema.safeParse({
        me: ME,
        user: bare,
        brokerAccounts: [fresh],
        intents,
        ledger,
      }).success,
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
    ['the user ledger', { ...user, ledger: { ...ledger, extra: 1 } }, adminUserResponseSchema],
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
      expect(adminUserResponseSchema.safeParse(without(user, 'ledger')).success).toBe(false);
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

describe('token ledger contracts (#109)', () => {
  const U1 = '00000000-0000-4000-8000-000000000010';
  const entry = {
    id: '00000000-0000-4000-8000-000000000050',
    userId: U1,
    telegramUserId: '4242',
    kind: 'reserve',
    balanceDelta: '0',
    reservedDelta: '1',
    intentId: '00000000-0000-4000-8000-000000000030',
    depositEventId: null,
    brokerAccountId: null,
    refType: null,
    refId: null,
    note: null,
    createdAt: AT,
  };
  const bare = { ...entry, kind: 'adjustment', balanceDelta: '-3', reservedDelta: '0' };
  const bareAll = { ...bare, intentId: null, note: 'manual' };
  const manual = { ...bareAll, refType: 'manual', refId: CURSOR };
  const list = { me: ME, entries: [entry, bareAll], nextCursor: CURSOR };

  it.each(['0', '-3', '12', '-9223372036854775808'])('takes %j as a token delta', (value) => {
    expect(tokenDeltaSchema.safeParse(value).success).toBe(true);
  });

  it.each(['-0', '03', '', '+1', '1.5', ' 1'])('refuses %j as a token delta', (value) => {
    expect(tokenDeltaSchema.safeParse(value).success).toBe(false);
  });

  it('accepts a row, a row with every nullable as null, and a manual reference', () => {
    expect(adminLedgerEntrySchema.safeParse(entry).success).toBe(true);
    expect(adminLedgerEntrySchema.safeParse({ ...bare, intentId: null }).success).toBe(true);
    expect(adminLedgerEntrySchema.safeParse(manual).success).toBe(true);
  });

  it('carries exactly the thirteen wire keys of a ledger row', () => {
    expect(Object.keys(adminLedgerEntrySchema.shape)).toEqual([
      'id',
      'userId',
      'telegramUserId',
      'kind',
      'balanceDelta',
      'reservedDelta',
      'intentId',
      'depositEventId',
      'brokerAccountId',
      'refType',
      'refId',
      'note',
      'createdAt',
    ]);
  });

  it.each([
    ['an extra key', { ...entry, extra: 1 }],
    ['an unknown kind', { ...entry, kind: 'bogus' }],
    ['an unknown ref type', { ...manual, refType: 'deposit' }],
    ['a numeric delta', { ...entry, reservedDelta: 1 }],
  ])('refuses a row with %s', (_label, row) => {
    expect(adminLedgerEntrySchema.safeParse(row).success).toBe(false);
  });

  it('bounds the card section at ADMIN_USER_RECENT_LEDGER rows', () => {
    const at = Array.from({ length: ADMIN_USER_RECENT_LEDGER }, () => entry);
    expect(ADMIN_USER_RECENT_LEDGER).toBe(20);
    expect(adminUserLedgerSectionSchema.safeParse({ recent: at }).success).toBe(true);
    expect(adminUserLedgerSectionSchema.safeParse({ recent: [...at, entry] }).success).toBe(false);
    expect(adminUserLedgerSectionSchema.safeParse({ recent: [], extra: 1 }).success).toBe(false);
  });

  it('accepts a page and refuses an extra key at each level, a bad cursor and a 51st row', () => {
    expect(adminTokensResponseSchema.safeParse(list).success).toBe(true);
    expect(adminTokensResponseSchema.safeParse({ ...list, nextCursor: null }).success).toBe(true);
    expect(adminTokensResponseSchema.safeParse({ ...list, extra: 1 }).success).toBe(false);
    expect(adminTokensResponseSchema.safeParse({ ...list, me: { ...ME, extra: 1 } }).success).toBe(
      false,
    );
    expect(
      adminTokensResponseSchema.safeParse({ ...list, entries: [{ ...entry, extra: 1 }] }).success,
    ).toBe(false);
    expect(adminTokensResponseSchema.safeParse({ ...list, nextCursor: 'bad' }).success).toBe(false);
    const at = Array.from({ length: ADMIN_PAGE_SIZE }, () => entry);
    expect(adminTokensResponseSchema.safeParse({ ...list, entries: at }).success).toBe(true);
    expect(adminTokensResponseSchema.safeParse({ ...list, entries: [...at, entry] }).success).toBe(
      false,
    );
  });

  it('puts the ledger section last on the user card', () => {
    const user = adminUserResponseSchema.shape;
    expect(Object.keys(user)).toEqual(['me', 'user', 'brokerAccounts', 'intents', 'ledger']);
    expect(user.ledger).toBe(adminUserLedgerSectionSchema);
  });

  describe('adminTokensQuerySchema', () => {
    it('takes no key as an empty query, and each key alone', () => {
      expect(adminTokensQuerySchema.parse({})).toEqual({});
      for (const query of [{ user: U1 }, { kind: 'bonus' }, { cursor: CURSOR }]) {
        expect(adminTokensQuerySchema.parse(query)).toEqual(query);
      }
    });

    it.each([
      ['kind', 'bogus'],
      ['kind', ''],
      ['kind', ['bonus', 'reserve']],
      ['user', 'not-a-uuid'],
      ['user', ' '],
      ['cursor', 'bad'],
    ])('refuses %s = %j', (key, value) => {
      expect(adminTokensQuerySchema.safeParse({ [key]: value }).success).toBe(false);
    });

    it('strips keys it does not declare', () => {
      expect(adminTokensQuerySchema.parse({ kind: 'bonus', utm: '1' })).toEqual({ kind: 'bonus' });
    });
  });

  describe('adminTokensSearchParams', () => {
    it('writes keys in the schema order, whatever order the caller used', () => {
      const params = adminTokensSearchParams({ cursor: CURSOR, kind: 'settle', user: U1 });
      expect([...params].map(([k]) => k)).toEqual(['user', 'kind', 'cursor']);
    });

    it('round-trips a query through its own serialization', () => {
      const query = { user: U1, kind: 'adjustment', cursor: CURSOR } as const;
      const params = adminTokensSearchParams(query);
      expect(safeParseAdminTokensQuery(Object.fromEntries(params)).data).toEqual(query);
    });

    it('writes nothing for an empty query', () => {
      expect(adminTokensSearchParams({}).size).toBe(0);
    });
  });

  it('builds both enums from the constants', () => {
    for (const value of Object.values(TokenLedgerKind)) {
      expect(tokenLedgerKindSchema.safeParse(value).success).toBe(true);
    }
    for (const value of Object.values(TokenLedgerRefType)) {
      expect(tokenLedgerRefTypeSchema.safeParse(value).success).toBe(true);
    }
    expect(tokenLedgerKindSchema.safeParse('bogus').success).toBe(false);
    expect(tokenLedgerRefTypeSchema.safeParse('bogus').success).toBe(false);
  });
});

describe('audit log contracts (#110)', () => {
  const STAFF = '00000000-0000-4000-8000-000000000020';
  const ENTITY = '00000000-0000-4000-8000-000000000010';
  const full = {
    action: 'user_viewed',
    entityType: 'user',
    entityId: ENTITY,
    actorId: STAFF,
    from: '2026-10-01',
    to: '2026-10-07',
    cursor: CURSOR,
  } as const;
  const entry = {
    id: '00000000-0000-4000-8000-000000000060',
    createdAt: AT,
    actorType: 'admin',
    actorId: STAFF,
    actorLogin: 'ada',
    action: 'user_viewed',
    entityType: 'user',
    entityId: ENTITY,
    payload: '{"path": "/admin/users/:id"}',
    payloadTruncated: false,
  };
  const nulls = {
    ...entry,
    actorId: null,
    actorLogin: null,
    entityType: null,
    entityId: null,
  };
  const list = { me: ME, entries: [entry, nulls], nextCursor: CURSOR };

  describe('adminAuditQuerySchema', () => {
    it('takes no key as an empty query, and each key alone', () => {
      expect(adminAuditQuerySchema.parse({})).toEqual({});
      for (const [key, value] of Object.entries(full)) {
        expect(adminAuditQuerySchema.parse({ [key]: value })).toEqual({ [key]: value });
      }
    });

    it.each([
      ['action', 'bogus'],
      ['action', ''],
      ['action', ['staff_logout', 'user_viewed']],
      ['entityType', 'bogus'],
      ['entityId', 'not-a-uuid'],
      ['entityId', ' '],
      ['actorId', 'cli'],
      ['actorId', ' '],
      ['cursor', 'bad'],
      ['from', '2026-13-01'],
      ['from', '2026-2-3'],
      ['from', '2026-10-06T00:00:00Z'],
      ['to', ''],
    ])('refuses %s = %j', (key, value) => {
      expect(adminAuditQuerySchema.safeParse({ [key]: value }).success).toBe(false);
    });

    it('refuses from after to on the to key, with or without a cursor', () => {
      for (const query of [
        { from: '2026-10-07', to: '2026-10-06' },
        { from: '2026-10-07', to: '2026-10-06', cursor: CURSOR },
      ]) {
        const parsed = adminAuditQuerySchema.safeParse(query);
        expect(parsed.success).toBe(false);
        expect(parsed.error?.issues.map((issue) => issue.path)).toEqual([['to']]);
      }
    });

    it('takes one day as from = to, and either bound alone', () => {
      for (const query of [
        { from: '2026-10-06', to: '2026-10-06' },
        { from: '2026-10-06' },
        { to: '2026-10-06' },
      ]) {
        expect(adminAuditQuerySchema.parse(query)).toEqual(query);
      }
    });

    it('strips keys it does not declare', () => {
      expect(adminAuditQuerySchema.parse({ action: 'staff_logout', utm: '1' })).toEqual({
        action: 'staff_logout',
      });
    });
  });

  describe('adminAuditSearchParams', () => {
    it('writes keys in the schema order, whatever order the caller used', () => {
      const reversed = Object.fromEntries(Object.entries(full).reverse()) as typeof full;
      expect([...adminAuditSearchParams(reversed)].map(([k]) => k)).toEqual([
        'action',
        'entityType',
        'entityId',
        'actorId',
        'from',
        'to',
        'cursor',
      ]);
    });

    it('round-trips a full query through its own serialization', () => {
      const params = adminAuditSearchParams(full);
      expect(safeParseAdminAuditQuery(Object.fromEntries(params)).data).toEqual(full);
    });

    it('writes nothing for an empty query', () => {
      expect(adminAuditSearchParams({}).size).toBe(0);
    });
  });

  it('accepts a row and a row with every nullable as null', () => {
    expect(adminAuditEntryViewSchema.safeParse(entry).success).toBe(true);
    expect(adminAuditEntryViewSchema.safeParse(nulls).success).toBe(true);
  });

  it('carries exactly the ten wire keys of an audit row', () => {
    expect(Object.keys(adminAuditEntryViewSchema.shape)).toEqual([
      'id',
      'createdAt',
      'actorType',
      'actorId',
      'actorLogin',
      'action',
      'entityType',
      'entityId',
      'payload',
      'payloadTruncated',
    ]);
  });

  it('bounds the payload preview in code points, not bytes', () => {
    const at = 'я'.repeat(ADMIN_AUDIT_PAYLOAD_PREVIEW_CHARS);
    expect(ADMIN_AUDIT_PAYLOAD_PREVIEW_CHARS).toBe(1024);
    expect(adminAuditEntryViewSchema.safeParse({ ...entry, payload: at }).success).toBe(true);
    expect(adminAuditEntryViewSchema.safeParse({ ...entry, payload: `${at}я` }).success).toBe(
      false,
    );
  });

  it('takes an entity id of the column shape, not only an RFC uuid', () => {
    const entityId = '00000000-0000-0000-0000-000000000001';
    expect(adminAuditEntryViewSchema.safeParse({ ...entry, entityId }).success).toBe(true);
  });

  it('shows an entity type outside the constant', () => {
    expect(adminAuditEntryViewSchema.safeParse({ ...entry, entityType: 'other' }).success).toBe(
      true,
    );
  });

  it.each([
    ['an extra key', { ...entry, extra: 1 }],
    ['an unknown actor type', { ...entry, actorType: 'bogus' }],
    ['an unknown action', { ...entry, action: 'bogus' }],
    ['a payload object', { ...entry, payload: { path: '/admin/audit' } }],
    ['a missing truncation flag', { ...entry, payloadTruncated: undefined }],
  ])('refuses a row with %s', (_label, row) => {
    expect(adminAuditEntryViewSchema.safeParse(row).success).toBe(false);
  });

  it('accepts a page and refuses an extra key at each level, a bad cursor and a 51st row', () => {
    expect(adminAuditResponseSchema.safeParse(list).success).toBe(true);
    expect(adminAuditResponseSchema.safeParse({ ...list, nextCursor: null }).success).toBe(true);
    expect(adminAuditResponseSchema.safeParse({ ...list, extra: 1 }).success).toBe(false);
    expect(adminAuditResponseSchema.safeParse({ ...list, me: { ...ME, extra: 1 } }).success).toBe(
      false,
    );
    expect(
      adminAuditResponseSchema.safeParse({ ...list, entries: [{ ...entry, extra: 1 }] }).success,
    ).toBe(false);
    expect(adminAuditResponseSchema.safeParse({ ...list, nextCursor: 'bad' }).success).toBe(false);
    const at = Array.from({ length: ADMIN_PAGE_SIZE }, () => entry);
    expect(adminAuditResponseSchema.safeParse({ ...list, entries: at }).success).toBe(true);
    expect(adminAuditResponseSchema.safeParse({ ...list, entries: [...at, entry] }).success).toBe(
      false,
    );
  });

  it('builds the audit enums from the constants', () => {
    expect(auditActionSchema.options).toEqual(Object.values(AuditAction));
    expect(auditEntityTypeSchema.options).toEqual(Object.values(AuditEntityType));
    expect(auditActorTypeSchema.options).toEqual(Object.values(AuditActorType));
    expect(auditActionSchema.safeParse('bogus').success).toBe(false);
    expect(auditEntityTypeSchema.safeParse('bogus').success).toBe(false);
    expect(auditActorTypeSchema.safeParse('bogus').success).toBe(false);
  });
});

describe('the password change contract (#78)', () => {
  const body = { currentPassword: 'OLD-SECRET', newPassword: 'NEW-SECRET', ...CLIENT };

  it('accepts two different passwords within the login bounds', () => {
    expect(safeParseAdminChangePasswordRequest(body).success).toBe(true);
    const atMax = 'x'.repeat(STAFF_PASSWORD_MAX_LENGTH);
    expect(safeParseAdminChangePasswordRequest({ ...body, newPassword: atMax }).success).toBe(true);
    expect(safeParseAdminChangePasswordRequest({ ...body, currentPassword: atMax }).success).toBe(
      true,
    );
  });

  it('refuses an empty or over-long password on either side', () => {
    const over = 'x'.repeat(STAFF_PASSWORD_MAX_LENGTH + 1);
    for (const patch of [
      { newPassword: '' },
      { currentPassword: '' },
      { newPassword: over },
      { currentPassword: over },
    ]) {
      expect(safeParseAdminChangePasswordRequest({ ...body, ...patch }).success).toBe(false);
    }
  });

  it('refuses a new password equal to the current one with one custom issue on newPassword', () => {
    const parsed = safeParseAdminChangePasswordRequest({ ...body, newPassword: 'OLD-SECRET' });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((i) => [i.code, i.path])).toEqual([
      ['custom', ['newPassword']],
    ]);
  });

  it('drops a key it does not declare instead of refusing it', () => {
    const parsed = safeParseAdminChangePasswordRequest({
      ...body,
      newPasswordRepeat: 'NEW-SECRET',
    });
    expect(parsed.success).toBe(true);
    expect(Object.keys(parsed.data ?? {}).sort()).toEqual(
      ['currentPassword', 'ip', 'newPassword', 'userAgent'].sort(),
    );
  });

  it('never echoes a password in its issues', () => {
    const parsed = safeParseAdminChangePasswordRequest({
      ...body,
      currentPassword: 'OLD-SECRET'.repeat(30),
      newPassword: 'OLD-SECRET'.repeat(30),
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).not.toContain('OLD-SECRET');
  });

  it('accepts only the exact success shape as the response', () => {
    expect(safeParseChangePasswordResponse({ changed: true, revokedSessions: 0 }).success).toBe(
      true,
    );
    expect(safeParseChangePasswordResponse({ changed: true, revokedSessions: 3 }).success).toBe(
      true,
    );
    for (const bad of [
      { changed: true, revokedSessions: 1, extra: 1 },
      { changed: false, revokedSessions: 1 },
      { changed: true, revokedSessions: -1 },
      { changed: true, revokedSessions: 1.5 },
      { changed: true },
    ]) {
      expect(safeParseChangePasswordResponse(bad).success).toBe(false);
    }
  });
});
