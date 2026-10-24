import {
  abandonedFetches,
  errorLogFields,
  INT4_MAX,
  type BinaryPair,
  type PairsCatalogView,
} from '@binarius/shared';
import { BROKER_REST_TIMEOUT_MS, BrokerRestError, type BrokerRestClient } from './rest';

// The catalog's numbers form one chain:
//   BROKER_REST_TIMEOUT_MS < MIN_BROKER_PAIRS_TTL_MS — one GET ends before the next tick
//   MIN ≤ DEFAULT ≤ MAX                              — the env range (BROKER_PAIRS_TTL_MS) holds its default
//   MAX_BROKER_PAIRS_TTL_MS < BROKER_PAIRS_MAX_STALE_MS — a snapshot outlives several failed ticks
//   MAX_BROKER_PAIRS_TTL_MS + BROKER_REST_TIMEOUT_MS < BROKER_PAIRS_MAX_STALE_MS — a fresh snapshot
//                                                    is still served
// The TTL is the timer's period; a healthy snapshot is at most TTL + BROKER_REST_TIMEOUT_MS old,
// and read() calls a snapshot within that age fresh: older means the broker is failing.
// MAX_STALE is how long the last snapshot is still served while the broker is unavailable.
// Two clocks: now() (the wall clock) only stamps fetchedAt; every age and interval is taken on
// ageClock() (monotonic), so a wall clock that steps back cannot make an old snapshot fresh.
export const MIN_BROKER_PAIRS_TTL_MS = 30_000;
export const DEFAULT_BROKER_PAIRS_TTL_MS = 30_000;
export const MAX_BROKER_PAIRS_TTL_MS = 60_000;
export const BROKER_PAIRS_MAX_STALE_MS = 300_000;

export const PAIRS_CATALOG_CHAIN_HOLDS =
  BROKER_REST_TIMEOUT_MS < MIN_BROKER_PAIRS_TTL_MS &&
  MIN_BROKER_PAIRS_TTL_MS <= DEFAULT_BROKER_PAIRS_TTL_MS &&
  DEFAULT_BROKER_PAIRS_TTL_MS <= MAX_BROKER_PAIRS_TTL_MS &&
  MAX_BROKER_PAIRS_TTL_MS < BROKER_PAIRS_MAX_STALE_MS &&
  MAX_BROKER_PAIRS_TTL_MS + BROKER_REST_TIMEOUT_MS < BROKER_PAIRS_MAX_STALE_MS;
if (!PAIRS_CATALOG_CHAIN_HOLDS) {
  throw new Error('pairs catalog timing constants are out of order (see pairs-catalog.ts)');
}

interface PairsSnapshot {
  pairs: BinaryPair[];
  fetchedAt: number;
  // ageClock() when the answer arrived
  takenAt: number;
}

export interface PairsCatalog {
  read(): PairsCatalogView | undefined;
  // true when the snapshot was replaced; one request at a time; false without a request after stop()
  refresh(): Promise<boolean>;
  start(): void;
  stop(): void;
}

export interface PairsCatalogLogger {
  warn(fields: object, message: string): void;
  error(fields: object, message: string): void;
  info(fields: object, message: string): void;
}

export interface PairsCatalogDeps {
  client: Pick<BrokerRestClient, 'listPairs'>;
  ttlMs: number;
  logger: PairsCatalogLogger;
  now?: () => number;
  // the clock ages are measured on, in whole ms; monotonic (performance.now, floored) by default
  ageClock?: () => number;
  // calls of the process still pending past their deadline; abandonedFetches() by default
  abandoned?: () => number;
}

export function createPairsCatalog(deps: PairsCatalogDeps): PairsCatalog {
  const now = deps.now ?? Date.now;
  // whole milliseconds: ageMs goes on the wire as an integer (pairsCatalogViewSchema)
  const ageClock = deps.ageClock ?? (() => Math.floor(performance.now()));
  let snapshot: PairsSnapshot | undefined;
  let inFlight: Promise<boolean> | undefined;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  // request failures since the last success; a request cut by stop() is not one
  let failedRefreshes = 0;
  // ageClock() of the last 'pairs catalog is stale' line; undefined while no streak is reported
  let lastStaleLineAt: number | undefined;
  const abandoned = deps.abandoned ?? abandonedFetches;

  const ageOf = (taken: PairsSnapshot, at: number): number => at - taken.takenAt;

  function read(): PairsCatalogView | undefined {
    if (snapshot === undefined) return undefined;
    const ageMs = ageOf(snapshot, ageClock());
    if (ageMs > BROKER_PAIRS_MAX_STALE_MS) return undefined;
    return {
      pairs: snapshot.pairs,
      fetchedAt: snapshot.fetchedAt,
      ageMs,
      fresh: ageMs <= deps.ttlMs + BROKER_REST_TIMEOUT_MS,
    };
  }

  // #481: a catalog that stopped refreshing is an error in the log, not only `fresh: false` in a
  // response. Once per streak, then again every BROKER_PAIRS_MAX_STALE_MS from the last line.
  // No snapshot at all (a failed warm-up) is stale, with ageMs null.
  function reportIfStale(): void {
    if (read()?.fresh === true) return;
    const at = ageClock();
    if (lastStaleLineAt !== undefined && at - lastStaleLineAt < BROKER_PAIRS_MAX_STALE_MS) return;
    lastStaleLineAt = at;
    deps.logger.error(
      {
        ageMs: snapshot === undefined ? null : ageOf(snapshot, at),
        failedRefreshes,
        abandoned: abandoned(),
      },
      'pairs catalog is stale',
    );
  }

  // checked before the refresh, so a refresh that never settles cannot hide the streak
  function tick(): void {
    reportIfStale();
    void refresh();
  }

  async function fetchOnce(): Promise<boolean> {
    const abort = new AbortController();
    controller = abort;
    try {
      const pairs = await deps.client.listPairs({ signal: abort.signal });
      if (stopped) return false;
      const at = ageClock();
      if (lastStaleLineAt !== undefined) {
        deps.logger.info(
          { ageMs: snapshot === undefined ? null : ageOf(snapshot, at), failedRefreshes },
          'pairs catalog fresh again',
        );
        lastStaleLineAt = undefined;
      }
      failedRefreshes = 0;
      const { kept, dropped } = admissiblePairs(pairs);
      if (dropped.length > 0) {
        deps.logger.warn(
          { dropped: dropped.length, ids: dropped.slice(0, 10).map((pair) => pair.id) },
          'pairs catalog dropped pairs with an unusable id',
        );
      }
      // taken after the answer: the age measures the data, not the attempt
      snapshot = { pairs: kept, fetchedAt: now(), takenAt: at };
      return true;
    } catch (error) {
      // only stop() aborts this signal, and our own shutdown is not a broker failure
      if (abort.signal.aborted) return false;
      failedRefreshes += 1;
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
    read,
    refresh,
    start() {
      if (stopped || timer !== undefined) return;
      timer = setInterval(tick, deps.ttlMs);
    },
    stop() {
      stopped = true;
      clearInterval(timer);
      timer = undefined;
      controller?.abort();
    },
  };
}

// The bot's callbacks and trade intents carry the id as a positive int4; a pair outside that
// range would be a dead button, and a repeated id resolves to its first pair only.
function admissiblePairs(pairs: BinaryPair[]): { kept: BinaryPair[]; dropped: BinaryPair[] } {
  const kept: BinaryPair[] = [];
  const dropped: BinaryPair[] = [];
  const seen = new Set<number>();
  for (const pair of pairs) {
    if (Number.isInteger(pair.id) && pair.id >= 1 && pair.id <= INT4_MAX && !seen.has(pair.id)) {
      seen.add(pair.id);
      kept.push(pair);
    } else {
      dropped.push(pair);
    }
  }
  return { kept, dropped };
}
