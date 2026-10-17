import { SIGNAL_CHART_INTERVAL_MS, type Candle, type ScanInterval } from '@binarius/shared';
import {
  chartWindow,
  createCandleBuilder,
  tickProblem,
  type CandleBuilder,
  type Tick,
} from '@binarius/signal';
import type { CandleWindow } from './source';

// The candles of the data socket (#404, docs/market-data.md -> The ring): one #392 builder per
// (pair, interval), created on the pair's first tick. Two rules sit on top of the builders.
// Closing: a bucket b of interval I is closed once the watermark W (the newest tick time on the
// active socket, any pair) reaches b + I, or once the process clock reaches b + I + skewMarginMs.
// Holes: when the active socket leaves `ready`, each pair keeps its own watermark; its first tick
// past it, from whichever socket comes next, marks [watermark, tick] a hole on both builders.

export interface CandleRingOptions {
  capacity: number;
  skewMarginMs: number;
  intervals: readonly ScanInterval[];
}

export interface CandleRingCounters {
  // per tick, before any builder
  invalid: number;
  skewed: number;
  // summed over the builders of every interval
  late: number;
  holed: number;
  // holes marked, one per pair per drop
  holes: number;
  // a tick that changed a candle the ring already called closed, by the rule that closed it
  lateClose: { watermark: number; clock: number };
  pairs: number;
}

export interface CandleRing {
  // digits: the pair's, from the catalog; a pair keeps the digits of its first tick
  push(assetId: number, digits: number, tick: Tick, receivedAtMs: number): void;
  // the active socket left `ready`
  onDrop(): void;
  read(assetId: number, interval: ScanInterval, nowMs: number): CandleWindow;
  // REST rows into closed buckets of the window that neither the builder nor an earlier fill has;
  // a tick-built candle is never replaced
  fill(
    assetId: number,
    interval: ScanInterval,
    rows: readonly Candle[],
    nowMs: number,
  ): { filled: number; skipped: number };
  // the empty closed buckets of the window
  missing(assetId: number, interval: ScanInterval, nowMs: number): number;
  closedUntil(interval: ScanInterval, nowMs: number): number;
  // tick-built candles whose bucket ends in (afterMs, upToMs]
  closedBetween(interval: ScanInterval, afterMs: number, upToMs: number): number;
  readonly watermark: number | undefined;
  counters(): CandleRingCounters;
}

interface PairState {
  builders: Map<ScanInterval, CandleBuilder>;
  filled: Map<ScanInterval, Map<number, Candle>>;
  holePending: boolean;
  // the pair's watermark when the socket dropped; undefined: no tick before the drop
  dropWatermark: number | undefined;
}

const floorTo = (value: number, step: number) => Math.floor(value / step) * step;

export function createCandleRing(options: CandleRingOptions): CandleRing {
  const { capacity, skewMarginMs, intervals } = options;
  if (!Number.isInteger(capacity) || capacity <= 0) {
    throw new RangeError(`candle ring: capacity must be a positive integer, got ${capacity}`);
  }
  if (!Number.isFinite(skewMarginMs) || skewMarginMs < 0) {
    throw new RangeError(`candle ring: skewMarginMs must be finite and >= 0, got ${skewMarginMs}`);
  }
  const pairs = new Map<number, PairState>();
  let watermark: number | undefined;
  let drops = 0;
  let invalid = 0;
  let skewed = 0;
  let holes = 0;
  const lateClose = { watermark: 0, clock: 0 };

  const ruleBounds = (intervalMs: number, nowMs: number) => ({
    byWatermark: watermark === undefined ? -Infinity : floorTo(watermark, intervalMs),
    byClock: floorTo(nowMs - skewMarginMs, intervalMs),
  });

  function closedUntil(interval: ScanInterval, nowMs: number): number {
    const { byWatermark, byClock } = ruleBounds(SIGNAL_CHART_INTERVAL_MS[interval], nowMs);
    return Math.max(byWatermark, byClock);
  }

  function pairOf(assetId: number): PairState {
    let pair = pairs.get(assetId);
    if (pair === undefined) {
      // a pair first heard after a drop may have lost the start of its first bucket
      pair = {
        builders: new Map(),
        filled: new Map(),
        holePending: drops > 0,
        dropWatermark: undefined,
      };
      pairs.set(assetId, pair);
    }
    return pair;
  }

  function window(assetId: number, interval: ScanInterval, nowMs: number) {
    const intervalMs = SIGNAL_CHART_INTERVAL_MS[interval];
    const { startTime } = chartWindow(nowMs, intervalMs, capacity);
    const boundary = floorTo(nowMs, intervalMs);
    const closed = closedUntil(interval, nowMs);
    const pair = pairs.get(assetId);
    const built = pair?.builders.get(interval)?.candles() ?? [];
    const inWindow = (timestamp: number) => startTime <= timestamp && timestamp <= boundary;
    const isClosed = (timestamp: number) => timestamp + intervalMs <= closed;
    return { intervalMs, startTime, boundary, closed, pair, built, inWindow, isClosed };
  }

  function read(assetId: number, interval: ScanInterval, nowMs: number): CandleWindow {
    const w = window(assetId, interval, nowMs);
    const candles = new Map<number, Candle>();
    for (const row of w.pair?.filled.get(interval)?.values() ?? []) {
      if (w.inWindow(row.timestamp) && w.isClosed(row.timestamp)) {
        candles.set(row.timestamp, { ...row });
      }
    }
    let forming: Candle | undefined;
    for (const candle of w.built) {
      if (!w.inWindow(candle.timestamp)) continue;
      if (w.isClosed(candle.timestamp)) candles.set(candle.timestamp, candle);
      else forming = candle;
    }
    const gaps: number[] = [];
    for (
      let bucket = w.startTime;
      bucket <= w.boundary && w.isClosed(bucket);
      bucket += w.intervalMs
    ) {
      if (!candles.has(bucket)) gaps.push(bucket);
    }
    return {
      candles: [...candles.values()].sort((a, b) => a.timestamp - b.timestamp),
      ...(forming === undefined ? {} : { forming }),
      closedUntil: w.closed,
      startTime: w.startTime,
      gaps,
    };
  }

  return {
    push(assetId, digits, tick, receivedAtMs) {
      const problem = tickProblem(tick, receivedAtMs);
      if (problem === 'invalid') invalid += 1;
      if (problem === 'skewed') skewed += 1;
      if (problem !== undefined) return;
      const pair = pairOf(assetId);
      if (pair.builders.size === 0) {
        for (const interval of intervals) {
          const intervalMs = SIGNAL_CHART_INTERVAL_MS[interval];
          pair.builders.set(interval, createCandleBuilder({ intervalMs, digits, capacity }));
        }
      }
      const { timestamp } = tick;
      if (
        pair.holePending &&
        (pair.dropWatermark === undefined || timestamp > pair.dropWatermark)
      ) {
        for (const builder of pair.builders.values()) {
          builder.markHole(pair.dropWatermark ?? timestamp, timestamp);
        }
        pair.holePending = false;
        pair.dropWatermark = undefined;
        holes += 1;
      }
      for (const [interval, builder] of pair.builders) {
        const intervalMs = SIGNAL_CHART_INTERVAL_MS[interval];
        // both rules as they stood when the tick arrived: the watermark before this tick
        const { byWatermark, byClock } = ruleBounds(intervalMs, receivedAtMs);
        const { late, holed } = builder;
        builder.push(tick, receivedAtMs);
        if (builder.late !== late || builder.holed !== holed) continue;
        const end = floorTo(timestamp, intervalMs) + intervalMs;
        if (end <= byWatermark) lateClose.watermark += 1;
        else if (end <= byClock) lateClose.clock += 1;
      }
      if (watermark === undefined || timestamp > watermark) watermark = timestamp;
    },
    onDrop() {
      drops += 1;
      for (const pair of pairs.values()) {
        // a second drop before the pair's next tick keeps the first one's mark: one hole
        if (pair.holePending) continue;
        pair.holePending = true;
        pair.dropWatermark = pair.builders.values().next().value?.watermark;
      }
    },
    read,
    fill(assetId, interval, rows, nowMs) {
      const w = window(assetId, interval, nowMs);
      const pair = pairOf(assetId);
      let filled = pair.filled.get(interval);
      if (filled === undefined) {
        filled = new Map();
        pair.filled.set(interval, filled);
      }
      for (const timestamp of filled.keys()) {
        if (timestamp < w.startTime) filled.delete(timestamp);
      }
      const built = new Set(w.built.map((candle) => candle.timestamp));
      let added = 0;
      let skipped = 0;
      for (const row of rows) {
        const { timestamp } = row;
        if (
          timestamp % w.intervalMs === 0 &&
          w.inWindow(timestamp) &&
          w.isClosed(timestamp) &&
          !built.has(timestamp) &&
          !filled.has(timestamp)
        ) {
          filled.set(timestamp, { ...row });
          added += 1;
        } else {
          skipped += 1;
        }
      }
      return { filled: added, skipped };
    },
    missing: (assetId, interval, nowMs) => read(assetId, interval, nowMs).gaps.length,
    closedUntil,
    closedBetween(interval, afterMs, upToMs) {
      const intervalMs = SIGNAL_CHART_INTERVAL_MS[interval];
      let count = 0;
      for (const pair of pairs.values()) {
        for (const candle of pair.builders.get(interval)?.candles() ?? []) {
          const end = candle.timestamp + intervalMs;
          if (afterMs < end && end <= upToMs) count += 1;
        }
      }
      return count;
    },
    get watermark() {
      return watermark;
    },
    counters() {
      let late = 0;
      let holed = 0;
      for (const pair of pairs.values()) {
        for (const builder of pair.builders.values()) {
          late += builder.late;
          holed += builder.holed;
        }
      }
      return {
        invalid,
        skewed,
        late,
        holed,
        holes,
        lateClose: { ...lateClose },
        pairs: [...pairs.values()].filter((pair) => pair.builders.size > 0).length,
      };
    },
  };
}
