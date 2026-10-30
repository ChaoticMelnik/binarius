import {
  listRunnableSessions,
  markSessionDecisions,
  readSessionBatch,
  stopExpiredSessions,
  stopHaltedSessions,
  stopPausedSessions,
  stopTradingSessions,
  touchBalancesRequested,
  type Db,
  type RunnableSession,
  type SessionBalanceRead,
  type SessionBatchRead,
  type SessionHistory,
  type StoppedSession,
} from '@binarius/db';
import {
  assertExhausted,
  errorLogFields,
  isH1Settings,
  isPairOpen,
  pairAcceptsDuration,
  safeParseTradingSessionSettings,
  sessionStakeParams,
  sessionNoSignalTimeoutMs,
  sessionIntentBlock,
  SessionIntentBlockReason,
  TradingSessionStopReason,
  type TradingSessionSettings,
} from '@binarius/shared';
import type { Logger } from '../intents/processor';
import {
  createStakeSizer,
  sessionStakeInput,
  StakeKind,
  StopReason,
  type StakeDecision,
  type StakeSizer,
} from '@binarius/stake';
import type { PairsOutcome, PairsSource } from './backend';
import type { SessionOrchestratorConfig } from './config';

// The session orchestrator (#287, real sessions #327, docs/trading-session.md -> The orchestrator): every tick
// stops the sessions the kill switch, the deadline and a halt end, then decides every runnable
// session of its batch in memory over one batched read and one pairs GET (#871). A decision either
// writes an ending (a stop, or last_decision_at moved) or holds the session back in memory. It
// creates no intent since #835: the backend's H1 driver opens every session's trades (#707), the
// orchestrator stops the session or holds it for the driver.
// A write in the worker that ends an intent or halts its account wakes it (#696): a tick at once
// over that account's sessions (#871), the interval is the safety net.

export interface SessionOrchestratorDeps {
  db: Db;
  pairs: PairsSource;
  logger: Logger;
  config: SessionOrchestratorConfig;
  // the tick's clock: the sizer and the hold-backs, not the deadline (the database's)
  now?: () => number;
}

export interface SessionOrchestrator {
  start(): void;
  // a tick now, or the running one; during a tick over accounts only, the running one and a full
  // tick right after it (#871); never rejects
  tick(): Promise<void>;
  // a tick now, or one more right after the running one (its scan may predate the caller's write);
  // with an account, a tick over that account's sessions only, without the sweeps (#871); calls
  // merge, a no-op after stop(); never throws, so a caller may call it after its commit (#696)
  wake(brokerAccountId?: string): void;
  // aborts the batch's pairs read and waits for the running tick
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

type Ending =
  | { kind: 'stop'; reason: TradingSessionStopReason; fields?: Record<string, unknown> }
  | { kind: 'reschedule' }
  | { kind: 'hold'; ms: number }
  // no ending written: a throw in the session's decision
  | { kind: 'failed' };

interface LogIds {
  sessionId: string;
  brokerAccountId: string;
}

// a session whose settings parsed: the H1 strategy frozen in its row at the start
interface Prepared {
  session: RunnableSession;
  ids: LogIds;
  settings: TradingSessionSettings;
  sizer: StakeSizer;
  noSignalTimeoutMs: number;
}

// a session that passed its history and balance and waits for the pairs catalog
interface AtPair {
  prepared: Prepared;
  history: SessionHistory;
  balance: SessionBalanceRead;
}

interface BatchCounts {
  held: number;
  stopped: number;
}

class AttemptAborted extends Error {
  constructor() {
    super('trading session batch aborted');
    this.name = 'AttemptAborted';
  }
}

export function createSessionOrchestrator({
  db,
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
  let runningFull = false;
  // wake() calls no tick has served yet: the accounts they named, and whether one named none
  let pending = 0;
  const pendingAccounts = new Set<string>();
  let pendingFull = false;
  // the tick clock of the last tick that ran the sweeps; the first tick is always full
  let lastFullAt = Number.NEGATIVE_INFINITY;

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

  // a throw here is a bug (the predicates and the sizer do not throw on what was read): that
  // session is held back, the rest of the batch goes on
  function guarded<T>(ids: LogIds, decide: () => T | Ending): T | Ending {
    try {
      return decide();
    } catch (error) {
      logger.error({ ...errorLogFields(error), ...ids }, 'trading session attempt failed');
      return { kind: 'failed' };
    }
  }

  // the settings, before any read: an active v1-v3 row has no trader left (#835)
  function prepare(session: RunnableSession): Prepared | Ending {
    const ids = { sessionId: session.id, brokerAccountId: session.brokerAccountId };
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
      sizer = createStakeSizer(sessionStakeParams(settings));
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      return {
        kind: 'stop',
        reason: TradingSessionStopReason.InvalidSettings,
        fields: { error: error.name },
      };
    }
    // #835: only an H1 session (settings v5; a read-only v4 row of #670) is traded, by its driver
    // (#707)
    if (!isH1Settings(settings)) {
      return {
        kind: 'stop',
        reason: TradingSessionStopReason.InvalidSettings,
        fields: { version: settings.version },
      };
    }
    return {
      session,
      ids,
      settings,
      sizer,
      noSignalTimeoutMs: sessionNoSignalTimeoutMs(settings.durationSec, config.noSignalCandles),
    };
  }

  // the history and the balance: none of these stops waits for the catalog
  function beforePair(prepared: Prepared, read: SessionBatchRead | undefined): AtPair | Ending {
    const { ids, settings } = prepared;
    if (read === undefined) {
      logger.warn(ids, 'trading session vanished');
      return { kind: 'hold', ms: config.retryMs };
    }
    const { history, balance } = read;
    // the scan skips expired sessions; this catches one whose deadline passed since the scan.
    // The H1 driver (#707) skips on the same reasons, so its intents never outrun these stops
    const block = sessionIntentBlock(history, settings);
    if (block !== null) {
      switch (block.reason) {
        case SessionIntentBlockReason.Expired:
          return { kind: 'stop', reason: TradingSessionStopReason.Timeout };
        case SessionIntentBlockReason.Live:
          logger.info(ids, 'trading session has a live intent');
          return { kind: 'reschedule' };
        case SessionIntentBlockReason.Completed:
          return {
            kind: 'stop',
            reason: TradingSessionStopReason.Completed,
            fields: { settled: block.settled, cycles: block.done },
          };
        case SessionIntentBlockReason.RejectedTwice:
          return {
            kind: 'stop',
            reason: TradingSessionStopReason.RejectedTwice,
            fields: { lastErrors: history.intents.slice(-2).map((i) => i.lastError) },
          };
        default:
          return assertExhausted(block, 'session intent block');
      }
    }
    if (balance === undefined) {
      return { kind: 'stop', reason: TradingSessionStopReason.BalanceUnavailable };
    }
    return { prepared, history, balance };
  }

  function atPair(
    { prepared, history, balance }: AtPair,
    catalog: PairsOutcome,
    tickAt: number,
  ): Ending {
    const { ids, settings, sizer, noSignalTimeoutMs, session } = prepared;
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
    // A closed pair waits until the no-signal limit (#509, owner), config.noSignalCandles candles
    // of the session's duration (#637; 5 s since #828); the no_signal wait is the driver's (#775).
    // A failure to read the pairs is not a wait for a signal: it neither stops nor moves the count.
    if (!isPairOpen(pair, tickAt)) {
      if (history.waitExpired) {
        return {
          kind: 'stop',
          reason: TradingSessionStopReason.NoSignalTimeout,
          fields: { waited: 'pair_closed', limitMs: noSignalTimeoutMs },
        };
      }
      logger.info({ ...ids, assetId: pair.id }, 'trading session waits for the pair to open');
      return { kind: 'hold', ms: Math.min(pair.scheduledUntil - tickAt, config.retryMs) };
    }
    // since #631 no payout refuses a session, not even at the start (#509 kept the floor
    // there); an H1 session has no floor either (#775, В2)

    // the executor sends the intent's mode, so the stake is sized against the same mode's balance
    const decision = sizer.next(
      sessionStakeInput({
        intents: history.intents,
        payout: pair.payout,
        minTradeAmount: balance.minTradeAmount,
        available: balance.available,
        sessionStartedAtMs: session.startedAt.getTime(),
        nowMs: tickAt,
      }),
    );
    // #696: a settlement on the account in the session's mode (this session's, an earlier one's, a
    // bot's one-off) is newer than the balance; its update_balance, the pass's check or the
    // backend's refresh brings the payout. Until the no-signal limit counted from that settlement
    // the step waits a tick (a hold: a wake does not attempt again inside it), then the sizer's
    // stop stands
    if (waitsForBalance(decision, balance)) {
      logger.info(
        { ...ids, step: history.intents.length + 1 },
        'trading session waits for the balance',
      );
      return { kind: 'hold', ms: config.tickMs };
    }
    if (decision.kind === StakeKind.Stop) {
      return {
        kind: 'stop',
        reason: STAKE_STOP_REASONS[decision.reason],
        fields: { stopReason: decision.reason, detail: decision.detail },
      };
    }
    // the no-signal stop of an H1 session is the driver's, on the seconds it decided no_signal
    // (#775, review round 1): this check has no evidence that H1 was asked at all
    logger.debug(ids, 'trading session waits for the H1 driver');
    return { kind: 'hold', ms: config.h1CheckMs };
  }

  const waitsForBalance = (decision: StakeDecision, balance: SessionBalanceRead) =>
    decision.kind === StakeKind.Stop &&
    decision.reason === StopReason.InsufficientBalance &&
    balance.awaitsBalance;

  // The batch (#871): the reads, the decisions up to the pair step, one pairs GET when any session
  // reached it, the rest of the decisions, then the writes - one statement per stop reason, one
  // decision mark, one balance touch - and the hold-backs. After every await a checkpoint: past the
  // deadline or the stop signal nothing more is written and nothing is held back.
  async function runBatch(
    runnable: readonly RunnableSession[],
    tickAt: number,
    signal: AbortSignal,
  ): Promise<BatchCounts> {
    const checkpoint = () => {
      if (signal.aborted) throw new AttemptAborted();
    };
    const endings: [RunnableSession, Ending][] = [];
    const prepared: Prepared[] = [];
    for (const session of runnable) {
      const ids = { sessionId: session.id, brokerAccountId: session.brokerAccountId };
      const result = guarded(ids, () => prepare(session));
      if ('kind' in result) endings.push([session, result]);
      else prepared.push(result);
    }

    const reads = await readSessionBatch(
      db,
      prepared.map(({ session, noSignalTimeoutMs }) => ({ id: session.id, noSignalTimeoutMs })),
      { maxDurationMs: config.maxDurationMs },
    );
    checkpoint();
    const waiting: AtPair[] = [];
    for (const one of prepared) {
      const result = guarded(one.ids, () => beforePair(one, reads.get(one.session.id)));
      if ('kind' in result) endings.push([one.session, result]);
      else waiting.push(result);
    }

    if (waiting.length > 0) {
      const catalog = await pairs.read({ signal });
      checkpoint();
      for (const one of waiting) {
        endings.push([
          one.prepared.session,
          guarded(one.prepared.ids, () => atPair(one, catalog, tickAt)),
        ]);
      }
    }

    const stops = new Map<
      TradingSessionStopReason,
      Map<string, Record<string, unknown> | undefined>
    >();
    const marked: string[] = [];
    const holds: [string, number][] = [];
    for (const [session, ending] of endings) {
      switch (ending.kind) {
        case 'stop': {
          const group = stops.get(ending.reason) ?? new Map();
          group.set(session.id, ending.fields);
          stops.set(ending.reason, group);
          break;
        }
        case 'hold':
          holds.push([session.id, ending.ms]);
          marked.push(session.id);
          break;
        case 'reschedule':
          marked.push(session.id);
          break;
        case 'failed':
          holds.push([session.id, config.retryMs]);
          break;
        default:
          assertExhausted(ending, 'session ending');
      }
    }
    for (const [reason, group] of stops) {
      const rows = await stopTradingSessions(db, { ids: [...group.keys()], reason });
      for (const row of rows) logStop(row, reason, group.get(row.id));
      checkpoint();
    }
    await markSessionDecisions(db, marked);
    checkpoint();
    // keeps the accounts "in work": the balance refresh and the broker session stay on them
    await touchBalancesRequested(db, [
      ...new Set(waiting.map((one) => one.prepared.session.brokerAccountId)),
    ]);
    checkpoint();
    for (const [id, ms] of holds) heldUntil.set(id, tickAt + Math.max(ms, config.tickMs));
    return {
      held: holds.length,
      stopped: endings.filter(([, ending]) => ending.kind === 'stop').length,
    };
  }

  // The race bounds the tick's wait, not a statement: an abort does not cancel a pg query, so a
  // statement that outlives the deadline still lands (a mark, a touch - idempotent; a stop - its
  // CAS), and the next tick reads its result. Undefined: the deadline or the stop signal ended it.
  async function batchWithDeadline(
    runnable: readonly RunnableSession[],
    tickAt: number,
    startedMs: number,
  ): Promise<BatchCounts | undefined> {
    const deadline = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<'expired'>((resolve) => {
      timeout = setTimeout(() => {
        deadline.abort();
        resolve('expired');
      }, config.attemptTimeoutMs);
    });
    const signal = AbortSignal.any([stopping.signal, deadline.signal]);
    const run = Promise.resolve()
      .then(() => runBatch(runnable, tickAt, signal))
      .catch((error: unknown): undefined => {
        if (stopping.signal.aborted || error instanceof AttemptAborted) return undefined;
        throw error;
      });
    try {
      const outcome = await Promise.race([run, expired]);
      if (outcome !== 'expired') return outcome;
      logger.warn(
        { runnable: runnable.length, ms: Math.round(performance.now() - startedMs) },
        'trading session batch timed out',
      );
      run.catch((error: unknown) => {
        logger.error(errorLogFields(error), 'trading session tick failed');
      });
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function runTick(): Promise<void> {
    const startedMs = performance.now();
    // one reading of the tick's clock (#871): the hold-backs, the pair's hours and the sizer
    const tickAt = now();
    // before the first await: a wake() after this line is served by the next tick
    const woken = pending;
    pending = 0;
    const accounts = [...pendingAccounts];
    pendingAccounts.clear();
    // a timer tick merged into a run of woken ones still sweeps: a tick a tick after the last full
    // one is full
    const full = pendingFull || accounts.length === 0 || tickAt - lastFullAt >= config.tickMs;
    pendingFull = false;
    runningFull = full;
    let swept = 0;
    if (full) {
      const paused = await stopPausedSessions(db, { limit: config.batchSize });
      logStops(paused, TradingSessionStopReason.KillSwitch);
      const expired = await stopExpiredSessions(db, {
        maxDurationMs: config.maxDurationMs,
        limit: config.batchSize,
      });
      logStops(expired, TradingSessionStopReason.Timeout);
      const halted = await stopHaltedSessions(db, { limit: config.batchSize });
      logStops(halted, TradingSessionStopReason.ManualReview);
      swept = paused.length + expired.length + halted.length;
      lastFullAt = tickAt;
    }

    for (const [id, until] of heldUntil) {
      // the interval's jitter: a hold of a tick ends at the next tick (H1-O5″)
      if (until > tickAt + config.holdSlackMs) continue;
      heldUntil.delete(id);
    }
    const runnable = await listRunnableSessions(db, {
      limit: config.batchSize,
      maxDurationMs: config.maxDurationMs,
      exclude: [...heldUntil.keys()],
      ...(full ? {} : { accounts }),
    });
    const summary = {
      runnable: runnable.length,
      attempted: 0,
      held: 0,
      stopped: 0,
      woken,
      accounts: full ? 0 : accounts.length,
      ms: 0,
    };
    if (!stopped && runnable.length > 0) {
      summary.attempted = runnable.length;
      const counts = await batchWithDeadline(runnable, tickAt, startedMs);
      if (counts !== undefined) {
        summary.held = counts.held;
        summary.stopped = counts.stopped;
      }
    }
    summary.stopped += swept;
    summary.ms = Math.round(performance.now() - startedMs);
    logger.debug(summary, 'trading session tick');
  }

  function tick(): Promise<void> {
    if (stopped) return Promise.resolve();
    // the interval's tick during a tick over accounts only: one full tick right after it (#871,
    // review round 1); during a full tick the running one serves it, as before #871
    if (running !== undefined && !runningFull) {
      pendingFull = true;
      return running.then(() => running);
    }
    running ??= runTick()
      .catch((error: unknown) => {
        logger.error(errorLogFields(error), 'trading session tick failed');
      })
      .finally(() => {
        running = undefined;
        if (pending > 0 || pendingFull) void tick();
      });
    return running;
  }

  function wake(brokerAccountId?: string) {
    pending += 1;
    if (brokerAccountId === undefined) pendingFull = true;
    else pendingAccounts.add(brokerAccountId);
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
      stopping.abort();
      await running;
    },
  };
}
