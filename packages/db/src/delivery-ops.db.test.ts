import { and, eq, sql, type SQL } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NotificationLevel, UserStatus } from '@binarius/shared';
import { createTempDatabase, seedUser, type TempDatabase } from './testing';
import { NotificationJobStatus, notificationJobs, users } from './schema/index';
import {
  acceptsMailing,
  cancelPendingNotificationJobs,
  deliverable,
  markTelegramBlocked,
  markTelegramReachable,
  REDUCED_LEVEL_WINDOW_HOURS,
  setNotificationLevel,
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

const matches = async (userId: string, predicate: SQL): Promise<boolean> => {
  const rows = await tmp.db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), predicate));
  return rows.length === 1;
};
const isDeliverable = (userId: string) => matches(userId, deliverable());
const isMailable = (userId: string) => matches(userId, acceptsMailing());

const setLevel = (user: { telegramUserId: string }, level: NotificationLevel) =>
  setNotificationLevel(tmp.db, BigInt(user.telegramUserId), level);

describe('deliverable', () => {
  it('holds before the mark, not after it, and again after the clear', async () => {
    const user = await seedUser(tmp.db);
    expect(await isDeliverable(user.userId)).toBe(true);
    await markTelegramBlocked(tmp.db, BigInt(user.telegramUserId));
    expect(await isDeliverable(user.userId)).toBe(false);
    await markTelegramReachable(tmp.db, BigInt(user.telegramUserId));
    expect(await isDeliverable(user.userId)).toBe(true);
  });

  it('fails at off, holds again at all and at reduced, and fails on the mark at any level', async () => {
    const user = await seedUser(tmp.db);
    await setLevel(user, NotificationLevel.Off);
    expect(await isDeliverable(user.userId)).toBe(false);
    await setLevel(user, NotificationLevel.All);
    expect(await isDeliverable(user.userId)).toBe(true);
    await setLevel(user, NotificationLevel.Reduced);
    expect(await isDeliverable(user.userId)).toBe(true);
    await setLevel(user, NotificationLevel.All);
    await markTelegramBlocked(tmp.db, BigInt(user.telegramUserId));
    expect(await isDeliverable(user.userId)).toBe(false);
  });
});

describe('setNotificationLevel', () => {
  const levelOf = async (userId: string): Promise<NotificationLevel | undefined> => {
    const [row] = await tmp.db
      .select({ level: users.notificationLevel })
      .from(users)
      .where(eq(users.id, userId));
    return row?.level;
  };

  it('starts every user at all and stores each level', async () => {
    const user = await seedUser(tmp.db);
    expect(await levelOf(user.userId)).toBe(NotificationLevel.All);
    for (const level of Object.values(NotificationLevel)) {
      expect(await setLevel(user, level)).toEqual({ userId: user.userId, level, canceledJobs: 0 });
      expect(await levelOf(user.userId)).toBe(level);
    }
  });

  it('off cancels only this user’s pending jobs', async () => {
    const user = await seedUser(tmp.db);
    const other = await seedUser(tmp.db);
    const pendingA = await seedJob(user.userId, NotificationJobStatus.Pending);
    const pendingB = await seedJob(user.userId, NotificationJobStatus.Pending);
    const sent = await seedJob(user.userId, NotificationJobStatus.Sent);
    const othersPending = await seedJob(other.userId, NotificationJobStatus.Pending);

    expect((await setLevel(user, NotificationLevel.Off))?.canceledJobs).toBe(2);
    expect(await jobStatus(pendingA)).toBe(NotificationJobStatus.Canceled);
    expect(await jobStatus(pendingB)).toBe(NotificationJobStatus.Canceled);
    expect(await jobStatus(sent)).toBe(NotificationJobStatus.Sent);
    expect(await jobStatus(othersPending)).toBe(NotificationJobStatus.Pending);
  });

  it.each([NotificationLevel.Reduced, NotificationLevel.All])(
    '%s cancels nothing',
    async (level) => {
      const user = await seedUser(tmp.db);
      const pending = await seedJob(user.userId, NotificationJobStatus.Pending);
      expect((await setLevel(user, level))?.canceledJobs).toBe(0);
      expect(await jobStatus(pending)).toBe(NotificationJobStatus.Pending);
    },
  );

  it('answers undefined for an unknown Telegram id and inserts nothing', async () => {
    const before = await userCount();
    expect(await setNotificationLevel(tmp.db, 987_654_323n, NotificationLevel.Off)).toBeUndefined();
    expect(await userCount()).toBe(before);
  });

  it('writes neither status nor telegram_blocked_at', async () => {
    const user = await seedUser(tmp.db, { status: UserStatus.Blocked });
    await markTelegramBlocked(tmp.db, BigInt(user.telegramUserId));
    const markedAt = await blockedAt(user.userId);
    for (const level of Object.values(NotificationLevel)) {
      await setLevel(user, level);
      const [row] = await tmp.db
        .select({ status: users.status })
        .from(users)
        .where(eq(users.id, user.userId));
      expect(row?.status).toBe(UserStatus.Blocked);
      expect((await blockedAt(user.userId))?.getTime()).toBe(markedAt?.getTime());
    }
  });
});

describe('acceptsMailing', () => {
  // sent_at on the database clock, `hours` before now()
  const seedJobAt = async (
    userId: string,
    status: NotificationJobStatus,
    hours: number,
  ): Promise<void> => {
    await tmp.db.insert(notificationJobs).values({
      userId,
      kind: 'test',
      status,
      sentAt: sql`now() - make_interval(hours => ${hours})`,
    });
  };

  const userAt = async (level: NotificationLevel) => {
    const user = await seedUser(tmp.db);
    await setLevel(user, level);
    return user;
  };

  it('at all: accepts right after a mailing', async () => {
    const user = await userAt(NotificationLevel.All);
    await seedJobAt(user.userId, NotificationJobStatus.Sent, 1);
    expect(await isMailable(user.userId)).toBe(true);
  });

  it('at reduced: refuses within the window, accepts after it and with no mailing', async () => {
    expect(REDUCED_LEVEL_WINDOW_HOURS).toBe(24);
    const recent = await userAt(NotificationLevel.Reduced);
    await seedJobAt(recent.userId, NotificationJobStatus.Sent, 1);
    expect(await isMailable(recent.userId)).toBe(false);

    const old = await userAt(NotificationLevel.Reduced);
    await seedJobAt(old.userId, NotificationJobStatus.Sent, REDUCED_LEVEL_WINDOW_HOURS + 1);
    expect(await isMailable(old.userId)).toBe(true);

    expect(await isMailable((await userAt(NotificationLevel.Reduced)).userId)).toBe(true);
  });

  it.each([NotificationJobStatus.Pending, NotificationJobStatus.Canceled])(
    'at reduced: a %s job inside the window does not count',
    async (status) => {
      const user = await userAt(NotificationLevel.Reduced);
      await seedJobAt(user.userId, status, 1);
      expect(await isMailable(user.userId)).toBe(true);
    },
  );

  it('at reduced: another user’s mailing does not count', async () => {
    const user = await userAt(NotificationLevel.Reduced);
    const other = await seedUser(tmp.db);
    await seedJobAt(other.userId, NotificationJobStatus.Sent, 1);
    expect(await isMailable(user.userId)).toBe(true);
  });

  it('at off: refuses with no mailing; on the mark: refuses at all', async () => {
    expect(await isMailable((await userAt(NotificationLevel.Off)).userId)).toBe(false);
    const marked = await userAt(NotificationLevel.All);
    await markTelegramBlocked(tmp.db, BigInt(marked.telegramUserId));
    expect(await isMailable(marked.userId)).toBe(false);
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
