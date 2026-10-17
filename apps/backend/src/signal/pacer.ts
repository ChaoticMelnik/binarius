// The signal scanner's share of the broker's per-IP window (docs/signal.md -> The scanner): a
// token bucket refilled at perMinute / 60 s and holding at most one candle's batch plus one spare
// token (signalScanCapacity in timing.ts), so a batch goes out right after the boundary even when
// the timer fires a few ms earlier than the candle before, and any 60 s window carries at most
// perMinute plus the capacity.
// A rate_limited answer pauses it: for Retry-After held to [backoffMinMs, backoffMaxMs] when the
// broker sent one, otherwise for a backoff that doubles from backoffMinMs to backoffMaxMs and
// resets on the next decided answer. The calls in flight answer one 429 burst together, so a 429
// without Retry-After during a pause is the same episode: it neither doubles nor extends it.
// The scanner takes tokens; the candle backfill (docs/market-data.md -> Backfill) takes only the
// overflow: what refill discards above capacity, held to one token, so no answer of tryTake depends
// on tryTakeSpare, and a 60 s window carries at most perMinute + capacity + 1 of both together.
// POST /trading/signal never waits for it.

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

// #590 only, while main has a pacer per scanner; #405 passes its single pacer and deletes this.
// A 429 is the IP window's answer, so it pauses every pacer.
export function joinSpare(pacers: readonly ScanPacer[]): SpareTokenSource {
  return {
    tryTakeSpare: () => pacers.some((pacer) => pacer.tryTakeSpare()),
    onRateLimited: (retryAfterSec) =>
      pacers.reduce((most, pacer) => Math.max(most, pacer.onRateLimited(retryAfterSec)), 0),
    onDecided: () => {
      for (const pacer of pacers) pacer.onDecided();
    },
  };
}
