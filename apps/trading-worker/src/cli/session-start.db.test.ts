import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TradeMode, type BrokerUser, type DecimalString } from '@binarius/shared';
import { openTrading, tradingSessions, upsertBalanceSnapshot } from '@binarius/db';
import {
  closeTradingSwitch,
  createTempDatabase,
  seedBrokerAccount,
  seedUser,
  type TempDatabase,
} from '@binarius/db/testing';
import { SESSION_START_REFUSALS } from '../trading-session/start';
import { runSessionStartCli } from './session-start';

const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for apps/trading-worker integration tests (see README → Test database)',
  );
}

let tmp: TempDatabase;
beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
});
afterAll(() => tmp.drop());
afterEach(() => openTrading(tmp.db));

const snapshotUser = (minTradeAmount: string): BrokerUser => ({
  id: 'broker-1',
  level: { code: 'standard', rank: 1 },
  minTradeAmount: minTradeAmount as DecimalString,
  real: {
    available: '0.00' as DecimalString,
    held: '0.00' as DecimalString,
    total: '0.00' as DecimalString,
  },
  demo: {
    available: '100.00' as DecimalString,
    held: '0.00' as DecimalString,
    total: '100.00' as DecimalString,
  },
});

async function account(userId: string, { minTradeAmount = '1.00', snapshot = true } = {}) {
  const brokerAccountId = await seedBrokerAccount(tmp.db, userId);
  if (snapshot) {
    await upsertBalanceSnapshot(tmp.db, {
      brokerAccountId,
      user: snapshotUser(minTradeAmount),
      requested: false,
    });
  }
  return brokerAccountId;
}

async function run(env: Record<string, string>) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runSessionStartCli(
    { DATABASE_URL: tmp.url, ASSET_ID: '101', ...env },
    (line) => out.push(line),
    (line) => err.push(line),
  );
  return { code, out, err };
}

const sessionsOf = (brokerAccountId: string) =>
  tmp.db.select().from(tradingSessions).where(eq(tradingSessions.brokerAccountId, brokerAccountId));

describe('session-start (#287)', () => {
  it('starts a demo session on the only active account and prints its id', async () => {
    const user = await seedUser(tmp.db);
    const brokerAccountId = await account(user.userId);
    const result = await run({ TELEGRAM_USER_ID: user.telegramUserId, TRADES: '3' });
    expect(result.err).toEqual([]);
    expect(result.code).toBe(0);
    const [session] = await sessionsOf(brokerAccountId);
    expect(result.out).toEqual([session!.id]);
    expect(session).toMatchObject({
      mode: TradeMode.Demo,
      settings: {
        version: 1,
        assetId: 101,
        durationSec: 15,
        trades: 3,
        stake: { baseStake: '1', stakeScale: 0 },
      },
    });
  });

  it('refuses two active accounts and lists their ids, writing nothing', async () => {
    const user = await seedUser(tmp.db);
    const first = await account(user.userId);
    const second = await account(user.userId);
    const result = await run({ TELEGRAM_USER_ID: user.telegramUserId });
    expect(result.code).toBe(1);
    expect(result.out).toEqual([]);
    expect(result.err.slice(1).sort()).toEqual([`${first} active`, `${second} active`].sort());
    expect([...(await sessionsOf(first)), ...(await sessionsOf(second))]).toEqual([]);

    const chosen = await run({ TELEGRAM_USER_ID: user.telegramUserId, ACCOUNT_ID: second });
    expect(chosen.code).toBe(0);
    expect(await sessionsOf(second)).toHaveLength(1);
  });

  it('accepts the own ACCOUNT_ID in upper case and stores the canonical id (review round 2 M1)', async () => {
    const user = await seedUser(tmp.db);
    await account(user.userId);
    const brokerAccountId = await account(user.userId);
    const result = await run({
      TELEGRAM_USER_ID: user.telegramUserId,
      ACCOUNT_ID: brokerAccountId.toUpperCase(),
    });
    expect(result.err).toEqual([]);
    expect(result.code).toBe(0);
    const [session] = await sessionsOf(brokerAccountId);
    expect(session?.brokerAccountId).toBe(brokerAccountId);
  });

  it("refuses another user's ACCOUNT_ID as account_not_found", async () => {
    const owner = await seedUser(tmp.db);
    const brokerAccountId = await account(owner.userId);
    const stranger = await seedUser(tmp.db);
    const result = await run({
      TELEGRAM_USER_ID: stranger.telegramUserId,
      ACCOUNT_ID: brokerAccountId,
    });
    expect(result).toMatchObject({
      code: 1,
      out: [],
      err: [SESSION_START_REFUSALS.account_not_found],
    });
    expect(await sessionsOf(brokerAccountId)).toEqual([]);
  });

  it.each([
    ['without a snapshot', { snapshot: false }],
    ['with a zero minimum', { minTradeAmount: '0.00' }],
  ])(
    "gives another user's account %s the same account_not_found, nothing about it (review m1)",
    async (_label, options) => {
      const owner = await seedUser(tmp.db);
      const brokerAccountId = await account(owner.userId, options);
      const stranger = await seedUser(tmp.db);
      await account(stranger.userId);
      const result = await run({
        TELEGRAM_USER_ID: stranger.telegramUserId,
        ACCOUNT_ID: brokerAccountId,
      });
      expect(result).toMatchObject({
        code: 1,
        out: [],
        err: [SESSION_START_REFUSALS.account_not_found],
      });
      expect(await sessionsOf(brokerAccountId)).toEqual([]);
    },
  );

  it('refuses while trading is paused', async () => {
    const user = await seedUser(tmp.db);
    const brokerAccountId = await account(user.userId);
    await closeTradingSwitch(tmp.db);
    const result = await run({ TELEGRAM_USER_ID: user.telegramUserId });
    expect(result).toMatchObject({ code: 1, err: [SESSION_START_REFUSALS.trading_paused] });
    expect(await sessionsOf(brokerAccountId)).toEqual([]);
  });

  it.each<
    [string, { minTradeAmount?: string; snapshot?: boolean }, Record<string, string>, RegExp]
  >([
    ['no snapshot', { snapshot: false }, {}, /Нет снимка баланса/],
    ['a zero minimum', { minTradeAmount: '0.00' }, {}, /Минимальная ставка аккаунта — 0/],
    ['a session past the deadline', {}, { TRADES: '20', DURATION_SEC: '600' }, /не уложится в час/],
  ])('refuses %s before writing anything', async (_label, options, env, text) => {
    const user = await seedUser(tmp.db);
    const brokerAccountId = await account(user.userId, options);
    const result = await run({ TELEGRAM_USER_ID: user.telegramUserId, ...env });
    expect(result.code).toBe(1);
    expect(result.err.join('\n')).toMatch(text);
    expect(await sessionsOf(brokerAccountId)).toEqual([]);
  });

  it('refuses an unknown user and a malformed env', async () => {
    expect((await run({ TELEGRAM_USER_ID: '999999999' })).err).toEqual([
      'Нет пользователя с таким TELEGRAM_USER_ID',
    ]);
    for (const env of <Record<string, string>[]>[
      { TELEGRAM_USER_ID: '-1' },
      { TELEGRAM_USER_ID: '1', ACCOUNT_ID: 'not-a-uuid' },
      { TELEGRAM_USER_ID: '1', TRADES: '21' },
    ]) {
      const result = await run(env);
      expect(result.code).toBe(1);
      expect(result.err).toHaveLength(1);
      expect(result.err[0]).toMatch(/^Env (TELEGRAM_USER_ID|ACCOUNT_ID|TRADES) /);
    }
  });
});
