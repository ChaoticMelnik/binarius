import { and, eq, sql } from 'drizzle-orm';
import { TradeIntentFailureReason, TradeIntentStatus } from '@binarius/shared';
import { markIntentUnknown, tradeIntents, type Db } from '@binarius/db';
import type { Logger } from './processor';

export interface SweepOptions {
  olderThanMs: number;
  limit: number;
}

// Intents whose worker died after taking them and whose job never came back (lost with the
// lock, or dropped by removeOnFail): the same predicate the redelivery branch uses, applied
// on a timer so a job-less intent cannot block its account forever.
export async function sweepStaleSubmitting(
  db: Db,
  { olderThanMs, limit }: SweepOptions,
): Promise<number> {
  const stale = await db
    .select({ id: tradeIntents.id })
    .from(tradeIntents)
    .where(
      and(
        eq(tradeIntents.status, TradeIntentStatus.Submitting),
        sql`${tradeIntents.submittedAt} < now() - (${olderThanMs}::int * interval '1 millisecond')`,
      ),
    )
    .orderBy(tradeIntents.submittedAt)
    .limit(limit);
  let moved = 0;
  for (const { id } of stale) {
    const row = await db.transaction((tx) =>
      markIntentUnknown(tx, { id, reason: TradeIntentFailureReason.StaleSubmitting, olderThanMs }),
    );
    if (row !== undefined) moved += 1;
  }
  return moved;
}

export interface SweeperDeps extends SweepOptions {
  db: Db;
  logger: Logger;
  intervalMs: number;
}

export function startSweeper({ db, logger, intervalMs, olderThanMs, limit }: SweeperDeps): {
  stop(): void;
} {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void sweepStaleSubmitting(db, { olderThanMs, limit })
      .then((moved) => {
        if (moved > 0) logger.warn({ moved }, 'stale submitting intents marked unknown');
      })
      .catch((error: unknown) => logger.error({ err: error }, 'stale submitting sweep failed'))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  return { stop: () => clearInterval(timer) };
}
