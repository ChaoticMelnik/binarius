import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@binarius/db';
import type { JobPublisher } from './bullmq';
import {
  claimPendingOutbox,
  claimPublishedOutbox,
  listPendingOutbox,
  listStaleQueued,
  markPublished,
  recordDeliveryFailure,
  type OutboxRow,
} from './store';

export interface PublisherConfig {
  pollMs: number;
  batchSize: number;
  maxAttempts: number;
  publishTimeoutMs: number;
  // a published row whose intent is still queued after this long gets its job checked
  staleQueuedMs: number;
  sweepMs: number;
}

// 1s, 2s, 4s, 8s: the fifth failure exhausts the row, so an intent whose delivery keeps failing
// is rejected within ~15s — a binary option order is worthless minutes later anyway
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

export interface PublisherDeps {
  db: Db;
  jobs: JobPublisher;
  logger: FastifyBaseLogger;
  config?: Partial<PublisherConfig>;
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

// Publishes pending outbox rows as BullMQ jobs. Each row is handled in its own short transaction
// (FOR UPDATE SKIP LOCKED → add → published/failed → commit), so several backend replicas can
// run a publisher against one database. wake() short-circuits the poll after a commit.
export class OutboxPublisher {
  private readonly config: PublisherConfig;
  private running = false;
  private loop: Promise<void> | undefined;
  private wakeUp: (() => void) | undefined;

  constructor(private readonly deps: PublisherDeps) {
    this.config = { ...DEFAULT_PUBLISHER_CONFIG, ...deps.config };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  // resolves once the in-flight tick (at most one row's transaction) has finished
  async stop(): Promise<void> {
    this.running = false;
    this.wake();
    await this.loop;
    this.loop = undefined;
  }

  wake(): void {
    this.wakeUp?.();
  }

  // one publishing pass; returns how many rows were processed (published or failed)
  async tick(): Promise<number> {
    const ids = await listPendingOutbox(this.deps.db, this.config.batchSize);
    let processed = 0;
    for (const id of ids) {
      if (await this.publishOne(id)) processed += 1;
    }
    return processed;
  }

  // re-pends published rows whose job is gone; returns how many were re-pended
  async sweep(): Promise<number> {
    const stale = await listStaleQueued(this.deps.db, {
      olderThanMs: this.config.staleQueuedMs,
      limit: this.config.batchSize,
    });
    let requeued = 0;
    for (const candidate of stale) {
      const present = await this.withDeadline(
        this.deps.jobs.has(candidate.topic, candidate.intentId),
      );
      if (!present.ok || present.value) continue;
      await this.deps.db.transaction(async (tx) => {
        const row = await claimPublishedOutbox(tx, candidate.id);
        if (row === undefined) return;
        // a lost job counts as a failed delivery: the attempt cap bounds re-publishing too
        const exhausted = await recordDeliveryFailure(tx, row, this.policy());
        this.deps.logger.warn(
          { intentId: row.intentId, topic: row.topic, attempts: row.attempts + 1, exhausted },
          'outbox job missing from the queue, re-pending',
        );
        requeued += 1;
      });
    }
    return requeued;
  }

  private async run(): Promise<void> {
    let lastSweep = Date.now();
    while (this.running) {
      try {
        await this.tick();
        if (Date.now() - lastSweep >= this.config.sweepMs) {
          lastSweep = Date.now();
          await this.sweep();
        }
      } catch (error) {
        this.deps.logger.error({ err: error }, 'outbox publisher pass failed');
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
      const row = await claimPendingOutbox(tx, id);
      if (row === undefined) return false;
      const outcome = await this.withDeadline(this.deps.jobs.add(row.topic, row.intentId));
      if (outcome.ok) {
        await markPublished(tx, row.id);
        return true;
      }
      const exhausted = await recordDeliveryFailure(tx, row, this.policy());
      this.deps.logger.warn(
        {
          err: outcome.error,
          intentId: row.intentId,
          topic: row.topic,
          attempts: row.attempts + 1,
          exhausted,
        },
        'outbox publish failed',
      );
      return true;
    });
  }

  private policy() {
    return { maxAttempts: this.config.maxAttempts, backoffMs };
  }

  // Promise.race cannot cancel the Redis command: a late success is harmless because the job id
  // dedupes, and a late rejection is observed here so it never becomes an unhandled rejection
  private withDeadline<T>(operation: Promise<T>): Promise<Outcome<T>> {
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => resolve({ ok: false, error: new Error('publish timed out') }),
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

export type { OutboxRow };
