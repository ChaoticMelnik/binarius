import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { Db } from './client';
import { NotificationJobStatus, notificationJobs } from './schema/notification-jobs';
import { users } from './schema/users';
import type { Tx } from './trade-intent-ops';

// Whether the bot may send to a user, as a predicate over `users`. Every sender puts it in its
// claim query instead of spelling the column, so a later rule (#120: frequency, opt-out) is one
// more conjunct here and reaches every sender at once.
export function deliverable(): SQL {
  return sql`${users.telegramBlockedAt} is null`;
}

// Precondition, which the caller's transaction owns: the users row is already held (lock order
// users → notification_jobs). Returns how many jobs it canceled.
export async function cancelPendingNotificationJobs(tx: Tx, userId: string): Promise<number> {
  const canceled = await tx
    .update(notificationJobs)
    .set({ status: NotificationJobStatus.Canceled })
    .where(
      and(
        eq(notificationJobs.userId, userId),
        eq(notificationJobs.status, NotificationJobStatus.Pending),
      ),
    )
    .returning({ id: notificationJobs.id });
  return canceled.length;
}

// The user blocked the bot (or Telegram refused a send with 403). The first time is kept; the
// cancel runs on every call, so a job created between two signals is caught by the second.
// No users row → undefined and nothing is inserted: rows are created by /start, and a user who
// never started cannot be mailed anyway.
export async function markTelegramBlocked(
  db: Db,
  telegramUserId: bigint,
): Promise<{ userId: string; canceledJobs: number } | undefined> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(users)
      .set({ telegramBlockedAt: sql`coalesce(${users.telegramBlockedAt}, now())` })
      .where(eq(users.telegramUserId, telegramUserId))
      .returning({ id: users.id });
    if (row === undefined) return undefined;
    const canceledJobs = await cancelPendingNotificationJobs(tx, row.id);
    return { userId: row.id, canceledJobs };
  });
}

// The user unblocked the bot. Reports whether a users row exists, marked or not.
export async function markTelegramReachable(db: Db, telegramUserId: bigint): Promise<boolean> {
  const rows = await db
    .update(users)
    .set({ telegramBlockedAt: null })
    .where(eq(users.telegramUserId, telegramUserId))
    .returning({ id: users.id });
  return rows.length > 0;
}
