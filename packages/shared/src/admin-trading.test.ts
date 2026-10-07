import { describe, expect, it } from 'vitest';
import {
  ADMIN_PAGE_SIZE,
  adminIntentResponseSchema,
  adminIntentsQuerySchema,
  adminIntentsResponseSchema,
  adminIntentsSearchParams,
  safeParseAdminIntentsQuery,
} from './admin';
import {
  ADMIN_INTENTS_ACTIVE_FILTER,
  adminIntentStatusFilterSchema,
  adminTradeIntentViewSchema,
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
