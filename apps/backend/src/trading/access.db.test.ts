import Fastify, { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UserErrorCode, UserStatus, safeParseTradingAccessResponse } from '@binarius/shared';
import {
  createTempDatabase,
  intentRequest,
  seedUser,
  seedUserWithAccount,
  type TempDatabase,
} from '@binarius/db/testing';
import { tokenLedger, users } from '@binarius/db';
import { tradingRoutes } from './routes';

const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for apps/backend integration tests (see README → Test database)',
  );
}

const TOKEN = 'internal-token-for-tests';
let tmp: TempDatabase;
let app: FastifyInstance;

// The tradingRoutes plugin on a bare Fastify, not buildApp: the bearer hook and the
// registerTradingAccess call both live in the plugin, and a dependency buildApp gains later
// (#138's `pairs`) does not reach this file. No case here asserts a 500 body or an unknown
// route — those are buildApp's handlers (app.test.ts).
beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
  app = Fastify();
  await app.register(tradingRoutes, {
    db: tmp.db,
    internalApiToken: TOKEN,
    onIntentQueued: () => {},
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await tmp.drop();
});

// null, not undefined: an explicit undefined would fall back to the default parameter and the
// "no header" case would have tested the happy path
const post = (url: string, payload: unknown, authorization: string | null = `Bearer ${TOKEN}`) =>
  app.inject({
    method: 'POST',
    url,
    headers: {
      'content-type': 'application/json',
      ...(authorization === null ? {} : { authorization }),
    },
    payload: JSON.stringify(payload),
  });

const access = (payload: unknown, authorization?: string | null) =>
  post('/trading/access', payload, authorization);

describe('POST /trading/access authorization', () => {
  it.each([
    ['no header', null],
    ['another bearer', 'Bearer some-other-token'],
    ['a non-bearer scheme', `Basic ${TOKEN}`],
  ])('refuses %s', async (_label, authorization) => {
    const user = await seedUser(tmp.db);
    const response = await access({ telegramUserId: user.telegramUserId }, authorization);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'unauthorized' });
  });
});

describe('POST /trading/access validation', () => {
  it.each([
    ['an empty body', {}],
    ['a non-numeric telegram id', { telegramUserId: 'abc' }],
    ['an id above int8', { telegramUserId: '9223372036854775808' }],
    ['a non-object body', ['1']],
  ])('refuses %s with 400', async (_label, payload) => {
    const response = await access(payload);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'validation' });
  });
});

describe('POST /trading/access', () => {
  it('answers 404 user_not_found for a Telegram id with no users row', async () => {
    const response = await access({ telegramUserId: '777000222' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: UserErrorCode.UserNotFound });
  });

  it('answers exactly the view, and a reserve made through /trading/intents shows in it', async () => {
    const seed = await seedUserWithAccount(tmp.db, { balance: 5n });
    const first = await access({ telegramUserId: seed.telegramUserId });
    expect(first.statusCode).toBe(200);
    const body = first.json();
    expect(Object.keys(body).sort()).toEqual(['status', 'tokens']);
    expect(Object.keys(body.tokens).sort()).toEqual(['available', 'balance', 'reserved']);
    expect(body).toEqual({
      status: UserStatus.Active,
      tokens: { balance: '5', reserved: '0', available: '5' },
    });
    expect(safeParseTradingAccessResponse(body).success).toBe(true);

    const created = await post('/trading/intents', intentRequest(seed.telegramUserId));
    expect(created.statusCode).toBe(201);
    const second = await access({ telegramUserId: seed.telegramUserId });
    expect(second.json()).toEqual({
      status: UserStatus.Active,
      tokens: { balance: '5', reserved: '1', available: '4' },
    });
  });

  it('answers 200 with the numbers for a blocked user', async () => {
    const user = await seedUser(tmp.db, { balance: 2n, status: UserStatus.Blocked });
    const response = await access({ telegramUserId: user.telegramUserId });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: UserStatus.Blocked,
      tokens: { balance: '2', reserved: '0', available: '2' },
    });
  });

  it('writes nothing', async () => {
    const user = await seedUser(tmp.db, { balance: 3n });
    const before = await usersRow(user.userId);
    const response = await access({ telegramUserId: user.telegramUserId });
    expect(response.statusCode).toBe(200);
    expect(await usersRow(user.userId)).toEqual(before);
    const ledger = await tmp.db
      .select({ id: tokenLedger.id })
      .from(tokenLedger)
      .where(eq(tokenLedger.userId, user.userId));
    expect(ledger).toEqual([]);
  });
});

const usersRow = async (userId: string) => {
  const [row] = await tmp.db
    .select({
      balance: users.tokenBalance,
      reserved: users.tokenReserved,
      updatedAt: users.updatedAt,
    })
    .from(users)
    .where(eq(users.id, userId));
  return row;
};
