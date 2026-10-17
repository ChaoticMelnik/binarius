import { SIGNAL_SCAN_INTERVALS, type ScanInterval, type SignalInterval } from '@binarius/shared';
import type { SignalCandleSource } from '@binarius/signal';
import type { CandleRing } from './ring';

// The candle source over the data socket (#404, docs/market-data.md): the signal feed reads it
// through createCandleSource (#405), and the REST backfill (#590, backfill.ts) reads pending().

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

const ringInterval = (interval: SignalInterval): interval is ScanInterval =>
  (SIGNAL_SCAN_INTERVALS as readonly SignalInterval[]).includes(interval);

// The port of packages/signal over the ring and the refill set: a window only while the active
// socket is ready and only for the intervals the ring builds; anything else reads REST.
export function createCandleSource(deps: {
  ring: Pick<CandleRing, 'read'>;
  requests: Pick<PendingRequests, 'add'>;
  // the manager's streaming(): the active socket is ready
  streaming: () => boolean;
}): SignalCandleSource {
  const { ring, requests, streaming } = deps;
  return {
    read: (assetId, interval, nowMs) =>
      streaming() && ringInterval(interval) ? ring.read(assetId, interval, nowMs) : undefined,
    // a full set refuses only a new key, and the keys are at most the catalog's pairs x 2
    request: (assetId, interval) => {
      if (ringInterval(interval)) requests.add(assetId, interval);
    },
  };
}
