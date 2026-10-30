import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrokerAccountStatus, UserStatus, type DecimalString } from '@binarius/shared';
import { resolveBalanceAccount } from './balance-snapshot-ops';
import { createDb } from './client';
import { tradingSwitch, users } from './schema/index';
import { createTempDatabase, seedBrokerAccount, seedUser, type TempDatabase } from './testing';
import { readTokenBalance } from './token-balance-ops';
import { readTradingAccessState } from './trading-access-ops';
import { isTradingOpen, openTrading, readTradingSwitch, stopTrading } from './trading-switch-ops';
import { readStakes } from './user-ops';

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

const read = (telegramUserId: string, brokerAccountId?: string) =>
  readTradingAccessState(tmp.db, {
    telegramUserId: BigInt(telegramUserId),
    ...(brokerAccountId === undefined ? {} : { brokerAccountId }),
  });

// the seeded row is put back as it was, so the order of the cases does not matter
async function withSwitch(state: 'open' | 'closed' | 'missing', body: () => Promise<void>) {
  const [row] = await tmp.db.select().from(tradingSwitch);
  await tmp.db.delete(tradingSwitch);
  if (state === 'open') await openTrading(tmp.db);
  if (state === 'closed') await stopTrading(tmp.db, { source: 'operator', reason: 'TA2' });
  try {
    await body();
  } finally {
    await tmp.db.delete(tradingSwitch);
    if (row !== undefined) await tmp.db.insert(tradingSwitch).values(row);
  }
}

describe('readTradingAccessState', () => {
  it('TA1 answers nothing without a users row, in one statement', async () => {
    const statements: string[] = [];
    const counted = createDb(tmp.pool, {
      logger: { logQuery: (query) => void statements.push(query) },
    });
    expect(await readTradingAccessState(counted, { telegramUserId: 999_999_999n })).toBeUndefined();
    expect(statements).toHaveLength(1);
  });

  it('TA2 reads the tokens, the canonical stakes, the switch and the only active account', async () => {
    const user = await seedUser(tmp.db, { balance: 7n });
    const accountId = await seedBrokerAccount(tmp.db, user.userId, { brokerUserId: 'ta-2' });
    const state = await read(user.telegramUserId);
    expect(state).toMatchObject({
      tokens: { status: 'active', balance: 7n, reserved: 0n, tradingMode: 'demo' },
      stakes: { demoStake: null, realStake: null },
      account: {
        kind: 'account',
        account: { id: accountId, status: 'active', brokerUserId: 'ta-2' },
      },
    });

    await tmp.db
      .update(users)
      .set({ demoStake: '2.50000000' as DecimalString, realStake: '10.00000000' as DecimalString })
      .where(eq(users.id, user.userId));
    expect((await read(user.telegramUserId))!.stakes).toEqual({
      demoStake: '2.5',
      realStake: '10',
    });

    for (const [state, open] of [
      ['open', true],
      ['closed', false],
      ['missing', false],
    ] as const) {
      await withSwitch(state, async () => {
        expect((await read(user.telegramUserId))!.tradingOpen, state).toBe(open);
      });
    }
  });

  it('TA3 finds an explicit account among the user’s own only, whatever its status', async () => {
    const user = await seedUser(tmp.db);
    await seedBrokerAccount(tmp.db, user.userId);
    const pending = await seedBrokerAccount(tmp.db, user.userId, {
      status: BrokerAccountStatus.Pending,
    });
    const other = await seedUser(tmp.db);
    const foreign = await seedBrokerAccount(tmp.db, other.userId);
    expect((await read(user.telegramUserId, foreign))!.account).toEqual({ kind: 'not_found' });
    expect((await read(user.telegramUserId, pending))!.account).toMatchObject({
      kind: 'account',
      account: { id: pending, status: 'pending' },
    });
    expect((await read(user.telegramUserId, foreign))!.tokens.status).toBe('active');
  });

  it('TA4 refuses to guess between two active accounts and still answers the tokens', async () => {
    const user = await seedUser(tmp.db, { balance: 3n });
    await seedBrokerAccount(tmp.db, user.userId);
    await seedBrokerAccount(tmp.db, user.userId);
    const state = await read(user.telegramUserId);
    expect(state!.account).toEqual({ kind: 'ambiguous' });
    expect(state!.tokens.balance).toBe(3n);
  });

  it('TA5 says there is no account when none is active', async () => {
    const user = await seedUser(tmp.db);
    expect((await read(user.telegramUserId))!.account).toEqual({ kind: 'no_account' });
    await seedBrokerAccount(tmp.db, user.userId, { status: BrokerAccountStatus.Revoked });
    expect((await read(user.telegramUserId))!.account).toEqual({ kind: 'no_account' });
  });

  it('TA6 equals the four single reads on the same rows', async () => {
    const blocked = await seedUser(tmp.db, { balance: 9n, status: UserStatus.Blocked });
    await seedBrokerAccount(tmp.db, blocked.userId);
    await tmp.db
      .update(users)
      .set({ realStake: '4.10000000' as DecimalString })
      .where(eq(users.id, blocked.userId));
    const twoAccounts = await seedUser(tmp.db);
    await seedBrokerAccount(tmp.db, twoAccounts.userId);
    await seedBrokerAccount(tmp.db, twoAccounts.userId);
    const none = await seedUser(tmp.db);

    for (const { telegramUserId } of [blocked, twoAccounts, none]) {
      const id = BigInt(telegramUserId);
      expect(await read(telegramUserId)).toEqual({
        tokens: await readTokenBalance(tmp.db, id),
        stakes: await readStakes(tmp.db, id),
        tradingOpen: isTradingOpen(await readTradingSwitch(tmp.db)),
        account: await resolveBalanceAccount(tmp.db, { telegramUserId: id }),
      });
    }
  });
});
