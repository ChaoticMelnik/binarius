import type { FastifyBaseLogger } from 'fastify';
import {
  errorLogFields,
  H1_EXPIRY_SEC,
  H1_R1_PARAMS,
  isPairOpen,
  pairAcceptsDuration,
  SignalKind,
  type H1Decision,
  type H1Params,
  type H1SignalWire,
} from '@binarius/shared';
import type { PairsCatalog } from '@binarius/broker-rest';
import { assertH1WindowFits, createH1Detector } from '@binarius/signal';
import type { ClosedSecond, SecondSeries } from '../market-data/seconds';

// The H1 scanner (#828, docs/h1.md -> The scanner and the signals list, Rule 55): on every closed
// second f of every pair of the fresh catalog that is open and takes H1_EXPIRY_SEC (no payout
// floor), while the source streams, the R1 detector decides on the window of sdWindowSec + 1
// closes, at = length - 1, as the driver and the start do (Rule 43). The pair's newest decision is
// kept in memory only, never written; GET /trading/signals and POST /trading/signal's `h1` serve a
// signal only while its second is current: now - f <= maxAgeMs (H1_START_SECOND_MAX_AGE_MS, the
// start's rule of #796). It listens to the series beside the driver and advances
// nothing: the driver's tick closes quiet seconds. Synchronous in the socket's handler, never
// throws.

// the source buildH1SessionSettings writes into every H1 session: the shown signal and the traded
// one are the same function of the same second
export const H1_SCANNER_PARAMS: Readonly<H1Params> = H1_R1_PARAMS;

export interface H1ScannerConfig {
  logMs: number;
  // a decision is served while now - f is at most this
  maxAgeMs: number;
}

export interface H1ScannerDeps {
  series: Pick<SecondSeries, 'onClosed' | 'window'>;
  catalog: Pick<PairsCatalog, 'read'>;
  // the data socket's active client is ready
  streaming: () => boolean;
  // H1_SCANNER_PARAMS by default
  params?: Readonly<H1Params>;
  logger: Pick<FastifyBaseLogger, 'info' | 'warn'>;
  now?: () => number;
  config: H1ScannerConfig;
}

export type H1ScannerSignal = H1SignalWire & { assetId: number };

export interface H1ScannerList {
  // the pairs whose newest decision is on a current second
  scanned: number;
  // those of them that decided a signal, in the order their seconds closed
  signals: H1ScannerSignal[];
}

export interface H1Scanner {
  start(): void;
  fresh(nowMs: number): H1ScannerList;
  // the pair's served signal, null without one
  current(assetId: number, nowMs: number): H1SignalWire | null;
  // the `h1 scanner` line, totals since start, the lag over the period
  report(): void;
  stop(): void;
}

interface Entry {
  second: number;
  takenAtMs: number;
  decision: H1Decision;
}

const percentile = (sorted: readonly number[], p: number) =>
  sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];

export function createH1Scanner(deps: H1ScannerDeps): H1Scanner {
  const { series, catalog, streaming, params = H1_SCANNER_PARAMS, logger, config } = deps;
  const now = deps.now ?? Date.now;
  assertH1WindowFits(params, 'h1 scanner');
  const detector = createH1Detector(params);
  const length = params.sdWindowSec + 1;
  const entries = new Map<number, Entry>();
  const counts = {
    decisions: 0,
    signals: 0,
    warming: 0,
    ineligible: 0,
    sourceDown: 0,
    catalogStale: 0,
    errors: 0,
  };
  const noSignal: Record<string, number> = {};
  // takenAtMs - f of the period's decisions
  let lags: number[] = [];
  let staleWarned = false;
  let unsubscribe: (() => void) | undefined;
  let logTimer: NodeJS.Timeout | undefined;
  let stopped = false;

  function decide({ assetId, second: f }: ClosedSecond) {
    if (!streaming()) {
      counts.sourceDown += 1;
      entries.clear();
      return;
    }
    const view = catalog.read();
    if (view?.fresh !== true) {
      counts.catalogStale += 1;
      if (!staleWarned) {
        staleWarned = true;
        logger.warn({ ageMs: view?.ageMs ?? null }, 'h1 scanner skipped: no fresh catalog');
      }
      return;
    }
    staleWarned = false;
    const pair = view.pairs.find((candidate) => candidate.id === assetId);
    if (
      pair === undefined ||
      !isPairOpen(pair, now()) ||
      !pairAcceptsDuration(pair, H1_EXPIRY_SEC)
    ) {
      counts.ineligible += 1;
      entries.delete(assetId);
      return;
    }
    const { closes, complete } = series.window(assetId, f, length);
    if (!complete) {
      counts.warming += 1;
      entries.delete(assetId);
      return;
    }
    const decision = detector.decide({ closes, at: length - 1 });
    const takenAtMs = now();
    lags.push(takenAtMs - f);
    counts.decisions += 1;
    if (decision.kind === SignalKind.Signal) counts.signals += 1;
    else noSignal[decision.reason] = (noSignal[decision.reason] ?? 0) + 1;
    entries.set(assetId, { second: f, takenAtMs, decision });
  }

  function onClosed(closed: ClosedSecond) {
    if (stopped) return;
    try {
      decide(closed);
    } catch (error) {
      counts.errors += 1;
      logger.warn(
        { assetId: closed.assetId, ...errorLogFields(error) },
        'h1 scanner decision failed',
      );
    }
  }

  const isCurrent = (entry: Entry, nowMs: number) => nowMs - entry.second <= config.maxAgeMs;

  function served(entry: Entry, nowMs: number): H1SignalWire | null {
    if (!isCurrent(entry, nowMs) || entry.decision.kind !== SignalKind.Signal) return null;
    return {
      action: entry.decision.action,
      second: entry.second,
      decidedAt: entry.takenAtMs,
      ageMs: Math.max(0, nowMs - entry.second),
    };
  }

  function fresh(nowMs: number): H1ScannerList {
    let scanned = 0;
    const signals: H1ScannerSignal[] = [];
    for (const [assetId, entry] of entries) {
      if (!isCurrent(entry, nowMs)) continue;
      scanned += 1;
      const signal = served(entry, nowMs);
      if (signal !== null) signals.push({ assetId, ...signal });
    }
    return { scanned, signals };
  }

  function current(assetId: number, nowMs: number): H1SignalWire | null {
    const entry = entries.get(assetId);
    return entry === undefined ? null : served(entry, nowMs);
  }

  function report() {
    if (stopped) return;
    const sorted = [...lags].sort((a, b) => a - b);
    lags = [];
    const listed = fresh(now());
    logger.info(
      {
        pairs: entries.size,
        current: listed.scanned,
        listed: listed.signals.length,
        ...counts,
        noSignal,
        lagMsP50: percentile(sorted, 0.5),
        lagMsP95: percentile(sorted, 0.95),
      },
      'h1 scanner',
    );
  }

  return {
    start() {
      if (stopped || unsubscribe !== undefined) return;
      unsubscribe = series.onClosed(onClosed);
      logTimer = setInterval(report, config.logMs);
    },
    fresh,
    current,
    report,
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(logTimer);
      unsubscribe?.();
      entries.clear();
    },
  };
}
