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

// 45 sideways closes around 100, then `moves` steps of a run: the session shapes of #379
function runAfterSideways(moves: number, step: (i: number) => number): number[] {
  const closes = [100];
  for (let i = 1; i < 45; i++) closes.push(closes[i - 1] + (i % 2 ? 0.03 : -0.03));
  for (let i = 0; i < moves; i++) closes.push(closes[closes.length - 1] + step(i));
  return closes.map((close) => Number(close.toFixed(2)));
}

// d9c92776: a sharp rise, every third move a small pullback; v1 signals up at RSI ~70
export const burst = (moves = 15, options?: SeriesOptions): Candle[] =>
  seriesFrom(
    runAfterSideways(moves, (i) => (i % 3 === 2 ? -0.05 : 0.08)),
    { wick: 0.02, ...options },
  );

// the mirror: a sharp fall, RSI ~28
export const fall = (moves = 15, options?: SeriesOptions): Candle[] =>
  seriesFrom(
    runAfterSideways(moves, (i) => (i % 3 === 2 ? 0.06 : -0.1)),
    { wick: 0.02, ...options },
  );

// a rise that is not a rush: trend up, RSI ~60
export const mildRise = (moves = 15, options?: SeriesOptions): Candle[] =>
  seriesFrom(
    runAfterSideways(moves, (i) => (i % 2 ? -0.04 : 0.06)),
    { wick: 0.02, ...options },
  );

export const mildFall = (moves = 15, options?: SeriesOptions): Candle[] =>
  seriesFrom(
    runAfterSideways(moves, (i) => (i % 2 ? 0.04 : -0.06)),
    { wick: 0.02, ...options },
  );

// 2e25e081: a pair near 0.0124 whose every move is a single quote step (10^-digits); the
// pattern drifts up, with flat and falling steps between
const ONE_STEP_DRIFT = [1, 1, 0, 1, -1, 1, 1, 0, 1, 1, -1, 1, 0, 1, 1, 1, -1, 1, 1, 0];

export interface TickSeriesOptions {
  // the wick beyond the body, in quote steps
  wickTicks?: number;
  // the close's move per candle, in quote steps, cycled
  pattern?: readonly number[];
  n?: number;
}

export function tickSeries(
  price: number,
  digits: number,
  { wickTicks = 0, pattern = ONE_STEP_DRIFT, n = 60 }: TickSeriesOptions = {},
): Candle[] {
  const step = 10 ** -digits;
  const closes = [price];
  for (let i = 1; i < n; i++) {
    closes.push(Number((closes[i - 1] + step * pattern[i % pattern.length]).toFixed(digits)));
  }
  return seriesFrom(closes, { wick: wickTicks * step }).map((candle) => ({
    ...candle,
    high: Number(candle.high.toFixed(digits)),
    low: Number(candle.low.toFixed(digits)),
  }));
}

// integer closes alternating by `range` around `from` without wicks: every true range is exactly
// `range`, so ATR is exact
export const integerSeries = (n: number, from: number, range: number): Candle[] =>
  seriesFrom(
    Array.from({ length: n }, (_, i) => from + (i % 2) * range),
    { wick: 0 },
  );

// every candle closed, nothing forming, the last one closed a second ago
export function closedNow(series: readonly Candle[], intervalMs = INTERVAL_MS): number {
  const last = series.at(-1);
  if (last === undefined) throw new RangeError('closedNow: empty series');
  return last.timestamp + intervalMs + 1000;
}
