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
import { InvalidJobError, type Logger } from './processor';
import {
  ReconcileUnavailableReason,
  type IntentReconciler,
  type ReconcileResult,
} from './reconciler';

// --- The trading-reconciliation job: a hand-off to the pass ----------------------------------

export type ReconciliationJobOutcome =
  // unknown → reconciling, and the pass was woken
  | 'reconciling'
  // the intent is already reconciling, parked or terminal, or another delivery won the CAS
  | 'noop';

export interface ReconciliationJobDeps {
  db: Db;
  logger: Logger;
  wake(): void;
}

// The job never asks the broker: the pass is the single attempt path. A throw (database down)
// fails the job into the dead-letter queue, and the outbox publisher re-pends the row while the
// intent is still unknown, so a reconciliation dead letter is a record, not a loss.
export async function processReconciliationJob(
  { db, logger, wake }: ReconciliationJobDeps,
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
  wake();
  return 'reconciling';
}

// --- The pass ---------------------------------------------------------------------------------

export interface ReconciliationPassConfig {
  tickMs: number;
  // the lease: a claimed intent is not a candidate again before this has passed
  retryMs: number;
  attemptTimeoutMs: number;
  batchSize: number;
}

export interface ReconciliationPassDeps {
  db: Db;
  reconciler: IntentReconciler;
  logger: Logger;
  config: ReconciliationPassConfig;
}

export interface ReconciliationPass {
  // one tick at once, then every tickMs
  start(): void;
  // a tick now unless one runs; a wake during a tick is picked up by the next interval tick
  wake(): void;
  // resolves when the tick (the running one, if any) ends; never rejects
  tick(): Promise<void>;
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
}

type Ending = Exclude<keyof TickSummary, 'candidates'>;

export function createReconciliationPass({
  db,
  reconciler,
  logger,
  config,
}: ReconciliationPassDeps): ReconciliationPass {
  const stopping = new AbortController();
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | undefined;

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
    return ending;
  }

  // The claim is the first write of every attempt, before the broker is asked: no ending can
  // leave an intent at the head of the order.
  async function attempt(id: string): Promise<{ ending: Ending; rateLimited: boolean }> {
    const claimed = await claimReconciling(db, { id, retryMs: config.retryMs });
    if (claimed === undefined) return { ending: 'skipped', rateLimited: false };
    const result = await reconcileWithDeadline(claimed);
    const rateLimited =
      result?.outcome === 'unavailable' && result.reason === ReconcileUnavailableReason.RateLimited;
    return { ending: await persist(claimed, result), rateLimited };
  }

  async function runTick(): Promise<void> {
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
    };
    for (const { id } of candidates) {
      if (stopped) break;
      try {
        const { ending, rateLimited } = await attempt(id);
        summary[ending] += 1;
        if (rateLimited) break;
      } catch (error) {
        logger.error({ ...errorLogFields(error), intentId: id }, 'reconciliation attempt failed');
        summary.failed += 1;
      }
    }
    if (candidates.length > 0) logger.info(summary, 'reconciliation tick');
  }

  function tick(): Promise<void> {
    if (stopped) return Promise.resolve();
    running ??= runTick()
      .catch((error: unknown) => {
        logger.error(errorLogFields(error), 'reconciliation tick failed');
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
    wake() {
      if (stopped || running !== undefined) return;
      void tick();
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      stopping.abort();
      await running;
    },
  };
}
