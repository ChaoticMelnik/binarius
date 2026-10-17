import type { Candle, ScanInterval } from '@binarius/shared';

// The candle source over the data socket (#404, docs/market-data.md). No consumer yet: the feed
// moves onto it in #405, and the REST refill that reads pending() is #590.

export interface CandleWindow {
  // closed candles of the window, ascending: tick-built, or REST rows fill() put into empty buckets
  candles: Candle[];
  // the bucket still forming by the ring's rule, when the pair has one
  forming?: Candle;
  // buckets ending at or before this are closed (docs/market-data.md -> Closing a candle)
  closedUntil: number;
  // the first bucket of the window: chartWindow(nowMs, interval, capacity).startTime
  startTime: number;
  // the closed buckets of the window that have no candle, ascending
  gaps: number[];
}

export interface CandleSource {
  read(assetId: number, interval: ScanInterval, nowMs: number): CandleWindow;
  // asks for a refill of the pair's window; remembered until #590's pending() takes it
  request(assetId: number, interval: ScanInterval): { queued: boolean };
}

export interface PendingRequest {
  assetId: number;
  interval: ScanInterval;
}

export interface PendingRequests {
  // false when the set is full and the request is not in it already
  add(assetId: number, interval: ScanInterval): boolean;
  // in insertion order; the set is empty afterwards
  pending(): PendingRequest[];
  readonly size: number;
}

export function createPendingRequests(max: number): PendingRequests {
  if (!Number.isInteger(max) || max <= 0) {
    throw new RangeError(`pending requests: max must be a positive integer, got ${max}`);
  }
  const requests = new Map<string, PendingRequest>();
  return {
    add(assetId, interval) {
      const key = `${assetId}:${interval}`;
      if (requests.has(key)) return true;
      if (requests.size >= max) return false;
      requests.set(key, { assetId, interval });
      return true;
    },
    pending() {
      const taken = [...requests.values()];
      requests.clear();
      return taken;
    },
    get size() {
      return requests.size;
    },
  };
}

export function createCandleSource(deps: {
  read: CandleSource['read'];
  requests: PendingRequests;
}): CandleSource {
  return {
    read: deps.read,
    request: (assetId, interval) => ({ queued: deps.requests.add(assetId, interval) }),
  };
}
