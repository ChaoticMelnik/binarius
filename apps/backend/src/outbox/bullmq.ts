import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { TradeIntentJobPayload } from '@binarius/shared';
import type { OutboxTopic } from '@binarius/db';

export interface JobPublisher {
  add(topic: OutboxTopic, intentId: string): Promise<void>;
  has(topic: OutboxTopic, intentId: string): Promise<boolean>;
  close(): Promise<void>;
}

export interface BullmqPublisherOptions {
  // namespaces every key; tests use a random one per file
  prefix?: string;
}

// One queue per outbox topic; the job id is the intent id, which BullMQ dedupes per queue
// (a custom id may not contain ':', so the topic lives in the queue name, not the id).
export function createBullmqPublisher(
  connection: Redis,
  options: BullmqPublisherOptions = {},
): JobPublisher {
  const queues = new Map<OutboxTopic, Queue<TradeIntentJobPayload>>();
  const queue = (topic: OutboxTopic): Queue<TradeIntentJobPayload> => {
    let existing = queues.get(topic);
    if (existing === undefined) {
      existing = new Queue<TradeIntentJobPayload>(topic, { connection, ...options });
      queues.set(topic, existing);
    }
    return existing;
  };
  return {
    async add(topic, intentId) {
      // attempts 1: the trade command is never retried by the queue; lost deliveries are
      // re-published from the outbox, and the worker's CAS makes a duplicate a no-op
      await queue(topic).add(
        'intent',
        { intentId },
        { jobId: intentId, attempts: 1, removeOnComplete: true, removeOnFail: true },
      );
    },
    async has(topic, intentId) {
      return (await queue(topic).getJob(intentId)) !== undefined;
    },
    async close() {
      await Promise.all([...queues.values()].map((q) => q.close()));
    },
  };
}
