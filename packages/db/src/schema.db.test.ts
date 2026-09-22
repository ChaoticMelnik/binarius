import { TransactionRollbackError, eq, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from './client';
import {
  brokerAccounts,
  brokerTrades,
  depositEvents,
  outboxEvents,
  tokenLedger,
  tradeIntents,
  tradingSessions,
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

// drizzle wraps driver errors in DrizzleQueryError; the Postgres error with its SQLSTATE and
// the name of the constraint that fired is the cause. Asserting the name keeps a test from
// passing because some *other* constraint rejected the row.
const pgError = (code: string, constraint: string) =>
  expect.objectContaining({ cause: expect.objectContaining({ code, constraint }) });

// raise_append_only() is a trigger, and PostgreSQL populates no `constraint` field for it,
// so those cases assert the code and the message instead
const triggerError = (table: string) =>
  expect.objectContaining({
    cause: expect.objectContaining({ code: 'P0001', message: `${table} is append-only` }),
  });

let seq = 0;
async function seedAccount(tx: Tx) {
  const n = ++seq;
  const [user] = await tx
    .insert(users)
    .values({ telegramUserId: BigInt(900_000 + n) })
    .returning({ id: users.id });
  const [account] = await tx
    .insert(brokerAccounts)
    .values({
      userId: user!.id,
      brokerUserId: `broker-${n}`,
      accessTokenEnc: Buffer.from('enc'),
      refreshTokenEnc: Buffer.from('enc'),
      tokenKeyId: 'k1',
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
    })
    .returning({ id: brokerAccounts.id });
  return { userId: user!.id, accountId: account!.id };
}

const intent = (
  seed: { accountId: string; userId: string },
  clientRequestId: string,
  patch: Record<string, unknown> = {},
) => ({
  brokerAccountId: seed.accountId,
  userId: seed.userId,
  mode: 'demo' as const,
  assetId: 91,
  amount: '10.00' as DecimalString,
  action: 'up' as const,
  durationSec: 60,
  clientRequestId,
  ...patch,
});

const trade = (seed: { accountId: string }, patch: Record<string, unknown> = {}) => ({
  brokerAccountId: seed.accountId,
  brokerTradeId: `t-${++seq}`,
  mode: 'demo' as const,
  assetId: 91,
  action: 'up' as const,
  amount: '10.00' as DecimalString,
  payout: 85,
  openPrice: 1.08765,
  openTimestampMs: 1790028496624,
  status: 'open' as const,
  raw: {},
  ...patch,
});

describe('trade_intents', () => {
  it('stores an intent and reads money back as a decimal string', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const [row] = await tx.insert(tradeIntents).values(intent(seed, 'r1')).returning();
      expect(row).toMatchObject({ status: 'planned', version: 1, tokensReserved: 0n });
      expect(row!.amount).toBe('10.00000000');
    });
  });

  it('rejects a second intent with the same client_request_id for the account', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      await tx.insert(tradeIntents).values(intent(seed, 'r1', { status: 'settled' }));
      await expect(tx.insert(tradeIntents).values(intent(seed, 'r1'))).rejects.toEqual(
        pgError('23505', 'trade_intents_account_request_idx'),
      );
    });
  });

  it('allows only one non-terminal intent per account', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      await tx.insert(tradeIntents).values(intent(seed, 'r1', { status: 'unknown' }));
      await expect(tx.insert(tradeIntents).values(intent(seed, 'r2'))).rejects.toEqual(
        pgError('23505', 'trade_intents_active_account_idx'),
      );
    });
  });

  it('allows a new intent once the previous one is terminal', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      await tx.insert(tradeIntents).values(intent(seed, 'r1', { status: 'rejected' }));
      await tx.insert(tradeIntents).values(intent(seed, 'r2', { status: 'settled' }));
      const [row] = await tx.insert(tradeIntents).values(intent(seed, 'r3')).returning();
      expect(row!.status).toBe('planned');
    });
  });

  it('rejects an intent whose user does not own the broker account', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const other = await seedAccount(tx);
      await expect(
        tx.insert(tradeIntents).values(intent({ ...seed, userId: other.userId }, 'r1')),
      ).rejects.toEqual(pgError('23503', 'trade_intents_account_owner_fk'));
    });
  });

  it('rejects an intent whose mode disagrees with its trading session', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const [session] = await tx
        .insert(tradingSessions)
        .values({ brokerAccountId: seed.accountId, mode: 'demo' })
        .returning({ id: tradingSessions.id });
      await expect(
        tx
          .insert(tradeIntents)
          .values(intent(seed, 'r1', { tradingSessionId: session!.id, mode: 'real' })),
      ).rejects.toEqual(pgError('23503', 'trade_intents_session_account_fk'));
    });
  });

  it('accepts an intent whose mode matches its trading session', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const [session] = await tx
        .insert(tradingSessions)
        .values({ brokerAccountId: seed.accountId, mode: 'real' })
        .returning({ id: tradingSessions.id });
      const [row] = await tx
        .insert(tradeIntents)
        .values(intent(seed, 'r1', { tradingSessionId: session!.id, mode: 'real' }))
        .returning();
      expect(row!.tradingSessionId).toBe(session!.id);
    });
  });

  it.each([
    ['an unknown status', { status: 'bogus' }, 'trade_intents_status_check'],
    ['a zero amount', { amount: '0' }, 'trade_intents_amount_check'],
    ['a NaN amount', { amount: 'NaN' }, 'trade_intents_amount_check'],
    ['a non-positive asset id', { assetId: 0 }, 'trade_intents_asset_id_check'],
    ['a non-positive duration', { durationSec: 0 }, 'trade_intents_duration_sec_check'],
  ])('rejects %s', async (_label, patch, constraint) => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      await expect(tx.insert(tradeIntents).values(intent(seed, 'r1', patch))).rejects.toEqual(
        pgError('23514', constraint),
      );
    });
  });
});

describe('users and token_ledger', () => {
  it('rejects a negative balance', async () => {
    await rolledBack(async (tx) => {
      await expect(
        tx.insert(users).values({ telegramUserId: 990_001n, tokenBalance: -1n }),
      ).rejects.toEqual(pgError('23514', 'users_token_balance_check'));
    });
  });

  it('rejects a reserve above the balance', async () => {
    await rolledBack(async (tx) => {
      await expect(
        tx.insert(users).values({ telegramUserId: 990_002n, tokenBalance: 5n, tokenReserved: 6n }),
      ).rejects.toEqual(pgError('23514', 'users_token_reserved_check'));
    });
  });

  it('allows one reservation per intent', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const [row] = await tx.insert(tradeIntents).values(intent(seed, 'r1')).returning();
      const ref = { userId: seed.userId, intentId: row!.id };
      await tx.insert(tokenLedger).values({ ...ref, kind: 'reserve', reservedDelta: 1n });
      await expect(
        tx.insert(tokenLedger).values({ ...ref, kind: 'reserve', reservedDelta: 1n }),
      ).rejects.toEqual(pgError('23505', 'token_ledger_reserve_intent_idx'));
    });
  });

  it('allows one terminal row per intent', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const [row] = await tx.insert(tradeIntents).values(intent(seed, 'r1')).returning();
      const ref = { userId: seed.userId, intentId: row!.id };
      await tx.insert(tokenLedger).values({ ...ref, kind: 'reserve', reservedDelta: 1n });
      await tx
        .insert(tokenLedger)
        .values({ ...ref, kind: 'settle', reservedDelta: -1n, balanceDelta: -1n });
      await expect(
        tx.insert(tokenLedger).values({ ...ref, kind: 'release', reservedDelta: -1n }),
      ).rejects.toEqual(pgError('23505', 'token_ledger_terminal_intent_idx'));
    });
  });

  it('rejects a ledger row referencing another user’s intent', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const other = await seedAccount(tx);
      const [row] = await tx.insert(tradeIntents).values(intent(seed, 'r1')).returning();
      await expect(
        tx
          .insert(tokenLedger)
          .values({ userId: other.userId, intentId: row!.id, kind: 'reserve', reservedDelta: 1n }),
      ).rejects.toEqual(pgError('23503', 'token_ledger_intent_owner_fk'));
    });
  });

  it('rejects a reservation without an intent reference', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      await expect(
        tx.insert(tokenLedger).values({ userId: seed.userId, kind: 'reserve', reservedDelta: 1n }),
      ).rejects.toEqual(pgError('23514', 'token_ledger_reference_check'));
    });
  });

  it('rejects a non-intent kind carrying an intent reference', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const [row] = await tx.insert(tradeIntents).values(intent(seed, 'r1')).returning();
      await expect(
        tx.insert(tokenLedger).values({
          userId: seed.userId,
          intentId: row!.id,
          kind: 'purchase',
          balanceDelta: 10n,
        }),
      ).rejects.toEqual(pgError('23514', 'token_ledger_reference_check'));
    });
  });

  it.each([
    ['a reserve that frees tokens', { kind: 'reserve' as const, reservedDelta: -500n }],
    ['a release that holds tokens', { kind: 'release' as const, reservedDelta: 500n }],
    [
      'a reserve that moves the balance',
      { kind: 'reserve' as const, reservedDelta: 1n, balanceDelta: 5n },
    ],
  ])('rejects %s', async (_label, patch) => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const [row] = await tx.insert(tradeIntents).values(intent(seed, 'r1')).returning();
      await expect(
        tx.insert(tokenLedger).values({ userId: seed.userId, intentId: row!.id, ...patch }),
      ).rejects.toEqual(pgError('23514', 'token_ledger_delta_shape_check'));
    });
  });

  it('rejects a negative purchase', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      await expect(
        tx.insert(tokenLedger).values({
          userId: seed.userId,
          kind: 'purchase',
          balanceDelta: -10n,
          refType: 'deposit_event',
          refId: '44444444-4444-4444-4444-444444444444',
        }),
      ).rejects.toEqual(pgError('23514', 'token_ledger_delta_shape_check'));
    });
  });

  it('credits one deposit event only once', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const credit = {
        userId: seed.userId,
        kind: 'purchase' as const,
        balanceDelta: 1000n,
        refType: 'deposit_event' as const,
        refId: '44444444-4444-4444-4444-444444444444',
      };
      await tx.insert(tokenLedger).values(credit);
      await expect(tx.insert(tokenLedger).values(credit)).rejects.toEqual(
        pgError('23505', 'token_ledger_deposit_ref_idx'),
      );
    });
  });

  it.each([
    [
      'UPDATE',
      (tx: Tx, id: string) =>
        tx.update(tokenLedger).set({ note: 'x' }).where(eq(tokenLedger.id, id)),
    ],
    ['DELETE', (tx: Tx, id: string) => tx.delete(tokenLedger).where(eq(tokenLedger.id, id))],
  ])('is append-only against %s', async (_label, mutate) => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const [row] = await tx
        .insert(tokenLedger)
        .values({ userId: seed.userId, kind: 'adjustment', balanceDelta: 10n })
        .returning({ id: tokenLedger.id });
      await expect(mutate(tx, row!.id)).rejects.toEqual(triggerError('token_ledger'));
    });
  });

  it.each(['token_ledger', 'audit_log'])('is append-only against TRUNCATE on %s', async (table) => {
    await rolledBack(async (tx) => {
      await expect(tx.execute(sql.raw(`truncate ${table}`))).rejects.toEqual(triggerError(table));
    });
  });

  it('protects audit_log against UPDATE', async () => {
    await rolledBack(async (tx) => {
      await tx.execute(sql`insert into audit_log (actor_type, action) values ('system', 'probe')`);
      await expect(
        tx.execute(sql`update audit_log set action = 'changed' where action = 'probe'`),
      ).rejects.toEqual(triggerError('audit_log'));
    });
  });
});

describe('outbox_events', () => {
  it('accepts a well-formed payload and rejects a duplicate', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const [row] = await tx.insert(tradeIntents).values(intent(seed, 'r1')).returning();
      await tx.insert(outboxEvents).values({ intentId: row!.id, payload: { intent_id: row!.id } });
      await expect(
        tx.insert(outboxEvents).values({ intentId: row!.id, payload: { intent_id: row!.id } }),
      ).rejects.toEqual(pgError('23505', 'outbox_events_topic_intent_key'));
    });
  });

  // the CHECK must be false, not NULL, for each of these: a NULL CHECK passes
  it.each([
    ['an empty payload', {}],
    ['a null intent_id', { intent_id: null }],
    ['a camelCase key', { intentId: '11111111-1111-1111-1111-111111111111' }],
    ['a numeric intent_id', { intent_id: 123 }],
    ['a non-uuid string', { intent_id: 'not-a-uuid' }],
    ['a different intent_id', { intent_id: '22222222-2222-2222-2222-222222222222' }],
  ])('rejects %s', async (_label, payload) => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const [row] = await tx.insert(tradeIntents).values(intent(seed, 'r1')).returning();
      await expect(
        tx
          .insert(outboxEvents)
          .values({ intentId: row!.id, payload: payload as { intent_id: string } }),
      ).rejects.toEqual(pgError('23514', 'outbox_events_payload_check'));
    });
  });

  it('tolerates extra payload keys', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const [row] = await tx.insert(tradeIntents).values(intent(seed, 'r1')).returning();
      const [event] = await tx
        .insert(outboxEvents)
        .values({
          intentId: row!.id,
          payload: { intent_id: row!.id, attempt: 2 } as { intent_id: string },
        })
        .returning();
      expect(event!.status).toBe('pending');
    });
  });
});

describe('broker_trades', () => {
  it('links a trade to an intent once', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const [row] = await tx.insert(tradeIntents).values(intent(seed, 'r1')).returning();
      await tx.insert(brokerTrades).values(trade(seed, { intentId: row!.id }));
      await expect(
        tx.insert(brokerTrades).values(trade(seed, { intentId: row!.id })),
      ).rejects.toEqual(pgError('23505', 'broker_trades_intent_id_key'));
    });
  });

  it('rejects a trade linked to another account’s intent', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const other = await seedAccount(tx);
      const [row] = await tx.insert(tradeIntents).values(intent(seed, 'r1')).returning();
      await expect(
        tx.insert(brokerTrades).values(trade(other, { intentId: row!.id })),
      ).rejects.toEqual(pgError('23503', 'broker_trades_intent_account_fk'));
    });
  });

  it('rejects a real trade against a demo intent', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const [row] = await tx.insert(tradeIntents).values(intent(seed, 'r1')).returning();
      await expect(
        tx.insert(brokerTrades).values(trade(seed, { intentId: row!.id, mode: 'real' })),
      ).rejects.toEqual(pgError('23503', 'broker_trades_intent_account_fk'));
    });
  });

  it('keeps settlement columns NULL while the trade is open', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const [row] = await tx.insert(brokerTrades).values(trade(seed)).returning();
      expect(row).toMatchObject({ closePrice: null, closeTimestampMs: null, profit: null });
    });
  });

  // the settlement group moves as a unit in both directions
  it.each([
    ['closing without the other two columns', { status: 'closed' as const }],
    ['an open trade carrying a close timestamp', { closeTimestampMs: 1790028556624 }],
    ['an open trade carrying a profit', { profit: '8.50' }],
    [
      'closing without a profit',
      { status: 'closed' as const, closeTimestampMs: 1790028556624, closePrice: 1.09 },
    ],
  ])('rejects %s', async (_label, patch) => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      await expect(tx.insert(brokerTrades).values(trade(seed, patch))).rejects.toEqual(
        pgError('23514', 'broker_trades_settlement_check'),
      );
    });
  });

  it('accepts a fully settled trade', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const [row] = await tx
        .insert(brokerTrades)
        .values(
          trade(seed, {
            status: 'closed' as const,
            closeTimestampMs: 1790028556624,
            closePrice: 1.09,
            profit: '8.50',
          }),
        )
        .returning();
      expect(row!.profit).toBe('8.50000000');
    });
  });

  it.each([
    ['a NaN amount', { amount: 'NaN' }, 'broker_trades_amount_check'],
    [
      'an infinite open price',
      { openPrice: Number.POSITIVE_INFINITY },
      'broker_trades_open_price_check',
    ],
    ['a NaN open price', { openPrice: Number.NaN }, 'broker_trades_open_price_check'],
    ['a zero open price', { openPrice: 0 }, 'broker_trades_open_price_check'],
    ['a negative payout', { payout: -5 }, 'broker_trades_payout_check'],
    ['a non-positive open timestamp', { openTimestampMs: 0 }, 'broker_trades_open_timestamp_check'],
  ])('rejects %s', async (_label, patch, constraint) => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      await expect(tx.insert(brokerTrades).values(trade(seed, patch))).rejects.toEqual(
        pgError('23514', constraint),
      );
    });
  });
});

describe('deposit_events', () => {
  it('rejects a deposit whose account belongs to another user', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const other = await seedAccount(tx);
      await expect(
        tx.insert(depositEvents).values({
          userId: other.userId,
          brokerAccountId: seed.accountId,
          postbackId: 'p-1',
          payload: {},
        }),
      ).rejects.toEqual(pgError('23503', 'deposit_events_account_owner_fk'));
    });
  });

  it('rejects a negative amount', async () => {
    await rolledBack(async (tx) => {
      await expect(
        tx.insert(depositEvents).values({
          postbackId: 'p-2',
          amount: '-500.00' as DecimalString,
          payload: {},
        }),
      ).rejects.toEqual(pgError('23514', 'deposit_events_amount_check'));
    });
  });

  it('dedupes by postback id', async () => {
    await rolledBack(async (tx) => {
      await tx.insert(depositEvents).values({ postbackId: 'p-3', payload: {} });
      await expect(
        tx.insert(depositEvents).values({ postbackId: 'p-3', payload: {} }),
      ).rejects.toEqual(pgError('23505', 'deposit_events_postback_id_idx'));
    });
  });
});
