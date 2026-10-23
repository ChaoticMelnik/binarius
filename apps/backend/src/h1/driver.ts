import type { FastifyBaseLogger } from 'fastify';
import {
  errorLogFields,
  H1_EXPIRY_SEC,
  H1_REPEAT_VERSION,
  H1_SESSION_DECISION_SET,
  H1_VERSION,
  H1NoSignalReason,
  isH1Settings,
  isPairOpen,
  isWin,
  pairAcceptsDuration,
  safeParseTradingSessionSettings,
  SESSION_INTENT_REFUSALS,
  SESSION_MAX_DURATION_MS,
  sessionIntentBlock,
  SessionIntentBlockReason,
  sessionNoSignalTimeoutMs,
  sessionStakeParams,
  SessionStakeStrategy,
  SessionTradeResult,
  sessionTradeSteps,
  SignalDecisionContext,
  SignalDecisionOutcome,
  SignalKind,
  TradeIntentStatus,
  TradingSessionStopReason,
  type BinaryPair,
  type DecimalString,
  type H1Decision,
  type H1SecondClosedBy,
  type H1SessionSettings,
  type H1ShadowParams,
  type H1ShadowSource,
  type LastTick,
  type TradeAction,
} from '@binarius/shared';
import type { PairsCatalog } from '@binarius/broker-rest';
import {
  TradeIntentError,
  TradingSessionNotActiveError,
  type ActiveH1Session,
  type CreateSessionIntentInput,
  type CreateTradeIntentResult,
  type SessionBalanceRead,
  type SessionHistory,
  type readSessionHistory,
  type SignalDecisionInput,
} from '@binarius/db';
import { assertH1WindowFits, createH1Detector, type H1Detector } from '@binarius/signal';
import {
  createStakeSizer,
  sessionStakeInput,
  StakeKind,
  StopReason,
  type StakeSizer,
} from '@binarius/stake';
import type { ClosedSecond, SecondSeries } from '../market-data/seconds';

// The H1 driver (#707, #775, docs/h1.md -> The driver, Rule 48): an H1 session is a regular
// session whose entries come from H1. On every closed second of the pair of an active H1 session
// on a marked account, the session's detector decides on the series' window; a signal of a session
// with no live intent and inside its limits becomes an intent of the session's sizer's stake with
// a submit deadline, its signal_decisions row in the intent's transaction, then a publisher wake.
// Шаг 2 after a lost or tied Шаг 1 is the repeat step: created at the settlement's notice, in that
// trade's direction, without a window. A no_signal second opens a waiting period, recorded once.
// It never reads the payout as a gate and stops a session on a stop refusal of createSessionIntent
// and at the no-signal limit, counted on the seconds the detector decided no_signal (#775, review
// round 1): the attempt never asks H1, so only the driver has that evidence. The other limits'
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
  // the session's balance as the orchestrator reads it (#696): awaitsBalance within waitMs
  balance(id: string, options: { waitMs: number }): Promise<SessionBalanceRead | undefined>;
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
  // a session's intent became accepted or settled (the SESSION_NOTICE_CHANNEL payload, #723): the
  // repeat step may be due. Never throws
  notice(sessionId: string): void;
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
  decision: H1Decision;
  payout: number;
  digits: number;
  symbol: string;
  closedBy: H1SecondClosedBy;
  closedAtMs: number;
  series: (number | null)[];
  lastTick: LastTick | null;
}

// the H1 signal's facts: the detector decided to trade
export type H1DriverSignalFacts = H1DriverDecisionFacts & {
  decision: H1Decision & { kind: typeof SignalKind.Signal };
};

const SECOND_MS = 1_000;

// what started the run that created the repeat step (#775): a jsonb value of its row, not a status
export const H1RepeatTrigger = { Notice: 'notice', Signal: 'signal', Tick: 'tick' } as const;
export type H1RepeatTrigger = (typeof H1RepeatTrigger)[keyof typeof H1RepeatTrigger];

// The repeat step is due (#775, В1): under martingale, the session's last intent is a settled
// Шаг 1 that did not win (a loss or a tie) - its position by sessionTradeSteps, the numbering of
// the session's messages, so the next trade is Шаг 2. Under fixed there is no Шаг 2: never. A
// settled intent without its profit is not known yet: nothing is due.
export interface H1RepeatStep {
  intentId: string;
  action: TradeAction;
  profit: DecimalString;
}

const resultOf = (profit: DecimalString): SessionTradeResult =>
  isWin(profit)
    ? SessionTradeResult.Won
    : /[1-9]/.test(profit) && profit.startsWith('-')
      ? SessionTradeResult.Lost
      : SessionTradeResult.Tied;

export function repeatDue(
  history: Pick<SessionHistory, 'intents'>,
  settings: H1SessionSettings,
): H1RepeatStep | null {
  const { strategy } = sessionStakeParams(settings);
  if (strategy !== SessionStakeStrategy.Martingale) return null;
  const last = history.intents.at(-1);
  if (last === undefined || last.status !== TradeIntentStatus.Settled || last.profit === null) {
    return null;
  }
  if (isWin(last.profit)) return null;
  const results = history.intents.flatMap((intent) =>
    intent.status === TradeIntentStatus.Settled && intent.profit !== null
      ? [resultOf(intent.profit)]
      : [],
  );
  const position = sessionTradeSteps(results, strategy).at(-1);
  if (position?.step !== 1) return null;
  return { intentId: last.id, action: last.action, profit: last.profit };
}

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
// window from the trade's close). A no_signal decision is the waiting period's row (#775): the
// row waitingForSignalSql reads
export function h1DriverDecisionInput(
  facts: H1DriverDecisionFacts,
  step: number,
  outcome:
    | typeof SignalDecisionOutcome.Intent
    | typeof SignalDecisionOutcome.Refused
    | typeof SignalDecisionOutcome.NoSignal,
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
    kind: facts.decision.kind,
    action: facts.decision.kind === SignalKind.Signal ? facts.decision.action : null,
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

// The repeat step's row (#775, docs/trade-log.md -> The H1 driver): decided by the rule, not the
// detector - no series, no tick, the settled trade it repeats in `decision.after`
export function h1RepeatDecisionInput(input: {
  sessionId: string;
  brokerAccountId: string;
  assetId: number;
  step: number;
  takenAtMs: number;
  payout: number;
  strategy: SessionStakeStrategy;
  after: H1RepeatStep;
  trigger: H1RepeatTrigger;
  outcome: typeof SignalDecisionOutcome.Intent | typeof SignalDecisionOutcome.Refused;
  detail: string | null;
}): SignalDecisionInput {
  return {
    context: SignalDecisionContext.Session,
    tradingSessionId: input.sessionId,
    brokerAccountId: input.brokerAccountId,
    step: input.step,
    assetId: input.assetId,
    interval: null,
    version: H1_REPEAT_VERSION,
    decidedAtMs: input.takenAtMs,
    takenAtMs: input.takenAtMs,
    kind: SignalKind.Signal,
    action: input.after.action,
    payout: input.payout,
    digits: null,
    params: { rule: 'repeat_step_2', strategy: input.strategy },
    decision: {
      kind: SignalKind.Signal,
      version: H1_REPEAT_VERSION,
      action: input.after.action,
      after: input.after,
    },
    source: { kind: 'settlement', trigger: input.trigger },
    series: [],
    lastTick: null,
    outcome: input.outcome,
    detail: input.detail,
    ticksUntilMs: null,
  };
}

interface Tracked {
  session: ActiveH1Session;
  settings: H1SessionSettings;
  detector: H1Detector;
  // the session's sizer (#775): the orchestrator's, over the same history
  sizer: StakeSizer;
  // a run in flight (a trade, a notice, the no-signal run): the next signal of the session is skipped
  busy: boolean;
  // the first second the session may decide again (one trade at a time)
  nextAt: number;
  // the waiting period's no_signal row is written (#775); reset by every intent and every notice
  waitingRecorded: boolean;
  // a refused waiting row is tried again from here (process clock)
  waitingRetryAt: number;
  // a notice came while busy: one more run after the current one
  renotice: boolean;
  // a due repeat step not created yet (the balance awaited, the pair ineligible): retried on
  // every closed second of the pair
  repeatPending: boolean;
  // the seconds the detector decided no_signal on a full window (below_threshold, no_volatility)
  // since the driver last saw the session change: an intent, a notice, add(). In memory, so a
  // restart counts from zero: a second without a decision never moves it (#775, review round 1)
  noSignalSeconds: number;
  // the no-signal limit in those seconds: the orchestrator's limit of the session's duration
  noSignalLimitSec: number;
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
    repeats: 0,
    waitingRows: 0,
    noticeIdle: 0,
    heldBalance: 0,
    repeatPending: 0,
    refused: 0,
    stops: 0,
    noSignalStops: 0,
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
        sizer: createStakeSizer(sessionStakeParams(parsed.data)),
        busy: false,
        nextAt: -Infinity,
        waitingRecorded: false,
        waitingRetryAt: -Infinity,
        renotice: false,
        repeatPending: false,
        noSignalSeconds: 0,
        noSignalLimitSec: sessionNoSignalTimeoutMs(parsed.data.durationSec) / SECOND_MS,
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

  // false when the stop threw: the session is kept
  async function stopSession(
    state: Tracked,
    reason: TradingSessionStopReason,
    code: string,
  ): Promise<boolean> {
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
      return true;
    } catch (error) {
      counts.errors += 1;
      logger.warn({ ...ids, reason, code, ...errorLogFields(error) }, 'h1 driver stop failed');
      return false;
    }
  }

  async function record(input: SignalDecisionInput): Promise<boolean> {
    try {
      await sessions.record(input);
      return true;
    } catch (error) {
      counts.failed += 1;
      logger.warn(
        { sessionId: input.tradingSessionId, step: input.step, ...errorLogFields(error) },
        'h1 driver decision not recorded',
      );
      return false;
    }
  }

  // the pair the session trades, open and taking 5 s on a fresh catalog, with the source up; the
  // skip is counted. No payout check: a payout that falls during the session does not stop it
  // (owner 2026-10-19), nor does a low one at the start (#775, В2)
  function eligiblePair(assetId: number): BinaryPair | undefined {
    if (!streaming()) {
      counts.sourceDown += 1;
      return undefined;
    }
    const view = catalog.read();
    if (view?.fresh !== true) {
      counts.catalogStale += 1;
      if (!staleWarned) {
        staleWarned = true;
        logger.warn({ ageMs: view?.ageMs ?? null }, 'h1 driver skipped: no fresh catalog');
      }
      return undefined;
    }
    staleWarned = false;
    const pair = view.pairs.find((candidate) => candidate.id === assetId);
    if (
      pair === undefined ||
      !isPairOpen(pair, now()) ||
      !pairAcceptsDuration(pair, H1_EXPIRY_SEC)
    ) {
      counts.ineligible += 1;
      return undefined;
    }
    return pair;
  }

  const historyOf = (state: Tracked) =>
    sessions.history(state.session.id, {
      maxDurationMs: SESSION_MAX_DURATION_MS,
      noSignalTimeoutMs: sessionNoSignalTimeoutMs(state.settings.durationSec),
    });

  // One step of the session (#707, #775): the repeat step when it is due, else the H1 signal's
  // step; with neither (a notice after a win, a lost Шаг 2) nothing. `signal` is null on a notice
  // and on the pending repeat's retry.
  async function trade(
    state: Tracked,
    signal: H1DriverSignalFacts | null,
    trigger: H1RepeatTrigger,
  ) {
    const { session, settings } = state;
    const ids = { sessionId: session.id, brokerAccountId: session.brokerAccountId };
    // the orchestrator's reading of the same history (Rule 48): the driver skips where it stops
    const history = await historyOf(state);
    if (stopped) return;
    if (history === undefined) {
      counts.gone += 1;
      forget(session.id);
      return;
    }
    const block = sessionIntentBlock(history, settings);
    if (block !== null) {
      state.repeatPending = false;
      if (block.reason === SessionIntentBlockReason.Live) counts.skippedLive += 1;
      else skippedLimits[block.reason] = (skippedLimits[block.reason] ?? 0) + 1;
      return;
    }
    const repeat = repeatDue(history, settings);
    if (repeat === null) {
      state.repeatPending = false;
      if (signal === null) {
        counts.noticeIdle += 1;
        return;
      }
    }
    // the repeat's pair is read now, not at the second a signal saw
    const pair = repeat === null ? undefined : eligiblePair(settings.assetId);
    if (repeat !== null && pair === undefined) {
      state.repeatPending = true;
      counts.repeatPending += 1;
      return;
    }
    const payout = pair?.payout ?? signal!.payout;
    const balance = await sessions.balance(session.id, {
      waitMs: sessionNoSignalTimeoutMs(settings.durationSec),
    });
    if (stopped) return;
    if (balance === undefined) {
      state.repeatPending = false;
      skippedLimits.balance_unavailable = (skippedLimits.balance_unavailable ?? 0) + 1;
      return;
    }
    const stake = state.sizer.next(
      sessionStakeInput({
        intents: history.intents,
        payout,
        minTradeAmount: balance.minTradeAmount,
        available: balance.available,
        sessionStartedAtMs: session.startedAt.getTime(),
        nowMs: now(),
      }),
    );
    if (stake.kind === StakeKind.Stop) {
      // #696: the payout of the settlement is not in the balance yet; the orchestrator holds too
      if (stake.reason === StopReason.InsufficientBalance && balance.awaitsBalance) {
        counts.heldBalance += 1;
        if (repeat !== null) {
          state.repeatPending = true;
          counts.repeatPending += 1;
        }
        return;
      }
      state.repeatPending = false;
      skippedLimits[stake.reason] = (skippedLimits[stake.reason] ?? 0) + 1;
      return;
    }
    const step = history.intents.length + 1;
    const takenAtMs = now();
    const row = (
      outcome: typeof SignalDecisionOutcome.Intent | typeof SignalDecisionOutcome.Refused,
      detail: string | null,
    ) =>
      repeat === null
        ? h1DriverDecisionInput(signal!, step, outcome, detail)
        : h1RepeatDecisionInput({
            sessionId: session.id,
            brokerAccountId: session.brokerAccountId,
            assetId: settings.assetId,
            step,
            takenAtMs,
            payout,
            strategy: sessionStakeParams(settings).strategy,
            after: repeat,
            trigger,
            outcome,
            detail,
          });
    let created: CreateTradeIntentResult;
    try {
      created = await sessions.createIntent({
        sessionId: session.id,
        step,
        telegramUserId: history.telegramUserId,
        brokerAccountId: session.brokerAccountId,
        mode: session.mode,
        assetId: settings.assetId,
        amount: stake.amount,
        action: repeat === null ? signal!.decision.action : repeat.action,
        durationSec: settings.durationSec,
        decision: row(SignalDecisionOutcome.Intent, null),
        // the entry window is the H1 signal's; the repeat, as a regular session's Шаг 2, has none
        ...(repeat === null
          ? { submitDeadlineAt: new Date(signal!.takenAtMs + config.submitBudgetMs) }
          : {}),
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
      await record(row(SignalDecisionOutcome.Refused, error.code));
      return;
    }
    state.repeatPending = false;
    state.waitingRecorded = false;
    state.noSignalSeconds = 0;
    // one trade at a time: the signal's from its second (entry + expiry + 1 s), the repeat's from
    // its creation on the process clock (expiry + 1 s)
    state.nextAt =
      repeat === null
        ? signal!.f + (settings.signal.entryDelaySec + settings.signal.expirySec + 1) * SECOND_MS
        : takenAtMs + (settings.signal.expirySec + 1) * SECOND_MS;
    if (!created.created) {
      counts.replayed += 1;
      logger.info({ ...ids, step, intentId: created.intent.id }, 'h1 driver step replayed');
      return;
    }
    counts.intents += 1;
    if (repeat !== null) counts.repeats += 1;
    if (created.decisionError !== undefined) {
      logger.warn(
        { ...ids, step, reason: 'insert_refused', ...errorLogFields(created.decisionError) },
        'h1 driver decision not recorded',
      );
    }
    if (!stopped) wake();
  }

  // The no-signal run (#775, В3, В5, review round 1), on a second the detector decided no_signal:
  // nothing while a block stands (the orchestrator's) or the repeat step is due (it goes on the
  // next closed second); else the waiting period's row, once; then, with that row written, the
  // no-signal limit reached and the database's wait expired too, the stop
  async function onNoSignal(state: Tracked, facts: H1DriverDecisionFacts) {
    const { settings } = state;
    const history = await historyOf(state);
    if (stopped) return;
    if (history === undefined) {
      counts.gone += 1;
      forget(state.session.id);
      return;
    }
    if (sessionIntentBlock(history, settings) !== null) return;
    if (repeatDue(history, settings) !== null) {
      state.repeatPending = true;
      counts.repeatPending += 1;
      return;
    }
    const row = () =>
      h1DriverDecisionInput(
        facts,
        history.intents.length + 1,
        SignalDecisionOutcome.NoSignal,
        null,
      );
    if (!state.waitingRecorded) {
      if (now() < state.waitingRetryAt) return;
      if (await record(row())) {
        state.waitingRecorded = true;
        counts.waitingRows += 1;
      } else {
        state.waitingRetryAt = now() + config.scanMs;
      }
      return;
    }
    if (state.noSignalSeconds < state.noSignalLimitSec || !history.waitExpired) return;
    if (!(await stopSession(state, TradingSessionStopReason.NoSignalTimeout, 'no_signal'))) return;
    counts.noSignalStops += 1;
    // the stopping second's row, after the stop whether its CAS matched or not (Rule 42)
    await record(row());
  }

  function launch(state: Tracked, run: () => Promise<void>) {
    state.busy = true;
    const job = run()
      .catch((error: unknown) => {
        counts.errors += 1;
        logger.warn(
          { sessionId: state.session.id, ...errorLogFields(error) },
          'h1 driver trade failed',
        );
      })
      .finally(() => {
        state.busy = false;
        if (state.renotice && !stopped && tracked.get(state.session.id) === state) {
          state.renotice = false;
          launch(state, () => trade(state, null, H1RepeatTrigger.Notice));
        }
      });
    track(job);
  }

  function notice(sessionId: string) {
    if (stopped) return;
    const state = tracked.get(sessionId);
    if (state === undefined) return;
    state.waitingRecorded = false;
    state.noSignalSeconds = 0;
    if (state.busy) {
      state.renotice = true;
      return;
    }
    launch(state, () => trade(state, null, H1RepeatTrigger.Notice));
  }

  function decide({ assetId, second: f, closedBy, closedAtMs }: ClosedSecond) {
    const own = [...tracked.values()].filter((state) => state.settings.assetId === assetId);
    if (own.length === 0) return;
    const pair = eligiblePair(assetId);
    if (pair === undefined) return;
    // a pending repeat needs no digits: its row has none
    const digits = series.digitsOf(assetId);
    for (const state of own) {
      if (state.busy) {
        counts.skippedLive += 1;
        continue;
      }
      // the repeat waits for no decision of the detector and no cadence: it is due now
      if (state.repeatPending) {
        launch(state, () => trade(state, null, H1RepeatTrigger.Tick));
        continue;
      }
      if (f < state.nextAt) {
        counts.held += 1;
        continue;
      }
      if (digits === undefined) continue;
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
      const facts: H1DriverDecisionFacts = {
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
      };
      if (decision.kind === SignalKind.NoSignal) {
        noSignal[decision.reason] = (noSignal[decision.reason] ?? 0) + 1;
        // a missing price is a hole in the data, not a reading of the market: not counted
        if (decision.reason === H1NoSignalReason.NoPrice) continue;
        state.noSignalSeconds += 1;
        if (
          (!state.waitingRecorded && takenAtMs >= state.waitingRetryAt) ||
          state.noSignalSeconds >= state.noSignalLimitSec
        ) {
          launch(state, () => onNoSignal(state, facts));
        }
        continue;
      }
      counts.signals += 1;
      const signalFacts: H1DriverSignalFacts = { ...facts, decision };
      launch(state, () => trade(state, signalFacts, H1RepeatTrigger.Signal));
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
    notice,
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
