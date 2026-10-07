import { and, eq, sql, type SQL } from 'drizzle-orm';
import { NotificationLevel, type DecimalString } from '@binarius/shared';
import type { Db } from './client';
import { literal } from './schema/columns';
import { NotificationJobStatus, notificationJobs } from './schema/notification-jobs';
import { users } from './schema/users';
import type { Tx } from './trade-intent-ops';
import { canonicalStake } from './user-ops';

// Whether the bot may mail a user at all, as a predicate over `users`: reachable (#119) and not
// opted out (#120). A sender puts it — or acceptsMailing(), which includes it — in its claim
// query instead of spelling the columns, so a later rule is one more conjunct here.
export function deliverable(): SQL {
  return sql`(${users.telegramBlockedAt} is null and ${users.notificationLevel} <> ${literal(NotificationLevel.Off)})`;
}

// `reduced`: at most one mailing per this many hours, counted from what was sent (sent_at).
export const REDUCED_LEVEL_WINDOW_HOURS = 24;

// deliverable() plus the frequency of `reduced`, as a predicate over `users` for a sender's claim
// query. A sender records each mailing as a `sent` notification_jobs row with sent_at, which is
// what the window reads. Two senders claiming one user at the same instant can both pass the
// `not exists`; a sender that cannot accept that locks the users row first.
export function acceptsMailing(): SQL {
  return sql`(${deliverable()} and (${users.notificationLevel} = ${literal(NotificationLevel.All)} or not exists (
    select 1 from ${notificationJobs}
    where ${notificationJobs.userId} = ${users.id}
      and ${notificationJobs.status} = ${literal(NotificationJobStatus.Sent)}
      and ${notificationJobs.sentAt} > now() - make_interval(hours => ${REDUCED_LEVEL_WINDOW_HOURS})
  )))`;
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
// No users row → undefined and nothing is inserted: rows are created by /users/start (/start and
// /settings), and a user who never wrote to the bot cannot be mailed anyway.
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

// The user's choice in /settings. Writes the level only — never status or telegram_blocked_at.
// `off` cancels what is already scheduled in the same transaction (lock order users →
// notification_jobs; the UPDATE holds the users row); `reduced` cancels nothing, its window is
// applied when a sender claims. No users row → undefined and nothing is inserted.
export async function setNotificationLevel(
  db: Db,
  telegramUserId: bigint,
  level: NotificationLevel,
): Promise<
  { level: NotificationLevel; demoStake: DecimalString | null; canceledJobs: number } | undefined
> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(users)
      .set({ notificationLevel: level })
      .where(eq(users.telegramUserId, telegramUserId))
      .returning({ id: users.id, level: users.notificationLevel, demoStake: users.demoStake });
    if (row === undefined) return undefined;
    const canceledJobs =
      level === NotificationLevel.Off ? await cancelPendingNotificationJobs(tx, row.id) : 0;
    return { level: row.level, demoStake: canonicalStake(row.demoStake), canceledJobs };
  });
}
