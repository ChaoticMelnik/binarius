import { describe, expect, it } from 'vitest';
import {
  ADMIN_PAGE_SIZE,
  adminIntentResponseSchema,
  adminIntentsQuerySchema,
  adminIntentsResponseSchema,
  adminIntentsSearchParams,
  adminTradingSessionsQuerySchema,
  adminTradingSessionsResponseSchema,
  adminTradingSessionsSearchParams,
  safeParseAdminIntentsQuery,
  safeParseAdminTradingSessionsQuery,
} from './admin';
import {
  ADMIN_INTENTS_ACTIVE_FILTER,
  ADMIN_USER_RECENT_INTENTS,
  adminIntentsByStatusSchema,
  adminIntentStatusFilterSchema,
  adminTradeIntentViewSchema,
  adminTradingSessionViewSchema,
  adminUserIntentsSectionSchema,
} from './admin-trading';
import { TradeIntentStatus, tradeIntentViewSchema } from './trading';

const AT = '2026-10-07T08:00:00.000Z';

const SAMPLE_ADMIN_INTENT = {
  id: '00000000-0000-4000-8000-000000000030',
  brokerAccountId: '00000000-0000-4000-8000-000000000020',
  telegramUserId: '4242',
  mode: 'demo',
  assetId: 1,
  amount: '1.50000000',
  action: 'up',
  durationSec: 60,
  clientRequestId: 'demo:4242:n1',
  createdAt: AT,
  status: 'accepted',
  version: 3,
  tokensReserved: '1',
  transport: 'socket',
  submittedAt: AT,
  lastError: 'broker_rejected',
  updatedAt: AT,
  userId: '00000000-0000-4000-8000-000000000010',
  tradingSessionId: '00000000-0000-4000-8000-000000000040',
  reconcileClaimedAt: AT,
};

describe('adminIntentStatusFilterSchema', () => {
  it.each([ADMIN_INTENTS_ACTIVE_FILTER, ...Object.values(TradeIntentStatus)])('accepts %s', (s) => {
    expect(adminIntentStatusFilterSchema.safeParse(s).success).toBe(true);
  });

  it.each([
    ['an empty value', ''],
    ['an unknown status', 'bogus'],
    ['an array', ['queued']],
  ])('refuses %s', (_label, value) => {
    expect(adminIntentStatusFilterSchema.safeParse(value).success).toBe(false);
  });
});

describe('adminTradeIntentViewSchema', () => {
  it('accepts its sample, and every nullable key as null', () => {
    expect(adminTradeIntentViewSchema.safeParse(SAMPLE_ADMIN_INTENT).success).toBe(true);
    const bare = {
      ...SAMPLE_ADMIN_INTENT,
      transport: null,
      submittedAt: null,
      lastError: null,
      tradingSessionId: null,
      reconcileClaimedAt: null,
    };
    expect(adminTradeIntentViewSchema.safeParse(bare).success).toBe(true);
  });

  it("is the bot's view plus three keys, nothing else", () => {
    expect(Object.keys(adminTradeIntentViewSchema.shape).sort()).toEqual(
      [
        ...Object.keys(tradeIntentViewSchema.shape),
        'userId',
        'tradingSessionId',
        'reconcileClaimedAt',
      ].sort(),
    );
  });

  it('refuses an extra key', () => {
    expect(
      adminTradeIntentViewSchema.safeParse({ ...SAMPLE_ADMIN_INTENT, accessTokenEnc: 'x' }).success,
    ).toBe(false);
  });

  it.each(['userId', 'tradingSessionId', 'reconcileClaimedAt'] as const)(
    'refuses a view without %s',
    (key) => {
      const rest: Record<string, unknown> = { ...SAMPLE_ADMIN_INTENT };
      delete rest[key];
      expect(adminTradeIntentViewSchema.safeParse(rest).success).toBe(false);
    },
  );

  it('refuses a session id that is not a uuid', () => {
    expect(
      adminTradeIntentViewSchema.safeParse({ ...SAMPLE_ADMIN_INTENT, tradingSessionId: 'x' })
        .success,
    ).toBe(false);
  });
});

const U1 = '00000000-0000-4000-8000-0000000000f1';
const S1 = '00000000-0000-4000-8000-0000000000f2';
const C1 = '00000000-0000-4000-8000-0000000000f3';

describe('adminIntentsQuerySchema', () => {
  it('takes no key as an empty query', () => {
    expect(adminIntentsQuerySchema.parse({})).toEqual({});
  });

  it('accepts every filter at once', () => {
    const query = { status: 'active', mode: 'real', user: U1, session: S1, cursor: C1 };
    expect(adminIntentsQuerySchema.parse(query)).toEqual(query);
  });

  it.each([
    ['status', ''],
    ['status', 'bogus'],
    ['mode', 'paper'],
    ['user', 'not-a-uuid'],
    ['user', ' '],
    ['session', 'x'],
    ['cursor', 'bad'],
    ['status', ['queued', 'settled']],
  ])('refuses %s = %j', (key, value) => {
    expect(adminIntentsQuerySchema.safeParse({ [key]: value }).success).toBe(false);
  });

  it('strips keys it does not declare', () => {
    expect(adminIntentsQuerySchema.parse({ mode: 'real', utm: '1' })).toEqual({ mode: 'real' });
  });
});

describe('adminIntentsSearchParams', () => {
  it('writes keys in the schema order, whatever order the caller used', () => {
    const params = adminIntentsSearchParams({
      cursor: C1,
      session: S1,
      user: U1,
      mode: 'demo',
      status: 'active',
    });
    expect([...params].map(([k]) => k)).toEqual(['status', 'mode', 'user', 'session', 'cursor']);
  });

  it('round-trips a query through its own serialization', () => {
    const query = { status: 'manual_review', mode: 'demo', session: S1 } as const;
    const params = adminIntentsSearchParams(query);
    expect(safeParseAdminIntentsQuery(Object.fromEntries(params)).data).toEqual(query);
  });

  it('writes nothing for an empty query', () => {
    expect(adminIntentsSearchParams({}).size).toBe(0);
  });
});

describe('admin intents responses', () => {
  const ME = {
    staffId: '00000000-0000-4000-8000-000000000002',
    login: 'ada',
    sessionId: '00000000-0000-4000-8000-000000000003',
  };
  const list = { me: ME, intents: [SAMPLE_ADMIN_INTENT], nextCursor: C1 };
  const card = { me: ME, intent: SAMPLE_ADMIN_INTENT };

  it('accept their samples', () => {
    expect(adminIntentsResponseSchema.safeParse(list).success).toBe(true);
    expect(adminIntentsResponseSchema.safeParse({ ...list, nextCursor: null }).success).toBe(true);
    expect(adminIntentResponseSchema.safeParse(card).success).toBe(true);
  });

  it.each([
    ['the list response', { ...list, extra: 1 }, adminIntentsResponseSchema],
    ['the list me', { ...list, me: { ...ME, extra: 1 } }, adminIntentsResponseSchema],
    [
      'a list row',
      { ...list, intents: [{ ...SAMPLE_ADMIN_INTENT, extra: 1 }] },
      adminIntentsResponseSchema,
    ],
    ['the card response', { ...card, extra: 1 }, adminIntentResponseSchema],
    ['the card me', { ...card, me: { ...ME, extra: 1 } }, adminIntentResponseSchema],
    [
      'the card',
      { ...card, intent: { ...SAMPLE_ADMIN_INTENT, extra: 1 } },
      adminIntentResponseSchema,
    ],
  ] as const)('refuse an extra key in %s', (_label, body, schema) => {
    expect(schema.safeParse(body).success).toBe(false);
  });

  it('refuse a next cursor that is not a uuid, and a page over ADMIN_PAGE_SIZE', () => {
    expect(adminIntentsResponseSchema.safeParse({ ...list, nextCursor: 'bad' }).success).toBe(
      false,
    );
    const at = Array.from({ length: ADMIN_PAGE_SIZE }, () => SAMPLE_ADMIN_INTENT);
    const over = [...at, SAMPLE_ADMIN_INTENT];
    expect(adminIntentsResponseSchema.safeParse({ ...list, intents: at }).success).toBe(true);
    expect(adminIntentsResponseSchema.safeParse({ ...list, intents: over }).success).toBe(false);
  });
});

describe('adminIntentsByStatusSchema (#330)', () => {
  const zeros = Object.fromEntries(Object.values(TradeIntentStatus).map((s) => [s, 0]));

  it('accepts every status with a count, zeros included', () => {
    expect(adminIntentsByStatusSchema.safeParse(zeros).success).toBe(true);
    expect(adminIntentsByStatusSchema.safeParse({ ...zeros, settled: 7 }).success).toBe(true);
  });

  it('declares exactly the ten statuses', () => {
    expect(Object.keys(adminIntentsByStatusSchema.shape)).toEqual(Object.values(TradeIntentStatus));
  });

  it.each([
    [
      'a missing status',
      (() => {
        const rest: Record<string, number> = { ...zeros };
        delete rest.manual_review;
        return rest;
      })(),
    ],
    ['an extra key', { ...zeros, bogus: 0 }],
    ['a negative count', { ...zeros, queued: -1 }],
    ['a fractional count', { ...zeros, queued: 1.5 }],
  ])('refuses %s', (_label, value) => {
    expect(adminIntentsByStatusSchema.safeParse(value).success).toBe(false);
  });
});

describe('adminUserIntentsSectionSchema (#330)', () => {
  it('accepts an empty section and one of ADMIN_USER_RECENT_INTENTS rows', () => {
    expect(ADMIN_USER_RECENT_INTENTS).toBe(20);
    expect(
      adminUserIntentsSectionSchema.safeParse({ recent: [], total: 0, active: 0 }).success,
    ).toBe(true);
    const full = Array.from({ length: ADMIN_USER_RECENT_INTENTS }, () => SAMPLE_ADMIN_INTENT);
    expect(
      adminUserIntentsSectionSchema.safeParse({ recent: full, total: 25, active: 1 }).success,
    ).toBe(true);
  });

  it('refuses more than ADMIN_USER_RECENT_INTENTS rows, an extra key, a strict-view violation', () => {
    const over = Array.from({ length: ADMIN_USER_RECENT_INTENTS + 1 }, () => SAMPLE_ADMIN_INTENT);
    const ok = { recent: [SAMPLE_ADMIN_INTENT], total: 1, active: 0 };
    expect(adminUserIntentsSectionSchema.safeParse({ ...ok, recent: over }).success).toBe(false);
    expect(adminUserIntentsSectionSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(
      adminUserIntentsSectionSchema.safeParse({ ...ok, recent: [{ ...SAMPLE_ADMIN_INTENT, x: 1 }] })
        .success,
    ).toBe(false);
    expect(adminUserIntentsSectionSchema.safeParse({ ...ok, active: -1 }).success).toBe(false);
  });
});

const SAMPLE_SESSION = {
  id: '00000000-0000-4000-8000-000000000040',
  brokerAccountId: '00000000-0000-4000-8000-000000000020',
  brokerUserId: 'broker-7',
  userId: '00000000-0000-4000-8000-000000000010',
  telegramUserId: '4242',
  mode: 'demo',
  status: 'stopped',
  stopReason: 'rejected_twice',
  settings: {
    version: 1,
    assetId: 1,
    durationSec: 60,
    trades: 5,
    stake: { baseStake: '1', stakeScale: 0 },
  },
  startedAt: AT,
  endedAt: AT,
  lastDecisionAt: AT,
  createdAt: AT,
  updatedAt: AT,
};

describe('adminTradingSessionViewSchema (#330)', () => {
  it('accepts its sample, and every nullable key as null', () => {
    expect(adminTradingSessionViewSchema.safeParse(SAMPLE_SESSION).success).toBe(true);
    const bare = {
      ...SAMPLE_SESSION,
      status: 'active',
      stopReason: null,
      settings: null,
      endedAt: null,
      lastDecisionAt: null,
    };
    expect(adminTradingSessionViewSchema.safeParse(bare).success).toBe(true);
  });

  it.each([
    ['an extra key', { ...SAMPLE_SESSION, summarySentAt: AT }],
    [
      'settings with an extra key',
      { ...SAMPLE_SESSION, settings: { ...SAMPLE_SESSION.settings, x: 1 } },
    ],
    [
      'settings of another version',
      { ...SAMPLE_SESSION, settings: { ...SAMPLE_SESSION.settings, version: 2 } },
    ],
    ['an unknown status', { ...SAMPLE_SESSION, status: 'bogus' }],
    ['an unknown stop reason', { ...SAMPLE_SESSION, stopReason: 'bogus' }],
    ['a broker account id that is not a uuid', { ...SAMPLE_SESSION, brokerAccountId: 'x' }],
  ])('refuses %s', (_label, value) => {
    expect(adminTradingSessionViewSchema.safeParse(value).success).toBe(false);
  });
});

describe('adminTradingSessionsQuerySchema (#330)', () => {
  it('takes no key as an empty query, a uuid cursor as given, strips other keys', () => {
    expect(adminTradingSessionsQuerySchema.parse({})).toEqual({});
    expect(adminTradingSessionsQuerySchema.parse({ cursor: C1, utm: '1' })).toEqual({ cursor: C1 });
  });

  it.each([['bad'], [''], [[C1, C1]]])('refuses cursor = %j', (cursor) => {
    expect(safeParseAdminTradingSessionsQuery({ cursor }).success).toBe(false);
  });

  it('serializes nothing for an empty query and round-trips a cursor', () => {
    expect(adminTradingSessionsSearchParams({}).size).toBe(0);
    const params = adminTradingSessionsSearchParams({ cursor: C1 });
    expect(params.toString()).toBe(`cursor=${C1}`);
    expect(safeParseAdminTradingSessionsQuery(Object.fromEntries(params)).data).toEqual({
      cursor: C1,
    });
  });
});

describe('adminTradingSessionsResponseSchema (#330)', () => {
  const ME = {
    staffId: '00000000-0000-4000-8000-000000000002',
    login: 'ada',
    sessionId: '00000000-0000-4000-8000-000000000003',
  };
  const list = { me: ME, sessions: [SAMPLE_SESSION], nextCursor: C1 };

  it('accepts its sample, with and without a next cursor', () => {
    expect(adminTradingSessionsResponseSchema.safeParse(list).success).toBe(true);
    expect(
      adminTradingSessionsResponseSchema.safeParse({ ...list, nextCursor: null }).success,
    ).toBe(true);
  });

  it.each([
    ['the response', { ...list, extra: 1 }],
    ['me', { ...list, me: { ...ME, extra: 1 } }],
    ['a row', { ...list, sessions: [{ ...SAMPLE_SESSION, extra: 1 }] }],
  ])('refuses an extra key in %s', (_label, body) => {
    expect(adminTradingSessionsResponseSchema.safeParse(body).success).toBe(false);
  });

  it('refuses a next cursor that is not a uuid, and a page over ADMIN_PAGE_SIZE', () => {
    expect(
      adminTradingSessionsResponseSchema.safeParse({ ...list, nextCursor: 'bad' }).success,
    ).toBe(false);
    const at = Array.from({ length: ADMIN_PAGE_SIZE }, () => SAMPLE_SESSION);
    expect(adminTradingSessionsResponseSchema.safeParse({ ...list, sessions: at }).success).toBe(
      true,
    );
    expect(
      adminTradingSessionsResponseSchema.safeParse({ ...list, sessions: [...at, SAMPLE_SESSION] })
        .success,
    ).toBe(false);
  });
});
