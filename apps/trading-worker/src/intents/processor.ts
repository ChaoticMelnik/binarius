import type pino from 'pino';
import {
  TradeIntentFailureReason,
  TradeIntentStatus,
  tradeIntentJobPayloadSchema,
} from '@binarius/shared';
import {
  findTradeIntent,
  markIntentAccepted,
  markIntentUnknown,
  rejectExpiredIntent,
  rejectIntent,
  takeIntent,
  type Db,
  type TradeIntentRow,
} from '@binarius/db';
import { MAX_DETAIL_LENGTH } from './config';
import type { SubmitResult, TradeExecutor } from './executor';

export type Logger = Pick<pino.Logger, 'info' | 'warn' | 'error' | 'debug'>;

export interface ProcessorConfig {
  intentMaxAgeMs: number;
  submitAckTimeoutMs: number;
  staleSubmittingMs: number;
}

export interface ProcessorDeps {
  db: Db;
  executor: TradeExecutor;
  logger: Logger;
  config: ProcessorConfig;
}

export type ProcessOutcome =
  | 'accepted'
  | 'rejected'
  | 'unknown'
  | 'expired'
  | 'stale_unknown'
  // duplicate delivery, terminal intent, or an outcome the sweeper beat us to
  | 'noop';

// a job the worker cannot act on at all: malformed payload or an intent that does not exist
export class InvalidJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidJobError';
  }
}

// One job: re-read the intent, CAS it forward, let the executor talk to the broker, persist
// the outcome with another CAS. After the intent is `submitting` nothing here throws except
// the database refusing to record the outcome, and the broker command is never re-sent.
export async function processIntentJob(
  deps: ProcessorDeps,
  payload: unknown,
): Promise<ProcessOutcome> {
  const parsed = tradeIntentJobPayloadSchema.safeParse(payload);
  if (!parsed.success) throw new InvalidJobError('job payload is not { intentId: uuid }');
  const { intentId } = parsed.data;
  const intent = await findTradeIntent(deps.db, intentId);
  if (intent === undefined) throw new InvalidJobError(`intent ${intentId} does not exist`);

  switch (intent.status) {
    case TradeIntentStatus.Queued:
      return handleQueued(deps, intent);
    case TradeIntentStatus.Submitting:
      return handleSubmitting(deps, intent);
    default:
      deps.logger.info({ intentId, status: intent.status }, 'intent job is a no-op');
      return 'noop';
  }
}

async function handleQueued(deps: ProcessorDeps, intent: TradeIntentRow): Promise<ProcessOutcome> {
  const { db, logger, config } = deps;
  const taken = await takeIntent(db, {
    id: intent.id,
    expectedVersion: intent.version,
    maxAgeMs: config.intentMaxAgeMs,
  });
  if (taken === undefined) {
    // the same CAS refused: either the intent is too old (then this one succeeds) or someone
    // else moved it (then this one is a no-op too)
    const expired = await db.transaction((tx) =>
      rejectExpiredIntent(tx, {
        id: intent.id,
        expectedVersion: intent.version,
        maxAgeMs: config.intentMaxAgeMs,
      }),
    );
    if (expired !== undefined) {
      logger.warn(
        { intentId: intent.id, createdAt: intent.createdAt },
        'intent expired before submission',
      );
      return 'expired';
    }
    logger.info({ intentId: intent.id }, 'duplicate intent job, intent already taken');
    return 'noop';
  }

  const result = await submitWithDeadline(deps, taken);
  return persistOutcome(deps, taken, result);
}

// a redelivered job for an intent that is still submitting: its first worker is gone (the
// lock lapsed), so once the stale threshold has passed the outcome is unknown by definition
async function handleSubmitting(
  deps: ProcessorDeps,
  intent: TradeIntentRow,
): Promise<ProcessOutcome> {
  const row = await deps.db.transaction((tx) =>
    markIntentUnknown(tx, {
      id: intent.id,
      reason: TradeIntentFailureReason.StaleSubmitting,
      olderThanMs: deps.config.staleSubmittingMs,
    }),
  );
  if (row === undefined) {
    deps.logger.info({ intentId: intent.id }, 'intent still submitting elsewhere, leaving it');
    return 'noop';
  }
  deps.logger.warn(
    { intentId: intent.id, submittedAt: intent.submittedAt },
    'stale submitting intent marked unknown',
  );
  return 'stale_unknown';
}

// The deadline is enforced here, not delegated to the executor: an implementation that ignores
// the signal cannot hold the job past it. A late settle is observed so it never surfaces as an
// unhandled rejection, and it is dropped because the outcome CAS already moved on.
function submitWithDeadline(deps: ProcessorDeps, intent: TradeIntentRow): Promise<SubmitResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<SubmitResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ outcome: 'unknown', reason: TradeIntentFailureReason.ExecutorTimeout });
    }, deps.config.submitAckTimeoutMs);
  });
  const attempt = Promise.resolve()
    .then(() => deps.executor.submit(intent, controller.signal))
    .catch((error: unknown): SubmitResult => {
      // name and code only: the message of a client-library error may carry a token or a
      // raw broker response, and key-based redaction cannot scrub a string
      deps.logger.error({ err: errorIdentity(error), intentId: intent.id }, 'trade executor threw');
      return { outcome: 'unknown', reason: TradeIntentFailureReason.ExecutorError };
    });
  return Promise.race([attempt, deadline]).finally(() => clearTimeout(timer));
}

async function persistOutcome(
  deps: ProcessorDeps,
  taken: TradeIntentRow,
  result: SubmitResult,
): Promise<ProcessOutcome> {
  const { db, logger } = deps;
  const cas = { id: taken.id, expectedVersion: taken.version };
  let row: TradeIntentRow | undefined;
  switch (result.outcome) {
    case 'accepted':
      row = await markIntentAccepted(db, { ...cas, transport: result.transport });
      break;
    case 'rejected':
      row = await db.transaction((tx) =>
        rejectIntent(tx, { ...cas, from: TradeIntentStatus.Submitting, reason: result.reason }),
      );
      break;
    case 'unknown':
      row = await db.transaction((tx) => markIntentUnknown(tx, { ...cas, reason: result.reason }));
      break;
  }
  const detail = 'detail' in result ? result.detail?.slice(0, MAX_DETAIL_LENGTH) : undefined;
  if (row === undefined) {
    logger.warn(
      { intentId: taken.id, outcome: result.outcome, detail },
      'executor outcome dropped: the intent moved on while the broker was answering',
    );
    return 'noop';
  }
  logger.info(
    { intentId: taken.id, outcome: result.outcome, status: row.status, detail },
    'intent outcome recorded',
  );
  return result.outcome;
}

function errorIdentity(error: unknown): { name: string; code?: string } {
  const name = error instanceof Error ? error.name : typeof error;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? { name, code } : { name };
}
