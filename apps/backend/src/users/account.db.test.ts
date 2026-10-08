import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrokerAccountStatus, UserErrorCode, UserStatus } from '@binarius/shared';
import {
  createTempDatabase,
  seedBrokerAccount,
  seedUser,
  type TempDatabase,
} from '@binarius/db/testing';
import { brokerAccounts, users } from '@binarius/db';
import { buildApp } from '../app';
import { unusedAdminDeps } from '../admin/testing';
import {
  unusedAccessTokenDeps,
  unusedBalanceDeps,
  unusedPairsDeps,
  unusedSignalDeps,
  unusedSessionDeps,
  unusedSignalsDeps,
} from '../trading/testing';

const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for apps/backend integration tests (see README → Test database)',
  );
}

const TOKEN = 'internal-token-for-tests';
let tmp: TempDatabase;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
  app = buildApp({
    pairs: unusedPairsDeps(),
    sessions: unusedSessionDeps(),
    signal: unusedSignalDeps(),
    signals: unusedSignalsDeps(),
    admin: unusedAdminDeps(),
    checkPostgres: () => Promise.resolve(),
    checkRedis: () => Promise.resolve(),
    logLevel: 'silent',
    checkTimeoutMs: 20,
    trading: {
      db: tmp.db,
      internalApiToken: TOKEN,
      onIntentQueued: () => {},
      balance: unusedBalanceDeps(),
      accessToken: unusedAccessTokenDeps(),
    },
    auth: {
      db: tmp.db,
      cipher: {} as never,
      broker: {} as never,
      internalApiToken: TOKEN,
      authorizeUrl: 'https://binodex.app/oauth/authorize',
      clientId: 'client-id',
      redirectUri: 'https://bot.example/oauth/callback',
      partnerRef: 'partner-ref',
      linkNotifier: {} as never,
      initDataVerifier: {} as never,
    },
    users: { db: tmp.db, internalApiToken: TOKEN },
  });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await tmp.drop();
});

// null, not undefined: an explicit undefined would fall back to the default parameter and the
// "no header" case would have tested the happy path
const post = (payload: unknown, authorization: string | null = `Bearer ${TOKEN}`) =>
  app.inject({
    method: 'POST',
    url: '/users/account',
    headers: {
      'content-type': 'application/json',
      ...(authorization === null ? {} : { authorization }),
    },
    payload: JSON.stringify(payload),
  });

const usersRow = async (userId: string) => {
  const [row] = await tmp.db
    .select({ status: users.status, updatedAt: users.updatedAt })
    .from(users)
    .where(eq(users.id, userId));
  return row;
};

describe('POST /users/account authorization', () => {
  it.each([
    ['no header', null],
    ['another bearer', 'Bearer some-other-token'],
    ['a non-bearer scheme', `Basic ${TOKEN}`],
  ])('refuses %s', async (_label, authorization) => {
    const user = await seedUser(tmp.db);
    const response = await post({ telegramUserId: user.telegramUserId }, authorization);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'unauthorized' });
  });
});

describe('POST /users/account validation', () => {
  it.each([
    ['an empty body', {}],
    ['a non-numeric telegram id', { telegramUserId: 'abc' }],
  ])('refuses %s with 400', async (_label, payload) => {
    const response = await post(payload);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'validation' });
  });
});

describe('POST /users/account', () => {
  it('answers 404 user_not_found for a Telegram id with no users row, and creates none', async () => {
    const response = await post({ telegramUserId: '777000111' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: UserErrorCode.UserNotFound });
    const rows = await tmp.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.telegramUserId, 777_000_111n));
    expect(rows).toEqual([]);
  });

  it('answers an empty list for a user with no accounts', async () => {
    const user = await seedUser(tmp.db);
    const response = await post({ telegramUserId: user.telegramUserId });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ user: { status: UserStatus.Active, accounts: [] } });
  });

  it('answers 200 blocked for a blocked user, and the row stays blocked', async () => {
    const user = await seedUser(tmp.db, { status: UserStatus.Blocked });
    await seedBrokerAccount(tmp.db, user.userId, { status: BrokerAccountStatus.Active });
    const response = await post({ telegramUserId: user.telegramUserId });
    expect(response.statusCode).toBe(200);
    expect(response.json().user).toMatchObject({ status: UserStatus.Blocked });
    expect((await usersRow(user.userId))?.status).toBe(UserStatus.Blocked);
  });

  it('answers exactly the view, the id on the pending entry only, and writes nothing', async () => {
    const user = await seedUser(tmp.db);
    const seed = async (status: BrokerAccountStatus, email: string, minutesAgo: number) => {
      const id = await seedBrokerAccount(tmp.db, user.userId, { status });
      await tmp.db
        .update(brokerAccounts)
        .set({ email, createdAt: sql`now() - make_interval(mins => ${minutesAgo})` })
        .where(eq(brokerAccounts.id, id));
      return id;
    };
    await seed(BrokerAccountStatus.Revoked, 'old@example.test', 30);
    await seed(BrokerAccountStatus.Active, 'ada@example.test', 20);
    const pending = await seed(BrokerAccountStatus.Pending, 'new@example.test', 10);
    const before = await usersRow(user.userId);
    const accountsBefore = await tmp.db
      .select({ updatedAt: brokerAccounts.updatedAt })
      .from(brokerAccounts)
      .where(eq(brokerAccounts.userId, user.userId))
      .orderBy(brokerAccounts.id);

    const response = await post({ telegramUserId: user.telegramUserId });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      user: {
        status: UserStatus.Active,
        accounts: [
          { status: BrokerAccountStatus.Pending, id: pending, email: 'new@example.test' },
          { status: BrokerAccountStatus.Active, email: 'ada@example.test' },
          { status: BrokerAccountStatus.Revoked, email: 'old@example.test' },
        ],
      },
    });
    expect(await usersRow(user.userId)).toEqual(before);
    expect(
      await tmp.db
        .select({ updatedAt: brokerAccounts.updatedAt })
        .from(brokerAccounts)
        .where(eq(brokerAccounts.userId, user.userId))
        .orderBy(brokerAccounts.id),
    ).toEqual(accountsBefore);
  });
});
