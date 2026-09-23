import { Queue, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import {
  errorLogFields,
  TRADING_INTENTS_DEAD_LETTER_QUEUE,
  TradeIntentFailureReason,
  tradeIntentJobPayloadSchema,
} from '@binarius/shared';
import { OutboxTopic } from '@binarius/db';
import { LOCK_DURATION_MS, MAX_STALLED_COUNT, STALLED_INTERVAL_MS } from './config';
import { InvalidJobError, type Logger, type ProcessOutcome } from './processor';

export interface DeadLetter {
  intentId: string | null;
  reason: TradeIntentFailureReason;
  failedAt: string;
}

export interface DeadLetterSink {
  add(name: string, data: DeadLetter): Promise<unknown>;
}

export interface ConsumerDeps {
  connection: Redis;
  processor: (payload: unknown) => Promise<ProcessOutcome>;
  logger: Logger;
  concurrency: number;
  prefix?: string;
}

export interface IntentConsumer {
  worker: Worker;
  dlq: Queue<DeadLetter>;
  // resolves once every dead-letter write started so far has settled; call it after
  // worker.close() (which lets active jobs finish and fire their `failed` events) and before
  // closing the queue underneath those writes
  drainDeadLetters(): Promise<void>;
}

// Records a failed job for an operator. Both the DLQ row and the log line carry codes only,
// never the exception text — it could hold connection details. Event listeners are not awaited
// by BullMQ, so this must never reject.
export async function deadLetter(
  sink: DeadLetterSink,
  logger: Logger,
  job: Job | undefined,
  error: Error,
): Promise<void> {
  const payload = tradeIntentJobPayloadSchema.safeParse(job?.data);
  const entry: DeadLetter = {
    intentId: payload.success ? payload.data.intentId : null,
    reason:
      error instanceof InvalidJobError
        ? TradeIntentFailureReason.InvalidJob
        : TradeIntentFailureReason.ProcessingFailed,
    failedAt: new Date().toISOString(),
  };
  logger.error(
    { ...errorLogFields(error), intentId: entry.intentId, reason: entry.reason },
    'intent job failed',
  );
  try {
    await sink.add('dead', entry);
  } catch (sinkError) {
    logger.error(
      { ...errorLogFields(sinkError), intentId: entry.intentId },
      'dlq_publish_failed',
    );
  }
}

export function startIntentConsumer({
  connection,
  processor,
  logger,
  concurrency,
  prefix,
}: ConsumerDeps): IntentConsumer {
  const options = prefix === undefined ? {} : { prefix };
  const dlq = new Queue<DeadLetter>(TRADING_INTENTS_DEAD_LETTER_QUEUE, { connection, ...options });
  const worker = new Worker(OutboxTopic.TradingIntents, (job) => processor(job.data), {
    connection,
    ...options,
    concurrency,
    lockDuration: LOCK_DURATION_MS,
    stalledInterval: STALLED_INTERVAL_MS,
    maxStalledCount: MAX_STALLED_COUNT,
  });
  // BullMQ does not await listeners: the writes are tracked so shutdown can wait for them
  const inFlight = new Set<Promise<void>>();
  // job is undefined when a job that stalled too often was removed by removeOnFail
  worker.on('failed', (job, error) => {
    const write = deadLetter(dlq, logger, job, error).finally(() => inFlight.delete(write));
    inFlight.add(write);
  });
  // a BullMQ worker error is often message-only, so the log says what failed rather than
  // relying on the error to say it
  worker.on('error', (error) =>
    logger.error({ ...errorLogFields(error), failure: 'worker_error' }, 'intent worker error'),
  );
  return {
    worker,
    dlq,
    // deadLetter never rejects, so this cannot either
    drainDeadLetters: async () => {
      await Promise.all([...inFlight]);
    },
  };
}
