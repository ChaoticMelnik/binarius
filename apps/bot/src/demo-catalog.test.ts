import { describe, expect, it, vi } from 'vitest';
import { PairsCatalogErrorCode, type PairView } from '@binarius/shared';
import { BackendError, BackendErrorCode } from './backend-client';
import {
  checkDemoTrade,
  DEMO_DURATIONS_SEC,
  DEMO_PAGE_SIZE,
  durationOptions,
  groupOf,
  isOpen,
  openPairsOf,
  pairsOf,
  pageIndexOf,
  pageOf,
  readDemoCatalog,
  readDemoTrade,
} from './demo-catalog';
import {
  PAIR_CLOSED,
  PAIR_EURUSD,
  PAIR_MINUTE_ONLY,
  PAIR_OTHER_TYPE,
  PAIR_SHORT,
  PAIRS_RESPONSE,
  pairsResponse,
} from './testing';

const NOW = 1_790_000_000_000;

const pairs = (count: number): PairView[] =>
  Array.from({ length: count }, (_, index) => ({
    ...PAIR_EURUSD,
    id: 1000 + index,
    symbol: `P${String(index).padStart(2, '0')}`,
  }));

describe('groupOf', () => {
  it.each(['currency', 'commodity', 'stock', 'cryptocurrency', 'index'])(
    'keeps the live type %s as its group',
    (type) => {
      expect(groupOf(type)).toBe(type);
    },
  );

  it('puts any other type under other', () => {
    expect(groupOf('bond')).toBe('other');
    expect(groupOf('')).toBe('other');
  });
});

describe('isOpen', () => {
  it('is open with no schedule, and from scheduledUntil on, closed before it', () => {
    expect(isOpen({ ...PAIR_EURUSD, scheduledUntil: 0 }, NOW)).toBe(true);
    expect(isOpen({ ...PAIR_EURUSD, scheduledUntil: NOW - 1 }, NOW)).toBe(true);
    expect(isOpen({ ...PAIR_EURUSD, scheduledUntil: NOW }, NOW)).toBe(true);
    expect(isOpen({ ...PAIR_EURUSD, scheduledUntil: NOW + 1 }, NOW)).toBe(false);
  });
});

describe('openPairsOf', () => {
  it('lists the open pairs of a group by symbol, ties by id, and leaves out the closed ones', () => {
    const catalog = pairsResponse({
      pairs: [
        { ...PAIR_EURUSD, id: 7, symbol: 'USD/JPY' },
        PAIR_CLOSED,
        { ...PAIR_EURUSD, id: 9, symbol: 'AUD/CAD' },
        { ...PAIR_EURUSD, id: 3, symbol: 'AUD/CAD' },
        PAIR_SHORT,
      ],
    });
    expect(openPairsOf(catalog, 'currency', NOW).map((pair) => pair.id)).toEqual([3, 9, 7]);
  });

  it('is empty for a group with no open pair, and for one with none at all', () => {
    const catalog = pairsResponse({ pairs: [PAIR_CLOSED] });
    expect(openPairsOf(catalog, 'currency', NOW)).toEqual([]);
    expect(openPairsOf(catalog, 'index', NOW)).toEqual([]);
  });

  it('lists an unknown type under other', () => {
    expect(openPairsOf(PAIRS_RESPONSE, 'other', NOW)).toEqual([PAIR_OTHER_TYPE]);
  });

  // #313: a pair that accepts neither 5 nor 15 s is never listed, open or not
  it('leaves out a pair that accepts no demo duration', () => {
    expect(PAIRS_RESPONSE.pairs).toContain(PAIR_MINUTE_ONLY);
    expect(openPairsOf(PAIRS_RESPONSE, 'currency', NOW)).toEqual([PAIR_EURUSD]);
    expect(pairsOf(PAIRS_RESPONSE, 'currency')).toEqual([PAIR_EURUSD, PAIR_CLOSED]);
    const narrow = { ...PAIR_EURUSD, id: 8, minTimeframe: 10, maxTimeframe: 15 };
    expect(pairsOf(pairsResponse({ pairs: [narrow] }), 'currency')).toEqual([narrow]);
  });
});

describe('pageOf', () => {
  it.each([
    [0, 1],
    [DEMO_PAGE_SIZE, 1],
    [DEMO_PAGE_SIZE + 1, 2],
    [2 * DEMO_PAGE_SIZE + 1, 3],
  ])('splits %i pairs into %i pages', (count, pageCount) => {
    expect(pageOf(pairs(count), 0).pageCount).toBe(pageCount);
  });

  it('holds DEMO_PAGE_SIZE pairs a page, the rest on the last', () => {
    const all = pairs(25);
    expect(pageOf(all, 1).pairs).toEqual(all.slice(12, 24));
    expect(pageOf(all, 2).pairs).toEqual(all.slice(24));
  });

  it('clamps a page beyond the end to the last page', () => {
    const all = pairs(13);
    expect(pageOf(all, 9999)).toEqual({ pairs: all.slice(12), page: 1, pageCount: 2 });
  });
});

describe('pageIndexOf', () => {
  it('finds the page a pair is listed on, and the first for one not listed', () => {
    const all = pairs(25);
    expect(pageIndexOf(all, 1000)).toBe(0);
    expect(pageIndexOf(all, 1011)).toBe(0);
    expect(pageIndexOf(all, 1012)).toBe(1);
    expect(pageIndexOf(all, 1024)).toBe(2);
    expect(pageIndexOf(all, 5)).toBe(0);
  });
});

describe('durationOptions', () => {
  it.each([
    [5, 3600, [...DEMO_DURATIONS_SEC]],
    [1, 15, [5, 15]],
    [5, 10, [5]],
    [10, 3600, [15]],
    [6, 14, []],
    [60, 3600, []],
  ])('admits for min %i and max %i exactly %j', (minTimeframe, maxTimeframe, expected) => {
    expect(durationOptions({ ...PAIR_EURUSD, minTimeframe, maxTimeframe })).toEqual(expected);
  });
});

describe('checkDemoTrade', () => {
  const pair = { ...PAIR_EURUSD, minTimeframe: 10, maxTimeframe: 15 };
  const catalog = pairsResponse({ pairs: [pair] });

  // the durations around the range are the table's, so the range is what refuses them
  it('admits a duration on either end of the range, and nothing outside it', () => {
    expect(checkDemoTrade(catalog, pair.id, 15, NOW)).toEqual({
      ok: true,
      pair,
      durationSec: 15,
    });
    expect(checkDemoTrade(catalog, pair.id, 5, NOW)).toEqual({
      ok: false,
      reason: 'duration_unsupported',
      pair,
    });
  });

  // #125 review m5: the duration comes from callback data
  it("refuses a duration outside the demo's table even where the pair's range admits it", () => {
    const wide = { ...PAIR_EURUSD, minTimeframe: 5, maxTimeframe: 3600 };
    for (const durationSec of [10, 60, 300]) {
      expect(checkDemoTrade(pairsResponse({ pairs: [wide] }), wide.id, durationSec, NOW)).toEqual({
        ok: false,
        reason: 'duration_unsupported',
        pair: wide,
      });
    }
  });

  it('refuses an id the catalog does not hold', () => {
    expect(checkDemoTrade(catalog, 999, 15, NOW)).toEqual({ ok: false, reason: 'pair_missing' });
  });

  it('refuses a closed pair before looking at the duration', () => {
    const closed = { ...pair, scheduledUntil: NOW + 1 };
    expect(checkDemoTrade(pairsResponse({ pairs: [closed] }), pair.id, 1, NOW)).toEqual({
      ok: false,
      reason: 'pair_closed',
      pair: closed,
    });
  });
});

describe('readDemoCatalog', () => {
  const failing = (error: unknown) => ({ readPairs: () => Promise.reject(error) });

  it('hands out a fresh catalog', async () => {
    expect(await readDemoCatalog({ readPairs: () => Promise.resolve(PAIRS_RESPONSE) })).toEqual({
      ok: true,
      catalog: PAIRS_RESPONSE,
    });
  });

  it('calls a catalog the backend does not call fresh stale', async () => {
    const stale = pairsResponse({ fresh: false });
    expect(await readDemoCatalog({ readPairs: () => Promise.resolve(stale) })).toEqual({
      ok: false,
      reason: 'catalog_stale',
    });
  });

  it('tells the 503 by its reason', async () => {
    const error = new BackendError(BackendErrorCode.HttpStatus, {
      status: 503,
      reason: PairsCatalogErrorCode.Unavailable,
    });
    expect(await readDemoCatalog(failing(error))).toEqual({
      ok: false,
      reason: 'catalog_unavailable',
    });
  });

  it.each([
    ['a 503 without the reason', new BackendError(BackendErrorCode.HttpStatus, { status: 503 })],
    [
      'a 404 not_found',
      new BackendError(BackendErrorCode.HttpStatus, { status: 404, reason: 'not_found' }),
    ],
    [
      'a 401',
      new BackendError(BackendErrorCode.HttpStatus, { status: 401, reason: 'unauthorized' }),
    ],
    ['no answer', new BackendError(BackendErrorCode.Unreachable)],
    ['a broken body', new BackendError(BackendErrorCode.ContractViolation)],
  ])('reads %s as backend_failed and carries the error', async (_case, error) => {
    expect(await readDemoCatalog(failing(error))).toEqual({
      ok: false,
      reason: 'backend_failed',
      error,
    });
  });
});

describe('readDemoTrade', () => {
  it('checks the pair on the clock taken after the read, against that catalog', async () => {
    const now = vi.fn(() => NOW);
    expect(
      await readDemoTrade({ readPairs: () => Promise.resolve(PAIRS_RESPONSE) }, 101, 15, now),
    ).toEqual({ ok: true, pair: PAIR_EURUSD, durationSec: 15, catalog: PAIRS_RESPONSE });
    expect(now).toHaveBeenCalledTimes(1);
  });

  it('never reaches the pair check with a stale catalog', async () => {
    const stale = pairsResponse({ fresh: false, pairs: [] });
    const now = vi.fn(() => NOW);
    expect(await readDemoTrade({ readPairs: () => Promise.resolve(stale) }, 101, 15, now)).toEqual({
      ok: false,
      reason: 'catalog_stale',
    });
    expect(now).not.toHaveBeenCalled();
  });

  it('carries the catalog with a pair-level refusal', async () => {
    const read = await readDemoTrade(
      { readPairs: () => Promise.resolve(PAIRS_RESPONSE) },
      PAIR_CLOSED.id,
      15,
      () => NOW,
    );
    expect(read).toEqual({
      ok: false,
      reason: 'pair_closed',
      pair: PAIR_CLOSED,
      catalog: PAIRS_RESPONSE,
    });
  });
});
