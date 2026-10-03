import { errorLogFields, type BinaryPair, type PairsCatalogView } from '@binarius/shared';
import { BROKER_REST_TIMEOUT_MS, BrokerRestError, type BrokerRestClient } from './rest';

// The catalog's numbers form one chain:
//   BROKER_REST_TIMEOUT_MS < MIN_BROKER_PAIRS_TTL_MS — one GET ends before the next tick
//   MIN ≤ DEFAULT ≤ MAX                              — the env range (BROKER_PAIRS_TTL_MS) holds its default
//   MAX_BROKER_PAIRS_TTL_MS < BROKER_PAIRS_MAX_STALE_MS — a snapshot outlives several failed ticks
// The TTL is the timer's period and so the age a caller may treat as fresh; MAX_STALE is how long
// the last snapshot is still served while the broker is unavailable.
export const MIN_BROKER_PAIRS_TTL_MS = 30_000;
export const DEFAULT_BROKER_PAIRS_TTL_MS = 30_000;
export const MAX_BROKER_PAIRS_TTL_MS = 60_000;
export const BROKER_PAIRS_MAX_STALE_MS = 300_000;

export const PAIRS_CATALOG_CHAIN_HOLDS =
  BROKER_REST_TIMEOUT_MS < MIN_BROKER_PAIRS_TTL_MS &&
  MIN_BROKER_PAIRS_TTL_MS <= DEFAULT_BROKER_PAIRS_TTL_MS &&
  DEFAULT_BROKER_PAIRS_TTL_MS <= MAX_BROKER_PAIRS_TTL_MS &&
  MAX_BROKER_PAIRS_TTL_MS < BROKER_PAIRS_MAX_STALE_MS;
if (!PAIRS_CATALOG_CHAIN_HOLDS) {
  throw new Error('pairs catalog timing constants are out of order (see pairs-catalog.ts)');
}

export interface PairsSnapshot {
  pairs: BinaryPair[];
  fetchedAt: number;
}

export interface PairsCatalog {
  // undefined: no snapshot yet, or the last one is older than BROKER_PAIRS_MAX_STALE_MS
  read(): PairsCatalogView | undefined;
  // true when the snapshot was replaced; one request at a time; false without a request after stop()
  refresh(): Promise<boolean>;
  // setInterval(refresh, ttlMs); a second start() and a start() after stop() do nothing
  start(): void;
  // clears the timer and aborts the request in flight
  stop(): void;
}

export interface PairsCatalogLogger {
  warn(fields: object, message: string): void;
}

export interface PairsCatalogDeps {
  client: Pick<BrokerRestClient, 'listPairs'>;
  ttlMs: number;
  logger: PairsCatalogLogger;
  now?: () => number;
}

export function createPairsCatalog(deps: PairsCatalogDeps): PairsCatalog {
  const now = deps.now ?? Date.now;
  let snapshot: PairsSnapshot | undefined;
  let inFlight: Promise<boolean> | undefined;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;

  async function fetchOnce(): Promise<boolean> {
    const abort = new AbortController();
    controller = abort;
    try {
      const pairs = await deps.client.listPairs({ signal: abort.signal });
      if (stopped) return false;
      // taken after the answer: the age measures the data, not the attempt
      snapshot = { pairs, fetchedAt: now() };
      return true;
    } catch (error) {
      // only stop() aborts this signal, and our own shutdown is not a broker failure
      if (abort.signal.aborted) return false;
      const fields =
        error instanceof BrokerRestError
          ? {
              ...errorLogFields(error),
              status: error.status,
              retryAfterSec: error.retryAfterSec,
              detail: error.detail,
            }
          : errorLogFields(error);
      deps.logger.warn(fields, 'pairs catalog refresh failed');
      return false;
    } finally {
      controller = undefined;
    }
  }

  function refresh(): Promise<boolean> {
    if (stopped) return Promise.resolve(false);
    // reset in .finally, which always runs after this assignment: a listPairs that throws
    // synchronously settles fetchOnce() before it returns
    inFlight ??= fetchOnce().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  }

  return {
    read() {
      if (snapshot === undefined) return undefined;
      const ageMs = Math.max(0, now() - snapshot.fetchedAt);
      if (ageMs > BROKER_PAIRS_MAX_STALE_MS) return undefined;
      return { pairs: snapshot.pairs, fetchedAt: snapshot.fetchedAt, ageMs };
    },
    refresh,
    start() {
      if (stopped || timer !== undefined) return;
      timer = setInterval(() => void refresh(), deps.ttlMs);
    },
    stop() {
      stopped = true;
      clearInterval(timer);
      timer = undefined;
      controller?.abort();
    },
  };
}
