import type { FastifyBaseLogger } from 'fastify';
import {
  errorLogFields,
  H1_ENTRY_WINDOW_SEC,
  H1_EXPIRY_SEC,
  H1_MIN_PAYOUT_PCT,
  H1_VERSION,
  H1ShadowEntryOutcome,
  isPairOpen,
  pairAcceptsDuration,
  SignalDecisionContext,
  SignalDecisionOutcome,
  SignalKind,
  tradeOutcomeOf,
  type H1Decision,
  type H1SecondClosedBy,
  type H1ShadowParams,
  type H1ShadowResult,
  type H1ShadowSet,
  type H1ShadowSource,
  type LastTick,
  type TradeAction,
} from '@binarius/shared';
import type { PairsCatalog } from '@binarius/broker-rest';
import type { SignalDecisionInput } from '@binarius/db';
import {
  assertH1ShadowSet,
  createH1Detector,
  H1_SHADOW_SETS,
  type H1ShadowSetSpec,
} from '@binarius/signal';
import type { ClosedSecond, SecondSeries } from '../market-data/seconds';

// The H1 shadow (#669, docs/h1.md -> The shadow, Rule 44): on every closed second of every pair
// a live trade of #670 could take, both sets decide with the H1 detector; a signal becomes one
// signal_decisions row once the seconds its outcome rests on are closed. It never trades.

export interface H1ShadowConfig {
  // the period of series.advance() and of the sweep
  tickMs: number;
  logMs: number;
  // the series' capacity: an outcome older than it can no longer be priced
  capacitySec: number;
}

export interface H1ShadowDeps {
  series: Pick<
    SecondSeries,
    'onClosed' | 'advance' | 'window' | 'close' | 'lastTickOf' | 'digitsOf'
  >;
  catalog: Pick<PairsCatalog, 'read'>;
  // the data socket's active client is ready
  streaming: () => boolean;
  record: (input: SignalDecisionInput) => Promise<unknown>;
  logger: Pick<FastifyBaseLogger, 'info' | 'warn'>;
  now?: () => number;
  sets?: readonly H1ShadowSetSpec[];
  config: H1ShadowConfig;
}

export interface H1Shadow {
  start(): void;
  // the `h1 shadow` line, totals since start
  report(): void;
  stop(): Promise<void>;
}

// a signal waiting for the seconds of its outcome
export interface H1PendingOutcome {
  set: H1ShadowSetSpec;
  assetId: number;
  f: number;
  decision: H1Decision & { kind: typeof SignalKind.Signal };
  series: (number | null)[];
  payout: number;
  digits: number;
  symbol: string;
  takenAtMs: number;
  closedBy: H1SecondClosedBy;
  closedAtMs: number;
  lastTick: LastTick | null;
  untilSec: number;
}

const SECOND_MS = 1_000;
const ENTRY_DELAYS_SEC = Array.from(
  { length: H1_ENTRY_WINDOW_SEC.to - H1_ENTRY_WINDOW_SEC.from + 1 },
  (_, i) => H1_ENTRY_WINDOW_SEC.from + i,
);
// the last second a row's prices rest on: the exit of the latest entry
export const H1_SHADOW_UNTIL_MS = (H1_ENTRY_WINDOW_SEC.to + H1_EXPIRY_SEC) * SECOND_MS;

export function h1ShadowParams(set: H1ShadowSetSpec): H1ShadowParams {
  return {
    set: set.name,
    ...set.params,
    entryDelaySec: set.entryDelaySec,
    expirySec: H1_EXPIRY_SEC,
  };
}

export function h1ShadowResult(
  action: TradeAction,
  priceAt: (second: number) => number,
  f: number,
): H1ShadowResult {
  return {
    entries: ENTRY_DELAYS_SEC.map((g) => {
      const entry = priceAt(f + g * SECOND_MS);
      const exit = priceAt(f + (g + H1_EXPIRY_SEC) * SECOND_MS);
      return Number.isNaN(entry) || Number.isNaN(exit)
        ? {
            entryDelaySec: g,
            entryPrice: null,
            exitPrice: null,
            outcome: H1ShadowEntryOutcome.Unpriced,
          }
        : {
            entryDelaySec: g,
            entryPrice: entry,
            exitPrice: exit,
            outcome: tradeOutcomeOf(action, entry, exit),
          };
    }),
  };
}

export function h1ShadowDecisionInput(
  pending: H1PendingOutcome,
  result: H1ShadowResult,
): SignalDecisionInput {
  const source: H1ShadowSource = {
    kind: 'ticks',
    symbol: pending.symbol,
    closedBy: pending.closedBy,
    closedAtMs: pending.closedAtMs,
  };
  return {
    context: SignalDecisionContext.Shadow,
    tradingSessionId: null,
    brokerAccountId: null,
    step: null,
    assetId: pending.assetId,
    interval: null,
    version: H1_VERSION,
    decidedAtMs: pending.f,
    takenAtMs: pending.takenAtMs,
    kind: SignalKind.Signal,
    action: pending.decision.action,
    payout: pending.payout,
    digits: pending.digits,
    params: h1ShadowParams(pending.set),
    decision: pending.decision,
    source,
    series: pending.series,
    lastTick: pending.lastTick,
    outcome: SignalDecisionOutcome.Shadow,
    detail: null,
    result,
    ticksUntilMs: pending.f + H1_SHADOW_UNTIL_MS,
  };
}

interface SetTotals {
  decisions: number;
  signals: number;
  rows: number;
  // rows with an unpriced entry
  unpriced: number;
  noSignal: Record<string, number>;
}

const percentile = (sorted: readonly number[], p: number) =>
  sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];

export function createH1Shadow(deps: H1ShadowDeps): H1Shadow {
  const { series, catalog, streaming, record, logger, config } = deps;
  const now = deps.now ?? Date.now;
  const sets = (deps.sets ?? H1_SHADOW_SETS).map((set) => {
    assertH1ShadowSet(set);
    return { set, detector: createH1Detector(set.params) };
  });
  // assetId -> the pending outcomes of its sets (at most one per set: the cadence)
  const pending = new Map<number, H1PendingOutcome[]>();
  // `${assetId}|${set}` -> the first second the set may decide again
  const nextAt = new Map<string, number>();
  const inflight = new Set<Promise<void>>();
  const totals = new Map<H1ShadowSet, SetTotals>(
    sets.map(({ set }) => [
      set.name,
      { decisions: 0, signals: 0, rows: 0, unpriced: 0, noSignal: {} },
    ]),
  );
  const skips = { warming: 0, ineligible: 0, sourceDown: 0, catalogStale: 0 };
  let failed = 0;
  let dropped = 0;
  let errors = 0;
  // takenAtMs - f of the period's decisions
  let lags: number[] = [];
  let staleWarned = false;
  let unsubscribe: (() => void) | undefined;
  let tickTimer: NodeJS.Timeout | undefined;
  let logTimer: NodeJS.Timeout | undefined;
  let stopped = false;

  function write(item: H1PendingOutcome) {
    const result = h1ShadowResult(
      item.decision.action,
      (second) => series.close(item.assetId, second),
      item.f,
    );
    const set = totals.get(item.set.name)!;
    set.rows += 1;
    if (result.entries.some((entry) => entry.outcome === H1ShadowEntryOutcome.Unpriced)) {
      set.unpriced += 1;
    }
    const job = Promise.resolve()
      .then(() => record(h1ShadowDecisionInput(item, result)))
      .then(
        () => undefined,
        (error: unknown) => {
          failed += 1;
          logger.warn(
            { assetId: item.assetId, set: item.set.name, ...errorLogFields(error) },
            'h1 shadow decision not recorded',
          );
        },
      )
      .finally(() => inflight.delete(job));
    inflight.add(job);
  }

  function settle(assetId: number, f: number) {
    const own = pending.get(assetId);
    if (own === undefined) return;
    const due = own.filter((item) => item.untilSec === f);
    if (due.length === 0) return;
    const rest = own.filter((item) => item.untilSec !== f);
    if (rest.length === 0) pending.delete(assetId);
    else pending.set(assetId, rest);
    for (const item of due) write(item);
  }

  function decide({ assetId, second: f, closedBy, closedAtMs }: ClosedSecond) {
    settle(assetId, f);
    if (!streaming()) {
      skips.sourceDown += 1;
      return;
    }
    const view = catalog.read();
    if (view?.fresh !== true) {
      skips.catalogStale += 1;
      if (!staleWarned) {
        staleWarned = true;
        logger.warn({ ageMs: view?.ageMs ?? null }, 'h1 shadow skipped: no fresh catalog');
      }
      return;
    }
    staleWarned = false;
    const at = now();
    const pair = view.pairs.find((candidate) => candidate.id === assetId);
    if (
      pair === undefined ||
      !(pair.payout >= H1_MIN_PAYOUT_PCT) ||
      !isPairOpen(pair, at) ||
      !pairAcceptsDuration(pair, H1_EXPIRY_SEC)
    ) {
      skips.ineligible += 1;
      return;
    }
    const digits = series.digitsOf(assetId);
    if (digits === undefined) return;
    for (const { set, detector } of sets) {
      const key = `${assetId}|${set.name}`;
      if (f < (nextAt.get(key) ?? -Infinity)) continue;
      const length = set.params.sdWindowSec + 1;
      const { closes, complete } = series.window(assetId, f, length);
      if (!complete) {
        skips.warming += 1;
        continue;
      }
      const decision = detector.decide({ closes, at: length - 1 });
      const takenAtMs = now();
      lags.push(takenAtMs - f);
      const own = totals.get(set.name)!;
      own.decisions += 1;
      if (decision.kind === SignalKind.NoSignal) {
        own.noSignal[decision.reason] = (own.noSignal[decision.reason] ?? 0) + 1;
        continue;
      }
      own.signals += 1;
      const item: H1PendingOutcome = {
        set,
        assetId,
        f,
        decision,
        series: Array.from(closes, (close) => (Number.isNaN(close) ? null : close)),
        payout: pair.payout,
        digits,
        symbol: pair.symbol,
        takenAtMs,
        closedBy,
        closedAtMs,
        lastTick: series.lastTickOf(assetId, f) ?? null,
        untilSec: f + H1_SHADOW_UNTIL_MS,
      };
      pending.set(assetId, [...(pending.get(assetId) ?? []), item]);
      nextAt.set(key, f + (set.entryDelaySec + H1_EXPIRY_SEC + 1) * SECOND_MS);
    }
  }

  function onClosed(closed: ClosedSecond) {
    if (stopped) return;
    try {
      decide(closed);
    } catch (error) {
      errors += 1;
      logger.warn(
        { assetId: closed.assetId, ...errorLogFields(error) },
        'h1 shadow decision failed',
      );
    }
  }

  function tick() {
    try {
      sweep();
    } catch (error) {
      errors += 1;
      logger.warn(errorLogFields(error), 'h1 shadow tick failed');
    }
  }

  function sweep() {
    const at = now();
    series.advance(at);
    const oldest = at - config.capacitySec * SECOND_MS;
    for (const [assetId, own] of pending) {
      const kept = own.filter((item) => item.untilSec >= oldest);
      dropped += own.length - kept.length;
      if (kept.length === 0) pending.delete(assetId);
      else pending.set(assetId, kept);
    }
  }

  const pendingCount = () => [...pending.values()].reduce((sum, own) => sum + own.length, 0);

  function report() {
    if (stopped) return;
    const sorted = [...lags].sort((a, b) => a - b);
    lags = [];
    logger.info(
      {
        sets: Object.fromEntries(totals),
        ...skips,
        pending: pendingCount(),
        inflight: inflight.size,
        failed,
        dropped,
        errors,
        lagMsP50: percentile(sorted, 0.5),
        lagMsP95: percentile(sorted, 0.95),
      },
      'h1 shadow',
    );
  }

  return {
    start() {
      if (stopped || unsubscribe !== undefined) return;
      unsubscribe = series.onClosed(onClosed);
      tickTimer = setInterval(tick, config.tickMs);
      logTimer = setInterval(report, config.logMs);
    },
    report,
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(tickTimer);
      clearInterval(logTimer);
      unsubscribe?.();
      await Promise.allSettled([...inflight]);
      logger.info({ pending: pendingCount() }, 'h1 shadow stopped');
      pending.clear();
    },
  };
}
