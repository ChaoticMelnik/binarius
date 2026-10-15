// Test-only fixtures for the stand's suites, imported by no runtime module.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Candle } from '@binarius/shared';
import { appendRows, seriesPath, writePairs, type PairSnapshot } from './cache';

export const T0 = Date.UTC(2026, 9, 12, 12, 0, 0);

export const tempDir = (): string => mkdtempSync(path.join(tmpdir(), 'signal-stand-'));
export const quiet = (): void => undefined;

// A 1s series from one price path: open = the previous close (the broker's convention), the
// wick one tenth of a step either side. The path is deterministic: a slow sine plus a fast one.
export function secondsPath(
  start: number,
  n: number,
  price = (i: number) => 1 + 0.002 * Math.sin(i / 97) + 0.0004 * Math.sin(i / 7),
): Candle[] {
  const candles: Candle[] = [];
  let previous = Number(price(0).toFixed(5));
  for (let i = 0; i < n; i++) {
    const close = Number(price(i).toFixed(5));
    candles.push({
      timestamp: start + i * 1_000,
      open: previous,
      high: Math.max(previous, close) + 0.00001,
      low: Math.min(previous, close) - 0.00001,
      close,
    });
    previous = close;
  }
  return candles;
}

// the candles of `stepMs` built from the 1s rows inside each step
export function aggregate(seconds: readonly Candle[], stepMs: number): Candle[] {
  const out: Candle[] = [];
  for (const row of seconds) {
    const timestamp = Math.floor(row.timestamp / stepMs) * stepMs;
    const last = out.at(-1);
    if (last?.timestamp === timestamp) {
      last.high = Math.max(last.high, row.high);
      last.low = Math.min(last.low, row.low);
      last.close = row.close;
    } else {
      out.push({ ...row, timestamp });
    }
  }
  return out;
}

export const PAIR: PairSnapshot = {
  id: 1605169136,
  symbol: 'EUR/USD',
  type: 'currency',
  digits: 5,
  payout: 90,
  minTimeframe: 5,
  fetchedAt: T0,
};

// a cache directory holding one pair's 1s path and its 5s/15s/1m aggregates
export function cacheWith(
  seconds: readonly Candle[],
  pair: PairSnapshot = PAIR,
  dir = tempDir(),
): string {
  writePairs(dir, [pair]);
  appendRows(seriesPath(dir, pair.id, '1s'), seconds, quiet);
  for (const [interval, stepMs] of [
    ['5s', 5_000],
    ['15s', 15_000],
    ['1m', 60_000],
  ] as const) {
    appendRows(seriesPath(dir, pair.id, interval), aggregate(seconds, stepMs), quiet);
  }
  return dir;
}
