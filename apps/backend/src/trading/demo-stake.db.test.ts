import Fastify, { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEMO_STAKE_PATH,
  safeParseDemoStakeRefusal,
  safeParseSetDemoStakeResponse,
  type DecimalString,
} from '@binarius/shared';
import {
  createTempDatabase,
  seedBalanceSnapshot,
  seedBrokerAccount,
  seedUser,
  seedUserWithAccount,
  type TempDatabase,
} from '@binarius/db/testing';
import { readDemoStake, setDemoStake, users } from '@binarius/db';
import { tradingRoutes } from './routes';
import { unusedAccessTokenDeps, unusedBalanceDeps } from './testing';

const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for apps/backend integration tests (see README → Test database)',
  );
}

const TOKEN = 'internal-token-for-tests';
let tmp: TempDatabase;
let app: FastifyInstance;

// the tradingRoutes plugin on a bare Fastify, as access.db.test.ts does: the bearer hook and the
// registration both live in the plugin; the balance reconciler is never called
beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
  app = Fastify();
  await app.register(tradingRoutes, {
    db: tmp.db,
    internalApiToken: TOKEN,
    onIntentQueued: () => {},
    balance: unusedBalanceDeps(),
    accessToken: unusedAccessTokenDeps(),
  });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await tmp.drop();
});

const save = (payload: unknown, authorization = `Bearer ${TOKEN}`) =>
  app.inject({
    method: 'POST',
    url: DEMO_STAKE_PATH,
    headers: { authorization, 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });

const stakeOf = (telegramUserId: string) => readDemoStake(tmp.db, BigInt(telegramUserId));

async function ready(snapshot: { minTradeAmount?: string; demoAvailable?: string } = {}) {
  const seed = await seedUserWithAccount(tmp.db);
  await seedBalanceSnapshot(tmp.db, seed.brokerAccountId, snapshot);
  return seed;
}

describe('POST /trading/demo-stake', () => {
  it('answers 401 without the internal token and writes nothing', async () => {
    const seed = await ready();
    const response = await save({ telegramUserId: seed.telegramUserId, amount: '5' }, 'Bearer x');
    expect(response.statusCode).toBe(401);
    expect(await stakeOf(seed.telegramUserId)).toBeNull();
  });

  it('saves a stake inside the bounds canonically, both ends included', async () => {
    const seed = await ready({ minTradeAmount: '1', demoAvailable: '50' });
    for (const [amount, saved] of [
      ['2.50', '2.5'],
      ['1', '1'],
      ['50.00', '50'],
    ] as const) {
      const response = await save({ telegramUserId: seed.telegramUserId, amount });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ demoStake: saved });
      expect(safeParseSetDemoStakeResponse(response.json()).success).toBe(true);
      expect(await stakeOf(seed.telegramUserId)).toBe(saved);
    }
  });

  it.each([
    ['0.99', 'stake_below_minimum'],
    ['50.01', 'insufficient_demo_balance'],
    ['1.234', 'stake_precision'],
  ])('refuses %s with %s and the limits, keeping the saved stake', async (amount, error) => {
    const seed = await ready({ minTradeAmount: '1.00000000', demoAvailable: '50.00000000' });
    await setDemoStake(tmp.db, BigInt(seed.telegramUserId), '3' as DecimalString);
    const response = await save({ telegramUserId: seed.telegramUserId, amount });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error,
      limits: { minTradeAmount: '1', demoAvailable: '50', scale: 2 },
    });
    expect(safeParseDemoStakeRefusal(response.json()).success).toBe(true);
    expect(await stakeOf(seed.telegramUserId)).toBe('3');
  });

  it('resets to the broker minimum with null, even with no account or snapshot', async () => {
    const user = await seedUser(tmp.db);
    await setDemoStake(tmp.db, BigInt(user.telegramUserId), '3' as DecimalString);
    const response = await save({ telegramUserId: user.telegramUserId, amount: null });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ demoStake: null });
    expect(await stakeOf(user.telegramUserId)).toBeNull();
  });

  it.each([
    ['no account', async () => (await seedUser(tmp.db)).telegramUserId],
    [
      'an account without a snapshot',
      async () => (await seedUserWithAccount(tmp.db)).telegramUserId,
    ],
    [
      'two active accounts',
      async () => {
        const seed = await ready();
        await seedBrokerAccount(tmp.db, seed.userId);
        return seed.telegramUserId;
      },
    ],
  ])('answers 409 balance_unavailable with %s and saves nothing', async (_label, seedUserId) => {
    const telegramUserId = await seedUserId();
    const response = await save({ telegramUserId, amount: '5' });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'balance_unavailable' });
    expect(await stakeOf(telegramUserId)).toBeNull();
  });

  it.each([['5'], [null]])(
    'answers 404 user_not_found to %s for an unknown user',
    async (amount) => {
      const response = await save({ telegramUserId: '777000333', amount });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: 'user_not_found' });
      expect(
        await tmp.db.select().from(users).where(eq(users.telegramUserId, 777_000_333n)),
      ).toEqual([]);
    },
  );

  it.each([
    ['a zero', { amount: '0' }],
    ['a number', { amount: 5 }],
    ['nine fraction digits', { amount: '1.123456789' }],
    ['no amount', {}],
    ['an unknown key', { amount: '5', mode: 'real' }],
  ])('answers 400 validation for %s', async (_label, patch) => {
    const seed = await ready();
    const response = await save({ telegramUserId: seed.telegramUserId, ...patch });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'validation' });
    expect(await stakeOf(seed.telegramUserId)).toBeNull();
  });

  it('saves for a blocked user: the stake is a preference, trades refuse at creation', async () => {
    const seed = await ready();
    await tmp.db.update(users).set({ status: 'blocked' }).where(eq(users.id, seed.userId));
    const response = await save({ telegramUserId: seed.telegramUserId, amount: '5' });
    expect(response.statusCode).toBe(200);
    expect(await stakeOf(seed.telegramUserId)).toBe('5');
  });
});
