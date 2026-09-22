import { TransactionRollbackError, eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from './client';
import {
  brokerAccounts,
  brokerTrades,
  outboxEvents,
  tokenLedger,
  tradeIntents,
  users,
} from './schema/index';
import type { DecimalString } from '@binarius/shared';

// Integration tests: a migrated Postgres named by DATABASE_URL (README → Database).
// Each case runs in one transaction that is rolled back at the end; Postgres aborts a
// transaction after its first error, so every case expects exactly one error code.
const url = process.env.DATABASE_URL;
if (url === undefined || url === '') {
  throw new Error('DATABASE_URL is required for packages/db integration tests (see README)');
}

const pool = new Pool({ connectionString: url });
const db = createDb(pool);
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

beforeAll(async () => {
  await pool.query('select 1 from trade_intents limit 0');
});
afterAll(() => pool.end());

async function rolledBack(run: (tx: Tx) => Promise<void>): Promise<void> {
  await db
    .transaction(async (tx) => {
      await run(tx);
      tx.rollback();
    })
    .catch((error: unknown) => {
      if (!(error instanceof TransactionRollbackError)) throw error;
    });
}

// drizzle wraps driver errors in DrizzleQueryError; the Postgres error with its SQLSTATE is the cause
const pgError = (code: string) =>
  expect.objectContaining({ cause: expect.objectContaining({ code }) });

async function seedAccount(tx: Tx, telegramUserId: bigint) {
  const [user] = await tx.insert(users).values({ telegramUserId }).returning({ id: users.id });
  const [account] = await tx
    .insert(brokerAccounts)
    .values({
      userId: user!.id,
      brokerUserId: `broker-${telegramUserId}`,
      accessTokenEnc: Buffer.from('enc'),
      refreshTokenEnc: Buffer.from('enc'),
      tokenKeyId: 'k1',
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
    })
    .returning({ id: brokerAccounts.id });
  return { userId: user!.id, accountId: account!.id };
}

const intent = (accountId: string, userId: string, clientRequestId: string) => ({
  brokerAccountId: accountId,
  userId,
  mode: 'demo' as const,
  assetId: 91,
  amount: '10.00' as DecimalString,
  action: 'up' as const,
  durationSec: 60,
  clientRequestId,
});

describe('trade_intents', () => {
  it('stores an intent and reads money back as a decimal string', async () => {
    await rolledBack(async (tx) => {
      const { accountId, userId } = await seedAccount(tx, 1001n);
      const [row] = await tx
        .insert(tradeIntents)
        .values(intent(accountId, userId, 'r1'))
        .returning();
      expect(row).toMatchObject({ status: 'planned', version: 1, tokensReserved: 0n });
      expect(row!.amount).toBe('10.00000000');
    });
  });

  it('rejects a second intent with the same client_request_id for the account', async () => {
    await rolledBack(async (tx) => {
      const { accountId, userId } = await seedAccount(tx, 1002n);
      await tx
        .insert(tradeIntents)
        .values({ ...intent(accountId, userId, 'r1'), status: 'settled' });
      await expect(tx.insert(tradeIntents).values(intent(accountId, userId, 'r1'))).rejects.toEqual(
        pgError('23505'),
      );
    });
  });

  it('allows only one non-terminal intent per account', async () => {
    await rolledBack(async (tx) => {
      const { accountId, userId } = await seedAccount(tx, 1003n);
      await tx
        .insert(tradeIntents)
        .values({ ...intent(accountId, userId, 'r1'), status: 'unknown' });
      await expect(tx.insert(tradeIntents).values(intent(accountId, userId, 'r2'))).rejects.toEqual(
        pgError('23505'),
      );
    });
  });

  it('allows a new intent once the previous one is terminal', async () => {
    await rolledBack(async (tx) => {
      const { accountId, userId } = await seedAccount(tx, 1004n);
      await tx
        .insert(tradeIntents)
        .values({ ...intent(accountId, userId, 'r1'), status: 'rejected' });
      await tx
        .insert(tradeIntents)
        .values({ ...intent(accountId, userId, 'r2'), status: 'settled' });
      const [row] = await tx
        .insert(tradeIntents)
        .values(intent(accountId, userId, 'r3'))
        .returning();
      expect(row!.status).toBe('planned');
    });
  });

  it('rejects an intent whose user does not own the broker account', async () => {
    await rolledBack(async (tx) => {
      const { accountId } = await seedAccount(tx, 1005n);
      const { userId: otherUser } = await seedAccount(tx, 1006n);
      await expect(
        tx.insert(tradeIntents).values(intent(accountId, otherUser, 'r1')),
      ).rejects.toEqual(pgError('23503'));
    });
  });

  it.each([
    ['an unknown status', { status: 'bogus' as never }],
    ['a zero amount', { amount: '0' as DecimalString }],
    ['a non-positive asset id', { assetId: 0 }],
    ['a non-positive duration', { durationSec: 0 }],
  ])('rejects %s', async (_label, patch) => {
    await rolledBack(async (tx) => {
      const { accountId, userId } = await seedAccount(tx, 1007n);
      await expect(
        tx.insert(tradeIntents).values({ ...intent(accountId, userId, 'r1'), ...patch }),
      ).rejects.toEqual(pgError('23514'));
    });
  });
});

describe('users and token_ledger', () => {
  it('rejects a negative balance and a reserve above the balance', async () => {
    await rolledBack(async (tx) => {
      await expect(
        tx.insert(users).values({ telegramUserId: 2001n, tokenBalance: -1n }),
      ).rejects.toEqual(pgError('23514'));
    });
    await rolledBack(async (tx) => {
      await expect(
        tx.insert(users).values({ telegramUserId: 2002n, tokenBalance: 5n, tokenReserved: 6n }),
      ).rejects.toEqual(pgError('23514'));
    });
  });

  it('allows one reservation and one terminal ledger row per intent', async () => {
    await rolledBack(async (tx) => {
      const { accountId, userId } = await seedAccount(tx, 2003n);
      const [row] = await tx
        .insert(tradeIntents)
        .values(intent(accountId, userId, 'r1'))
        .returning();
      const ref = { refType: 'trade_intent' as const, refId: row!.id };
      await tx.insert(tokenLedger).values({ userId, kind: 'reserve', reservedDelta: 1n, ...ref });
      await expect(
        tx.insert(tokenLedger).values({ userId, kind: 'reserve', reservedDelta: 1n, ...ref }),
      ).rejects.toEqual(pgError('23505'));
    });
    await rolledBack(async (tx) => {
      const { accountId, userId } = await seedAccount(tx, 2004n);
      const [row] = await tx
        .insert(tradeIntents)
        .values(intent(accountId, userId, 'r1'))
        .returning();
      const ref = { refType: 'trade_intent' as const, refId: row!.id };
      await tx
        .insert(tokenLedger)
        .values({ userId, kind: 'settle', reservedDelta: -1n, balanceDelta: -1n, ...ref });
      await expect(
        tx.insert(tokenLedger).values({ userId, kind: 'release', reservedDelta: -1n, ...ref }),
      ).rejects.toEqual(pgError('23505'));
    });
  });

  it('rejects a reservation without an intent reference', async () => {
    await rolledBack(async (tx) => {
      const { userId } = await seedAccount(tx, 2005n);
      await expect(
        tx.insert(tokenLedger).values({ userId, kind: 'reserve', reservedDelta: 1n }),
      ).rejects.toEqual(pgError('23514'));
    });
  });

  it('is append-only', async () => {
    await rolledBack(async (tx) => {
      const { userId } = await seedAccount(tx, 2006n);
      const [row] = await tx
        .insert(tokenLedger)
        .values({ userId, kind: 'purchase', balanceDelta: 10n })
        .returning({ id: tokenLedger.id });
      await expect(
        tx.update(tokenLedger).set({ balanceDelta: 20n }).where(eq(tokenLedger.id, row!.id)),
      ).rejects.toEqual(pgError('P0001'));
    });
    await rolledBack(async (tx) => {
      const { userId } = await seedAccount(tx, 2007n);
      const [row] = await tx
        .insert(tokenLedger)
        .values({ userId, kind: 'purchase', balanceDelta: 10n })
        .returning({ id: tokenLedger.id });
      await expect(tx.delete(tokenLedger).where(eq(tokenLedger.id, row!.id))).rejects.toEqual(
        pgError('P0001'),
      );
    });
  });
});

describe('outbox_events and broker_trades', () => {
  it('keeps the outbox payload consistent with the intent column', async () => {
    await rolledBack(async (tx) => {
      const { accountId, userId } = await seedAccount(tx, 3001n);
      const [row] = await tx
        .insert(tradeIntents)
        .values(intent(accountId, userId, 'r1'))
        .returning();
      await tx.insert(outboxEvents).values({ intentId: row!.id, payload: { intent_id: row!.id } });
      await expect(
        tx.insert(outboxEvents).values({ intentId: row!.id, payload: { intent_id: row!.id } }),
      ).rejects.toEqual(pgError('23505'));
    });
    await rolledBack(async (tx) => {
      const { accountId, userId } = await seedAccount(tx, 3002n);
      const [row] = await tx
        .insert(tradeIntents)
        .values(intent(accountId, userId, 'r1'))
        .returning();
      await expect(
        tx.insert(outboxEvents).values({ intentId: row!.id, payload: { intent_id: accountId } }),
      ).rejects.toEqual(pgError('23514'));
    });
  });

  it('links a trade to an intent once, and only within the same account', async () => {
    const trade = (accountId: string, intentId: string | null, brokerTradeId: string) => ({
      brokerAccountId: accountId,
      intentId,
      brokerTradeId,
      mode: 'demo' as const,
      assetId: 91,
      action: 'up' as const,
      amount: '10.00' as DecimalString,
      payout: 85,
      openPrice: 1.08765,
      openTimestampMs: 1790028496624,
      status: 'open' as const,
      raw: {},
    });
    await rolledBack(async (tx) => {
      const { accountId, userId } = await seedAccount(tx, 3003n);
      const [row] = await tx
        .insert(tradeIntents)
        .values(intent(accountId, userId, 'r1'))
        .returning();
      await tx.insert(brokerTrades).values(trade(accountId, row!.id, 't1'));
      await expect(tx.insert(brokerTrades).values(trade(accountId, row!.id, 't2'))).rejects.toEqual(
        pgError('23505'),
      );
    });
    await rolledBack(async (tx) => {
      const { accountId, userId } = await seedAccount(tx, 3004n);
      const { accountId: otherAccount } = await seedAccount(tx, 3005n);
      const [row] = await tx
        .insert(tradeIntents)
        .values(intent(accountId, userId, 'r1'))
        .returning();
      await expect(
        tx.insert(brokerTrades).values(trade(otherAccount, row!.id, 't1')),
      ).rejects.toEqual(pgError('23503'));
    });
  });

  it('keeps settlement columns NULL until the trade is closed', async () => {
    await rolledBack(async (tx) => {
      const { accountId } = await seedAccount(tx, 3006n);
      const [row] = await tx
        .insert(brokerTrades)
        .values({
          brokerAccountId: accountId,
          brokerTradeId: 't1',
          mode: 'real',
          assetId: 91,
          action: 'down',
          amount: '10.00' as DecimalString,
          payout: 85,
          openPrice: 1.08765,
          openTimestampMs: 1790028496624,
          status: 'open',
          raw: {},
        })
        .returning();
      expect(row).toMatchObject({ closePrice: null, closeTimestampMs: null, profit: null });
      await expect(
        tx.update(brokerTrades).set({ status: 'closed' }).where(eq(brokerTrades.id, row!.id)),
      ).rejects.toEqual(pgError('23514'));
    });
  });
});
