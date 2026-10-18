// The one pacer of the signal chart GETs (docs/signal.md -> The budget, #405): perMinute tokens,
// capacity at most (signalRestCapacity in timing.ts). tryTake is an on-demand GET of the feed when
// the source has no window (no BROKER_WS_URL, no ready socket, or an interval the ring does not
// build); tryTakeSpare is the candle backfill's (docs/market-data.md -> Backfill): only the
// overflow, what refill discards above capacity, held to one token. On a clock that does not go
// back no answer of tryTake depends on tryTakeSpare, and a 60 s window carries at most
// perMinute + capacity + 1 of both together.
// A rate_limited answer pauses both: for Retry-After held to [backoffMinMs, backoffMaxMs] when the
// broker sent one, otherwise for a backoff that doubles from backoffMinMs to backoffMaxMs and
// resets on the next decided answer. The calls in flight answer one 429 burst together, so a 429
// without Retry-After during a pause is the same episode: it neither doubles nor extends it.

export interface ScanPacerOptions {
  perMinute: number;
  capacity: number;
  backoffMinMs: number;
  backoffMaxMs: number;
  now: () => number;
}

export interface ScanPacer {
  // one GET's worth now, or false: paused, or the bucket is empty
  tryTake(): boolean;
  // a token from the overflow only: what refill() discarded above capacity; never the bucket's own
  tryTakeSpare(): boolean;
  // the ms this answer added to the pause
  onRateLimited(retryAfterSec: number | undefined): number;
  // any answered 2xx resets the backoff; the backfill calls it too
  onDecided(): void;
  // the end of the current pause, or undefined when not paused
  pausedUntil(): number | undefined;
}

export function createScanPacer(options: ScanPacerOptions): ScanPacer {
  const { perMinute, capacity, backoffMinMs, backoffMaxMs, now } = options;
  if (!(perMinute > 0 && capacity >= 1 && backoffMinMs > 0 && backoffMinMs <= backoffMaxMs)) {
    throw new RangeError('scan pacer: perMinute > 0, capacity >= 1 and 0 < min <= max backoff');
  }
  let tokens = capacity;
  let overflow = 0;
  let refilledAt = now();
  let pauseEnd: number | undefined;
  let backoffs = 0;

  function refill(at: number): void {
    const raw = tokens + ((at - refilledAt) * perMinute) / 60_000;
    overflow = Math.min(1, overflow + Math.max(0, raw - capacity));
    tokens = Math.min(capacity, raw);
    refilledAt = at;
  }

  function paused(at: number): boolean {
    if (pauseEnd !== undefined && at >= pauseEnd) pauseEnd = undefined;
    return pauseEnd !== undefined;
  }

  return {
    tryTake() {
      const at = now();
      refill(at);
      if (paused(at) || tokens < 1) return false;
      tokens -= 1;
      return true;
    },
    tryTakeSpare() {
      const at = now();
      refill(at);
      if (paused(at) || overflow < 1) return false;
      overflow -= 1;
      return true;
    },
    onRateLimited(retryAfterSec) {
      const at = now();
      const before = paused(at) && pauseEnd !== undefined ? pauseEnd : at;
      let pauseMs: number;
      if (retryAfterSec !== undefined) {
        pauseMs = Math.min(backoffMaxMs, Math.max(backoffMinMs, retryAfterSec * 1000));
      } else if (before > at) {
        return 0;
      } else {
        pauseMs = Math.min(backoffMaxMs, backoffMinMs * 2 ** backoffs);
        backoffs += 1;
      }
      pauseEnd = Math.max(before, at + pauseMs);
      return pauseEnd - before;
    },
    onDecided() {
      backoffs = 0;
    },
    pausedUntil() {
      return paused(now()) ? pauseEnd : undefined;
    },
  };
}

export type SpareTokenSource = Pick<ScanPacer, 'tryTakeSpare' | 'onRateLimited' | 'onDecided'>;
