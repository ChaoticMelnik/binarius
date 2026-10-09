import type pino from 'pino';
import { errorLogFields, TradeIntentFailureReason, type TradeMode } from '@binarius/shared';
import type { OutboxTopic } from '@binarius/db';

// The one dead-letter queue (TRADING_INTENTS_DEAD_LETTER_QUEUE) and what may go in it: codes and
// ids only, never an exception text, an amount or a broker payload.

export interface JobDeadLetter {
  source: 'intent_job';
  intentId: string | null;
  // the queue the job came from; both consumers share one dead-letter queue
  topic: OutboxTopic;
  reason: TradeIntentFailureReason;
  failedAt: string;
}

// A broker session write that threw (#92): which event of which account, never its payload - no
// amount, balance or user object, only the ids an operator needs to look the event up.
export interface SessionDeadLetter {
  source: 'user_data' | 'update_balance' | 'close_trade_success';
  accountId: string;
  // update_balance and close_trade_success
  mode: TradeMode | null;
  // close_trade_success: the event's trade ids (the first failing event of the hour's)
  brokerTradeIds: string[];
  reason: typeof TradeIntentFailureReason.ProcessingFailed;
  // the worker's clock, like a job entry's
  failedAt: string;
}

export type DeadLetter = JobDeadLetter | SessionDeadLetter;

export interface DeadLetterSink {
  add(name: string, data: DeadLetter, options?: { jobId?: string }): Promise<unknown>;
}

// One entry per account, source and UTC hour: BullMQ adds nothing while a job with the id exists,
// and nothing consumes this queue, so a writer failing on every event cannot grow it without
// bound. The log line still marks every failure. BullMQ refuses ':' in a custom id.
export const sessionDeadLetterJobId = (
  entry: Pick<SessionDeadLetter, 'accountId' | 'source' | 'failedAt'>,
) => `session.${entry.accountId}.${entry.source}.${entry.failedAt.slice(0, 13)}`;

// Never rejects and never waits longer than timeoutMs: the session manager awaits it inside the
// account's write queue, and the shared Redis connection queues a command while it is down
// instead of failing it. A write cut by the timeout still lands once Redis is back.
export async function deadLetterSessionWrite(
  sink: DeadLetterSink,
  logger: Pick<pino.Logger, 'error'>,
  entry: Omit<SessionDeadLetter, 'reason' | 'failedAt'>,
  timeoutMs: number,
): Promise<void> {
  const failedAt = new Date().toISOString();
  const full: SessionDeadLetter = {
    ...entry,
    reason: TradeIntentFailureReason.ProcessingFailed,
    failedAt,
  };
  const fields = { accountId: entry.accountId, source: entry.source };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const write = sink.add('dead', full, { jobId: sessionDeadLetterJobId(full) }).then(
    () => 'written' as const,
    (error: unknown) => {
      logger.error({ ...errorLogFields(error), ...fields }, 'dlq_publish_failed');
      return 'failed' as const;
    },
  );
  try {
    if ((await Promise.race([write, timedOut])) === 'timeout') {
      logger.error({ ...fields, reason: 'timeout' }, 'dlq_publish_failed');
    }
  } finally {
    clearTimeout(timer);
  }
}
