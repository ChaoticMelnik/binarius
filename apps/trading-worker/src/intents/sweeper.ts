import { errorLogFields, TradeIntentFailureReason } from '@binarius/shared';
import { listStaleSubmittingIntents, markIntentUnknown, type Db } from '@binarius/db';
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
  const stale = await listStaleSubmittingIntents(db, { olderThanMs, limit });
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
      .catch((error: unknown) =>
        logger.error(errorLogFields(error), 'stale submitting sweep failed'),
      )
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  return { stop: () => clearInterval(timer) };
}
