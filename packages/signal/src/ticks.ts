import type { Candle } from '@binarius/shared';
import { assertDigits } from './decide';

// Candles from the broker's price.update ticks (#392, docs/broker-socket.md -> The candle spike).
// The rules come from the chart probe of 2026-10-09: the series is continuous (open of a candle =
// close of the one before it) and every price is compared at the pair's `digits`, so the broker's
// float artifacts (0.6946199999999999) are rounded away here. #404 consumes this builder as is.

export interface Tick {
  price: number;
  timestamp: number;
}

export interface CandleBuilderOptions {
  intervalMs: number;
  digits: number;
  // the most candles kept; the oldest go first
  capacity: number;
}

export interface CandleBuilder {
  push(tick: Tick): void;
  // ascending, a copy
  candles(): Candle[];
  // the timestamp of the newest tick that was neither late nor invalid
  readonly watermark: number | undefined;
  // drops every candle whose span [timestamp, timestamp + intervalMs) overlaps [fromMs, toMs], and
  // builds none for a bucket it reaches; finite, fromMs <= toMs
  markHole(fromMs: number, toMs: number): void;
  // ticks of a bucket older than the current one, dropped
  readonly late: number;
  // ticks of a bucket a marked hole reaches: no candle
  readonly holed: number;
  // ticks with a non-finite or non-positive price or a non-finite timestamp, dropped
  readonly invalid: number;
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`candle builder: ${name} must be a positive integer, got ${value}`);
  }
}

export function createCandleBuilder(options: CandleBuilderOptions): CandleBuilder {
  const { intervalMs, digits, capacity } = options;
  assertPositiveInteger('intervalMs', intervalMs);
  assertPositiveInteger('capacity', capacity);
  assertDigits(digits);
  const round = (value: number) => Number(value.toFixed(digits));

  const stored: Candle[] = [];
  let currentBucket: number | undefined;
  // survives markHole: the next candle still opens at the last close the broker's series had
  let lastClose: number | undefined;
  let watermark: number | undefined;
  // the first bucket no marked hole reaches
  let holeUntil = Number.NEGATIVE_INFINITY;
  let late = 0;
  let holed = 0;
  let invalid = 0;

  return {
    push({ price, timestamp }) {
      if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(timestamp)) {
        invalid += 1;
        return;
      }
      const bucket = Math.floor(timestamp / intervalMs) * intervalMs;
      if (currentBucket !== undefined && bucket < currentBucket) {
        late += 1;
        return;
      }
      const value = round(price);
      // an older tick inside the current bucket: close stays with the newest one
      const newest = watermark === undefined || timestamp >= watermark;
      const current = stored.at(-1);
      if (bucket < holeUntil) {
        holed += 1;
      } else if (current !== undefined && current.timestamp === bucket) {
        current.high = Math.max(current.high, value);
        current.low = Math.min(current.low, value);
        if (newest) current.close = value;
      } else {
        const open = lastClose ?? value;
        stored.push({
          timestamp: bucket,
          open,
          high: Math.max(open, value),
          low: Math.min(open, value),
          close: value,
        });
        if (stored.length > capacity) stored.splice(0, stored.length - capacity);
      }
      currentBucket = bucket;
      if (newest) {
        lastClose = value;
        watermark = timestamp;
      }
    },
    candles: () => stored.map((candle) => ({ ...candle })),
    get watermark() {
      return watermark;
    },
    markHole(fromMs, toMs) {
      if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs) {
        throw new RangeError('candle builder: a hole must be finite with fromMs <= toMs');
      }
      const kept = stored.filter(
        (candle) => !(candle.timestamp <= toMs && candle.timestamp + intervalMs > fromMs),
      );
      stored.splice(0, stored.length, ...kept);
      holeUntil = Math.max(holeUntil, Math.floor(toMs / intervalMs) * intervalMs + intervalMs);
    },
    get late() {
      return late;
    },
    get holed() {
      return holed;
    },
    get invalid() {
      return invalid;
    },
  };
}

// Groups end-labelled rows (the broker's `1s` row labelled s covers (s - stepMs, s]) into candles
// of intervalMs labelled by their start: the row labelled t + stepMs is the first of the candle at
// t. Only complete buckets (intervalMs / stepMs rows) become candles. Rows ascending.
export function aggregateEndLabelled(
  rows: readonly Candle[],
  stepMs: number,
  intervalMs: number,
): Candle[] {
  assertPositiveInteger('stepMs', stepMs);
  assertPositiveInteger('intervalMs', intervalMs);
  if (intervalMs % stepMs !== 0) {
    throw new RangeError(
      `candle aggregation: intervalMs ${intervalMs} is not a multiple of ${stepMs}`,
    );
  }
  const perBucket = intervalMs / stepMs;
  const buckets = new Map<number, Candle[]>();
  for (const row of rows) {
    const bucket = Math.floor((row.timestamp - stepMs) / intervalMs) * intervalMs;
    const members = buckets.get(bucket) ?? [];
    members.push(row);
    buckets.set(bucket, members);
  }
  return [...buckets.entries()]
    .filter(([, members]) => members.length === perBucket)
    .sort(([a], [b]) => a - b)
    .map(([timestamp, members]) => ({
      timestamp,
      open: members[0].open,
      high: Math.max(...members.map((row) => row.high)),
      low: Math.min(...members.map((row) => row.low)),
      close: members[members.length - 1].close,
    }));
}
