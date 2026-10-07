import { SIGNAL_CHART_INTERVAL_MS, SIGNAL_INTERVALS, type SignalParams } from '@binarius/shared';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SIGNAL_PARAMS } from './config';
import { assertFeedLimit, SIGNAL_CHART_LIMIT } from './feed-config';

const withParams = (patch: Partial<SignalParams>): SignalParams => ({
  ...DEFAULT_SIGNAL_PARAMS,
  ...patch,
});

const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000 } as const;

describe('signal feed config', () => {
  it('K1 every interval is its label in milliseconds', () => {
    expect(SIGNAL_INTERVALS).toEqual(['5s', '15s', '1m', '5m', '15m', '30m', '1h']);
    for (const label of SIGNAL_INTERVALS) {
      const match = /^(\d+)(s|m|h)$/.exec(label);
      if (match === null) throw new Error(`unexpected label ${label}`);
      const [, count, unit] = match as unknown as [string, string, keyof typeof UNIT_MS];
      expect(SIGNAL_CHART_INTERVAL_MS[label], label).toBe(Number(count) * UNIT_MS[unit]);
    }
  });

  it('K2 the limit leaves minClosedCandles closed candles after the forming one and maxStaleIntervals late ones', () => {
    const { maxStaleIntervals, minClosedCandles } = DEFAULT_SIGNAL_PARAMS;
    expect(SIGNAL_CHART_LIMIT - 1 - maxStaleIntervals).toBeGreaterThanOrEqual(minClosedCandles);
    expect(() => assertFeedLimit(SIGNAL_CHART_LIMIT, DEFAULT_SIGNAL_PARAMS)).not.toThrow();

    const atBoundary = SIGNAL_CHART_LIMIT - 1 - maxStaleIntervals;
    expect(() =>
      assertFeedLimit(SIGNAL_CHART_LIMIT, withParams({ minClosedCandles: atBoundary })),
    ).not.toThrow();
    expect(() =>
      assertFeedLimit(SIGNAL_CHART_LIMIT, withParams({ minClosedCandles: atBoundary + 1 })),
    ).toThrow(
      new RangeError(
        `signal feed: chart limit must be an integer >= 1 + maxStaleIntervals (${maxStaleIntervals}) + minClosedCandles (${atBoundary + 1}) = ${SIGNAL_CHART_LIMIT + 1}, got ${SIGNAL_CHART_LIMIT}`,
      ),
    );

    const staleBoundary = SIGNAL_CHART_LIMIT - 1 - minClosedCandles;
    expect(() =>
      assertFeedLimit(SIGNAL_CHART_LIMIT, withParams({ maxStaleIntervals: staleBoundary })),
    ).not.toThrow();
    expect(() =>
      assertFeedLimit(SIGNAL_CHART_LIMIT, withParams({ maxStaleIntervals: staleBoundary + 1 })),
    ).toThrow(RangeError);
  });

  it('K3 a non-integer limit throws', () => {
    expect(() => assertFeedLimit(SIGNAL_CHART_LIMIT - 0.5, DEFAULT_SIGNAL_PARAMS)).toThrow(
      RangeError,
    );
  });
});
