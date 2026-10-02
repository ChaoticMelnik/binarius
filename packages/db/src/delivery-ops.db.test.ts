import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UserStatus } from '@binarius/shared';
import { createTempDatabase, seedUser, type TempDatabase } from './testing';
import { NotificationJobStatus, notificationJobs, users } from './schema/index';
import {
  cancelPendingNotificationJobs,
  deliverable,
  markTelegramBlocked,
  markTelegramReachable,
} from './delivery-ops';

const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for packages/db integration tests (see README → Test database)',
  );
}

let tmp: TempDatabase;
beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
});
afterAll(() => tmp.drop());

const blockedAt = async (userId: string): Promise<Date | null> => {
  const [row] = await tmp.db
    .select({ at: users.telegramBlockedAt })
    .from(users)
    .where(eq(users.id, userId));
  if (row === undefined) throw new Error(`no users row ${userId}`);
  return row.at;
};

const seedJob = async (userId: string, status: NotificationJobStatus): Promise<string> => {
  const [row] = await tmp.db
    .insert(notificationJobs)
    .values({ userId, kind: 'test', status })
    .returning({ id: notificationJobs.id });
  if (row === undefined) throw new Error('seedJob: insert returned no row');
  return row.id;
};

const jobStatus = async (id: string): Promise<NotificationJobStatus | undefined> => {
  const [row] = await tmp.db
    .select({ status: notificationJobs.status })
    .from(notificationJobs)
    .where(eq(notificationJobs.id, id));
  return row?.status;
};

const userCount = async (): Promise<number> => {
  const [row] = await tmp.db.select({ n: sql<number>`count(*)::int` }).from(users);
  return row?.n ?? 0;
};

describe('markTelegramBlocked', () => {
  it('sets telegram_blocked_at and keeps the first time on a repeat', async () => {
    const user = await seedUser(tmp.db);
    expect(await blockedAt(user.userId)).toBeNull();

    const first = await markTelegramBlocked(tmp.db, BigInt(user.telegramUserId));
    expect(first?.userId).toBe(user.userId);
    const firstAt = await blockedAt(user.userId);
    expect(firstAt).toBeInstanceOf(Date);

    // backdate, so a second now() would be visibly different
    await tmp.db
      .update(users)
      .set({ telegramBlockedAt: sql`now() - interval '1 hour'` })
      .where(eq(users.id, user.userId));
    const backdated = await blockedAt(user.userId);
    await markTelegramBlocked(tmp.db, BigInt(user.telegramUserId));
    expect((await blockedAt(user.userId))?.getTime()).toBe(backdated?.getTime());
  });

  it('cancels only this user’s pending jobs', async () => {
    const user = await seedUser(tmp.db);
    const other = await seedUser(tmp.db);
    const pendingA = await seedJob(user.userId, NotificationJobStatus.Pending);
    const pendingB = await seedJob(user.userId, NotificationJobStatus.Pending);
    const sent = await seedJob(user.userId, NotificationJobStatus.Sent);
    const canceled = await seedJob(user.userId, NotificationJobStatus.Canceled);
    const othersPending = await seedJob(other.userId, NotificationJobStatus.Pending);

    const result = await markTelegramBlocked(tmp.db, BigInt(user.telegramUserId));

    expect(result?.canceledJobs).toBe(2);
    expect(await jobStatus(pendingA)).toBe(NotificationJobStatus.Canceled);
    expect(await jobStatus(pendingB)).toBe(NotificationJobStatus.Canceled);
    expect(await jobStatus(sent)).toBe(NotificationJobStatus.Sent);
    expect(await jobStatus(canceled)).toBe(NotificationJobStatus.Canceled);
    expect(await jobStatus(othersPending)).toBe(NotificationJobStatus.Pending);
  });

  it('cancels, on a repeat, a job created after the first mark', async () => {
    const user = await seedUser(tmp.db);
    await seedJob(user.userId, NotificationJobStatus.Pending);
    expect((await markTelegramBlocked(tmp.db, BigInt(user.telegramUserId)))?.canceledJobs).toBe(1);

    const late = await seedJob(user.userId, NotificationJobStatus.Pending);
    expect((await markTelegramBlocked(tmp.db, BigInt(user.telegramUserId)))?.canceledJobs).toBe(1);
    expect(await jobStatus(late)).toBe(NotificationJobStatus.Canceled);
  });

  it('answers undefined for an unknown Telegram id and inserts nothing', async () => {
    const before = await userCount();
    expect(await markTelegramBlocked(tmp.db, 987_654_321n)).toBeUndefined();
    expect(await userCount()).toBe(before);
  });
});

describe('markTelegramReachable', () => {
  it('clears a mark and reports the row', async () => {
    const user = await seedUser(tmp.db);
    await markTelegramBlocked(tmp.db, BigInt(user.telegramUserId));
    expect(await markTelegramReachable(tmp.db, BigInt(user.telegramUserId))).toBe(true);
    expect(await blockedAt(user.userId)).toBeNull();
  });

  it('reports a row that was never marked', async () => {
    const user = await seedUser(tmp.db);
    expect(await markTelegramReachable(tmp.db, BigInt(user.telegramUserId))).toBe(true);
    expect(await blockedAt(user.userId)).toBeNull();
  });

  it('reports false for an unknown Telegram id and inserts nothing', async () => {
    const before = await userCount();
    expect(await markTelegramReachable(tmp.db, 987_654_322n)).toBe(false);
    expect(await userCount()).toBe(before);
  });
});

describe('the Telegram mark and the admin block', () => {
  it('neither helper writes status', async () => {
    const user = await seedUser(tmp.db, { status: UserStatus.Blocked });
    await markTelegramBlocked(tmp.db, BigInt(user.telegramUserId));
    await markTelegramReachable(tmp.db, BigInt(user.telegramUserId));
    const [row] = await tmp.db
      .select({ status: users.status })
      .from(users)
      .where(eq(users.id, user.userId));
    expect(row?.status).toBe(UserStatus.Blocked);
  });
});

describe('deliverable', () => {
  const isDeliverable = async (userId: string): Promise<boolean> => {
    const rows = await tmp.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, userId), deliverable()));
    return rows.length === 1;
  };

  it('holds before the mark, not after it, and again after the clear', async () => {
    const user = await seedUser(tmp.db);
    expect(await isDeliverable(user.userId)).toBe(true);
    await markTelegramBlocked(tmp.db, BigInt(user.telegramUserId));
    expect(await isDeliverable(user.userId)).toBe(false);
    await markTelegramReachable(tmp.db, BigInt(user.telegramUserId));
    expect(await isDeliverable(user.userId)).toBe(true);
  });
});

describe('cancelPendingNotificationJobs', () => {
  it('returns 0 when nothing is pending', async () => {
    const user = await seedUser(tmp.db);
    await seedJob(user.userId, NotificationJobStatus.Sent);
    await seedJob(user.userId, NotificationJobStatus.Failed);
    const count = await tmp.db.transaction((tx) => cancelPendingNotificationJobs(tx, user.userId));
    expect(count).toBe(0);
  });
});
