import type { LastTick } from '@binarius/shared';
import { tickProblem, type Tick } from '@binarius/signal';
import { TRADE_TICKS_AHEAD_MS, TRADE_TICKS_BUFFER_MS, TRADE_TICKS_MAX_PER_PAIR } from '../timing';

// The data socket's ticks per pair (#666, #668; docs/market-data.md → The tick store): the active
// client's ticks, as the ring takes them. `last` answers a session's decision record; `between`
// answers the trade log keeper with a window and how much of it the store saw.

// complete: the store held every tick of the window it was given; uncovered: the window starts
// before the store's first tick or below the pair's pruning floor; hole: a socket drop overlaps it
export type TickCoverage = 'complete' | 'uncovered' | 'hole';

export interface TickWindow {
  ticks: LastTick[];
  coverage: TickCoverage;
}

export interface TickStoreCounters {
  pairs: number;
  held: number;
  // ticks more than aheadMs past their receipt: kept, the watermark clamped
  ahead: number;
  // ticks below a pair's floor, and ticks pushed out by the per-pair cap
  dropped: number;
  holes: number;
}

export interface TickStore {
  // receivedAtMs: the local clock when the tick arrived; a tick `tickProblem` refuses is dropped;
  // a tick ahead of its receipt is kept here and clamps the watermark, while the ring drops it
  // beyond its margin (#683)
  push(assetId: number, tick: Tick, receivedAtMs: number): void;
  // the newest tick by broker time, kept until a newer one, never cleared (a socket drop, a
  // failover, a quiet pair): a reader bounds its age itself
  last(assetId: number): LastTick | undefined;
  // the active socket left ready (beside ring.onDrop): every pair's next tick closes a hole
  onDrop(): void;
  // fromMs <= timestamp <= untilMs, ascending by (timestamp, receivedAtMs), with the coverage
  between(assetId: number, fromMs: number, untilMs: number): TickWindow;
  // the pair's newest broker time, clamped to receipt + aheadMs
  watermark(assetId: number): number | undefined;
  // running totals; the manager's line prints period deltas
  counters(): TickStoreCounters;
}

export interface TickStoreOptions {
  bufferMs?: number;
  maxPerPair?: number;
  aheadMs?: number;
}

interface PairWindow {
  // parallel, in arrival order from `head`; the front is compacted away as it is pruned
  timestamps: number[];
  receipts: number[];
  prices: number[];
  head: number;
  watermark: number;
  // ticks below it are gone or refused: a window starting below it is uncovered
  floorMs: number;
  holes: { from: number; to: number }[];
  holePending: boolean;
  dropWatermark: number | undefined;
}

export function createTickStore(options: TickStoreOptions = {}): TickStore {
  const bufferMs = options.bufferMs ?? TRADE_TICKS_BUFFER_MS;
  const maxPerPair = options.maxPerPair ?? TRADE_TICKS_MAX_PER_PAIR;
  const aheadMs = options.aheadMs ?? TRADE_TICKS_AHEAD_MS;
  const newest = new Map<number, LastTick>();
  const pairs = new Map<number, PairWindow>();
  // the first accepted tick of the process (clamped), any pair: nothing before it was seen
  let coveredSinceMs: number | undefined;
  const totals = { ahead: 0, dropped: 0, holes: 0 };

  const size = (pair: PairWindow) => pair.timestamps.length - pair.head;

  function shift(pair: PairWindow): number {
    const timestamp = pair.timestamps[pair.head]!;
    pair.head += 1;
    if (pair.head >= 1024 && pair.head * 2 >= pair.timestamps.length) {
      pair.timestamps.splice(0, pair.head);
      pair.receipts.splice(0, pair.head);
      pair.prices.splice(0, pair.head);
      pair.head = 0;
    }
    return timestamp;
  }

  function prune(pair: PairWindow): void {
    const floor = pair.watermark - bufferMs;
    if (floor > pair.floorMs) pair.floorMs = floor;
    while (size(pair) > 0 && pair.timestamps[pair.head]! < pair.floorMs) shift(pair);
    while (size(pair) > maxPerPair) {
      const removed = shift(pair);
      totals.dropped += 1;
      // the removed tick's broker time is no longer whole either
      pair.floorMs = Math.max(pair.floorMs, removed + 1);
    }
    if (pair.holes.length > 0) pair.holes = pair.holes.filter((hole) => hole.to >= pair.floorMs);
  }

  return {
    push(assetId, tick, receivedAtMs) {
      if (tickProblem(tick, receivedAtMs) !== undefined) return;
      const held = newest.get(assetId);
      if (held === undefined || tick.timestamp >= held.timestamp) {
        newest.set(assetId, { price: tick.price, timestamp: tick.timestamp, receivedAtMs });
      }
      // a tick stamped in the future is real data, but moving the watermark to it would close
      // windows early and prune the buffer early
      const bound = receivedAtMs + aheadMs;
      if (tick.timestamp > bound) totals.ahead += 1;
      const clamped = Math.min(tick.timestamp, bound);
      let pair = pairs.get(assetId);
      if (pair === undefined) {
        pair = {
          timestamps: [],
          receipts: [],
          prices: [],
          head: 0,
          watermark: clamped,
          floorMs: -Infinity,
          holes: [],
          holePending: false,
          dropWatermark: undefined,
        };
        pairs.set(assetId, pair);
      } else if (tick.timestamp < pair.floorMs) {
        totals.dropped += 1;
        return;
      }
      coveredSinceMs ??= clamped;
      if (
        pair.holePending &&
        (pair.dropWatermark === undefined || tick.timestamp > pair.dropWatermark)
      ) {
        pair.holes.push({ from: pair.dropWatermark ?? tick.timestamp, to: tick.timestamp });
        pair.holePending = false;
        pair.dropWatermark = undefined;
        totals.holes += 1;
      }
      pair.timestamps.push(tick.timestamp);
      pair.receipts.push(receivedAtMs);
      pair.prices.push(tick.price);
      if (clamped > pair.watermark) pair.watermark = clamped;
      prune(pair);
    },
    last: (assetId) => newest.get(assetId),
    onDrop() {
      for (const pair of pairs.values()) {
        if (pair.holePending) continue;
        pair.holePending = true;
        pair.dropWatermark = pair.watermark;
      }
    },
    between(assetId, fromMs, untilMs) {
      const pair = pairs.get(assetId);
      const ticks: LastTick[] = [];
      if (pair !== undefined) {
        for (let i = pair.head; i < pair.timestamps.length; i += 1) {
          const timestamp = pair.timestamps[i]!;
          if (timestamp >= fromMs && timestamp <= untilMs) {
            ticks.push({ price: pair.prices[i]!, timestamp, receivedAtMs: pair.receipts[i]! });
          }
        }
        ticks.sort((a, b) => a.timestamp - b.timestamp || a.receivedAtMs - b.receivedAtMs);
      }
      let coverage: TickCoverage = 'complete';
      if (
        coveredSinceMs === undefined ||
        fromMs < coveredSinceMs ||
        (pair !== undefined && fromMs < pair.floorMs)
      ) {
        coverage = 'uncovered';
      } else if (
        pair !== undefined &&
        (pair.holes.some((hole) => hole.from <= untilMs && hole.to >= fromMs) ||
          (pair.holePending && (pair.dropWatermark === undefined || pair.dropWatermark <= untilMs)))
      ) {
        coverage = 'hole';
      }
      return { ticks, coverage };
    },
    watermark: (assetId) => pairs.get(assetId)?.watermark,
    counters() {
      let held = 0;
      for (const pair of pairs.values()) held += size(pair);
      return { pairs: pairs.size, held, ...totals };
    },
  };
}
