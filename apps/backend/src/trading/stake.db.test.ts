import Fastify, { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  safeParseSetStakeResponse,
  safeParseStakeRefusal,
  STAKE_PATH,
  TradeMode,
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
import { readStakes, setStake, users } from '@binarius/db';
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
let demoOnlyApp: FastifyInstance;

// the tradingRoutes plugin on a bare Fastify, as access.db.test.ts does: the bearer hook and the
// registration both live in the plugin; the balance reconciler is never called
async function build(demoOnly: boolean): Promise<FastifyInstance> {
  const instance = Fastify();
  await instance.register(tradingRoutes, {
    db: tmp.db,
    internalApiToken: TOKEN,
    onIntentQueued: () => {},
    balance: unusedBalanceDeps(),
    accessToken: unusedAccessTokenDeps(),
    demoOnly,
  });
  await instance.ready();
  return instance;
}

beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
  app = await build(false);
  demoOnlyApp = await build(true);
});
afterAll(async () => {
  await app.close();
  await demoOnlyApp.close();
  await tmp.drop();
});

const save = (payload: unknown, authorization = `Bearer ${TOKEN}`, on = app) =>
  on.inject({
    method: 'POST',
    url: STAKE_PATH,
    headers: { authorization, 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });

const stakesOf = (telegramUserId: string) => readStakes(tmp.db, BigInt(telegramUserId));
const FIELD = { [TradeMode.Demo]: 'demoStake', [TradeMode.Real]: 'realStake' } as const;
const stakeOf = async (telegramUserId: string, mode: TradeMode) =>
  (await stakesOf(telegramUserId))?.[FIELD[mode]];

async function ready(
  snapshot: { minTradeAmount?: string; demoAvailable?: string; realAvailable?: string } = {},
) {
  const seed = await seedUserWithAccount(tmp.db);
  await seedBalanceSnapshot(tmp.db, seed.brokerAccountId, snapshot);
  return seed;
}

// the bounds of each mode are checked against that mode's balance only: the other balance is set
// far apart so a swapped ternary answers the opposite verdict
const balancesFor = (mode: TradeMode, available: string) =>
  mode === TradeMode.Real
    ? { realAvailable: available, demoAvailable: '10000' }
    : { demoAvailable: available, realAvailable: '0' };

describe.each([TradeMode.Demo, TradeMode.Real])('POST /trading/stake, mode %s', (mode) => {
  it('answers 401 without the internal token and writes nothing', async () => {
    const seed = await ready();
    const response = await save(
      { telegramUserId: seed.telegramUserId, mode, amount: '5' },
      'Bearer x',
    );
    expect(response.statusCode).toBe(401);
    expect(await stakeOf(seed.telegramUserId, mode)).toBeNull();
  });

  it('saves a stake inside the bounds canonically, both ends included', async () => {
    const seed = await ready({ minTradeAmount: '1', ...balancesFor(mode, '50') });
    for (const [amount, saved] of [
      ['2.50', '2.5'],
      ['1', '1'],
      ['50.00', '50'],
    ] as const) {
      const response = await save({ telegramUserId: seed.telegramUserId, mode, amount });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ mode, stake: saved });
      expect(safeParseSetStakeResponse(response.json()).success).toBe(true);
      expect(await stakeOf(seed.telegramUserId, mode)).toBe(saved);
    }
  });

  it.each([
    ['0.99', 'stake_below_minimum'],
    ['50.01', 'insufficient_balance'],
    ['1.234', 'stake_precision'],
  ])('refuses %s with %s and the limits, keeping the saved stake', async (amount, error) => {
    const seed = await ready({ minTradeAmount: '1.00000000', ...balancesFor(mode, '50.00000000') });
    await setStake(tmp.db, BigInt(seed.telegramUserId), mode, '3' as DecimalString);
    const response = await save({ telegramUserId: seed.telegramUserId, mode, amount });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error,
      limits: { minTradeAmount: '1', available: '50', scale: 2 },
    });
    expect(safeParseStakeRefusal(response.json()).success).toBe(true);
    expect(await stakeOf(seed.telegramUserId, mode)).toBe('3');
  });

  it("resets to the broker minimum with null, leaving the other mode's stake", async () => {
    const user = await seedUser(tmp.db);
    const telegramUserId = BigInt(user.telegramUserId);
    await setStake(tmp.db, telegramUserId, TradeMode.Demo, '3' as DecimalString);
    await setStake(tmp.db, telegramUserId, TradeMode.Real, '4' as DecimalString);
    const response = await save({ telegramUserId: user.telegramUserId, mode, amount: null });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ mode, stake: null });
    expect(await stakesOf(user.telegramUserId)).toEqual(
      mode === TradeMode.Real
        ? { demoStake: '3', realStake: null }
        : { demoStake: null, realStake: '4' },
    );
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
    const response = await save({ telegramUserId, mode, amount: '5' });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'balance_unavailable' });
    expect(await stakesOf(telegramUserId)).toEqual({ demoStake: null, realStake: null });
  });

  it.each([['5'], [null]])(
    'answers 404 user_not_found to %s for an unknown user',
    async (amount) => {
      const response = await save({ telegramUserId: '777000333', mode, amount });
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
    ['an unknown key', { amount: '5', extra: 1 }],
  ])('answers 400 validation for %s', async (_label, patch) => {
    const seed = await ready();
    const response = await save({ telegramUserId: seed.telegramUserId, mode, ...patch });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'validation' });
    expect(await stakesOf(seed.telegramUserId)).toEqual({ demoStake: null, realStake: null });
  });

  it('saves for a blocked user: the stake is a preference, trades refuse at creation', async () => {
    const seed = await ready();
    await tmp.db.update(users).set({ status: 'blocked' }).where(eq(users.id, seed.userId));
    const response = await save({ telegramUserId: seed.telegramUserId, mode, amount: '5' });
    expect(response.statusCode).toBe(200);
    expect(await stakeOf(seed.telegramUserId, mode)).toBe('5');
  });

  it('saves on a DEMO_ONLY backend: the stake moves no money (#326)', async () => {
    const seed = await ready({ minTradeAmount: '1', ...balancesFor(mode, '50') });
    const response = await save(
      { telegramUserId: seed.telegramUserId, mode, amount: '5' },
      `Bearer ${TOKEN}`,
      demoOnlyApp,
    );
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ mode, stake: '5' });
    expect(await stakeOf(seed.telegramUserId, mode)).toBe('5');
  });
});

describe('POST /trading/stake: the mode', () => {
  it('answers 400 validation without a mode or with an unknown one', async () => {
    const seed = await ready();
    for (const patch of [{}, { mode: 'both' }]) {
      const response = await save({ telegramUserId: seed.telegramUserId, amount: '5', ...patch });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: 'validation' });
    }
    expect(await stakesOf(seed.telegramUserId)).toEqual({ demoStake: null, realStake: null });
  });

  it("writes only the request mode's column", async () => {
    const seed = await ready({ minTradeAmount: '1', demoAvailable: '50', realAvailable: '50' });
    await save({ telegramUserId: seed.telegramUserId, mode: TradeMode.Real, amount: '7' });
    expect(await stakesOf(seed.telegramUserId)).toEqual({ demoStake: null, realStake: '7' });
    await save({ telegramUserId: seed.telegramUserId, mode: TradeMode.Demo, amount: '2' });
    expect(await stakesOf(seed.telegramUserId)).toEqual({ demoStake: '2', realStake: '7' });
  });
});
