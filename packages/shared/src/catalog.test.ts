import { describe, expect, it } from 'vitest';
import type { BinaryPair } from './broker';
import {
  breakEvenPct,
  comparePairsByPayout,
  MIN_CYCLE_PAYOUT_PCT,
  PAIR_TYPE_GROUPS,
  pairTypeGroupOf,
  pairPayoutAccepted,
  PairsCatalogErrorCode,
  TRADING_PAIRS_PATH,
  isPairOpen,
  pairAcceptsDuration,
  safeParsePairsCatalogResponse,
  toPairView,
  toPairsCatalogResponse,
} from './catalog';

const pair: BinaryPair = {
  id: 101,
  symbol: 'EUR/USD',
  isOtc: false,
  type: 'currency',
  digits: 5,
  payout: 82,
  maxPayout: 90,
  minTimeframe: 30,
  maxTimeframe: 3600,
  scheduledUntil: 0,
};

const PAIR_VIEW_KEYS = [
  'id',
  'symbol',
  'isOtc',
  'type',
  'digits',
  'payout',
  'maxPayout',
  'minTimeframe',
  'maxTimeframe',
  'scheduledUntil',
];

const response = (patch: Record<string, unknown> = {}) => ({
  pairs: [pair],
  fetchedAt: 1_790_000_000_000,
  ageMs: 1_500,
  fresh: true,
  ...patch,
});

describe('TRADING_PAIRS_PATH', () => {
  it('is the route the backend serves', () => {
    expect(TRADING_PAIRS_PATH).toBe('/trading/pairs');
    expect(PairsCatalogErrorCode.Unavailable).toBe('catalog_unavailable');
  });
});

describe('pairsCatalogResponseSchema', () => {
  it('accepts a response and an empty catalog', () => {
    expect(safeParsePairsCatalogResponse(response()).data).toEqual(response());
    expect(safeParsePairsCatalogResponse(response({ pairs: [] })).success).toBe(true);
  });

  it('refuses a negative or fractional age and a fractional fetchedAt', () => {
    expect(safeParsePairsCatalogResponse(response({ ageMs: -1 })).success).toBe(false);
    expect(safeParsePairsCatalogResponse(response({ ageMs: 1.5 })).success).toBe(false);
    expect(safeParsePairsCatalogResponse(response({ fetchedAt: 1.5 })).success).toBe(false);
  });

  it('refuses a body without fresh and a fresh that is not a boolean', () => {
    const withoutFresh: Record<string, unknown> = response();
    delete withoutFresh.fresh;
    expect(safeParsePairsCatalogResponse(withoutFresh).success).toBe(false);
    expect(safeParsePairsCatalogResponse(response({ fresh: 'yes' })).success).toBe(false);
    expect(safeParsePairsCatalogResponse(response({ fresh: false })).data?.fresh).toBe(false);
  });

  it('strips a key a pair does not declare', () => {
    const parsed = safeParsePairsCatalogResponse(response({ pairs: [{ ...pair, extra: 'x' }] }));
    expect(parsed.data?.pairs[0]).toEqual(pair);
    expect(parsed.data?.pairs[0]).not.toHaveProperty('extra');
  });
});

describe('toPairView', () => {
  it('copies exactly the PairView keys', () => {
    expect(Object.keys(toPairView(pair)).sort()).toEqual([...PAIR_VIEW_KEYS].sort());
    expect(toPairView(pair)).toEqual(pair);
  });

  it('leaves out isOtc when the pair has none, rather than sending undefined', () => {
    const withoutOtc: BinaryPair = { ...pair };
    delete withoutOtc.isOtc;
    expect(Object.keys(toPairView(withoutOtc))).not.toContain('isOtc');
  });

  it('drops a field BinaryPair gains later', () => {
    const future = { ...pair, spread: 3 } as BinaryPair;
    expect(toPairView(future)).not.toHaveProperty('spread');
  });
});

describe('toPairsCatalogResponse', () => {
  it('maps every pair through the allowlist and keeps fetchedAt, ageMs and fresh', () => {
    const future = { ...pair, id: 102, spread: 3 } as BinaryPair;
    const body = toPairsCatalogResponse({
      pairs: [pair, future],
      fetchedAt: 10,
      ageMs: 2,
      fresh: false,
    });
    expect(body).toEqual({
      pairs: [pair, { ...pair, id: 102 }],
      fetchedAt: 10,
      ageMs: 2,
      fresh: false,
    });
    expect(safeParsePairsCatalogResponse(body).success).toBe(true);
  });
});

describe('pair predicates', () => {
  const now = 1_000_000;

  it('isPairOpen: no restriction, the boundary, and a future time', () => {
    expect(isPairOpen({ scheduledUntil: 0 }, now)).toBe(true);
    expect(isPairOpen({ scheduledUntil: now }, now)).toBe(true);
    expect(isPairOpen({ scheduledUntil: now + 1 }, now)).toBe(false);
  });

  it('pairAcceptsDuration: both bounds inside, one second outside each', () => {
    const range = { minTimeframe: 60, maxTimeframe: 3600 };
    expect(pairAcceptsDuration(range, 60)).toBe(true);
    expect(pairAcceptsDuration(range, 3600)).toBe(true);
    expect(pairAcceptsDuration(range, 59)).toBe(false);
    expect(pairAcceptsDuration(range, 3601)).toBe(false);
  });
});

describe('the cycle payout floor (#379)', () => {
  it.each([
    [79, false],
    [79.99, false],
    [80, true],
    [81, true],
  ])('a pair paying %s percent is accepted: %s', (payout, accepted) => {
    expect(MIN_CYCLE_PAYOUT_PCT).toBe(80);
    expect(pairPayoutAccepted({ payout })).toBe(accepted);
  });

  it.each([
    [80, 55.56],
    [68.9, 59.21],
    [100, 50],
    [0, 100],
  ])('at a payout of %s percent the break-even share is %s percent', (payout, share) => {
    expect(breakEvenPct(payout)).toBeCloseTo(share, 2);
  });

  it('is not finite at a payout of -100', () => {
    expect(Number.isFinite(breakEvenPct(-100))).toBe(false);
  });
});

describe('pairTypeGroupOf (#460)', () => {
  it('lists the five broker types and other, in the screen order', () => {
    expect(PAIR_TYPE_GROUPS).toEqual([
      'currency',
      'commodity',
      'stock',
      'cryptocurrency',
      'index',
      'other',
    ]);
  });

  it.each(['currency', 'commodity', 'stock', 'cryptocurrency', 'index'])(
    'keeps the live type %s as its group',
    (type) => {
      expect(pairTypeGroupOf(type)).toBe(type);
    },
  );

  it('puts any other type under other', () => {
    expect(pairTypeGroupOf('bond')).toBe('other');
    expect(pairTypeGroupOf('')).toBe('other');
  });
});

describe('comparePairsByPayout (#460)', () => {
  it('puts the higher payout first, then the lower id, whatever the input order', () => {
    const items = [
      { id: 7, payout: 85 },
      { id: 3, payout: 85 },
      { id: 9, payout: 92 },
      { id: 1, payout: 80 },
    ];
    const expected = [9, 3, 7, 1];
    expect([...items].sort(comparePairsByPayout).map((p) => p.id)).toEqual(expected);
    expect(
      [...items]
        .reverse()
        .sort(comparePairsByPayout)
        .map((p) => p.id),
    ).toEqual(expected);
  });
});
