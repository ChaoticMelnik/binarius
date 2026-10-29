import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { DepositModeSwitch } from '@binarius/shared';
import type { Db } from './client';
import { depositEvents } from './schema/deposit-events';
import type { DbExecutor } from './trade-intent-ops';

// The switch to real after a deposit (#686, docs/trading-mode.md → The automatic switch after a
// deposit): the pass's work queue and the outcome columns of deposit_events. An outcome is written
// once, only where mode_switch is NULL, so one payment — one row (deposit_events_source_payment_idx)
// — switches the mode at most once whatever its postbacks and passes.

// Attributed rows with no outcome yet, oldest first (deposit_events_mode_switch_pending_idx: the
// query's predicate implies the index's). Only rows an authenticated receipt wrote (#142,
// docs/postbacks.md → Authenticity); verification never changes after the insert, so the pass need
// not re-read it under the lock.
export async function listDepositsAwaitingModeSwitch(
  db: Db,
  { limit }: { limit: number },
): Promise<string[]> {
  const rows = await db
    .select({ id: depositEvents.id })
    .from(depositEvents)
    .where(
      and(
        isNotNull(depositEvents.userId),
        isNull(depositEvents.modeSwitch),
        isNotNull(depositEvents.verification),
      ),
    )
    .orderBy(asc(depositEvents.createdAt), asc(depositEvents.id))
    .limit(limit);
  return rows.map((row) => row.id);
}

// The row's outcome, if it has none yet. false: another writer was first.
export async function markDepositModeSwitch(
  exec: DbExecutor,
  { depositEventId, outcome }: { depositEventId: string; outcome: DepositModeSwitch },
): Promise<boolean> {
  const marked = await exec
    .update(depositEvents)
    .set({ modeSwitch: outcome, modeSwitchAt: sql`now()` })
    .where(and(eq(depositEvents.id, depositEventId), isNull(depositEvents.modeSwitch)))
    .returning({ id: depositEvents.id });
  return marked.length > 0;
}

// Every waiting row of the user, in the caller's transaction. Returns how many.
export async function markUserDepositModeSwitches(
  exec: DbExecutor,
  { userId, outcome }: { userId: string; outcome: DepositModeSwitch },
): Promise<number> {
  const marked = await exec
    .update(depositEvents)
    .set({ modeSwitch: outcome, modeSwitchAt: sql`now()` })
    .where(and(eq(depositEvents.userId, userId), isNull(depositEvents.modeSwitch)))
    .returning({ id: depositEvents.id });
  return marked.length;
}
