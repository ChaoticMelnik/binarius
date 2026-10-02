import { safeParseCandles, type BinaryPairWire } from '@binarius/shared';
import { describe, expect, it } from 'vitest';
import {
  buildCandles,
  DEFAULT_CHART_LIMIT,
  MAX_CHART_LIMIT,
  parseIntervalMs,
  validateChartQuery,
} from './chart';
import { rawPriceAt, roundTo } from './price';

const PAIR: BinaryPairWire = {
  id: 7,
  symbol: 'EUR/USD',
  type: 'currency',
  digits: 5,
  payout: 85,
  max_payout: 90,
  min_timeframe: 60,
  max_timeframe: 3600,
  scheduled_until: 0,
};
const findPair = (id: number) => (id === PAIR.id ? PAIR : undefined);
// a whole minute, so candles start exactly at START
const START = 1_790_000_040_000;

describe('parseIntervalMs', () => {
  it.each([
    ['30s', 30_000],
    ['15m', 900_000],
    ['2h', 7_200_000],
    ['3d', 259_200_000],
    ['1w', 604_800_000],
    ['1M', 2_592_000_000],
    ['250ms', 250],
    ['0m', 0],
  ])('reads %j as %d ms', (raw, ms) => {
    expect(parseIntervalMs(raw)).toBe(ms);
  });

  it.each(['60', '1x', 'm', '1 m', '1min', '-1m', '1.5m', ''])('refuses %j', (raw) => {
    expect(parseIntervalMs(raw)).toBeUndefined();
  });
});

describe('validateChartQuery', () => {
  const valid = { interval: '1m', asset_id: String(PAIR.id), start_time: String(START) };

  it.each(['60', '1x'])('answers the live text for interval %j', (interval) => {
    expect(validateChartQuery({ ...valid, interval }, findPair)).toEqual({
      ok: false,
      message: `Unsupported interval ${interval}; expected "250ms" / "5s" / "1m" / "1h" / "1d" / "1w" / "1M" forms`,
    });
  });

  it('checks interval before asset and asset before start_time', () => {
    expect(validateChartQuery({ interval: '1x', asset_id: 'x' }, findPair)).toMatchObject({
      message: expect.stringMatching(/^Unsupported interval 1x;/),
    });
    expect(validateChartQuery({ interval: '1m', asset_id: '999' }, findPair)).toEqual({
      ok: false,
      message: 'Unknown asset',
    });
    expect(validateChartQuery({ interval: '1m', asset_id: String(PAIR.id) }, findPair)).toEqual({
      ok: false,
      message: 'Validation failed: "start_time" (ms epoch) is required',
    });
  });

  it.each(['999', 'abc', '7.0', ''])('answers Unknown asset for asset_id %j', (assetId) => {
    expect(validateChartQuery({ ...valid, asset_id: assetId }, findPair)).toEqual({
      ok: false,
      message: 'Unknown asset',
    });
  });

  it('asks for a missing interval', () => {
    expect(validateChartQuery({ asset_id: '7', start_time: String(START) }, findPair)).toEqual({
      ok: false,
      message: 'Validation failed: "interval" is required',
    });
  });

  it.each(['0m', '500ms', '4s'])('answers [] for a step below 5 s (%j)', (interval) => {
    expect(validateChartQuery({ ...valid, interval }, findPair)).toEqual({ ok: true, empty: true });
  });

  it('answers [] for a start_time in seconds', () => {
    expect(validateChartQuery({ ...valid, start_time: '1790000040' }, findPair)).toEqual({
      ok: true,
      empty: true,
    });
  });

  it.each([
    [undefined, DEFAULT_CHART_LIMIT],
    ['0', DEFAULT_CHART_LIMIT],
    ['-5', DEFAULT_CHART_LIMIT],
    ['abc', DEFAULT_CHART_LIMIT],
    ['7', 7],
    ['5000', MAX_CHART_LIMIT],
    ['9000', MAX_CHART_LIMIT],
  ])('reads limit %j as %d', (limit, expected) => {
    const query = limit === undefined ? valid : { ...valid, limit };
    expect(validateChartQuery(query, findPair)).toMatchObject({ ok: true, limit: expected });
  });

  it('carries the step and the pair', () => {
    expect(validateChartQuery({ ...valid, interval: '5s' }, findPair)).toMatchObject({
      ok: true,
      empty: false,
      pair: PAIR,
      stepMs: 5_000,
      startTime: START,
    });
  });
});

describe('buildCandles', () => {
  const step = 60_000;
  const now = START + 10 * step;

  it('aligns to the step, advances by it and stops at limit', () => {
    const candles = buildCandles(PAIR, step, START + 12_345, 5, now);
    expect(candles.map(([ts]) => ts)).toEqual(
      [0, 1, 2, 3, 4].map((i) => Math.floor((START + 12_345) / step) * step + i * step),
    );
  });

  it('never returns a candle that starts after now', () => {
    const candles = buildCandles(PAIR, step, START, 100, now);
    expect(candles).toHaveLength(11);
    expect(candles.at(-1)?.[0]).toBe(now);
    expect(buildCandles(PAIR, step, now + step, 100, now)).toEqual([]);
  });

  it('is deterministic and continuous: a close is the next open', () => {
    const first = buildCandles(PAIR, step, START, 10, now);
    expect(buildCandles(PAIR, step, START, 10, now)).toEqual(first);
    for (let i = 0; i + 1 < first.length; i += 1) {
      expect(first[i]?.[4]).toBe(first[i + 1]?.[1]);
    }
    expect(first[0]?.[1]).toBe(roundTo(rawPriceAt(PAIR.id, START), PAIR.digits));
  });

  it('keeps low <= min(open, close) <= max(open, close) <= high, rounded to the pair digits', () => {
    const candles = buildCandles(PAIR, 5_000, START, 2_000, START + 2_000 * 5_000);
    expect(candles).toHaveLength(2_000);
    let higher = 0;
    let lower = 0;
    for (const [, open, high, low, close] of candles) {
      expect(low).toBeLessThanOrEqual(Math.min(open, close));
      expect(high).toBeGreaterThanOrEqual(Math.max(open, close));
      if (high > Math.max(open, close)) higher += 1;
      if (low < Math.min(open, close)) lower += 1;
      for (const price of [open, high, low, close]) {
        expect(String(price).split('.')[1]?.length ?? 0).toBeLessThanOrEqual(PAIR.digits);
        expect(price).toBeGreaterThan(0);
      }
    }
    // the wicks are not degenerate: both bounds do extend past the body
    expect(higher).toBeGreaterThan(0);
    expect(lower).toBeGreaterThan(0);
  });

  it('produces candles the shared contract parses', () => {
    expect(safeParseCandles(buildCandles(PAIR, step, START, 10, now)).success).toBe(true);
  });
});
