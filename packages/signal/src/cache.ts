import { BrokerRestErrorCode, SIGNAL_CHART_INTERVAL_MS, SignalFeedOutcome } from '@binarius/shared';
import type { SignalDecider } from './decide';
import type { SignalEvaluation, SignalFeed, SignalFeedRequest } from './feed';

// The live catalog is 144 pairs x 5 intervals = 720 keys. Failures are never held, so an id the
// broker does not know costs a GET and no entry.
export const SIGNAL_CACHE_MAX_ENTRIES = 1_024;

export interface CachedSignalFeedOptions {
  // the deadline of every inner evaluate; a joiner never inherits another caller's abort
  fetchBudgetMs: number;
  // the longest any result is held
  maxTtlMs: number;
  maxEntries?: number;
  now?: () => number;
}

// No caller signal: the deadline is the cache's own, so every waiter of a shared fetch gets the
// same bound.
export interface CachedSignalFeed {
  readonly decider: SignalDecider;
  evaluate(request: SignalFeedRequest): Promise<SignalEvaluation>;
}

interface Held {
  until: number;
  result: SignalEvaluation;
}

// docs/signal.md -> The cache. A decided result is held to the end of the candle its window was
// fetched in, capped at maxTtlMs; a rate_limited one with retryAfterSec for that long, capped;
// nothing else is held. Concurrent calls for one key in one candle share one inner evaluate: a
// call in the next candle never waits for the previous candle's fetch (#343, the scanner at the
// boundary). No timer is kept.
export function createCachedSignalFeed(
  inner: SignalFeed,
  options: CachedSignalFeedOptions,
): CachedSignalFeed {
  const {
    fetchBudgetMs,
    maxTtlMs,
    maxEntries = SIGNAL_CACHE_MAX_ENTRIES,
    now = Date.now,
  } = options;
  const inFlight = new Map<string, Promise<SignalEvaluation>>();
  const held = new Map<string, Held>();

  function holdUntil(result: SignalEvaluation): number | undefined {
    if (result.outcome === SignalFeedOutcome.Decided) {
      // the entry's own clock reading, taken before the fetch: a fetch that crossed the boundary
      // is not held into the next candle
      const { nowMs, intervalMs } = result.entry;
      const candleEnd = Math.floor(nowMs / intervalMs) * intervalMs + intervalMs;
      return Math.min(candleEnd, nowMs + maxTtlMs);
    }
    if (result.code === BrokerRestErrorCode.RateLimited && result.retryAfterSec !== undefined) {
      return now() + Math.min(result.retryAfterSec * 1000, maxTtlMs);
    }
    return undefined;
  }

  function fromHold(key: string): SignalEvaluation | undefined {
    const entry = held.get(key);
    if (entry === undefined) return undefined;
    const nowMs = now();
    if (nowMs >= entry.until) {
      held.delete(key);
      return undefined;
    }
    if (entry.result.outcome === SignalFeedOutcome.FetchFailed) {
      // what is left of the broker's window, never the stale original
      return { ...entry.result, retryAfterSec: Math.ceil((entry.until - nowMs) / 1000) };
    }
    return entry.result;
  }

  // a late result of an older fetch never replaces a hold that lasts longer
  function hold(key: string, entry: Held): void {
    const current = held.get(key);
    if (current !== undefined && current.until > entry.until) return;
    held.delete(key);
    held.set(key, entry);
    for (const oldest of held.keys()) {
      if (held.size <= maxEntries) break;
      held.delete(oldest);
    }
  }

  async function fetchAndHold(key: string, request: SignalFeedRequest): Promise<SignalEvaluation> {
    const result = await inner.evaluate(request, { signal: AbortSignal.timeout(fetchBudgetMs) });
    const until = holdUntil(result);
    if (until !== undefined) hold(key, { until, result });
    return result;
  }

  return {
    decider: inner.decider,
    evaluate(request) {
      const key = `${request.assetId}:${request.interval}`;
      const hit = fromHold(key);
      if (hit !== undefined) return Promise.resolve(hit);
      const intervalMs: number | undefined = SIGNAL_CHART_INTERVAL_MS[request.interval];
      // an unknown interval keeps the plain key; the inner feed refuses it
      const flightKey = intervalMs === undefined ? key : `${key}:${Math.floor(now() / intervalMs)}`;
      const pending = inFlight.get(flightKey);
      if (pending !== undefined) return pending;

      const started = fetchAndHold(key, request);
      inFlight.set(flightKey, started);
      // runs after the set above even when the inner call failed synchronously
      const clear = () => {
        inFlight.delete(flightKey);
      };
      void started.then(clear, clear);
      return started;
    },
  };
}
