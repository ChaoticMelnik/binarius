// Test-only fixtures for the signal suites. Compiled by `tsc -b` alongside the *.test.ts files
// next to it and imported by no runtime module.

import type { Candle } from '@binarius/shared';

export const INTERVAL_MS = 60_000;
export const START_MS = 1_760_000_000_000;

export interface SeriesOptions {
  start?: number;
  intervalMs?: number;
  wick?: number;
}

// open = previous close (the first open = its close), high/low = max/min(open, close) ± wick;
// every candle passes prepareCandles' checks by construction, so a test breaks one on purpose
export function seriesFrom(closes: readonly number[], options: SeriesOptions = {}): Candle[] {
  const { start = START_MS, intervalMs = INTERVAL_MS, wick = 0.1 } = options;
  return closes.map((close, i) => {
    const open = i === 0 ? close : closes[i - 1];
    return {
      timestamp: start + i * intervalMs,
      open,
      high: Math.max(open, close) + wick,
      low: Math.min(open, close) - wick,
      close,
    };
  });
}

export function trending(n: number, step: number, from = 100, options?: SeriesOptions): Candle[] {
  return seriesFrom(
    Array.from({ length: n }, (_, i) => from + step * i),
    options,
  );
}

export function sine(
  n: number,
  amplitude: number,
  period: number,
  phase: number,
  options?: SeriesOptions,
): Candle[] {
  return seriesFrom(
    Array.from(
      { length: n },
      (_, i) => 100 + amplitude * Math.sin((2 * Math.PI * (i + phase)) / period),
    ),
    options,
  );
}

// every candle closed, nothing forming, the last one closed a second ago
export function closedNow(series: readonly Candle[], intervalMs = INTERVAL_MS): number {
  const last = series.at(-1);
  if (last === undefined) throw new RangeError('closedNow: empty series');
  return last.timestamp + intervalMs + 1000;
}
