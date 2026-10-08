import {
  BrokerRestErrorCode,
  errorLogFields,
  isPairOpen,
  pairAcceptsDuration,
  SIGNAL_CHART_INTERVAL_MS,
  SIGNAL_SCAN_INTERVAL,
  SignalFeedOutcome,
  SignalKind,
  type PairsCatalogView,
  type TradeAction,
} from '@binarius/shared';
import type { CachedSignalFeed } from '@binarius/signal';
import type { ScanPacer } from './pacer';

// docs/signal.md -> The scanner (#343). On every 15s candle, SIGNAL_SCAN_SLACK_MS after its
// boundary, the scanner decides the top pairs of the fresh catalog through the same cached feed
// as POST /trading/signal, so a manual analysis of a scanned pair in that candle is a cache hit.
// Every decision is journalled by the feed itself (`signal decision`). The snapshot is in memory
// only; GET /trading/signals serves from it (signals-routes.ts).

export const SCAN_INTERVAL_MS = SIGNAL_CHART_INTERVAL_MS[SIGNAL_SCAN_INTERVAL];
// a 15s candle fits a trade of this many seconds (#313)
const SCAN_DURATION_SEC = SCAN_INTERVAL_MS / 1000;

export interface ScanEntry {
  kind: SignalKind;
  action?: TradeAction;
  // the candle the decision closed on; absent on a data refusal
  lastCandleTimestamp?: number;
  decidedAtMs: number;
}

export interface ScanSnapshot {
  // the pairs this candle's scan chose, in order
  scanned: readonly number[];
  entries: ReadonlyMap<number, ScanEntry>;
}

export interface SignalScannerLogger {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
}

export interface SignalScannerDeps {
  feed: Pick<CachedSignalFeed, 'evaluate'>;
  catalog: { read(): PairsCatalogView | undefined };
  pacer: ScanPacer;
  logger: SignalScannerLogger;
  now: () => number;
  // the top pairs scanned each candle
  maxPairs: number;
  slackMs: number;
  concurrency: number;
  logEveryMs: number;
}

export interface SignalScanner {
  start(): void;
  // clears the timers and waits for the evaluations in flight; nothing starts after it
  stop(): Promise<void>;
  snapshot(): ScanSnapshot;
}

// payout desc, then id asc, so the choice does not depend on the catalog's order
export function scanCandidates(view: PairsCatalogView, nowMs: number, maxPairs: number): number[] {
  return view.pairs
    .filter((pair) => isPairOpen(pair, nowMs) && pairAcceptsDuration(pair, SCAN_DURATION_SEC))
    .sort((a, b) => b.payout - a.payout || a.id - b.id)
    .slice(0, maxPairs)
    .map((pair) => pair.id);
}

export interface FreshSignal {
  assetId: number;
  action: TradeAction;
  lastCandleTimestamp: number;
  decidedAt: number;
  ageMs: number;
}

// docs/signal.md -> GET /trading/signals. A signal is served only on the candle that closed most
// recently and only for a pair this candle's scan chose: a candle that changed without a
// recompute (a 429, a stale catalog, a skew past the slack) serves nothing for that pair.
export function freshSignals(snapshot: ScanSnapshot, nowMs: number): FreshSignal[] {
  const closedAt = Math.floor(nowMs / SCAN_INTERVAL_MS) * SCAN_INTERVAL_MS;
  const fresh: FreshSignal[] = [];
  for (const assetId of snapshot.scanned) {
    const entry = snapshot.entries.get(assetId);
    if (
      entry?.kind !== SignalKind.Signal ||
      entry.action === undefined ||
      entry.lastCandleTimestamp !== closedAt - SCAN_INTERVAL_MS
    ) {
      continue;
    }
    fresh.push({
      assetId,
      action: entry.action,
      lastCandleTimestamp: entry.lastCandleTimestamp,
      decidedAt: entry.decidedAtMs,
      ageMs: nowMs - closedAt,
    });
  }
  return fresh;
}

interface Period {
  eligible: number;
  noSignal: number;
  skipped: number;
  rateLimited: number;
  failed: Record<string, number>;
  pausedMs: number;
  lagsMs: number[];
}

const newPeriod = (): Period => ({
  eligible: 0,
  noSignal: 0,
  skipped: 0,
  rateLimited: 0,
  failed: {},
  pausedMs: 0,
  lagsMs: [],
});

// nearest rank; 0 when nothing was decided
function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0;
}

export function createSignalScanner(deps: SignalScannerDeps): SignalScanner {
  const { feed, catalog, pacer, logger, now, maxPairs, slackMs, concurrency, logEveryMs } = deps;
  let stopped = false;
  let candleTimer: ReturnType<typeof setTimeout> | undefined;
  let logTimer: ReturnType<typeof setInterval> | undefined;
  const inFlight = new Set<Promise<void>>();
  let scanned: number[] = [];
  const entries = new Map<number, ScanEntry>();
  let staleStreak = false;
  let period = newPeriod();

  function nextScanDelay(): number {
    const at = now();
    const boundary = Math.floor((at - slackMs) / SCAN_INTERVAL_MS) * SCAN_INTERVAL_MS;
    return boundary + SCAN_INTERVAL_MS + slackMs - at;
  }

  function schedule(): void {
    if (stopped) return;
    candleTimer = setTimeout(() => {
      candleTimer = undefined;
      schedule();
      const run = scan();
      inFlight.add(run);
      void run.finally(() => inFlight.delete(run));
    }, nextScanDelay());
  }

  function choose(nowMs: number): number[] {
    const view = catalog.read();
    if (view === undefined || !view.fresh) {
      if (!staleStreak)
        logger.warn({ fresh: view?.fresh ?? null }, 'signal scan skipped: no fresh catalog');
      staleStreak = true;
      return [];
    }
    staleStreak = false;
    const chosen = scanCandidates(view, nowMs, maxPairs);
    period.eligible = view.pairs.filter(
      (pair) => isPairOpen(pair, nowMs) && pairAcceptsDuration(pair, SCAN_DURATION_SEC),
    ).length;
    return chosen;
  }

  function rateLimited(retryAfterSec: number | undefined): void {
    const at = now();
    const before = pacer.pausedUntil() ?? at;
    pacer.onRateLimited(retryAfterSec);
    const after = pacer.pausedUntil() ?? at;
    period.rateLimited += 1;
    period.pausedMs += Math.max(0, after - Math.max(before, at));
  }

  async function decide(assetId: number, boundary: number): Promise<void> {
    try {
      const result = await feed.evaluate({ assetId, interval: SIGNAL_SCAN_INTERVAL });
      if (result.outcome === SignalFeedOutcome.FetchFailed) {
        period.failed[result.code] = (period.failed[result.code] ?? 0) + 1;
        if (result.code === BrokerRestErrorCode.RateLimited) rateLimited(result.retryAfterSec);
        return;
      }
      pacer.onDecided();
      const { decision, nowMs } = result.entry;
      // a pair that left the top while its call was in flight is not put back
      if (!scanned.includes(assetId)) return;
      entries.set(assetId, {
        kind: decision.kind,
        ...(decision.kind === SignalKind.Signal ? { action: decision.action } : {}),
        ...('features' in decision
          ? { lastCandleTimestamp: decision.features.lastCandleTimestamp }
          : {}),
        decidedAtMs: nowMs,
      });
      if (decision.kind === SignalKind.NoSignal) period.noSignal += 1;
      period.lagsMs.push(now() - boundary);
    } catch (error) {
      period.failed.threw = (period.failed.threw ?? 0) + 1;
      logger.warn({ ...errorLogFields(error), assetId }, 'signal scan failed');
    }
  }

  async function scan(): Promise<void> {
    const at = now();
    const boundary = Math.floor(at / SCAN_INTERVAL_MS) * SCAN_INTERVAL_MS;
    scanned = choose(at);
    for (const assetId of entries.keys()) {
      if (!scanned.includes(assetId)) entries.delete(assetId);
    }
    const queue = [...scanned];
    const worker = async () => {
      for (let assetId = queue.shift(); assetId !== undefined; assetId = queue.shift()) {
        if (stopped) return;
        if (!pacer.tryTake()) {
          // a pause or an empty bucket drops the rest of this candle; the next one starts fresh
          period.skipped += queue.length + 1;
          queue.length = 0;
          return;
        }
        await decide(assetId, boundary);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
  }

  function logPeriod(): void {
    const { eligible, noSignal, skipped, rateLimited: limited, failed, pausedMs, lagsMs } = period;
    logger.info(
      {
        eligible,
        scanned: scanned.length,
        signals: freshSignals({ scanned, entries }, now()).length,
        noSignal,
        skipped,
        failed,
        rateLimited: limited,
        pausedMs,
        lagMsP95: p95(lagsMs),
      },
      'signal scanner',
    );
    period = { ...newPeriod(), eligible };
  }

  return {
    start() {
      if (stopped || candleTimer !== undefined) return;
      schedule();
      logTimer = setInterval(logPeriod, logEveryMs);
    },
    async stop() {
      stopped = true;
      if (candleTimer !== undefined) clearTimeout(candleTimer);
      candleTimer = undefined;
      if (logTimer !== undefined) clearInterval(logTimer);
      logTimer = undefined;
      await Promise.allSettled([...inFlight]);
    },
    snapshot() {
      return { scanned: [...scanned], entries: new Map(entries) };
    },
  };
}
