import type { FastifyBaseLogger } from 'fastify';
import { errorLogFields, TradeIntentFailureReason, TradeIntentStatus } from '@binarius/shared';
import { OutboxStatus, OutboxTopic, rejectIntent, type Db } from '@binarius/db';
import type { JobPublisher } from './bullmq';
import {
  claimOutboxRow,
  listPendingOutbox,
  listStalePublished,
  markPublished,
  recordDeliveryFailure,
  type DeliveryPolicy,
} from './store';

export interface PublisherConfig {
  pollMs: number;
  batchSize: number;
  // trading-intents only; reconciliation rows are never given up on
  maxAttempts: number;
  publishTimeoutMs: number;
  // a published row whose intent has not moved on after this long gets its job checked
  staleQueuedMs: number;
  sweepMs: number;
}

// 1s, 2s, 4s, 8s: the fifth failure exhausts a trading-intents row, so an intent whose delivery
// keeps failing is rejected within ~15s — a binary option order is worthless minutes later anyway
export const DEFAULT_PUBLISHER_CONFIG: PublisherConfig = {
  pollMs: 500,
  batchSize: 50,
  maxAttempts: 5,
  publishTimeoutMs: 5_000,
  staleQueuedMs: 30_000,
  sweepMs: 15_000,
};

const MAX_BACKOFF_MS = 16_000;
export const backoffMs = (attempts: number): number =>
  Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** (attempts - 1));

// a reconciliation row failing this often is worth an operator's eye even though it retries
export const RECONCILIATION_WARN_ATTEMPTS = 5;

// which intent status means "this topic's job has not been consumed yet"
const STALE_TARGETS: readonly { topic: OutboxTopic; intentStatus: TradeIntentStatus }[] = [
  { topic: OutboxTopic.TradingIntents, intentStatus: TradeIntentStatus.Queued },
  { topic: OutboxTopic.TradingReconciliation, intentStatus: TradeIntentStatus.Unknown },
];

export interface PublisherDeps {
  db: Db;
  jobs: JobPublisher;
  logger: FastifyBaseLogger;
  config?: Partial<PublisherConfig>;
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown; timedOut?: boolean };

// Publishes pending outbox rows as BullMQ jobs. Each row is handled in its own short transaction
// (FOR UPDATE SKIP LOCKED → add → published/failed → commit), so several backend replicas can
// run a publisher against one database. wake() short-circuits the poll after a commit.
export class OutboxPublisher {
  private readonly config: PublisherConfig;
  private running = false;
  // separate from `running`: tick()/sweep() are also called directly (tests, one-off passes)
  // and must not be no-ops just because start() never ran
  private stopping = false;
  private loop: Promise<void> | undefined;
  private wakeUp: (() => void) | undefined;

  constructor(private readonly deps: PublisherDeps) {
    this.config = { ...DEFAULT_PUBLISHER_CONFIG, ...deps.config };
  }

  // a no-op while a loop exists, including one that stop() is still waiting for: two loops
  // would share `running` and the finishing stop() would drop the newer loop's reference
  start(): void {
    if (this.loop !== undefined) return;
    this.running = true;
    this.stopping = false;
    this.loop = this.run();
  }

  // resolves once the row in flight (at most one transaction) has finished; the rest of the
  // batch is left for the next start. `stopping` is cleared afterwards so direct tick()/sweep()
  // calls keep working after a stop.
  async stop(): Promise<void> {
    this.stopping = true;
    this.running = false;
    this.wake();
    await this.loop;
    this.loop = undefined;
    this.stopping = false;
  }

  wake(): void {
    this.wakeUp?.();
  }

  // one publishing pass; returns how many rows were processed (published or failed)
  async tick(): Promise<number> {
    const ids = await listPendingOutbox(this.deps.db, this.config.batchSize);
    let processed = 0;
    for (const id of ids) {
      if (this.stopping) break;
      if (await this.publishOne(id)) processed += 1;
    }
    return processed;
  }

  // re-pends published rows whose job is gone; returns how many were re-pended
  async sweep(): Promise<number> {
    let requeued = 0;
    for (const target of STALE_TARGETS) {
      const stale = await listStalePublished(this.deps.db, {
        ...target,
        olderThanMs: this.config.staleQueuedMs,
        limit: this.config.batchSize,
      });
      for (const candidate of stale) {
        if (this.stopping) return requeued;
        const present = await this.withDeadline(
          this.deps.jobs.has(candidate.topic, candidate.intentId),
        );
        // has() may have waited out its deadline: no new database work once stop was requested
        if (this.stopping) return requeued;
        if (!present.ok || present.value) continue;
        await this.deps.db.transaction(async (tx) => {
          const row = await claimOutboxRow(tx, candidate.id, OutboxStatus.Published);
          if (row === undefined) return;
          // a lost job counts as a failed delivery: the attempt cap bounds re-publishing too
          const exhausted = await recordDeliveryFailure(tx, row, this.policyFor(row.topic));
          this.deps.logger.warn(
            { intentId: row.intentId, topic: row.topic, attempts: row.attempts + 1, exhausted },
            'outbox job missing from the queue, re-pending',
          );
          requeued += 1;
        });
      }
    }
    return requeued;
  }

  private async run(): Promise<void> {
    let lastSweep = Date.now();
    while (this.running) {
      try {
        await this.tick();
        if (!this.stopping && Date.now() - lastSweep >= this.config.sweepMs) {
          lastSweep = Date.now();
          await this.sweep();
        }
      } catch (error) {
        this.deps.logger.error(errorLogFields(error), 'outbox publisher pass failed');
      }
      if (this.running) await this.pause();
    }
  }

  private pause(): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(finish, this.config.pollMs);
      this.wakeUp = finish;
      function finish() {
        clearTimeout(timer);
        resolve();
      }
    }).finally(() => {
      this.wakeUp = undefined;
    });
  }

  private async publishOne(id: string): Promise<boolean> {
    return this.deps.db.transaction(async (tx) => {
      const row = await claimOutboxRow(tx, id, OutboxStatus.Pending);
      if (row === undefined) return false;
      const outcome = await this.withDeadline(this.deps.jobs.add(row.topic, row.intentId));
      if (outcome.ok) {
        await markPublished(tx, row.id);
        return true;
      }
      const exhausted = await recordDeliveryFailure(tx, row, this.policyFor(row.topic));
      const attempts = row.attempts + 1;
      // a reconciliation row retries forever, so its first failures are routine; only a row that
      // keeps failing deserves the warning level
      const level =
        row.topic === OutboxTopic.TradingReconciliation && attempts < RECONCILIATION_WARN_ATTEMPTS
          ? 'info'
          : 'warn';
      this.deps.logger[level](
        {
          ...errorLogFields(outcome.error),
          // the timeout this class raises itself carries neither a code nor a telling name
          failure: outcome.timedOut === true ? 'publish_timeout' : 'publish_error',
          intentId: row.intentId,
          topic: row.topic,
          attempts,
          exhausted,
        },
        'outbox publish failed',
      );
      return true;
    });
  }

  // trading-intents gives up after maxAttempts and rejects a still-queued intent (releasing its
  // token) in the same transaction; a reconciliation row is retried for as long as it takes,
  // because giving up on it would strand an unknown intent with its reserve forever
  private policyFor(topic: OutboxTopic): DeliveryPolicy {
    if (topic === OutboxTopic.TradingIntents) {
      return {
        maxAttempts: this.config.maxAttempts,
        backoffMs,
        onExhausted: async (tx, row) => {
          // undefined means the job got through after all and the worker already took the
          // intent; the outbox row is still failed, which is true — its own delivery gave up
          await rejectIntent(tx, {
            id: row.intentId,
            from: TradeIntentStatus.Queued,
            reason: TradeIntentFailureReason.PublishFailed,
          });
        },
      };
    }
    return { maxAttempts: null, backoffMs };
  }

  // Promise.race cannot cancel the Redis command: a late success is harmless because the job id
  // dedupes, and a late rejection is observed here so it never becomes an unhandled rejection
  private withDeadline<T>(operation: Promise<T>): Promise<Outcome<T>> {
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => resolve({ ok: false, error: new Error('publish timed out'), timedOut: true }),
        this.config.publishTimeoutMs,
      );
      operation.then(
        (value) => {
          clearTimeout(timer);
          resolve({ ok: true, value });
        },
        (error: unknown) => {
          clearTimeout(timer);
          resolve({ ok: false, error });
        },
      );
    });
  }
}
