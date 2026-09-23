import { and, eq, lt, sql } from 'drizzle-orm';
import { TradeIntentFailureReason, TradeIntentStatus } from '@binarius/shared';
import {
  OutboxStatus,
  OutboxTopic,
  outboxEvents,
  rejectIntent,
  tradeIntents,
  type Db,
  type Tx,
} from '@binarius/db';

export interface OutboxRow {
  id: string;
  intentId: string;
  topic: OutboxTopic;
  attempts: number;
}

export interface DeliveryPolicy {
  maxAttempts: number;
  backoffMs: (attempts: number) => number;
}

const outboxRowColumns = {
  id: outboxEvents.id,
  intentId: outboxEvents.intentId,
  topic: outboxEvents.topic,
  attempts: outboxEvents.attempts,
};

const millisecondsAgo = (ms: number) => sql`now() - (${ms}::int * interval '1 millisecond')`;

// candidates only: nothing is locked here, the per-row transaction re-checks and locks
export async function listPendingOutbox(db: Db, limit: number): Promise<string[]> {
  const rows = await db
    .select({ id: outboxEvents.id })
    .from(outboxEvents)
    .where(
      and(eq(outboxEvents.status, OutboxStatus.Pending), sql`${outboxEvents.availableAt} <= now()`),
    )
    .orderBy(outboxEvents.availableAt)
    .limit(limit);
  return rows.map((row) => row.id);
}

// SKIP LOCKED: a row another publisher replica holds is simply not ours this round
export async function claimPendingOutbox(tx: Tx, id: string): Promise<OutboxRow | undefined> {
  const [row] = await tx
    .select(outboxRowColumns)
    .from(outboxEvents)
    .where(and(eq(outboxEvents.id, id), eq(outboxEvents.status, OutboxStatus.Pending)))
    .for('update', { skipLocked: true });
  return row;
}

export async function markPublished(tx: Tx, id: string): Promise<void> {
  await tx
    .update(outboxEvents)
    .set({ status: OutboxStatus.Published, publishedAt: sql`now()`, lastError: null })
    .where(eq(outboxEvents.id, id));
}

// One more failed delivery for a claimed row: backoff while attempts remain; on the last one
// the row is failed and, if the intent is still queued, the intent is rejected and its token
// released in this same transaction — a crash between the two would strand the reserve.
// Returns true when the row was exhausted.
export async function recordDeliveryFailure(
  tx: Tx,
  row: OutboxRow,
  policy: DeliveryPolicy,
): Promise<boolean> {
  const attempts = row.attempts + 1;
  const exhausted = attempts >= policy.maxAttempts;
  await tx
    .update(outboxEvents)
    .set({
      attempts,
      status: exhausted ? OutboxStatus.Failed : OutboxStatus.Pending,
      availableAt: exhausted
        ? undefined
        : sql`now() + (${policy.backoffMs(attempts)}::int * interval '1 millisecond')`,
      lastError: TradeIntentFailureReason.PublishFailed,
    })
    .where(eq(outboxEvents.id, row.id));
  if (exhausted) {
    // undefined here means the job got through after all and the worker already took the
    // intent; the outbox row is still failed, which is true — its own delivery gave up
    await rejectIntent(tx, {
      id: row.intentId,
      from: TradeIntentStatus.Queued,
      reason: TradeIntentFailureReason.PublishFailed,
    });
  }
  return exhausted;
}

// published rows whose intent is still queued after olderThanMs: the job may have been lost
export async function listStaleQueued(
  db: Db,
  { olderThanMs, limit }: { olderThanMs: number; limit: number },
): Promise<OutboxRow[]> {
  return db
    .select(outboxRowColumns)
    .from(outboxEvents)
    .innerJoin(tradeIntents, eq(tradeIntents.id, outboxEvents.intentId))
    .where(
      and(
        eq(outboxEvents.status, OutboxStatus.Published),
        eq(outboxEvents.topic, OutboxTopic.TradingIntents),
        eq(tradeIntents.status, TradeIntentStatus.Queued),
        lt(outboxEvents.publishedAt, millisecondsAgo(olderThanMs)),
      ),
    )
    .orderBy(outboxEvents.publishedAt)
    .limit(limit);
}

// re-lock the published row so two sweepers cannot both count the same lost job
export async function claimPublishedOutbox(tx: Tx, id: string): Promise<OutboxRow | undefined> {
  const [row] = await tx
    .select(outboxRowColumns)
    .from(outboxEvents)
    .where(and(eq(outboxEvents.id, id), eq(outboxEvents.status, OutboxStatus.Published)))
    .for('update', { skipLocked: true });
  return row;
}
