import {
  createSessionIntent,
  listRunnableSessions,
  markSessionDecision,
  readSessionBalance,
  readSessionHistory,
  recordSignalDecision,
  signalDecisionInput,
  stopExpiredSessions,
  stopHaltedSessions,
  stopPausedSessions,
  stopTradingSession,
  TERMINAL_TRADE_INTENT_STATUSES,
  touchBalanceRequested,
  TradeIntentError,
  TradingSessionNotActiveError,
  type Db,
  type RunnableSession,
  type SessionHistoryIntent,
  type SignalDecisionInput,
  type StoppedSession,
} from '@binarius/db';
import {
  errorLogFields,
  intervalForDuration,
  isH1Settings,
  isPairOpen,
  pairAcceptsDuration,
  safeParseTradingSessionSettings,
  sessionProgress,
  sessionStakeParams,
  sessionNoSignalTimeoutMs,
  SIGNAL_CHART_INTERVAL_MS,
  SignalDecisionContext,
  SignalDecisionOutcome,
  SignalFeedOutcome,
  SignalKind,
  TradeIntentErrorCode,
  TradeIntentStatus,
  TradingSessionStopReason,
  type SignalRecord,
  type TradeAction,
  type TradingSessionSettings,
} from '@binarius/shared';
import type { Logger } from '../intents/processor';
import { SessionTradeKind, StakeKind, StopReason } from '../stake/codes';
import { parseAmount } from '../stake/money';
import {
  createStakeSizer,
  type SessionTrade,
  type StakeDecision,
  type StakeSizer,
} from '../stake/size';
import type { PairsSource, SignalSource } from './backend';
import type { SessionOrchestratorConfig } from './config';

// The session orchestrator (#287, real sessions #327, docs/trading-session.md -> The orchestrator): every tick
// stops the sessions the kill switch, the deadline and a halt end, then makes one attempt per
// runnable session. An attempt either writes an ending (a stop, or last_decision_at moved) or
// holds the session back in memory; the step comes from the database's history, never from memory.
// A write in the worker that ends an intent or halts its account wakes it (#696): a tick at once,
// the interval is the safety net. A hold until the next candle (no_signal, the pause) ends at the
// boundary + the slack, not rounded up to a tick, and one timer wakes the tick then (#697); the
// interval is its safety net too.

export interface SessionOrchestratorDeps {
  db: Db;
  signals: SignalSource;
  pairs: PairsSource;
  logger: Logger;
  config: SessionOrchestratorConfig;
  // the process runs DEMO_ONLY (#396): createSessionIntent refuses a real session's intent
  demoOnly: boolean;
  // the sizer's clock and the hold-backs, not the deadline (the database's)
  now?: () => number;
}

export interface SessionOrchestrator {
  start(): void;
  // never rejects
  tick(): Promise<void>;
  // a tick now, or one more right after the running one (its scan may predate the caller's write);
  // calls merge, a no-op after stop(); never throws, so a caller may call it after its commit (#696)
  wake(): void;
  // aborts the attempt's backend call and waits for the running tick
  stop(): Promise<void>;
}

// The sizer's stop codes as the session's stop_reason (#450): a martingale limit is its own, every
// other code (bad history, the minimum, the balance) is stake_stop; the log line keeps the code
const STAKE_STOP_REASONS = {
  [StopReason.MaxStepsExceeded]: TradingSessionStopReason.MaxStepsExceeded,
  [StopReason.MaxStakeExceeded]: TradingSessionStopReason.MaxStakeExceeded,
  [StopReason.MaxSessionLossExceeded]: TradingSessionStopReason.MaxSessionLossExceeded,
  [StopReason.SessionDurationExceeded]: TradingSessionStopReason.SessionDurationExceeded,
  [StopReason.UnresolvedTrade]: TradingSessionStopReason.StakeStop,
  [StopReason.InvalidTrade]: TradingSessionStopReason.StakeStop,
  [StopReason.InvalidAmount]: TradingSessionStopReason.StakeStop,
  [StopReason.InvalidPayout]: TradingSessionStopReason.StakeStop,
  [StopReason.BelowMinTradeAmount]: TradingSessionStopReason.StakeStop,
  [StopReason.InsufficientBalance]: TradingSessionStopReason.StakeStop,
} as const satisfies Record<StopReason, TradingSessionStopReason>;

// A hold must say whether the pause's memory (last_signal_action, #379) is cleared (null after a
// no_signal) or kept (the paused action); a candle hold (#697) is the exact wait for the next
// candle's ask. The traded action travels with the intent row
// (createTradeIntent), never through an ending: an ending can be lost after the INSERT. An ending
// reached after a decision carries its trade log row (#666, docs/trade-log.md → The writers and
// their outcomes), written by apply after the ending's own write; the intent's row is in the
// intent's transaction instead.
type Ending =
  | {
      kind: 'stop';
      reason: TradingSessionStopReason;
      fields?: Record<string, unknown>;
      record?: SignalDecisionInput;
    }
  | { kind: 'created' }
  | { kind: 'reschedule'; record?: SignalDecisionInput }
  | {
      kind: 'hold';
      ms: number;
      signalAction?: TradeAction | null;
      candle?: true;
      record?: SignalDecisionInput;
    }
  // the session is no longer active: nothing to write
  | { kind: 'gone' }
  // no ending written: the deadline, a throw or the stop signal
  | { kind: 'failed' }
  | { kind: 'stopped' };

type CreateRefusal = { kind: 'stop'; reason: TradingSessionStopReason } | { kind: 'reschedule' };

const accountUnavailable = {
  kind: 'stop',
  reason: TradingSessionStopReason.AccountUnavailable,
} as const;

// every code createTradeIntent can refuse with; a code added later fails tsc here
const CREATE_REFUSALS = {
  [TradeIntentErrorCode.UserNotFound]: accountUnavailable,
  [TradeIntentErrorCode.UserBlocked]: accountUnavailable,
  [TradeIntentErrorCode.BrokerAccountNotFound]: accountUnavailable,
  [TradeIntentErrorCode.AmbiguousBrokerAccount]: accountUnavailable,
  [TradeIntentErrorCode.AccountRevoked]: accountUnavailable,
  [TradeIntentErrorCode.AccountNotConfirmed]: accountUnavailable,
  [TradeIntentErrorCode.InsufficientTokens]: accountUnavailable,
  // a halt committed while the backend calls were in flight (reconciliation's write, Rule 25)
  [TradeIntentErrorCode.AccountHalted]: {
    kind: 'stop',
    reason: TradingSessionStopReason.ManualReview,
  },
  // the kill switch closed while the backend calls were in flight (#144)
  [TradeIntentErrorCode.TradingPaused]: {
    kind: 'stop',
    reason: TradingSessionStopReason.KillSwitch,
  },
  // a bot trade or a second worker on the account: the scan waits for it
  [TradeIntentErrorCode.ActiveIntentExists]: { kind: 'reschedule' },
  // the step key exists with other terms: the next attempt reads that intent in the history
  [TradeIntentErrorCode.ClientRequestIdConflict]: { kind: 'reschedule' },
  // the stake bounds of either mode (#297, #326): only POST /trading/intents asks for them, so a
  // session intent never gets these; were it to, they mean what the sizer's own stop means
  [TradeIntentErrorCode.BalanceUnavailable]: {
    kind: 'stop',
    reason: TradingSessionStopReason.BalanceUnavailable,
  },
  [TradeIntentErrorCode.StakePrecision]: {
    kind: 'stop',
    reason: TradingSessionStopReason.StakeStop,
  },
  [TradeIntentErrorCode.StakeBelowMinimum]: {
    kind: 'stop',
    reason: TradingSessionStopReason.StakeStop,
  },
  [TradeIntentErrorCode.InsufficientBalance]: {
    kind: 'stop',
    reason: TradingSessionStopReason.StakeStop,
  },
  // the process runs DEMO_ONLY and the session is real (#396): durable for this process
  [TradeIntentErrorCode.DemoOnly]: accountUnavailable,
  // the user is not in real mode (#121): a switch to demo stops the user's sessions itself
  // (setTradingMode, #327), so this is the race with that switch, whose stop wins the CAS, or a
  // trading_mode written by hand
  [TradeIntentErrorCode.RealModeOff]: accountUnavailable,
} as const satisfies Record<TradeIntentErrorCode, CreateRefusal>;

const TERMINAL = new Set<string>(TERMINAL_TRADE_INTENT_STATUSES);

// the sizer's view of the session's intents; a settled intent without its trade's profit and a
// manual_review one have no result the sizer can use
function toSessionTrade(intent: SessionHistoryIntent): SessionTrade {
  if (intent.status === TradeIntentStatus.Rejected) return { kind: SessionTradeKind.Rejected };
  if (intent.status === TradeIntentStatus.Settled && intent.profit !== null) {
    return { kind: SessionTradeKind.Settled, stake: intent.amount, profit: intent.profit };
  }
  return { kind: SessionTradeKind.Unresolved };
}

// docs/trading-session.md -> The pause after two losses (#379). A rejected intent between the two
// losses is not a trade, so it neither breaks nor extends the streak. A trailing one was created
// only once the pause had lifted, and a refusal is not a new loss to re-arm it on.
export function pausedDirection(intents: readonly SessionHistoryIntent[]): TradeAction | undefined {
  if (intents.at(-1)?.status === TradeIntentStatus.Rejected) return undefined;
  const trades = intents.filter((intent) => intent.status !== TradeIntentStatus.Rejected);
  const lastTwo = trades.slice(-2);
  if (lastTwo.length < 2) return undefined;
  const lost = lastTwo.every((intent) => {
    if (intent.status !== TradeIntentStatus.Settled || intent.profit === null) return false;
    const profit = parseAmount(intent.profit);
    return profit !== undefined && profit < 0n;
  });
  const [first, second] = lastTwo;
  return lost && first.action === second.action ? second.action : undefined;
}

class AttemptAborted extends Error {
  constructor() {
    super('trading session attempt aborted');
    this.name = 'AttemptAborted';
  }
}

export function createSessionOrchestrator({
  db,
  signals,
  pairs,
  logger,
  config,
  demoOnly,
  now = Date.now,
}: SessionOrchestratorDeps): SessionOrchestrator {
  const stopping = new AbortController();
  // session id -> when it may be attempted again; in memory, one worker container (#94)
  const heldUntil = new Map<string, number>();
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | undefined;
  // wake() calls no tick has served yet
  let pending = 0;
  // the sessions whose hold is a candle hold (#697): the candle timer wakes the tick at the
  // earliest of their heldUntil
  const candleHeld = new Set<string>();
  let candleTimer: ReturnType<typeof setTimeout> | undefined;
  let candleWakeAt: number | undefined;
  // a timer that fired before now() reached its target (its clock against Date.now) leaves the
  // session to the interval: targets at or before the last firing are not armed again
  let lastFiredAt = Number.NEGATIVE_INFINITY;

  function logStop(
    row: StoppedSession,
    reason: TradingSessionStopReason,
    fields: Record<string, unknown> = {},
  ): void {
    const ids = { sessionId: row.id, brokerAccountId: row.brokerAccountId };
    if (reason === TradingSessionStopReason.ManualReview) {
      logger.error({ ...ids, ...fields }, 'trading session stopped for manual review');
    } else if (reason === TradingSessionStopReason.Completed) {
      logger.info({ ...ids, reason, ...fields }, 'trading session completed');
    } else {
      logger.warn({ ...ids, reason, ...fields }, 'trading session stopped');
    }
  }

  function logStops(rows: StoppedSession[], reason: TradingSessionStopReason): void {
    for (const row of rows) logStop(row, reason);
  }

  // the strategy and its limits frozen in the session's row at the start, never the process's env
  function sizerOf(settings: TradingSessionSettings): StakeSizer {
    return createStakeSizer(sessionStakeParams(settings));
  }

  async function attempt(session: RunnableSession, signal: AbortSignal): Promise<Ending> {
    const ids = { sessionId: session.id, brokerAccountId: session.brokerAccountId };
    const checkpoint = () => {
      if (signal.aborted) throw new AttemptAborted();
    };

    const parsed = safeParseTradingSessionSettings(session.settings);
    if (!parsed.success) {
      return {
        kind: 'stop',
        reason: TradingSessionStopReason.InvalidSettings,
        fields: { issues: parsed.error.issues.map((issue) => issue.path.join('.')) },
      };
    }
    const settings = parsed.data;
    let sizer: StakeSizer;
    try {
      sizer = sizerOf(settings);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      return {
        kind: 'stop',
        reason: TradingSessionStopReason.InvalidSettings,
        fields: { error: error.name },
      };
    }

    // an H1 session (#670, settings v4): its driver opens the trades (#707); the attempt only
    // stops it or holds it, never asks the signal and never stops it with no_signal_timeout
    const h1 = isH1Settings(settings);
    const noSignalTimeoutMs = sessionNoSignalTimeoutMs(
      settings.durationSec,
      config.noSignalCandles,
    );
    const history = await readSessionHistory(db, session.id, {
      maxDurationMs: config.maxDurationMs,
      noSignalTimeoutMs,
      ...(h1
        ? { lossLimit: { maxLoss: settings.maxLoss, nextStake: settings.stake.baseStake } }
        : {}),
    });
    if (history === undefined) {
      logger.warn(ids, 'trading session vanished');
      return { kind: 'hold', ms: config.retryMs };
    }
    // the step this attempt tries: its intent key and every decision row it writes (#666)
    const step = history.intents.length + 1;
    // the scan skips expired sessions; this catches one whose deadline passed since the scan
    if (history.expired) return { kind: 'stop', reason: TradingSessionStopReason.Timeout };
    if (history.intents.some((intent) => !TERMINAL.has(intent.status))) {
      logger.info(ids, 'trading session has a live intent');
      return { kind: 'reschedule' };
    }
    const settledIntents = history.intents.filter((i) => i.status === TradeIntentStatus.Settled);
    const settled = settledIntents.length;
    // a settled intent without a readable profit is no win; the sizer stops the session on it:
    // unresolved_trade when the profit is missing (toSessionTrade), invalid_amount when its text
    // does not parse - both stake_stop
    const won = settledIntents.filter((i) => {
      const profit = i.profit === null ? undefined : parseAmount(i.profit);
      return profit !== undefined && profit > 0n;
    }).length;
    const progress = sessionProgress(settings, { settled, won });
    if (progress.done >= progress.planned) {
      return {
        kind: 'stop',
        reason: TradingSessionStopReason.Completed,
        fields: { settled, cycles: progress.done },
      };
    }
    if (h1 && history.lossLimitReached) {
      return {
        kind: 'stop',
        reason: TradingSessionStopReason.MaxSessionLossExceeded,
        fields: { maxLoss: settings.maxLoss },
      };
    }
    const lastTwo = history.intents.slice(-2);
    if (lastTwo.length === 2 && lastTwo.every((i) => i.status === TradeIntentStatus.Rejected)) {
      return {
        kind: 'stop',
        reason: TradingSessionStopReason.RejectedTwice,
        fields: { lastErrors: lastTwo.map((i) => i.lastError) },
      };
    }

    const snapshot = await readSessionBalance(db, session.id, { waitMs: noSignalTimeoutMs });
    if (snapshot === undefined) {
      return { kind: 'stop', reason: TradingSessionStopReason.BalanceUnavailable };
    }
    // the executor sends the intent's mode, so the stake is sized against the same mode's balance
    const available = snapshot.available;
    // #696: a settlement on the account in the session's mode (this session's, an earlier one's, a
    // bot's one-off) is newer than the balance; its update_balance, the pass's check or the
    // backend's refresh brings the payout. Until the no-signal limit counted from that settlement
    // the step waits a tick (a hold: a wake does not ask the signal again inside it), then the
    // sizer's stop stands
    const waitsForBalance = (decision: StakeDecision) =>
      decision.kind === StakeKind.Stop &&
      decision.reason === StopReason.InsufficientBalance &&
      snapshot.awaitsBalance;
    checkpoint();
    // keeps the account "in work": the balance refresh and the broker session stay on it
    await touchBalanceRequested(db, session.brokerAccountId);

    const catalog = await pairs.read({ signal });
    checkpoint();
    if (!catalog.ok || !catalog.catalog.fresh) {
      logger.warn(
        catalog.ok
          ? { ...ids, reason: 'stale' }
          : { ...ids, reason: catalog.reason, status: catalog.status },
        'trading session pairs unavailable',
      );
      return { kind: 'hold', ms: config.retryMs };
    }
    const pair = catalog.catalog.pairs.find((candidate) => candidate.id === settings.assetId);
    if (pair === undefined || !pairAcceptsDuration(pair, settings.durationSec)) {
      return {
        kind: 'stop',
        reason: TradingSessionStopReason.PairUnavailable,
        fields: { assetId: settings.assetId, listed: pair !== undefined },
      };
    }
    // The three waits for a signal end at the no-signal limit (#509, owner), config.noSignalCandles
    // candles of the session's signal interval (#637): a closed pair, a no_signal, the pause after
    // two losses. A failure to read the pairs or the signal is not a wait for a signal, so it
    // neither stops the session nor moves the count.
    const noSignalStop = (
      waited: 'pair_closed' | 'no_signal' | 'paused',
      record?: SignalDecisionInput,
    ): Ending => ({
      kind: 'stop',
      reason: TradingSessionStopReason.NoSignalTimeout,
      fields: { waited, limitMs: noSignalTimeoutMs },
      ...(record === undefined ? {} : { record }),
    });
    const nowMs = now();
    if (!isPairOpen(pair, nowMs)) {
      if (!h1 && history.waitExpired) return noSignalStop('pair_closed');
      logger.info({ ...ids, assetId: pair.id }, 'trading session waits for the pair to open');
      return { kind: 'hold', ms: Math.min(pair.scheduledUntil - nowMs, config.retryMs) };
    }
    // since #631 no payout refuses a session, not even at the start (#509 kept the floor
    // there): a pair whose payout fell keeps trading on its signals. An H1 session's floor is its
    // start's only (H1_MIN_PAYOUT_PCT, owner 2026-10-19)

    if (h1) {
      const startedAtMs = session.startedAt.getTime();
      const decision = sizer.next({
        history: history.intents.map(toSessionTrade),
        payout: pair.payout,
        minTradeAmount: snapshot.minTradeAmount,
        available,
        sessionStartedAtMs: startedAtMs,
        nowMs: Math.max(now(), startedAtMs),
      });
      if (waitsForBalance(decision)) {
        logger.info({ ...ids, step }, 'trading session waits for the balance');
        return { kind: 'hold', ms: config.tickMs };
      }
      if (decision.kind === StakeKind.Stop) {
        return {
          kind: 'stop',
          reason: STAKE_STOP_REASONS[decision.reason],
          fields: { stopReason: decision.reason, detail: decision.detail },
        };
      }
      logger.debug(ids, 'trading session waits for the H1 driver');
      return { kind: 'hold', ms: config.h1CheckMs };
    }

    const interval = intervalForDuration(settings.durationSec);
    const answer = await signals.evaluate({ assetId: settings.assetId, interval }, { signal });
    checkpoint();
    if (!answer.ok) {
      logger.warn(
        { ...ids, reason: answer.reason, status: answer.status },
        'trading session signal unavailable',
      );
      return { kind: 'hold', ms: config.retryMs };
    }
    const response = answer.response;
    if (response.outcome === SignalFeedOutcome.FetchFailed) {
      logger.warn(
        { ...ids, code: response.code, retryAfterSec: response.retryAfterSec },
        'trading session signal fetch failed',
      );
      return {
        kind: 'hold',
        ms: response.retryAfterSec !== undefined ? response.retryAfterSec * 1000 : config.retryMs,
      };
    }
    // the decision is taken: its row's clock and record (#666); an old backend answers none, and
    // the source drops one that is invalid or does not match the answer
    const takenAtMs = now();
    const record: SignalRecord | undefined = response.record;
    if (record === undefined) {
      const reason =
        answer.recordProblem === undefined ? 'record_missing' : `record_${answer.recordProblem}`;
      logger.warn({ ...ids, reason }, 'trading session decision not recorded');
    }
    const decisionRow = (
      outcome: SignalDecisionOutcome,
      detail: string | null = null,
    ): SignalDecisionInput | undefined =>
      record === undefined
        ? undefined
        : signalDecisionInput(record, {
            context: SignalDecisionContext.Session,
            tradingSessionId: session.id,
            brokerAccountId: session.brokerAccountId,
            step,
            payout: pair.payout,
            takenAtMs,
            outcome,
            detail,
          });
    const withRow = <E extends Ending>(ending: E, row: SignalDecisionInput | undefined): E =>
      row === undefined ? ending : { ...ending, record: row };
    const untilNextCandle = () => {
      const decidedAt = now();
      const intervalMs = SIGNAL_CHART_INTERVAL_MS[interval];
      return Math.ceil(decidedAt / intervalMs) * intervalMs + config.candleSlackMs - decidedAt;
    };
    if (response.decision.kind === SignalKind.NoSignal) {
      const row = decisionRow(SignalDecisionOutcome.NoSignal);
      if (history.waitExpired) return noSignalStop('no_signal', row);
      logger.info(
        { ...ids, reason: response.decision.reason },
        'trading session waits for the next candle',
      );
      return withRow(
        { kind: 'hold', ms: untilNextCandle(), signalAction: null, candle: true },
        row,
      );
    }
    const action: TradeAction = response.decision.action;
    if (pausedDirection(history.intents) === action && session.lastSignalAction === action) {
      const row = decisionRow(SignalDecisionOutcome.Paused);
      if (history.waitExpired) return noSignalStop('paused', row);
      logger.info({ ...ids, action }, 'trading session waits for the signal to change');
      return withRow(
        { kind: 'hold', ms: untilNextCandle(), signalAction: action, candle: true },
        row,
      );
    }

    const startedAtMs = session.startedAt.getTime();
    const decision = sizer.next({
      history: history.intents.map(toSessionTrade),
      payout: pair.payout,
      minTradeAmount: snapshot.minTradeAmount,
      available,
      sessionStartedAtMs: startedAtMs,
      // started_at is the database's clock: a worker clock behind it would make the sizer throw
      nowMs: Math.max(now(), startedAtMs),
    });
    if (waitsForBalance(decision)) {
      logger.info({ ...ids, step }, 'trading session waits for the balance');
      return { kind: 'hold', ms: config.tickMs };
    }
    if (decision.kind === StakeKind.Stop) {
      return withRow(
        {
          kind: 'stop',
          reason: STAKE_STOP_REASONS[decision.reason],
          fields: { stopReason: decision.reason, detail: decision.detail },
        },
        decisionRow(SignalDecisionOutcome.StakeStop, decision.reason),
      );
    }

    checkpoint();
    let created;
    try {
      created = await createSessionIntent(
        db,
        {
          sessionId: session.id,
          step,
          telegramUserId: history.telegramUserId,
          brokerAccountId: session.brokerAccountId,
          mode: session.mode,
          assetId: settings.assetId,
          amount: decision.amount,
          action,
          durationSec: settings.durationSec,
          decision: decisionRow(SignalDecisionOutcome.Intent) ?? null,
        },
        { demoOnly },
      );
    } catch (error) {
      if (error instanceof TradingSessionNotActiveError) {
        logger.info(ids, 'trading session stopped meanwhile');
        return { kind: 'gone' };
      }
      if (!(error instanceof TradeIntentError)) throw error;
      const refusal: CreateRefusal = CREATE_REFUSALS[error.code];
      const row = decisionRow(SignalDecisionOutcome.Refused, error.code);
      if (refusal.kind === 'reschedule') {
        logger.warn({ ...ids, step, code: error.code }, 'trading session intent refused');
        return withRow<Ending>(refusal, row);
      }
      return withRow<Ending>({ ...refusal, fields: { code: error.code } }, row);
    }
    if (!created.created) {
      logger.info({ ...ids, step, intentId: created.intent.id }, 'trading session step replayed');
      return withRow<Ending>({ kind: 'reschedule' }, decisionRow(SignalDecisionOutcome.Replayed));
    }
    if (created.decisionError !== undefined) {
      logger.warn(
        { ...ids, step, reason: 'insert_refused', ...errorLogFields(created.decisionError) },
        'trading session decision not recorded',
      );
    }
    logger.info(
      { ...ids, step, intentId: created.intent.id, action },
      'trading session intent created',
    );
    return { kind: 'created' };
  }

  // The race bounds the tick's wait, not a statement: an abort does not cancel a pg query, so a
  // statement that outlives the deadline still lands, and the next attempt reads its result.
  function attemptWithDeadline(session: RunnableSession): Promise<Ending> {
    const deadline = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<Ending>((resolve) => {
      timeout = setTimeout(() => {
        deadline.abort();
        logger.warn(
          { sessionId: session.id, brokerAccountId: session.brokerAccountId },
          'trading session attempt timed out',
        );
        resolve({ kind: 'failed' });
      }, config.attemptTimeoutMs);
    });
    const signal = AbortSignal.any([stopping.signal, deadline.signal]);
    const run = Promise.resolve()
      .then(() => attempt(session, signal))
      .catch((error: unknown): Ending => {
        if (stopping.signal.aborted) return { kind: 'stopped' };
        if (error instanceof AttemptAborted) return { kind: 'failed' };
        logger.error(
          {
            ...errorLogFields(error),
            sessionId: session.id,
            brokerAccountId: session.brokerAccountId,
          },
          'trading session attempt failed',
        );
        return { kind: 'failed' };
      });
    return Promise.race([run, expired]).finally(() => clearTimeout(timeout));
  }

  const hold = (sessionId: string, ms: number, candle = false) => {
    heldUntil.set(sessionId, now() + (candle ? ms : Math.max(ms, config.tickMs)));
    if (candle) candleHeld.add(sessionId);
    else candleHeld.delete(sessionId);
  };

  // Armed after every tick, so after the endings' writes: the woken tick reads them
  function armCandleWake() {
    if (stopped) return;
    let target: number | undefined;
    for (const id of candleHeld) {
      const until = heldUntil.get(id);
      if (until === undefined || until <= lastFiredAt) continue;
      if (target === undefined || until < target) target = until;
    }
    if (candleTimer !== undefined && target === candleWakeAt) return;
    clearTimeout(candleTimer);
    candleTimer = undefined;
    candleWakeAt = target;
    if (target === undefined) return;
    candleTimer = setTimeout(
      () => {
        candleTimer = undefined;
        candleWakeAt = undefined;
        lastFiredAt = now();
        wake();
      },
      Math.max(0, target - now()),
    );
  }

  // The decision's row follows its ending's own write, whether that write's CAS matched or not
  // (docs/trade-log.md → The order of writes); a failure loses the row only, never the ending
  async function recordDecision(session: RunnableSession, row: SignalDecisionInput | undefined) {
    if (row === undefined) return;
    try {
      await recordSignalDecision(db, row);
    } catch (error) {
      logger.warn(
        {
          sessionId: session.id,
          brokerAccountId: session.brokerAccountId,
          step: row.step,
          ...errorLogFields(error),
        },
        'trading session decision not recorded',
      );
    }
  }

  async function apply(session: RunnableSession, ending: Ending): Promise<void> {
    switch (ending.kind) {
      case 'stop': {
        const row = await stopTradingSession(db, { id: session.id, reason: ending.reason });
        if (row !== undefined) logStop(session, ending.reason, ending.fields);
        await recordDecision(session, ending.record);
        return;
      }
      case 'hold':
        hold(session.id, ending.ms, ending.candle === true);
        await markSessionDecision(db, { id: session.id, signalAction: ending.signalAction });
        await recordDecision(session, ending.record);
        return;
      case 'created':
        await markSessionDecision(db, { id: session.id });
        return;
      case 'reschedule':
        await markSessionDecision(db, { id: session.id });
        await recordDecision(session, ending.record);
        return;
      case 'failed':
        hold(session.id, config.retryMs);
        return;
      case 'gone':
      case 'stopped':
        return;
    }
  }

  async function runTick(): Promise<void> {
    // before the first await: a wake() after this line is served by the next tick
    const woken = pending;
    pending = 0;
    const paused = await stopPausedSessions(db, { limit: config.batchSize });
    logStops(paused, TradingSessionStopReason.KillSwitch);
    const expired = await stopExpiredSessions(db, {
      maxDurationMs: config.maxDurationMs,
      limit: config.batchSize,
    });
    logStops(expired, TradingSessionStopReason.Timeout);
    const halted = await stopHaltedSessions(db, { limit: config.batchSize });
    logStops(halted, TradingSessionStopReason.ManualReview);

    const tickAt = now();
    for (const [id, until] of heldUntil) {
      if (until > tickAt) continue;
      heldUntil.delete(id);
      candleHeld.delete(id);
    }
    const runnable = await listRunnableSessions(db, {
      limit: config.batchSize,
      maxDurationMs: config.maxDurationMs,
      exclude: [...heldUntil.keys()],
    });
    const summary = {
      runnable: runnable.length,
      attempted: 0,
      created: 0,
      held: 0,
      stopped: 0,
      woken,
    };
    for (const session of runnable) {
      if (stopped) break;
      summary.attempted += 1;
      const ending = await attemptWithDeadline(session);
      if (ending.kind === 'stopped') break;
      await apply(session, ending);
      if (ending.kind === 'created') summary.created += 1;
      if (ending.kind === 'hold' || ending.kind === 'failed') summary.held += 1;
      if (ending.kind === 'stop') summary.stopped += 1;
    }
    summary.stopped += paused.length + expired.length + halted.length;
    logger.debug(summary, 'trading session tick');
  }

  function tick(): Promise<void> {
    if (stopped) return Promise.resolve();
    running ??= runTick()
      .catch((error: unknown) => {
        logger.error(errorLogFields(error), 'trading session tick failed');
      })
      .finally(() => {
        running = undefined;
        armCandleWake();
        if (pending > 0) void tick();
      });
    return running;
  }

  function wake() {
    pending += 1;
    if (running === undefined) void tick();
  }

  return {
    tick,
    wake,
    start() {
      if (stopped || timer !== undefined) return;
      void tick();
      timer = setInterval(() => void tick(), config.tickMs);
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      clearTimeout(candleTimer);
      stopping.abort();
      await running;
    },
  };
}
