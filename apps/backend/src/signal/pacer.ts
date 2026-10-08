// The signal scanner's share of the broker's per-IP window (docs/signal.md -> The scanner): a
// token bucket refilled at perMinute / 60 s and holding at most one candle's batch, so a batch
// goes out right after the boundary and any 60 s window carries at most perMinute plus one batch.
// A rate_limited answer pauses it: for Retry-After when the broker sent one, otherwise for a
// backoff that doubles from backoffMinMs to backoffMaxMs and resets on the next decided answer.
// Only the scanner takes tokens; POST /trading/signal never waits for it.

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
  onRateLimited(retryAfterSec: number | undefined): void;
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
  let refilledAt = now();
  let pauseEnd: number | undefined;
  let backoffs = 0;

  function refill(at: number): void {
    tokens = Math.min(capacity, tokens + ((at - refilledAt) * perMinute) / 60_000);
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
    onRateLimited(retryAfterSec) {
      const at = now();
      let pauseMs: number;
      if (retryAfterSec === undefined) {
        pauseMs = Math.min(backoffMaxMs, backoffMinMs * 2 ** backoffs);
        backoffs += 1;
      } else {
        pauseMs = retryAfterSec * 1000;
      }
      pauseEnd = Math.max(pauseEnd ?? at, at + pauseMs);
    },
    onDecided() {
      backoffs = 0;
    },
    pausedUntil() {
      return paused(now()) ? pauseEnd : undefined;
    },
  };
}
