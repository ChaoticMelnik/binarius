import {
  createSessionIntent,
  listRunnableSessions,
  markSessionDecision,
  readBalanceSnapshot,
  readSessionHistory,
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
  type StoppedSession,
} from '@binarius/db';
import {
  errorLogFields,
  intervalForDuration,
  isPairOpen,
  MIN_CYCLE_PAYOUT_PCT,
  pairAcceptsDuration,
  pairPayoutAccepted,
  safeParseTradingSessionSettings,
  SIGNAL_CHART_INTERVAL_MS,
  SignalFeedOutcome,
  SignalKind,
  TradeIntentErrorCode,
  TradeIntentStatus,
  TradeMode,
  TradingSessionStopReason,
  type TradeAction,
  type TradingSessionSettings,
} from '@binarius/shared';
import type { Logger } from '../intents/processor';
import { SessionTradeKind, StakeKind, StakeStrategy } from '../stake/codes';
import { parseAmount } from '../stake/money';
import { createStakeSizer, type SessionTrade, type StakeSizer } from '../stake/size';
import type { PairsSource, SignalSource } from './backend';
import type { SessionOrchestratorConfig } from './config';

// The demo-session orchestrator (#287, docs/trading-session.md -> The orchestrator): every tick
// stops the sessions the kill switch, the deadline and a halt end, then makes one attempt per
// runnable session. An attempt either writes an ending (a stop, or last_decision_at moved) or
// holds the session back in memory; the step comes from the database's history, never from memory.

export interface SessionOrchestratorDeps {
  db: Db;
  signals: SignalSource;
  pairs: PairsSource;
  logger: Logger;
  config: SessionOrchestratorConfig;
  // the sizer's clock and the hold-backs, not the deadline (the database's)
  now?: () => number;
}

export interface SessionOrchestrator {
  start(): void;
  // never rejects
  tick(): Promise<void>;
  // aborts the attempt's backend call and waits for the running tick
  stop(): Promise<void>;
}

// A hold must say whether the pause's memory (last_signal_action, #379) is cleared (null after a
// no_signal) or kept (the paused action). The traded action travels with the intent row
// (createTradeIntent), never through an ending: an ending can be lost after the INSERT.
type Ending =
  | { kind: 'stop'; reason: TradingSessionStopReason; fields?: Record<string, unknown> }
  | { kind: 'created' }
  | { kind: 'reschedule' }
  | { kind: 'hold'; ms: number; signalAction?: TradeAction | null }
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
  // the demo-stake bounds (#297): only POST /trading/intents asks for them, so a session intent
  // never gets these; were it to, they mean what the sizer's own stop means
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
  [TradeIntentErrorCode.InsufficientDemoBalance]: {
    kind: 'stop',
    reason: TradingSessionStopReason.StakeStop,
  },
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

// docs/trading-session.md -> The pause after two losses (#379): the direction of the session's
// last two trades when both are settled losses in it. A rejected intent is not a trade and is
// skipped; any other intent (a tie, a win, manual_review, settled without a profit) breaks it.
export function pausedDirection(intents: readonly SessionHistoryIntent[]): TradeAction | undefined {
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
  now = Date.now,
}: SessionOrchestratorDeps): SessionOrchestrator {
  const stopping = new AbortController();
  // session id -> when it may be attempted again; in memory, one worker container (#94)
  const heldUntil = new Map<string, number>();
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | undefined;

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

  function sizerOf(settings: TradingSessionSettings): StakeSizer {
    return createStakeSizer({ strategy: StakeStrategy.Fixed, ...settings.stake });
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

    const history = await readSessionHistory(db, session.id, {
      maxDurationMs: config.maxDurationMs,
    });
    if (history === undefined) {
      logger.warn(ids, 'trading session vanished');
      return { kind: 'hold', ms: config.retryMs };
    }
    // the scan skips expired sessions; this catches one whose deadline passed since the scan
    if (history.expired) return { kind: 'stop', reason: TradingSessionStopReason.Timeout };
    if (history.intents.some((intent) => !TERMINAL.has(intent.status))) {
      logger.info(ids, 'trading session has a live intent');
      return { kind: 'reschedule' };
    }
    const settled = history.intents.filter((i) => i.status === TradeIntentStatus.Settled).length;
    if (settled >= settings.trades) {
      return { kind: 'stop', reason: TradingSessionStopReason.Completed, fields: { settled } };
    }
    const lastTwo = history.intents.slice(-2);
    if (lastTwo.length === 2 && lastTwo.every((i) => i.status === TradeIntentStatus.Rejected)) {
      return {
        kind: 'stop',
        reason: TradingSessionStopReason.RejectedTwice,
        fields: { lastErrors: lastTwo.map((i) => i.lastError) },
      };
    }

    const snapshot = await readBalanceSnapshot(db, session.brokerAccountId);
    if (snapshot === undefined) {
      return { kind: 'stop', reason: TradingSessionStopReason.BalanceUnavailable };
    }
    // the executor sends the intent's mode, so the stake is sized against the same mode's balance
    const available =
      session.mode === TradeMode.Real ? snapshot.real.available : snapshot.demo.available;
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
    const nowMs = now();
    if (!isPairOpen(pair, nowMs)) {
      logger.info({ ...ids, assetId: pair.id }, 'trading session waits for the pair to open');
      return { kind: 'hold', ms: Math.min(pair.scheduledUntil - nowMs, config.retryMs) };
    }
    // no cycle trades a pair paying less than the floor; the session waits for it (owner, #379)
    if (!pairPayoutAccepted(pair)) {
      logger.info(
        { ...ids, assetId: pair.id, payout: pair.payout, floor: MIN_CYCLE_PAYOUT_PCT },
        'trading session waits for the payout',
      );
      return { kind: 'hold', ms: config.retryMs };
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
    const untilNextCandle = () => {
      const decidedAt = now();
      const intervalMs = SIGNAL_CHART_INTERVAL_MS[interval];
      return Math.ceil(decidedAt / intervalMs) * intervalMs + config.candleSlackMs - decidedAt;
    };
    if (response.decision.kind === SignalKind.NoSignal) {
      logger.info(
        { ...ids, reason: response.decision.reason },
        'trading session waits for the next candle',
      );
      return { kind: 'hold', ms: untilNextCandle(), signalAction: null };
    }
    const action: TradeAction = response.decision.action;
    // the last two trades lost in this direction and every decision since was this signal
    if (pausedDirection(history.intents) === action && session.lastSignalAction === action) {
      logger.info({ ...ids, action }, 'trading session waits for the signal to change');
      return { kind: 'hold', ms: untilNextCandle(), signalAction: action };
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
    if (decision.kind === StakeKind.Stop) {
      return {
        kind: 'stop',
        reason: TradingSessionStopReason.StakeStop,
        fields: { stopReason: decision.reason, detail: decision.detail },
      };
    }

    const step = history.intents.length + 1;
    checkpoint();
    let created;
    try {
      created = await createSessionIntent(db, {
        sessionId: session.id,
        step,
        telegramUserId: history.telegramUserId,
        brokerAccountId: session.brokerAccountId,
        mode: session.mode,
        assetId: settings.assetId,
        amount: decision.amount,
        action,
        durationSec: settings.durationSec,
      });
    } catch (error) {
      if (error instanceof TradingSessionNotActiveError) {
        logger.info(ids, 'trading session stopped meanwhile');
        return { kind: 'gone' };
      }
      if (!(error instanceof TradeIntentError)) throw error;
      const refusal: CreateRefusal = CREATE_REFUSALS[error.code];
      if (refusal.kind === 'reschedule') {
        logger.warn({ ...ids, step, code: error.code }, 'trading session intent refused');
        return refusal;
      }
      return { ...refusal, fields: { code: error.code } };
    }
    if (!created.created) {
      logger.info({ ...ids, step, intentId: created.intent.id }, 'trading session step replayed');
      return { kind: 'reschedule' };
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

  const hold = (sessionId: string, ms: number) =>
    heldUntil.set(sessionId, now() + Math.max(ms, config.tickMs));

  async function apply(session: RunnableSession, ending: Ending): Promise<void> {
    switch (ending.kind) {
      case 'stop': {
        const row = await stopTradingSession(db, { id: session.id, reason: ending.reason });
        if (row !== undefined) logStop(session, ending.reason, ending.fields);
        return;
      }
      case 'hold':
        hold(session.id, ending.ms);
        await markSessionDecision(db, { id: session.id, signalAction: ending.signalAction });
        return;
      case 'created':
      case 'reschedule':
        await markSessionDecision(db, { id: session.id });
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
    for (const [id, until] of heldUntil) if (until <= tickAt) heldUntil.delete(id);
    const runnable = await listRunnableSessions(db, {
      limit: config.batchSize,
      maxDurationMs: config.maxDurationMs,
      exclude: [...heldUntil.keys()],
    });
    const summary = { runnable: runnable.length, attempted: 0, created: 0, held: 0, stopped: 0 };
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
      });
    return running;
  }

  return {
    tick,
    start() {
      if (stopped || timer !== undefined) return;
      void tick();
      timer = setInterval(() => void tick(), config.tickMs);
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      stopping.abort();
      await running;
    },
  };
}
