import type { FastifyBaseLogger } from 'fastify';
import {
  BrokerRestErrorCode,
  comparePairsByPayout,
  errorLogFields,
  SIGNAL_CHART_INTERVAL_MS,
  SIGNAL_SCAN_INTERVALS,
  type BinaryPair,
  type Candle,
  type PairsCatalogView,
  type ScanInterval,
} from '@binarius/shared';
import { BrokerRestError, type BrokerRestClient, type PairsCatalog } from '@binarius/broker-rest';
import { assertDigits, chartWindow } from '@binarius/signal';
import { eligiblePairs } from '../signal/scanner';
import type { SpareTokenSource } from '../signal/pacer';
import { floorTo, type CandleRing } from './ring';
import type { PendingRequests } from './source';

// The REST backfill of the ring (#590, docs/market-data.md -> Backfill). An element is a
// (pair, interval). It is due once its hold-back is over and its window has a closed empty bucket
// the last GET did not leave unfilled (or a request() and any empty bucket at all). The queue,
// rebuilt every scanMs: the requests in pending() order, then the elements never attempted by
// the pair's payout, then the rest by the age of their last attempt; on an equal key the order of
// SIGNAL_SCAN_INTERVALS (one interval since #685, `15s` before `5s` until then). The proactive
// set is the scanner's eligible pairs of the last fresh catalog with valid digits, and only while
// the active socket is ready; a request is served for any such pair with valid digits, whatever
// the socket. Every GET takes a spare token (the signal pacer's overflow, never a token of its
// bucket, #405).
// A GET may cross a candle boundary: it fills only the buckets closed when it was built, and a
// request that comes while it is in flight waits for the next attempt.

export interface CandleBackfillConfig {
  scanMs: number;
  pollMs: number;
  retryMs: number;
  attempts: number;
  budgetMs: number;
  concurrency: number;
  slackMs: number;
  // MARKET_DATA_RING_CANDLES: the ring's window
  candles: number;
}

export interface CandleBackfillDeps {
  ring: Pick<CandleRing, 'read' | 'fill' | 'closedUntil'>;
  requests: Pick<PendingRequests, 'pending'>;
  catalog: Pick<PairsCatalog, 'read'>;
  rest: Pick<BrokerRestClient, 'getChart'>;
  pacer: SpareTokenSource;
  // the manager's streaming(): the active socket is ready
  streaming: () => boolean;
  logger: Pick<FastifyBaseLogger, 'warn' | 'error'>;
  now?: () => number;
  config: CandleBackfillConfig;
}

// cumulative since the start, but queued: the queue's length now
export interface BackfillCounters {
  queued: number;
  fetched: number;
  filled: number;
  failed: number;
  rateLimited: number;
  spare: number;
}

export interface CandleBackfill {
  // a first scan now, then the scan and the poll timers
  start(): void;
  // one scan and one dispatch, for tests
  tick(): Promise<void>;
  // clears the timers, aborts the GETs in flight and waits for them; nothing starts after it
  stop(): Promise<void>;
  counters(): BackfillCounters;
}

interface Element {
  assetId: number;
  interval: ScanInterval;
  // the buckets the last GET (or the give-up) left empty; dropped once out of the window
  unfilled: Set<number>;
  // -Infinity: never attempted (a 429 is not an attempt)
  lastAttemptAt: number;
  retryAt: number;
  failures: number;
  // the place in pending() order, while a request waits on the element
  requested: number | undefined;
  inflight: boolean;
}

const keyOf = (assetId: number, interval: ScanInterval) => `${assetId}:${interval}`;
const intervalRank = (interval: ScanInterval) => SIGNAL_SCAN_INTERVALS.indexOf(interval);
const SHORTEST_MS = Math.min(
  ...SIGNAL_SCAN_INTERVALS.map((interval) => SIGNAL_CHART_INTERVAL_MS[interval]),
);

export function createCandleBackfill(deps: CandleBackfillDeps): CandleBackfill {
  const { ring, requests, catalog, rest, pacer, streaming, logger, config } = deps;
  const now = deps.now ?? Date.now;
  const elements = new Map<string, Element>();
  // the last fresh catalog, its pairs with valid digits only; undefined before the first one
  let view: PairsCatalogView | undefined;
  let pairs = new Map<number, BinaryPair>();
  let queue: Element[] = [];
  let requestSeq = 0;
  const inflight = new Set<Promise<void>>();
  const stopping = new AbortController();
  let stopped = false;
  let scanTimer: NodeJS.Timeout | undefined;
  let pollTimer: NodeJS.Timeout | undefined;
  const totals = { fetched: 0, filled: 0, failed: 0, rateLimited: 0, spare: 0 };

  function elementOf(assetId: number, interval: ScanInterval): Element {
    const key = keyOf(assetId, interval);
    let element = elements.get(key);
    if (element === undefined) {
      element = {
        assetId,
        interval,
        unfilled: new Set(),
        lastAttemptAt: -Infinity,
        retryAt: -Infinity,
        failures: 0,
        requested: undefined,
        inflight: false,
      };
      elements.set(key, element);
    }
    return element;
  }

  // the closed empty buckets now; the unfilled ones gone from the window are forgotten
  function gapsOf(element: Element, at: number): number[] {
    const window = ring.read(element.assetId, element.interval, at);
    for (const bucket of element.unfilled) {
      if (bucket < window.startTime) element.unfilled.delete(bucket);
    }
    return window.gaps;
  }

  function isDue(element: Element, at: number): boolean {
    if (element.inflight || element.retryAt > at) return false;
    const gaps = gapsOf(element, at);
    if (element.requested !== undefined && gaps.length === 0) element.requested = undefined;
    if (element.requested !== undefined) return true;
    return gaps.some((bucket) => !element.unfilled.has(bucket));
  }

  function readCatalog(): void {
    const read = catalog.read();
    if (read?.fresh !== true) return;
    const next = new Map<number, BinaryPair>();
    for (const pair of read.pairs) {
      // the manager's subscription filter: the ring holds no pair outside it
      try {
        assertDigits(pair.digits);
        next.set(pair.id, pair);
      } catch {
        continue;
      }
    }
    pairs = next;
    view = { ...read, pairs: [...next.values()] };
    for (const [key, element] of elements) {
      if (!next.has(element.assetId) && !element.inflight) elements.delete(key);
    }
  }

  function level(element: Element): number {
    if (element.requested !== undefined) return 0;
    return element.lastAttemptAt === -Infinity ? 1 : 2;
  }

  function compare(a: Element, b: Element): number {
    const byLevel = level(a) - level(b);
    if (byLevel !== 0) return byLevel;
    return keyOrder(a, b) || intervalRank(a.interval) - intervalRank(b.interval);
  }

  function keyOrder(a: Element, b: Element): number {
    if (level(a) === 0) return (a.requested ?? 0) - (b.requested ?? 0);
    if (level(a) === 2) return a.lastAttemptAt - b.lastAttemptAt;
    const pairA = pairs.get(a.assetId);
    const pairB = pairs.get(b.assetId);
    return pairA !== undefined && pairB !== undefined ? comparePairsByPayout(pairA, pairB) : 0;
  }

  function scan(): void {
    if (stopped) return;
    readCatalog();
    // before the first fresh catalog the requests wait in their set
    if (view === undefined) return;
    for (const { assetId, interval } of requests.pending()) {
      if (!pairs.has(assetId)) continue;
      const element = elementOf(assetId, interval);
      element.requested ??= requestSeq++;
    }
    const at = now();
    const candidates = new Set<Element>();
    if (streaming()) {
      for (const interval of SIGNAL_SCAN_INTERVALS) {
        const durationSec = SIGNAL_CHART_INTERVAL_MS[interval] / 1000;
        for (const pair of eligiblePairs(view, at, durationSec)) {
          candidates.add(elementOf(pair.id, interval));
        }
      }
    }
    for (const element of elements.values()) {
      if (element.requested !== undefined) candidates.add(element);
    }
    queue = [...candidates].filter((element) => isDue(element, at)).sort(compare);
  }

  // the buckets of the window still empty after a GET that could fill those before `closedAt`;
  // a bucket that closed since is a new one
  function leftUnfilled(element: Element, closedAt: number): Set<number> {
    return new Set(gapsOf(element, now()).filter((bucket) => bucket < closedAt));
  }

  function settle(element: Element, at: number): void {
    element.retryAt = at + config.retryMs;
    element.lastAttemptAt = at;
  }

  function failed(
    element: Element,
    closedAt: number,
    served: number | undefined,
    code: string,
  ): void {
    totals.failed += 1;
    settle(element, now());
    element.failures += 1;
    if (element.failures < config.attempts) {
      element.requested ??= served;
      return;
    }
    logger.warn(
      {
        assetId: element.assetId,
        interval: element.interval,
        code,
        attempts: element.failures,
      },
      'market data backfill gave up',
    );
    element.unfilled = leftUnfilled(element, closedAt);
    element.failures = 0;
  }

  async function attempt(element: Element, at: number, served: number | undefined): Promise<void> {
    const { assetId, interval } = element;
    const intervalMs = SIGNAL_CHART_INTERVAL_MS[interval];
    // the buckets the GET may fill: ended before its boundary, and closed by the ring's rule at
    // `at`; fill() alone would judge them at the answer, by a watermark the GET's time moved
    const closedAt = Math.min(floorTo(at, intervalMs), ring.closedUntil(interval, at));
    const window = chartWindow(at, intervalMs, config.candles);
    const signal = AbortSignal.any([AbortSignal.timeout(config.budgetMs), stopping.signal]);
    let rows: Candle[];
    try {
      rows = await rest.getChart(
        { assetId, interval, startTime: window.startTime - intervalMs, limit: window.limit + 1 },
        { signal },
      );
    } catch (error) {
      if (stopping.signal.aborted) return;
      if (error instanceof BrokerRestError) {
        if (error.code === BrokerRestErrorCode.RateLimited) {
          totals.rateLimited += 1;
          pacer.onRateLimited(error.retryAfterSec);
          element.requested ??= served;
          queue.unshift(element);
          return;
        }
        failed(element, closedAt, served, error.code);
        return;
      }
      logger.warn({ assetId, interval, ...errorLogFields(error) }, 'market data backfill threw');
      failed(element, closedAt, served, 'threw');
      return;
    }
    if (stopped) return;
    pacer.onDecided();
    // the first row opens on the window's first tick, not on the close before it (#392 spike)
    const closed = rows.slice(1).filter((row) => row.timestamp < closedAt);
    const { filled } = ring.fill(assetId, interval, closed, now());
    totals.fetched += 1;
    totals.filled += filled;
    settle(element, now());
    element.unfilled = leftUnfilled(element, closedAt);
    element.failures = 0;
  }

  function launch(element: Element, at: number): void {
    element.inflight = true;
    // the request this attempt serves; one that comes while it is in flight is the next one's
    const served = element.requested;
    element.requested = undefined;
    const work: Promise<void> = attempt(element, at, served)
      .catch((error: unknown) => {
        logger.error(errorLogFields(error), 'market data backfill tick failed');
      })
      .finally(() => {
        element.inflight = false;
        inflight.delete(work);
      });
    inflight.add(work);
  }

  function dispatch(): void {
    if (stopped) return;
    const at = now();
    // a candle just closed is published by the broker after the boundary (CANDLE_CLOSE_SLACK_MS)
    if (at - floorTo(at, SHORTEST_MS) < config.slackMs) return;
    while (inflight.size < config.concurrency && queue.length > 0) {
      const [head] = queue;
      if (head === undefined || !isDue(head, at)) {
        queue.shift();
        continue;
      }
      if (!pacer.tryTakeSpare()) return;
      totals.spare += 1;
      queue.shift();
      launch(head, at);
    }
  }

  function guarded(work: () => void): void {
    try {
      work();
    } catch (error) {
      logger.error(errorLogFields(error), 'market data backfill tick failed');
    }
  }

  return {
    start() {
      if (stopped || scanTimer !== undefined) return;
      guarded(scan);
      scanTimer = setInterval(() => guarded(scan), config.scanMs);
      pollTimer = setInterval(() => guarded(dispatch), config.pollMs);
    },
    async tick() {
      guarded(scan);
      guarded(dispatch);
      await Promise.allSettled([...inflight]);
    },
    async stop() {
      stopped = true;
      clearInterval(scanTimer);
      clearInterval(pollTimer);
      scanTimer = undefined;
      pollTimer = undefined;
      queue = [];
      stopping.abort();
      await Promise.allSettled([...inflight]);
    },
    counters: () => ({ queued: queue.length, ...totals }),
  };
}
