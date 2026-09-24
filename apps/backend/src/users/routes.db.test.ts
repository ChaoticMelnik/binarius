import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrokerAccountStatus, UserStatus } from '@binarius/shared';
import { createTempDatabase, seedBrokerAccount, type TempDatabase } from '@binarius/db/testing';
import { users } from '@binarius/db';
import { buildApp } from '../app';

const baseUrl = process.env.DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error('DATABASE_URL is required for apps/backend integration tests (see README)');
}

const TOKEN = 'internal-token-for-tests';
let tmp: TempDatabase;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
  app = buildApp({
    checkPostgres: () => Promise.resolve(),
    checkRedis: () => Promise.resolve(),
    logLevel: 'silent',
    checkTimeoutMs: 20,
    trading: { db: tmp.db, internalApiToken: TOKEN, onIntentQueued: () => {} },
    auth: {
      db: tmp.db,
      cipher: {} as never,
      broker: {} as never,
      internalApiToken: TOKEN,
      authorizeUrl: 'https://binodex.app/oauth/authorize',
      clientId: 'client-id',
      redirectUri: 'https://bot.example/oauth/callback',
      partnerRef: 'partner-ref',
    },
    users: { db: tmp.db, internalApiToken: TOKEN },
  });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await tmp.drop();
});

let seq = 0;
const nextTelegramUserId = (): string => String(600_000 + ++seq);

// null, not undefined: an explicit undefined would fall back to the default parameter and the
// "no header" case would have tested the happy path
const post = (payload: unknown, authorization: string | null = `Bearer ${TOKEN}`) =>
  app.inject({
    method: 'POST',
    url: '/users/start',
    headers: {
      'content-type': 'application/json',
      ...(authorization === null ? {} : { authorization }),
    },
    payload: JSON.stringify(payload),
  });

const body = (telegramUserId: string, patch: Record<string, unknown> = {}) => ({
  telegramUserId,
  displayName: 'Ada',
  ...patch,
});

describe('POST /users/start authorization', () => {
  it.each([
    ['no header', null],
    ['another bearer', 'Bearer some-other-token'],
    ['a non-bearer scheme', `Basic ${TOKEN}`],
  ])('refuses %s', async (_label, authorization) => {
    const response = await post(body(nextTelegramUserId()), authorization);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'unauthorized' });
  });

  it('writes nothing when the call is refused', async () => {
    const telegramUserId = nextTelegramUserId();
    await post(body(telegramUserId), null);
    const rows = await tmp.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.telegramUserId, BigInt(telegramUserId)));
    expect(rows).toEqual([]);
  });
});

describe('POST /users/start validation', () => {
  it.each([
    ['an empty body', {}],
    ['a non-numeric telegram id', { telegramUserId: 'abc', displayName: 'Ada' }],
    ['an empty display name', { telegramUserId: '600001', displayName: '  ' }],
    [
      'a payload outside the pattern',
      { telegramUserId: '600001', displayName: 'A', startPayload: 'a b' },
    ],
    [
      'a language code outside the pattern',
      { telegramUserId: '600001', displayName: 'A', languageCode: 'en_US' },
    ],
  ])('refuses %s with 400', async (_label, payload) => {
    const response = await post(payload);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'validation' });
  });
});

describe('POST /users/start', () => {
  it('answers with exactly the view for a first-time user', async () => {
    const telegramUserId = nextTelegramUserId();
    const response = await post(body(telegramUserId, { languageCode: 'ru' }));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      user: {
        telegramUserId,
        status: UserStatus.Active,
        acquisitionSource: null,
        acquiredAt: null,
        hasActiveBrokerAccount: false,
      },
    });
  });

  it('records the first payload through the route and keeps it on the next /start', async () => {
    const telegramUserId = nextTelegramUserId();
    const first = await post(body(telegramUserId, { startPayload: 'src_route' }));
    const firstUser = first.json().user as { acquisitionSource: string; acquiredAt: string };
    expect(firstUser.acquisitionSource).toBe('src_route');
    expect(Date.parse(firstUser.acquiredAt)).not.toBeNaN();

    const second = await post(body(telegramUserId, { startPayload: 'src_other' }));
    expect(second.json().user).toMatchObject({
      acquisitionSource: 'src_route',
      acquiredAt: firstUser.acquiredAt,
    });
  });

  it('reports a blocked user without unblocking them', async () => {
    const telegramUserId = nextTelegramUserId();
    await post(body(telegramUserId));
    await tmp.db
      .update(users)
      .set({ status: UserStatus.Blocked })
      .where(eq(users.telegramUserId, BigInt(telegramUserId)));

    const response = await post(body(telegramUserId));
    expect(response.statusCode).toBe(200);
    expect(response.json().user).toMatchObject({ status: UserStatus.Blocked });
    const [row] = await tmp.db
      .select({ status: users.status })
      .from(users)
      .where(eq(users.telegramUserId, BigInt(telegramUserId)));
    expect(row?.status).toBe(UserStatus.Blocked);
  });

  it('reports an active broker account once the user has one', async () => {
    const telegramUserId = nextTelegramUserId();
    const created = await post(body(telegramUserId));
    expect(created.json().user.hasActiveBrokerAccount).toBe(false);

    const [row] = await tmp.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.telegramUserId, BigInt(telegramUserId)));
    await seedBrokerAccount(tmp.db, row!.id, { status: BrokerAccountStatus.Active });

    const after = await post(body(telegramUserId));
    expect(after.json().user.hasActiveBrokerAccount).toBe(true);
  });
});
