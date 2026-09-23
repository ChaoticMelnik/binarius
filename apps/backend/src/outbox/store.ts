import { and, eq, lt, sql } from 'drizzle-orm';
import { TradeIntentFailureReason, type TradeIntentStatus } from '@binarius/shared';
import {
  OutboxStatus,
  OutboxTopic,
  millisecondsAgo,
  outboxEvents,
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
  // null: never give up — the row returns to pending with the capped backoff every time
  maxAttempts: number | null;
  backoffMs: (attempts: number) => number;
  // runs in the same transaction as the exhaustion; what "giving up" means for the intent is
  // the caller's business, this module only knows outbox rows
  onExhausted?: (tx: Tx, row: OutboxRow) => Promise<void>;
}

const outboxRowColumns = {
  id: outboxEvents.id,
  intentId: outboxEvents.intentId,
  topic: outboxEvents.topic,
  attempts: outboxEvents.attempts,
};

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
export async function claimOutboxRow(
  tx: Tx,
  id: string,
  status: OutboxStatus,
): Promise<OutboxRow | undefined> {
  const [row] = await tx
    .select(outboxRowColumns)
    .from(outboxEvents)
    .where(and(eq(outboxEvents.id, id), eq(outboxEvents.status, status)))
    .for('update', { skipLocked: true });
  return row;
}

export async function markPublished(tx: Tx, id: string): Promise<void> {
  await tx
    .update(outboxEvents)
    .set({ status: OutboxStatus.Published, publishedAt: sql`now()`, lastError: null })
    .where(eq(outboxEvents.id, id));
}

// One more failed delivery for a claimed row (pending, or published with its job gone): backoff
// while attempts remain, otherwise failed plus the policy's onExhausted in this same
// transaction — a crash between the two would strand whatever onExhausted has to undo.
// Returns true when the row was exhausted.
export async function recordDeliveryFailure(
  tx: Tx,
  row: OutboxRow,
  policy: DeliveryPolicy,
): Promise<boolean> {
  const attempts = row.attempts + 1;
  const exhausted = policy.maxAttempts !== null && attempts >= policy.maxAttempts;
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
  if (exhausted) await policy.onExhausted?.(tx, row);
  return exhausted;
}

export interface StalePublishedQuery {
  topic: OutboxTopic;
  // the intent status that means "still waiting for this topic's consumer"
  intentStatus: TradeIntentStatus;
  olderThanMs: number;
  limit: number;
}

// published rows whose intent has not moved on after olderThanMs: the job may have been lost
export async function listStalePublished(
  db: Db,
  { topic, intentStatus, olderThanMs, limit }: StalePublishedQuery,
): Promise<OutboxRow[]> {
  return db
    .select(outboxRowColumns)
    .from(outboxEvents)
    .innerJoin(tradeIntents, eq(tradeIntents.id, outboxEvents.intentId))
    .where(
      and(
        eq(outboxEvents.status, OutboxStatus.Published),
        eq(outboxEvents.topic, topic),
        eq(tradeIntents.status, intentStatus),
        lt(outboxEvents.publishedAt, millisecondsAgo(olderThanMs)),
      ),
    )
    .orderBy(outboxEvents.publishedAt)
    .limit(limit);
}
