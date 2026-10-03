import { describe, expect, it } from 'vitest';
import type { BinaryPair } from './broker';
import {
  PairsCatalogErrorCode,
  TRADING_PAIRS_PATH,
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
  it('maps every pair through the allowlist and keeps fetchedAt and ageMs', () => {
    const future = { ...pair, id: 102, spread: 3 } as BinaryPair;
    const body = toPairsCatalogResponse({ pairs: [pair, future], fetchedAt: 10, ageMs: 2 });
    expect(body).toEqual({ pairs: [pair, { ...pair, id: 102 }], fetchedAt: 10, ageMs: 2 });
    expect(safeParsePairsCatalogResponse(body).success).toBe(true);
  });
});
