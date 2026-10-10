import Fastify, { type FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AuditAction,
  safeParseSetTradingModeResponse,
  safeParseTradingModeRefusal,
  TradeMode,
  TRADING_MODE_PATH,
} from '@binarius/shared';
import {
  createTempDatabase,
  seedBalanceSnapshot,
  seedBrokerAccount,
  seedUser,
  seedUserWithAccount,
  type TempDatabase,
} from '@binarius/db/testing';
import { auditLog, setTradingMode, users } from '@binarius/db';
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

// the tradingRoutes plugin on a bare Fastify, as demo-stake.db.test.ts does; a second one on a
// DEMO_ONLY process (#396). The balance reconciler is never called: the route reads the stored
// snapshot only.
const appOf = async (demoOnly: boolean) => {
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
};

beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
  app = await appOf(false);
  demoOnlyApp = await appOf(true);
});
afterAll(async () => {
  await app.close();
  await demoOnlyApp.close();
  await tmp.drop();
});

const switchTo = (payload: unknown, target = app, authorization = `Bearer ${TOKEN}`) =>
  target.inject({
    method: 'POST',
    url: TRADING_MODE_PATH,
    headers: { authorization, 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });

const modeOf = async (telegramUserId: string) =>
  (
    await tmp.db
      .select({ tradingMode: users.tradingMode })
      .from(users)
      .where(eq(users.telegramUserId, BigInt(telegramUserId)))
  )[0]?.tradingMode;

async function ready(snapshot: { minTradeAmount?: string; realAvailable?: string } = {}) {
  const seed = await seedUserWithAccount(tmp.db);
  await seedBalanceSnapshot(tmp.db, seed.brokerAccountId, snapshot);
  return seed;
}

async function refused(
  telegramUserId: string,
  status: number,
  error: string,
  target: FastifyInstance = app,
) {
  const response = await switchTo({ telegramUserId, mode: TradeMode.Real }, target);
  expect(response.statusCode).toBe(status);
  expect(response.json()).toEqual({ error });
  expect(safeParseTradingModeRefusal(response.json()).success).toBe(true);
}

describe('POST /trading/mode (#121)', () => {
  it('answers 401 without the internal token and writes nothing', async () => {
    const seed = await ready();
    const response = await switchTo(
      { telegramUserId: seed.telegramUserId, mode: TradeMode.Real },
      app,
      'Bearer x',
    );
    expect(response.statusCode).toBe(401);
    expect(await modeOf(seed.telegramUserId)).toBe(TradeMode.Demo);
  });

  it('T1 switches back to demo without any account or snapshot', async () => {
    const user = await seedUser(tmp.db, { tradingMode: TradeMode.Real });
    const response = await switchTo({ telegramUserId: user.telegramUserId, mode: TradeMode.Demo });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ tradingMode: TradeMode.Demo, changed: true });
    expect(safeParseSetTradingModeResponse(response.json()).success).toBe(true);
    expect(await modeOf(user.telegramUserId)).toBe(TradeMode.Demo);

    const again = await switchTo({ telegramUserId: user.telegramUserId, mode: TradeMode.Demo });
    expect(again.json()).toEqual({ tradingMode: TradeMode.Demo, changed: false });
  });

  it('T2 switches to real with real.available equal to the minimum, writing one audit row', async () => {
    const seed = await ready({ minTradeAmount: '5', realAvailable: '5.00000000' });
    const response = await switchTo({ telegramUserId: seed.telegramUserId, mode: TradeMode.Real });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ tradingMode: TradeMode.Real, changed: true });
    expect(await modeOf(seed.telegramUserId)).toBe(TradeMode.Real);
    const rows = await tmp.db
      .select({ payload: auditLog.payload })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityId, seed.userId),
          eq(auditLog.action, AuditAction.TradingModeChanged),
        ),
      );
    expect(rows).toEqual([{ payload: { from: 'demo', to: 'real' } }]);
  });

  it('T3 refuses real below the minimum and keeps demo', async () => {
    const seed = await ready({ minTradeAmount: '5', realAvailable: '4.99999999' });
    await refused(seed.telegramUserId, 409, 'real_balance_below_minimum');
    expect(await modeOf(seed.telegramUserId)).toBe(TradeMode.Demo);
  });

  it('T4 refuses real without a balance snapshot', async () => {
    const seed = await seedUserWithAccount(tmp.db);
    await refused(seed.telegramUserId, 409, 'balance_unavailable');
    expect(await modeOf(seed.telegramUserId)).toBe(TradeMode.Demo);
  });

  it('T5 refuses real with no account, two active accounts or only a pending one', async () => {
    const none = await seedUser(tmp.db);
    await refused(none.telegramUserId, 409, 'balance_unavailable');
    const two = await ready();
    const second = await seedBrokerAccount(tmp.db, two.userId);
    await seedBalanceSnapshot(tmp.db, second);
    await refused(two.telegramUserId, 409, 'balance_unavailable');
    const pending = await seedUser(tmp.db);
    await seedBrokerAccount(tmp.db, pending.userId, { status: 'pending' });
    await refused(pending.telegramUserId, 409, 'balance_unavailable');
    for (const user of [none, two, pending]) {
      expect(await modeOf(user.telegramUserId)).toBe(TradeMode.Demo);
    }
  });

  it('T6 answers 404 for an unknown user in either direction', async () => {
    await refused('999999999', 404, 'user_not_found');
    const response = await switchTo({ telegramUserId: '999999998', mode: TradeMode.Demo });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'user_not_found' });
  });

  it('T7 answers 400 to a body with an unknown key or an unknown mode', async () => {
    const seed = await ready();
    for (const payload of [
      { telegramUserId: seed.telegramUserId, mode: TradeMode.Real, amount: '1' },
      { telegramUserId: seed.telegramUserId, mode: 'paper' },
    ]) {
      const response = await switchTo(payload);
      expect(response.statusCode).toBe(400);
    }
    expect(await modeOf(seed.telegramUserId)).toBe(TradeMode.Demo);
  });

  it('T8 a DEMO_ONLY process refuses real before any read and still allows demo', async () => {
    const seed = await ready({ minTradeAmount: '1', realAvailable: '100' });
    await refused(seed.telegramUserId, 409, 'demo_only', demoOnlyApp);
    expect(await modeOf(seed.telegramUserId)).toBe(TradeMode.Demo);
    // before any read: an unknown user gets the same refusal, not 404
    await refused('999999997', 409, 'demo_only', demoOnlyApp);

    await setTradingMode(tmp.db, BigInt(seed.telegramUserId), TradeMode.Real);
    const back = await switchTo(
      { telegramUserId: seed.telegramUserId, mode: TradeMode.Demo },
      demoOnlyApp,
    );
    expect(back.statusCode).toBe(200);
    expect(back.json()).toEqual({ tradingMode: TradeMode.Demo, changed: true });
  });

  it('allows real for a blocked user: their trades refuse at creation', async () => {
    const seed = await ready();
    await tmp.db.update(users).set({ status: 'blocked' }).where(eq(users.id, seed.userId));
    const response = await switchTo({ telegramUserId: seed.telegramUserId, mode: TradeMode.Real });
    expect(response.statusCode).toBe(200);
  });
});
