import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BrokerAccountStatus,
  USER_ACCOUNT_LIST_LIMIT,
  UserStatus,
  userAccountViewSchema,
} from '@binarius/shared';
import { readUserAccounts, toLinkedAccountView, toUserAccountView } from './account-ops';
import { createTempDatabase, seedBrokerAccount, seedUser, type TempDatabase } from './testing';
import { brokerAccounts, users } from './schema/index';

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

const read = (telegramUserId: string) => readUserAccounts(tmp.db, BigInt(telegramUserId));

// seeded rows share one transaction-free clock, so the order is pinned by hand
const seedAt = async (
  userId: string,
  status: BrokerAccountStatus,
  minutesAgo: number,
  email: string | null = null,
): Promise<string> => {
  const id = await seedBrokerAccount(tmp.db, userId, { status });
  await tmp.db
    .update(brokerAccounts)
    .set({ email, createdAt: sql`now() - make_interval(mins => ${minutesAgo})` })
    .where(eq(brokerAccounts.id, id));
  return id;
};

describe('readUserAccounts', () => {
  it('is undefined for a Telegram id with no users row', async () => {
    expect(await readUserAccounts(tmp.db, 999_999_999n)).toBeUndefined();
  });

  it('reports a user with no accounts as an empty list', async () => {
    const user = await seedUser(tmp.db);
    expect(await read(user.telegramUserId)).toEqual({ status: UserStatus.Active, accounts: [] });
  });

  it('reports a blocked user as blocked and writes nothing', async () => {
    const user = await seedUser(tmp.db, { status: UserStatus.Blocked });
    const before = await tmp.db
      .select({ status: users.status, updatedAt: users.updatedAt })
      .from(users)
      .where(eq(users.id, user.userId));
    expect((await read(user.telegramUserId))?.status).toBe(UserStatus.Blocked);
    const after = await tmp.db
      .select({ status: users.status, updatedAt: users.updatedAt })
      .from(users)
      .where(eq(users.id, user.userId));
    expect(after).toEqual(before);
  });

  it('lists every status, newest first, as id, email and status only', async () => {
    const user = await seedUser(tmp.db);
    const revoked = await seedAt(user.userId, BrokerAccountStatus.Revoked, 30, 'old@example.test');
    const active = await seedAt(user.userId, BrokerAccountStatus.Active, 20, 'ada@example.test');
    const pending = await seedAt(user.userId, BrokerAccountStatus.Pending, 10, 'new@example.test');

    const snapshot = await read(user.telegramUserId);
    expect(snapshot?.accounts).toEqual([
      { id: pending, email: 'new@example.test', status: BrokerAccountStatus.Pending },
      { id: active, email: 'ada@example.test', status: BrokerAccountStatus.Active },
      { id: revoked, email: 'old@example.test', status: BrokerAccountStatus.Revoked },
    ]);
    for (const row of snapshot?.accounts ?? []) {
      expect(Object.keys(row).sort()).toEqual(['email', 'id', 'status']);
    }
  });

  it('excludes another user’s accounts', async () => {
    const user = await seedUser(tmp.db);
    const other = await seedUser(tmp.db);
    await seedAt(other.userId, BrokerAccountStatus.Active, 1);
    const own = await seedAt(user.userId, BrokerAccountStatus.Pending, 1);
    expect((await read(user.telegramUserId))?.accounts.map(({ id }) => id)).toEqual([own]);
  });

  it(`keeps the ${USER_ACCOUNT_LIST_LIMIT} newest of more`, async () => {
    const user = await seedUser(tmp.db);
    const ids: string[] = [];
    for (let minutesAgo = USER_ACCOUNT_LIST_LIMIT; minutesAgo >= 0; minutesAgo -= 1) {
      ids.push(await seedAt(user.userId, BrokerAccountStatus.Revoked, minutesAgo));
    }
    // ids[0] is the oldest of the eleven
    expect((await read(user.telegramUserId))?.accounts.map(({ id }) => id)).toEqual(
      ids.slice(1).reverse(),
    );
  });
});

describe('toUserAccountView', () => {
  it('carries the id on a pending row only', async () => {
    const user = await seedUser(tmp.db);
    await seedAt(user.userId, BrokerAccountStatus.Revoked, 30, 'old@example.test');
    await seedAt(user.userId, BrokerAccountStatus.Active, 20, 'ada@example.test');
    const pending = await seedAt(user.userId, BrokerAccountStatus.Pending, 10, 'new@example.test');

    const snapshot = await read(user.telegramUserId);
    if (snapshot === undefined) throw new Error('no snapshot');
    const view = toUserAccountView(snapshot);
    expect(view).toEqual({
      status: UserStatus.Active,
      accounts: [
        { status: BrokerAccountStatus.Pending, id: pending, email: 'new@example.test' },
        { status: BrokerAccountStatus.Active, email: 'ada@example.test' },
        { status: BrokerAccountStatus.Revoked, email: 'old@example.test' },
      ],
    });
    expect(view.accounts.map((account) => Object.keys(account).sort())).toEqual([
      ['email', 'id', 'status'],
      ['email', 'status'],
      ['email', 'status'],
    ]);
    expect(userAccountViewSchema.parse(view)).toEqual(view);
  });

  it.each([
    ['empty', ''],
    ['whitespace only', ' \t '],
  ])('turns a %s address into null on every status', async (_label, email) => {
    const user = await seedUser(tmp.db);
    await seedAt(user.userId, BrokerAccountStatus.Revoked, 3, email);
    await seedAt(user.userId, BrokerAccountStatus.Active, 2, email);
    await seedAt(user.userId, BrokerAccountStatus.Pending, 1, email);

    const snapshot = await read(user.telegramUserId);
    expect(snapshot?.accounts.map((row) => row.email)).toEqual([email, email, email]);
    expect(snapshot?.accounts.map((row) => toLinkedAccountView(row).email)).toEqual([
      null,
      null,
      null,
    ]);
  });

  it('keeps an address as stored', () => {
    expect(
      toLinkedAccountView({
        id: '3f2b0a4c-9d3e-4c1a-8b5e-2a6f7d8c9e01',
        email: ' ada@example.test ',
        status: BrokerAccountStatus.Active,
      }),
    ).toEqual({ status: BrokerAccountStatus.Active, email: ' ada@example.test ' });
  });
});
