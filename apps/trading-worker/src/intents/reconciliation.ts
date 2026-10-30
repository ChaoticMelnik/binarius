import {
  errorLogFields,
  TradeIntentFailureReason,
  TradeIntentStatus,
  tradeIntentJobPayloadSchema,
} from '@binarius/shared';
import {
  claimReconciling,
  concludeReconciled,
  findTradeIntent,
  haltAccountForManualReview,
  listReconcilingCandidates,
  rejectIntent,
  startReconciling,
  TradeIntentMismatchError,
  type Db,
  type ManualReviewReason,
  type TradeIntentRow,
} from '@binarius/db';
import type { BrokerGetMeter } from '../broker/get-budget';
import type { BalanceCheck, BalanceCheckEnding } from './balance-check';
import { InvalidJobError, type Logger } from './processor';
import {
  ReconcileUnavailableReason,
  type IntentReconciler,
  type ReconcileResult,
} from './reconciler';

// --- The trading-reconciliation job: a hand-off to the pass ----------------------------------

export type ReconciliationJobOutcome =
  // unknown → reconciling; the consumer's wrapper wakes the pass after the commit (#872)
  | 'reconciling'
  // the intent is already reconciling, parked or terminal, or another delivery won the CAS
  | 'noop';

export interface ReconciliationJobDeps {
  db: Db;
  logger: Logger;
}

// The job never asks the broker: the pass is the single attempt path. The consumer's wrapper
// (worker.ts) wakes the pass once this returns 'reconciling', after the commit; the broker GETs a
// minute are bounded by the runtime budget (broker/get-budget.ts, #872), not by the interval. A
// throw (database down) fails the job into the dead-letter queue, and the outbox publisher re-pends the row while the
// intent is still unknown, so a reconciliation dead letter is a record, not a loss.
export async function processReconciliationJob(
  { db, logger }: ReconciliationJobDeps,
  payload: unknown,
): Promise<ReconciliationJobOutcome> {
  const parsed = tradeIntentJobPayloadSchema.safeParse(payload);
  if (!parsed.success) throw new InvalidJobError('job payload is not { intentId: uuid }');
  const { intentId } = parsed.data;
  const intent = await findTradeIntent(db, intentId);
  if (intent === undefined) throw new InvalidJobError(`intent ${intentId} does not exist`);
  if (intent.status !== TradeIntentStatus.Unknown) {
    logger.info({ intentId, status: intent.status }, 'reconciliation job is a no-op');
    return 'noop';
  }
  const row = await startReconciling(db, { id: intentId, expectedVersion: intent.version });
  if (row === undefined) {
    logger.info({ intentId }, 'reconciliation job is a no-op, the intent moved on');
    return 'noop';
  }
  logger.info({ intentId }, 'intent reconciling');
  return 'reconciling';
}

// --- The pass ---------------------------------------------------------------------------------

export interface ReconciliationPassConfig {
  tickMs: number;
  // the lease: a claimed intent is not a candidate again before this has passed
  retryMs: number;
  attemptTimeoutMs: number;
  batchSize: number;
  balanceCheckTimeoutMs: number;
  // the broker GETs reserved for one attempt and for one balance check (#872)
  attemptGets: number;
  checkGets: number;
}

export interface ReconciliationPassDeps {
  db: Db;
  // the reconciler and the balance check send their GETs through this meter's rest (#872)
  reconciler: IntentReconciler;
  // run after the tick's attempts, for every recorded outcome that is checked (#92); never
  // changes the outcome
  balanceCheck: BalanceCheck;
  budget: Pick<BrokerGetMeter, 'begin' | 'end'>;
  logger: Logger;
  config: ReconciliationPassConfig;
  // called after the commit of a write that ended an intent or halted its account, with that
  // account; never throws (#696)
  onIntentEnded?: (brokerAccountId: string) => void;
}

export interface ReconciliationPass {
  // one tick at once, then every tickMs
  start(): void;
  // resolves when the tick (the running one, if any) ends; never rejects
  tick(): Promise<void>;
  // a tick now, or one right after the running one; never throws; after stop(), nothing (#872)
  wake(): void;
  // stops the timer, aborts the attempt's signal and waits for the running tick
  stop(): Promise<void>;
}

export interface TickSummary {
  candidates: number;
  accepted: number;
  settled: number;
  rejected: number;
  manualReview: number;
  unavailable: number;
  // the claim was refused: another replica holds the lease, or the status moved
  skipped: number;
  // the outcome CAS found the intent moved after the claim
  dropped: number;
  // the reconciler or an outcome write threw
  failed: number;
  // balance checks that compared at least one mode, and those that alerted (#92)
  balanceCompared: number;
  balanceMismatch: number;
  // reservations the GET budget refused: an attempt (before its claim) or a balance check (#872)
  budget: number;
  // the wakes this tick answered
  woken: number;
  ms: number;
}

type Ending = Exclude<
  keyof TickSummary,
  'candidates' | 'balanceCompared' | 'balanceMismatch' | 'budget' | 'woken' | 'ms'
>;

// an outcome that changed what we hold at the broker, or proved what we do not (#92). Not
// manualReview: the account is halted and alerted already, and the parked intent keeps its mode
// out of any compare
const CHECKED_ENDINGS: ReadonlySet<Ending> = new Set(['accepted', 'settled', 'rejected']);

// the endings that end the intent (settled, rejected) or halt its account (manual_review): they wake
// the trading session orchestrator (#696)
const ENDED_INTENT: ReadonlySet<Ending> = new Set(['settled', 'rejected', 'manualReview']);

export function createReconciliationPass({
  db,
  reconciler,
  balanceCheck,
  budget,
  logger,
  config,
  onIntentEnded,
}: ReconciliationPassDeps): ReconciliationPass {
  const stopping = new AbortController();
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | undefined;
  // wakes not yet answered by a tick's start
  let pending = 0;

  // The deadline is enforced here, not delegated to the reconciler: one that ignores the signal
  // cannot hold the tick past it. A late settle is observed and dropped; a throw is logged by
  // name and code only (a client error's message may carry a token) and ends the attempt.
  function reconcileWithDeadline(intent: TradeIntentRow): Promise<ReconcileResult | undefined> {
    const deadline = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<ReconcileResult>((resolve) => {
      timeout = setTimeout(() => {
        deadline.abort();
        resolve({ outcome: 'unavailable', reason: ReconcileUnavailableReason.Timeout });
      }, config.attemptTimeoutMs);
    });
    const signal = AbortSignal.any([stopping.signal, deadline.signal]);
    const attempt = Promise.resolve()
      .then(() => reconciler.reconcile(intent, signal))
      .catch((error: unknown) => {
        logger.error({ ...errorLogFields(error), intentId: intent.id }, 'reconciler threw');
        return undefined;
      });
    return Promise.race([attempt, expired]).finally(() => clearTimeout(timeout));
  }

  // The same shape as reconcileWithDeadline: the pass, not the check, bounds it, and a throw (a
  // database error, a bug) is logged and ends as failed. It never touches the intent.
  function checkWithDeadline(brokerAccountId: string): Promise<BalanceCheckEnding> {
    const deadline = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<BalanceCheckEnding>((resolve) => {
      timeout = setTimeout(() => {
        deadline.abort();
        logger.warn({ brokerAccountId }, 'balance check timed out');
        resolve('failed');
      }, config.balanceCheckTimeoutMs);
    });
    const signal = AbortSignal.any([stopping.signal, deadline.signal]);
    const check = Promise.resolve()
      .then(() => balanceCheck.check(brokerAccountId, signal))
      .catch((error: unknown): BalanceCheckEnding => {
        logger.error({ ...errorLogFields(error), brokerAccountId }, 'balance check threw');
        return 'failed';
      });
    return Promise.race([check, expired]).finally(() => clearTimeout(timeout));
  }

  // Every manual_review out of the pass halts the account in the same transaction (#90). The
  // alert follows the commit, so a halt that rolled back or lost its CAS never alerts.
  async function haltForManualReview(
    claimed: TradeIntentRow,
    reason: ManualReviewReason,
  ): Promise<TradeIntentRow | undefined> {
    const row = await db.transaction((tx) =>
      haltAccountForManualReview(tx, { id: claimed.id, expectedVersion: claimed.version, reason }),
    );
    if (row !== undefined) {
      logger.error(
        { intentId: claimed.id, brokerAccountId: row.brokerAccountId, reason },
        'account halted for manual review',
      );
    }
    return row;
  }

  async function persist(
    claimed: TradeIntentRow,
    result: ReconcileResult | undefined,
  ): Promise<Ending> {
    const cas = { id: claimed.id, expectedVersion: claimed.version };
    if (result === undefined) return 'failed';
    let row: TradeIntentRow | undefined;
    let ending: Ending;
    switch (result.outcome) {
      case 'found':
        try {
          row = await db.transaction((tx) =>
            concludeReconciled(tx, { ...cas, trade: result.trade }),
          );
          ending = row?.status === TradeIntentStatus.Settled ? 'settled' : 'accepted';
        } catch (error) {
          if (!(error instanceof TradeIntentMismatchError)) throw error;
          // the reconciler offered a trade that is not this intent's: retrying would offer it
          // again, so it is a human's
          logger.warn(
            { intentId: claimed.id, brokerTradeId: error.brokerTradeId, mismatch: error.reason },
            'reconciled trade does not match the intent; parked for manual review',
          );
          row = await haltForManualReview(claimed, TradeIntentFailureReason.TradeMismatch);
          ending = 'manualReview';
        }
        break;
      case 'not_found':
        // the one release out of reconciling
        row = await db.transaction((tx) =>
          rejectIntent(tx, {
            ...cas,
            from: TradeIntentStatus.Reconciling,
            reason: TradeIntentFailureReason.ReconciliationNotFound,
          }),
        );
        ending = 'rejected';
        break;
      case 'ambiguous':
        row = await haltForManualReview(claimed, TradeIntentFailureReason.ReconciliationAmbiguous);
        ending = 'manualReview';
        break;
      case 'unresolved':
        row = await haltForManualReview(claimed, TradeIntentFailureReason.ReconciliationNotFound);
        ending = 'manualReview';
        break;
      case 'unavailable':
        logger.warn({ intentId: claimed.id, reason: result.reason }, 'reconciliation unavailable');
        return 'unavailable';
    }
    if (row === undefined) {
      logger.info(
        { intentId: claimed.id, outcome: result.outcome },
        'reconciliation outcome dropped',
      );
      return 'dropped';
    }
    logger.info(
      { intentId: claimed.id, outcome: result.outcome, status: row.status },
      'reconciliation outcome recorded',
    );
    if (ENDED_INTENT.has(ending)) onIntentEnded?.(claimed.brokerAccountId);
    return ending;
  }

  // The claim is the first write of every attempt, before the broker is asked: no ending can
  // leave an intent at the head of the order.
  async function attempt(
    id: string,
  ): Promise<{ ending: Ending; rateLimited: boolean; brokerAccountId?: string }> {
    const claimed = await claimReconciling(db, { id, retryMs: config.retryMs });
    if (claimed === undefined) return { ending: 'skipped', rateLimited: false };
    const result = await reconcileWithDeadline(claimed);
    const rateLimited =
      result?.outcome === 'unavailable' && result.reason === ReconcileUnavailableReason.RateLimited;
    const ending = await persist(claimed, result);
    return { ending, rateLimited, brokerAccountId: claimed.brokerAccountId };
  }

  async function runTick(): Promise<void> {
    const woken = pending;
    pending = 0;
    const started = performance.now();
    const candidates = await listReconcilingCandidates(db, {
      retryMs: config.retryMs,
      limit: config.batchSize,
    });
    const summary: TickSummary = {
      candidates: candidates.length,
      accepted: 0,
      settled: 0,
      rejected: 0,
      manualReview: 0,
      unavailable: 0,
      skipped: 0,
      dropped: 0,
      failed: 0,
      balanceCompared: 0,
      balanceMismatch: 0,
      budget: 0,
      woken,
      ms: 0,
    };
    // the accounts to check, in the order of their outcomes: the checks follow every attempt of
    // the tick, so a check's GET never delays the next intent's claim
    const checks: string[] = [];
    for (const { id } of candidates) {
      if (stopped) break;
      // refused before the claim: the intent keeps its place at the head of the order
      if (!budget.begin(config.attemptGets)) {
        summary.budget += 1;
        break;
      }
      try {
        const { ending, rateLimited, brokerAccountId } = await attempt(id);
        summary[ending] += 1;
        // a 429 is the IP's state: the tick ends, and its checks do not run either
        if (rateLimited) {
          checks.length = 0;
          break;
        }
        if (brokerAccountId !== undefined && CHECKED_ENDINGS.has(ending)) {
          checks.push(brokerAccountId);
        }
      } catch (error) {
        logger.error({ ...errorLogFields(error), intentId: id }, 'reconciliation attempt failed');
        summary.failed += 1;
      } finally {
        budget.end();
      }
    }
    for (const brokerAccountId of checks) {
      if (stopped) break;
      if (!budget.begin(config.checkGets)) {
        summary.budget += 1;
        break;
      }
      let check: BalanceCheckEnding;
      try {
        check = await checkWithDeadline(brokerAccountId);
      } finally {
        budget.end();
      }
      if (check === 'compared' || check === 'mismatch') summary.balanceCompared += 1;
      if (check === 'mismatch') summary.balanceMismatch += 1;
      if (check === 'rate_limited') break;
    }
    summary.ms = Math.round(performance.now() - started);
    if (candidates.length > 0) logger.info(summary, 'reconciliation tick');
  }

  function run(): Promise<void> {
    running ??= runTick()
      .catch((error: unknown) => {
        logger.error(errorLogFields(error), 'reconciliation tick failed');
      })
      .finally(() => {
        running = undefined;
        if (pending > 0 && !stopped) void run();
      });
    return running;
  }

  function tick(): Promise<void> {
    if (stopped) return Promise.resolve();
    return run();
  }

  return {
    tick,
    wake() {
      if (stopped) return;
      pending += 1;
      if (running === undefined) void run();
    },
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
