import { Queue, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import {
  errorLogFields,
  TRADING_INTENTS_DEAD_LETTER_QUEUE,
  TradeIntentFailureReason,
  tradeIntentJobPayloadSchema,
} from '@binarius/shared';
import { OutboxTopic } from '@binarius/db';
import type { DeadLetter, DeadLetterSink, JobDeadLetter } from '../dead-letter';
import { LOCK_DURATION_MS, MAX_STALLED_COUNT, STALLED_INTERVAL_MS } from './config';
import { InvalidJobError, type Logger } from './processor';

export interface ConsumerDeps<Outcome extends string> {
  // trading-intents (the executor) or trading-reconciliation (#89, the hand-off to the pass)
  topic: OutboxTopic;
  connection: Redis;
  processor: (payload: unknown) => Promise<Outcome>;
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
  topic: OutboxTopic,
  job: Job | undefined,
  error: Error,
): Promise<void> {
  const payload = tradeIntentJobPayloadSchema.safeParse(job?.data);
  const entry: JobDeadLetter = {
    source: 'intent_job',
    intentId: payload.success ? payload.data.intentId : null,
    topic,
    reason:
      error instanceof InvalidJobError
        ? TradeIntentFailureReason.InvalidJob
        : TradeIntentFailureReason.ProcessingFailed,
    failedAt: new Date().toISOString(),
  };
  logger.error(
    { ...errorLogFields(error), intentId: entry.intentId, topic, reason: entry.reason },
    'intent job failed',
  );
  try {
    await sink.add('dead', entry);
  } catch (sinkError) {
    logger.error({ ...errorLogFields(sinkError), intentId: entry.intentId }, 'dlq_publish_failed');
  }
}

export function startIntentConsumer<Outcome extends string>({
  topic,
  connection,
  processor,
  logger,
  concurrency,
  prefix,
}: ConsumerDeps<Outcome>): IntentConsumer {
  const options = prefix === undefined ? {} : { prefix };
  const dlq = new Queue<DeadLetter>(TRADING_INTENTS_DEAD_LETTER_QUEUE, { connection, ...options });
  const worker = new Worker(topic, (job) => processor(job.data), {
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
    const write = deadLetter(dlq, logger, topic, job, error).finally(() => inFlight.delete(write));
    inFlight.add(write);
  });
  worker.on('error', (error) =>
    logger.error({ ...errorLogFields(error), topic }, 'intent worker error'),
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
