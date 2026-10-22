import type { FastifyBaseLogger } from 'fastify';
import {
  errorLogFields,
  H1_EXPIRY_SEC,
  H1_SESSION_DECISION_SET,
  H1_VERSION,
  isH1Settings,
  isPairOpen,
  pairAcceptsDuration,
  safeParseTradingSessionSettings,
  SESSION_INTENT_REFUSALS,
  SESSION_MAX_DURATION_MS,
  sessionIntentBlock,
  SessionIntentBlockReason,
  sessionNoSignalTimeoutMs,
  SignalDecisionContext,
  SignalDecisionOutcome,
  SignalKind,
  type H1Decision,
  type H1SecondClosedBy,
  type H1SessionSettings,
  type H1ShadowParams,
  type H1ShadowSource,
  type LastTick,
  type TradingSessionStopReason,
} from '@binarius/shared';
import type { PairsCatalog } from '@binarius/broker-rest';
import {
  TradeIntentError,
  TradingSessionNotActiveError,
  type ActiveH1Session,
  type CreateSessionIntentInput,
  type CreateTradeIntentResult,
  type SessionHistory,
  type readSessionHistory,
  type SignalDecisionInput,
} from '@binarius/db';
import { assertH1WindowFits, createH1Detector, type H1Detector } from '@binarius/signal';
import type { ClosedSecond, SecondSeries } from '../market-data/seconds';

// The H1 driver (#707, docs/h1.md -> The driver, Rule 48): on every closed second of the pair of an
// active H1 session on a marked account, the session's detector decides on the series' window; a
// signal of a session with no live intent and inside its limits becomes an intent with a submit
// deadline, its signal_decisions row in the intent's transaction, then a publisher wake. It never
// reads the payout and stops a session only on a stop refusal of createSessionIntent: the limits'
// stops are the orchestrator's.

export interface H1DriverConfig {
  // how often the active H1 sessions are read
  scanMs: number;
  // the period of series.advance(): with H1_SHADOW=off the driver alone closes quiet seconds
  tickMs: number;
  logMs: number;
  // submit_deadline_at = taken_at_ms + this (H1_SUBMIT_BUDGET_MS)
  submitBudgetMs: number;
}

export interface H1DriverSessions {
  list(): Promise<ActiveH1Session[]>;
  history(
    id: string,
    options: Parameters<typeof readSessionHistory>[2],
  ): Promise<SessionHistory | undefined>;
  createIntent(input: CreateSessionIntentInput): Promise<CreateTradeIntentResult>;
  // the CAS stop: undefined when another writer stopped the session first
  stop(id: string, reason: TradingSessionStopReason): Promise<unknown>;
  record(input: SignalDecisionInput): Promise<unknown>;
}

export interface H1DriverDeps {
  series: Pick<SecondSeries, 'onClosed' | 'advance' | 'window' | 'lastTickOf' | 'digitsOf'>;
  catalog: Pick<PairsCatalog, 'read'>;
  // the data socket's active client is ready
  streaming: () => boolean;
  sessions: H1DriverSessions;
  // after a created intent's commit: the publisher sends it now, not at its next poll
  wake: () => void;
  logger: Pick<FastifyBaseLogger, 'info' | 'warn'>;
  now?: () => number;
  config: H1DriverConfig;
}

export interface H1Driver {
  start(): void;
  // one read of the active H1 sessions; start() runs it every scanMs
  scan(): Promise<void>;
  // the `h1 driver` line, totals since start
  report(): void;
  stop(): Promise<void>;
}

// what a decision at f captured for its row: the facts of that second, not of the later write
export interface H1DriverDecisionFacts {
  sessionId: string;
  brokerAccountId: string;
  settings: H1SessionSettings;
  assetId: number;
  f: number;
  takenAtMs: number;
  decision: H1Decision & { kind: typeof SignalKind.Signal };
  payout: number;
  digits: number;
  symbol: string;
  closedBy: H1SecondClosedBy;
  closedAtMs: number;
  series: (number | null)[];
  lastTick: LastTick | null;
}

const SECOND_MS = 1_000;

export function h1DriverParams(settings: H1SessionSettings): H1ShadowParams {
  return {
    set: H1_SESSION_DECISION_SET,
    ...settings.signal.params,
    entryDelaySec: settings.signal.entryDelaySec,
    expirySec: settings.signal.expirySec,
  };
}

// The driver's row: the shadow row's shape (params.set = session), so the export's replay reads it
// as it reads a shadow row; a session's writer leaves ticks_until_ms NULL (the keeper counts the
// window from the trade's close)
export function h1DriverDecisionInput(
  facts: H1DriverDecisionFacts,
  step: number,
  outcome: typeof SignalDecisionOutcome.Intent | typeof SignalDecisionOutcome.Refused,
  detail: string | null,
): SignalDecisionInput {
  const source: H1ShadowSource = {
    kind: 'ticks',
    symbol: facts.symbol,
    closedBy: facts.closedBy,
    closedAtMs: facts.closedAtMs,
  };
  return {
    context: SignalDecisionContext.Session,
    tradingSessionId: facts.sessionId,
    brokerAccountId: facts.brokerAccountId,
    step,
    assetId: facts.assetId,
    interval: null,
    version: H1_VERSION,
    decidedAtMs: facts.f,
    takenAtMs: facts.takenAtMs,
    kind: SignalKind.Signal,
    action: facts.decision.action,
    payout: facts.payout,
    digits: facts.digits,
    params: h1DriverParams(facts.settings),
    decision: facts.decision,
    source,
    series: facts.series,
    lastTick: facts.lastTick,
    outcome,
    detail,
    ticksUntilMs: null,
  };
}

interface Tracked {
  session: ActiveH1Session;
  settings: H1SessionSettings;
  detector: H1Detector;
  // a trade() in flight: the next signal of the session is skipped
  busy: boolean;
  // the first second the session may decide again (one trade at a time)
  nextAt: number;
}

const percentile = (sorted: readonly number[], p: number) =>
  sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];

export function createH1Driver(deps: H1DriverDeps): H1Driver {
  const { series, catalog, streaming, sessions, wake, logger, config } = deps;
  const now = deps.now ?? Date.now;
  const tracked = new Map<string, Tracked>();
  // forgotten until a scan no longer lists them: a session whose row is gone or no longer active,
  // or one the driver stopped
  const gone = new Set<string>();
  // listed sessions the driver cannot decide for (settings, window); warned once each
  const invalid = new Set<string>();
  const inflight = new Set<Promise<void>>();
  const counts = {
    decisions: 0,
    signals: 0,
    intents: 0,
    replayed: 0,
    refused: 0,
    stops: 0,
    skippedLive: 0,
    held: 0,
    warming: 0,
    ineligible: 0,
    sourceDown: 0,
    catalogStale: 0,
    gone: 0,
    failed: 0,
    errors: 0,
  };
  const skippedLimits: Record<string, number> = {};
  const noSignal: Record<string, number> = {};
  let lags: number[] = [];
  let staleWarned = false;
  let scanning: Promise<void> | undefined;
  let unsubscribe: (() => void) | undefined;
  let scanTimer: NodeJS.Timeout | undefined;
  let tickTimer: NodeJS.Timeout | undefined;
  let logTimer: NodeJS.Timeout | undefined;
  let stopped = false;

  function track(job: Promise<void>) {
    inflight.add(job);
    void job.finally(() => inflight.delete(job));
  }

  function forget(id: string) {
    tracked.delete(id);
    gone.add(id);
  }

  function add(session: ActiveH1Session) {
    const parsed = safeParseTradingSessionSettings(session.settings);
    try {
      if (!parsed.success || !isH1Settings(parsed.data)) {
        throw new TypeError('the settings are not H1 settings');
      }
      assertH1WindowFits(parsed.data.signal.params, `h1 session ${session.id}`);
      tracked.set(session.id, {
        session,
        settings: parsed.data,
        detector: createH1Detector(parsed.data.signal.params),
        busy: false,
        nextAt: -Infinity,
      });
    } catch (error) {
      invalid.add(session.id);
      logger.warn(
        { sessionId: session.id, reason: 'invalidSettings', ...errorLogFields(error) },
        'h1 driver session skipped',
      );
    }
  }

  async function readSessions() {
    const list = await sessions.list();
    if (stopped) return;
    const listed = new Set(list.map((session) => session.id));
    for (const id of gone) if (!listed.has(id)) gone.delete(id);
    for (const id of invalid) if (!listed.has(id)) invalid.delete(id);
    for (const id of tracked.keys()) if (!listed.has(id)) tracked.delete(id);
    for (const session of list) {
      if (tracked.has(session.id) || gone.has(session.id) || invalid.has(session.id)) continue;
      add(session);
    }
  }

  function scan(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (scanning !== undefined) return scanning;
    const job = readSessions()
      .catch((error: unknown) => {
        counts.errors += 1;
        logger.warn(errorLogFields(error), 'h1 driver scan failed');
      })
      .finally(() => {
        scanning = undefined;
      });
    scanning = job;
    track(job);
    return job;
  }

  async function stopSession(state: Tracked, reason: TradingSessionStopReason, code: string) {
    const ids = { sessionId: state.session.id, brokerAccountId: state.session.brokerAccountId };
    try {
      const row = await sessions.stop(state.session.id, reason);
      if (row === undefined) {
        logger.info({ ...ids, code }, 'h1 driver session already stopped');
      } else {
        counts.stops += 1;
        logger.warn({ ...ids, reason, code }, 'h1 driver stopped the session');
      }
      forget(state.session.id);
    } catch (error) {
      counts.errors += 1;
      logger.warn({ ...ids, reason, code, ...errorLogFields(error) }, 'h1 driver stop failed');
    }
  }

  async function recordRefused(facts: H1DriverDecisionFacts, step: number, code: string) {
    try {
      await sessions.record(
        h1DriverDecisionInput(facts, step, SignalDecisionOutcome.Refused, code),
      );
    } catch (error) {
      counts.failed += 1;
      logger.warn(
        { sessionId: facts.sessionId, step, ...errorLogFields(error) },
        'h1 driver decision not recorded',
      );
    }
  }

  async function trade(state: Tracked, facts: H1DriverDecisionFacts) {
    const { session, settings } = state;
    const ids = { sessionId: session.id, brokerAccountId: session.brokerAccountId };
    // the orchestrator's reading of the same history (Rule 48): the driver skips where it stops
    const history = await sessions.history(session.id, {
      maxDurationMs: SESSION_MAX_DURATION_MS,
      noSignalTimeoutMs: sessionNoSignalTimeoutMs(settings.durationSec),
      lossLimit: { maxLoss: settings.maxLoss, nextStake: settings.stake.baseStake },
    });
    if (stopped) return;
    if (history === undefined) {
      counts.gone += 1;
      forget(session.id);
      return;
    }
    const block = sessionIntentBlock(history, settings);
    if (block !== null) {
      if (block.reason === SessionIntentBlockReason.Live) counts.skippedLive += 1;
      else skippedLimits[block.reason] = (skippedLimits[block.reason] ?? 0) + 1;
      return;
    }
    const step = history.intents.length + 1;
    let created: CreateTradeIntentResult;
    try {
      created = await sessions.createIntent({
        sessionId: session.id,
        step,
        telegramUserId: history.telegramUserId,
        brokerAccountId: session.brokerAccountId,
        mode: session.mode,
        assetId: settings.assetId,
        amount: settings.stake.baseStake,
        action: facts.decision.action,
        durationSec: settings.durationSec,
        decision: h1DriverDecisionInput(facts, step, SignalDecisionOutcome.Intent, null),
        submitDeadlineAt: new Date(facts.takenAtMs + config.submitBudgetMs),
      });
    } catch (error) {
      if (error instanceof TradingSessionNotActiveError) {
        counts.gone += 1;
        forget(session.id);
        return;
      }
      if (!(error instanceof TradeIntentError)) throw error;
      counts.refused += 1;
      const refusal = SESSION_INTENT_REFUSALS[error.code];
      if (refusal.kind === 'stop') await stopSession(state, refusal.reason, error.code);
      else logger.warn({ ...ids, step, code: error.code }, 'h1 driver intent refused');
      await recordRefused(facts, step, error.code);
      return;
    }
    state.nextAt =
      facts.f + (settings.signal.entryDelaySec + settings.signal.expirySec + 1) * SECOND_MS;
    if (!created.created) {
      counts.replayed += 1;
      logger.info({ ...ids, step, intentId: created.intent.id }, 'h1 driver step replayed');
      return;
    }
    counts.intents += 1;
    if (created.decisionError !== undefined) {
      logger.warn(
        { ...ids, step, reason: 'insert_refused', ...errorLogFields(created.decisionError) },
        'h1 driver decision not recorded',
      );
    }
    if (!stopped) wake();
  }

  function launch(state: Tracked, facts: H1DriverDecisionFacts) {
    state.busy = true;
    const job = trade(state, facts)
      .catch((error: unknown) => {
        counts.errors += 1;
        logger.warn(
          { sessionId: state.session.id, ...errorLogFields(error) },
          'h1 driver trade failed',
        );
      })
      .finally(() => {
        state.busy = false;
      });
    track(job);
  }

  function decide({ assetId, second: f, closedBy, closedAtMs }: ClosedSecond) {
    const own = [...tracked.values()].filter((state) => state.settings.assetId === assetId);
    if (own.length === 0) return;
    if (!streaming()) {
      counts.sourceDown += 1;
      return;
    }
    const view = catalog.read();
    if (view?.fresh !== true) {
      counts.catalogStale += 1;
      if (!staleWarned) {
        staleWarned = true;
        logger.warn({ ageMs: view?.ageMs ?? null }, 'h1 driver skipped: no fresh catalog');
      }
      return;
    }
    staleWarned = false;
    const pair = view.pairs.find((candidate) => candidate.id === assetId);
    // no payout check: a payout that falls during the session does not stop it (owner 2026-10-19)
    if (
      pair === undefined ||
      !isPairOpen(pair, now()) ||
      !pairAcceptsDuration(pair, H1_EXPIRY_SEC)
    ) {
      counts.ineligible += 1;
      return;
    }
    const digits = series.digitsOf(assetId);
    if (digits === undefined) return;
    for (const state of own) {
      if (state.busy) {
        counts.skippedLive += 1;
        continue;
      }
      if (f < state.nextAt) {
        counts.held += 1;
        continue;
      }
      const length = state.settings.signal.params.sdWindowSec + 1;
      const { closes, complete } = series.window(assetId, f, length);
      if (!complete) {
        counts.warming += 1;
        continue;
      }
      const decision = state.detector.decide({ closes, at: length - 1 });
      const takenAtMs = now();
      counts.decisions += 1;
      lags.push(takenAtMs - f);
      if (decision.kind === SignalKind.NoSignal) {
        noSignal[decision.reason] = (noSignal[decision.reason] ?? 0) + 1;
        continue;
      }
      counts.signals += 1;
      launch(state, {
        sessionId: state.session.id,
        brokerAccountId: state.session.brokerAccountId,
        settings: state.settings,
        assetId,
        f,
        takenAtMs,
        decision,
        payout: pair.payout,
        digits,
        symbol: pair.symbol,
        closedBy,
        closedAtMs,
        series: Array.from(closes, (close) => (Number.isNaN(close) ? null : close)),
        lastTick: series.lastTickOf(assetId, f) ?? null,
      });
    }
  }

  function onClosed(closed: ClosedSecond) {
    if (stopped) return;
    try {
      decide(closed);
    } catch (error) {
      counts.errors += 1;
      logger.warn(
        { assetId: closed.assetId, ...errorLogFields(error) },
        'h1 driver decision failed',
      );
    }
  }

  function tick() {
    try {
      series.advance(now());
    } catch (error) {
      counts.errors += 1;
      logger.warn(errorLogFields(error), 'h1 driver tick failed');
    }
  }

  function report() {
    if (stopped) return;
    const sorted = [...lags].sort((a, b) => a - b);
    lags = [];
    logger.info(
      {
        sessions: tracked.size,
        ...counts,
        skippedLimits,
        noSignal,
        invalidSettings: invalid.size,
        inflight: inflight.size,
        lagMsP50: percentile(sorted, 0.5),
        lagMsP95: percentile(sorted, 0.95),
      },
      'h1 driver',
    );
  }

  return {
    start() {
      if (stopped || unsubscribe !== undefined) return;
      unsubscribe = series.onClosed(onClosed);
      void scan();
      scanTimer = setInterval(() => void scan(), config.scanMs);
      tickTimer = setInterval(tick, config.tickMs);
      logTimer = setInterval(report, config.logMs);
    },
    scan,
    report,
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(scanTimer);
      clearInterval(tickTimer);
      clearInterval(logTimer);
      unsubscribe?.();
      const pending = inflight.size;
      await Promise.allSettled([...inflight]);
      logger.info({ inflight: pending }, 'h1 driver stopped');
      tracked.clear();
    },
  };
}
