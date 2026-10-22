import {
  errorLogFields,
  isPairOpen,
  pairAcceptsDuration,
  SIGNAL_CHART_INTERVAL_MS,
  SignalKind,
  type BinaryPair,
  type NoSignalReason,
  type PairsCatalogView,
  type ScanInterval,
  type TradeAction,
} from '@binarius/shared';
import type { CachedSignalFeed, SignalDecidedEvaluation } from '@binarius/signal';

// docs/signal.md -> The scanner (#343, #405). One instance per interval of SIGNAL_SCAN_INTERVALS
// (#382): on every candle of its interval, CANDLE_CLOSE_SLACK_MS after its boundary, it decides
// every eligible pair of the fresh catalog from the data socket's window (fromSource of the cached
// feed: synchronous, no broker call, no pacer), so a manual analysis of a scanned pair in that
// candle is a cache hit. Its decisions write no journal line; the cache writes one when a route
// first answers the decision. While the source is not streaming it keeps no entry. The snapshot is
// in memory only; GET /trading/signals serves from it (signals-routes.ts).

export interface ScanEntry {
  kind: SignalKind;
  action?: TradeAction;
  reason?: NoSignalReason;
  // the candle the decision closed on; absent on a data refusal
  lastCandleTimestamp?: number;
  decidedAtMs: number;
}

export interface ScanSnapshot {
  interval: ScanInterval;
  // the eligible pairs of this candle's scan, in catalog order
  scanned: readonly number[];
  entries: ReadonlyMap<number, ScanEntry>;
}

interface SignalScannerLogger {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
}

export interface SignalScannerDeps {
  interval: ScanInterval;
  feed: Pick<CachedSignalFeed, 'fromSource'>;
  catalog: { read(): PairsCatalogView | undefined };
  // the manager's streaming(): the active data socket is ready
  streaming: () => boolean;
  logger: SignalScannerLogger;
  now: () => number;
  slackMs: number;
  logEveryMs: number;
}

export interface SignalScanner {
  start(): void;
  // clears the timers; a scan is synchronous, so nothing is in flight, and nothing starts after it
  stop(): Promise<void>;
  snapshot(): ScanSnapshot;
}

// the scanned candle fits a trade of the candle's own length (#313); the payout is no filter: a
// pair below MIN_CYCLE_PAYOUT_PCT is scanned and served too, the bot fills its list with it (#631)
export const eligiblePairs = (
  view: PairsCatalogView,
  nowMs: number,
  durationSec: number,
): BinaryPair[] =>
  view.pairs.filter((pair) => isPairOpen(pair, nowMs) && pairAcceptsDuration(pair, durationSec));

interface FreshSignal {
  assetId: number;
  action: TradeAction;
  lastCandleTimestamp: number;
  decidedAt: number;
  ageMs: number;
}

// docs/signal.md -> GET /trading/signals. A signal is served only on the candle that closed most
// recently and only for a pair this candle's scan decided: a candle that changed without a
// recompute (the source gone mid-scan, a stale catalog, a skew past the slack) serves nothing for
// that pair.
export function freshSignals(snapshot: ScanSnapshot, nowMs: number): FreshSignal[] {
  const candleMs = SIGNAL_CHART_INTERVAL_MS[snapshot.interval];
  const closedAt = Math.floor(nowMs / candleMs) * candleMs;
  const fresh: FreshSignal[] = [];
  for (const assetId of snapshot.scanned) {
    const entry = snapshot.entries.get(assetId);
    if (
      entry?.kind !== SignalKind.Signal ||
      entry.action === undefined ||
      entry.lastCandleTimestamp !== closedAt - candleMs
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
  decided: number;
  // by reason, as the decider gave it
  noSignal: Record<string, number>;
  // decisions whose window had not closed the boundary's candle yet
  unclosed: number;
  // scans not made because the source was not streaming
  sourceDown: number;
  skipped: number;
  threw: number;
  lagsMs: number[];
}

const newPeriod = (): Period => ({
  eligible: 0,
  decided: 0,
  noSignal: {},
  unclosed: 0,
  sourceDown: 0,
  skipped: 0,
  threw: 0,
  lagsMs: [],
});

// nearest rank; 0 when nothing was decided
function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0;
}

export function createSignalScanner(deps: SignalScannerDeps): SignalScanner {
  const { interval, feed, catalog, streaming, logger, now, slackMs, logEveryMs } = deps;
  const candleMs = SIGNAL_CHART_INTERVAL_MS[interval];
  const durationSec = candleMs / 1000;
  let stopped = false;
  let candleTimer: ReturnType<typeof setTimeout> | undefined;
  let logTimer: ReturnType<typeof setInterval> | undefined;
  let scanned: number[] = [];
  const entries = new Map<number, ScanEntry>();
  let staleStreak = false;
  let downStreak = false;
  let period = newPeriod();
  // the next scan moment, boundary + slack; kept, never recomputed from the clock at fire time,
  // so a timer that fires a few ms early cannot make a second scan of one candle
  let nextAt: number | undefined;
  let lastBoundary: number | undefined;

  // the first scan moment not yet past
  function upcoming(at: number): number {
    return Math.floor((at - slackMs) / candleMs) * candleMs + candleMs + slackMs;
  }

  // Normally the kept target plus one candle. After a stall or a forward clock jump, the candle
  // in progress at once while it still runs; after a jump back by a candle or more, the upcoming
  // moment, so the scanner is never silent for longer than one candle.
  function nextTarget(at: number): number {
    const ahead = upcoming(at);
    if (nextAt === undefined) return ahead;
    const candidate = nextAt + candleMs;
    if (candidate > ahead + candleMs) return ahead;
    const latest = ahead - candleMs;
    if (candidate <= latest) return at < latest - slackMs + candleMs ? latest : ahead;
    return candidate;
  }

  function schedule(): void {
    if (stopped) return;
    const at = now();
    nextAt = nextTarget(at);
    const target = nextAt;
    candleTimer = setTimeout(
      () => {
        candleTimer = undefined;
        // a target whose candle already ended is not scanned: schedule() aims at the current one
        const live = now() < target - slackMs + candleMs;
        schedule();
        if (live) scan(target - slackMs);
      },
      Math.max(0, target - at),
    );
  }

  // every eligible pair, each with its digits for the decider's tick floor (#379)
  function choose(nowMs: number): { id: number; digits: number }[] {
    const view = catalog.read();
    if (view === undefined || !view.fresh) {
      if (!staleStreak)
        logger.warn(
          { interval, fresh: view?.fresh ?? null },
          'signal scan skipped: no fresh catalog',
        );
      staleStreak = true;
      period.eligible = 0;
      return [];
    }
    staleStreak = false;
    const eligible = eligiblePairs(view, nowMs, durationSec);
    period.eligible = eligible.length;
    return eligible.map(({ id, digits }) => ({ id, digits }));
  }

  function record(assetId: number, result: SignalDecidedEvaluation, boundary: number): void {
    const { decision, nowMs, source } = result.entry;
    entries.set(assetId, {
      kind: decision.kind,
      ...(decision.kind === SignalKind.Signal
        ? { action: decision.action }
        : { reason: decision.reason }),
      ...('features' in decision
        ? { lastCandleTimestamp: decision.features.lastCandleTimestamp }
        : {}),
      decidedAtMs: nowMs,
    });
    period.decided += 1;
    if (decision.kind === SignalKind.NoSignal) {
      period.noSignal[decision.reason] = (period.noSignal[decision.reason] ?? 0) + 1;
    }
    // the ring had not closed the candle before the decision's own boundary, the reading the feed's
    // forming guard uses: the decision is on the candle before (docs/signal.md -> The scanner)
    const decisionBoundary = Math.floor(nowMs / candleMs) * candleMs;
    if (source.kind === 'socket' && source.closedUntil < decisionBoundary) period.unclosed += 1;
    period.lagsMs.push(now() - boundary);
  }

  function scan(boundary: number): void {
    if (boundary === lastBoundary) return;
    lastBoundary = boundary;
    if (!streaming()) {
      if (!downStreak) logger.warn({ interval }, 'signal scan skipped: source not streaming');
      downStreak = true;
      period.sourceDown += 1;
      period.eligible = 0;
      scanned = [];
      entries.clear();
      return;
    }
    downStreak = false;
    const candleEnd = boundary + candleMs;
    const chosen = choose(now());
    scanned = chosen.map((pair) => pair.id);
    for (const assetId of entries.keys()) {
      if (!scanned.includes(assetId)) entries.delete(assetId);
    }
    for (const [index, { id: assetId, digits }] of chosen.entries()) {
      // past its candle a decision would be the next candle's, which its own scan makes
      if (now() >= candleEnd) {
        period.skipped += chosen.length - index;
        return;
      }
      let result: SignalDecidedEvaluation | undefined;
      try {
        result = feed.fromSource({ assetId, interval, digits });
      } catch (error) {
        period.threw += 1;
        logger.warn({ ...errorLogFields(error), interval, assetId }, 'signal scan failed');
        continue;
      }
      // the source left mid-scan: the rest keeps its entries, which age out with the candle
      if (result === undefined) {
        period.skipped += chosen.length - index;
        return;
      }
      record(assetId, result, boundary);
    }
  }

  function logPeriod(): void {
    const { eligible, decided, noSignal, unclosed, sourceDown, skipped, threw, lagsMs } = period;
    logger.info(
      {
        interval,
        source: streaming() ? 'live' : 'down',
        eligible,
        scanned: scanned.length,
        signals: freshSignals({ interval, scanned, entries }, now()).length,
        decided,
        noSignal,
        unclosed,
        sourceDown,
        skipped,
        threw,
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
    stop() {
      stopped = true;
      if (candleTimer !== undefined) clearTimeout(candleTimer);
      candleTimer = undefined;
      if (logTimer !== undefined) clearInterval(logTimer);
      logTimer = undefined;
      return Promise.resolve();
    },
    snapshot() {
      return { interval, scanned: [...scanned], entries: new Map(entries) };
    },
  };
}
