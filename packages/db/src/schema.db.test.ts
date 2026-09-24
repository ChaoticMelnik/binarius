import { randomUUID } from 'node:crypto';
import { TransactionRollbackError, eq, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canTransition } from '@binarius/shared';
import { createDb, type Db } from './client';
import {
  brokerAccounts,
  brokerTrades,
  depositEvents,
  oauthStates,
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
// This file shares that database with a locally running compose stack, so no case runs DDL:
// its locks would sit in front of the stack's own writers, in an order they do not expect.
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

// Constraints the suite has actually seen the database enforce. Recorded by the matchers
// below at MATCH time, not at construction: a name mentioned in a comment, or passed by a
// test that never runs, must not count as covered. The gate at the end of this file compares
// this registry against the live catalog.
const observed = new Set<string>();
const caught = (error: unknown): Record<string, unknown> =>
  (error as { cause?: Record<string, unknown> } | undefined)?.cause ?? {};

// drizzle wraps driver errors in DrizzleQueryError; the Postgres error with its SQLSTATE and
// the name of the constraint that fired is the cause. Asserting the name keeps a test from
// passing because some *other* constraint rejected the row. Registration happens only after
// the assertion, so a failing or skipped case never marks a constraint covered — and awaiting
// the rejection here, rather than wrapping an asymmetric matcher, keeps a full diff on a
// mismatch, which matters because "a different constraint fired" is this file's usual failure.
async function rejectsWith(query: Promise<unknown>, code: string, constraint: string) {
  const error = await query.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error, `expected a ${constraint} violation but nothing was thrown`).toBeDefined();
  expect(caught(error)).toMatchObject({ code, constraint });
  observed.add(constraint);
}

// raise_append_only() is a trigger, and PostgreSQL populates no `constraint` field for it,
// so those cases assert the code and the message instead, and register the trigger that the
// statement kind reaches: the row trigger for UPDATE/DELETE, the statement one for TRUNCATE
async function rejectsAsAppendOnly(
  query: Promise<unknown>,
  table: string,
  trigger: 'append_only' | 'no_truncate',
) {
  const error = await query.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error, `expected ${table} to be append-only but nothing was thrown`).toBeDefined();
  expect(caught(error)).toMatchObject({ code: 'P0001', message: `${table} is append-only` });
  observed.add(`${table}_${trigger}`);
}

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

async function seedDeposit(tx: Tx, seed: { accountId: string; userId: string }): Promise<string> {
  const [row] = await tx
    .insert(depositEvents)
    .values({
      userId: seed.userId,
      brokerAccountId: seed.accountId,
      postbackId: `pb-${++seq}`,
      payload: {},
    })
    .returning({ id: depositEvents.id });
  return row!.id;
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

// The enum CHECKs and the plain uniques are mechanical, but they are what keeps a typo in a
// status list or a missing dedupe from reaching production, and the coverage gate at the end of
// this file will not accept a constraint that nothing exercises.
describe('enum and uniqueness constraints', () => {
  it.each([
    [
      'users_status_check',
      async (tx: Tx) =>
        tx.insert(users).values({ telegramUserId: 970_001n, status: 'bogus' as never }),
    ],
    [
      'audit_log_actor_type_check',
      (tx: Tx) => tx.execute(sql`insert into audit_log (actor_type, action) values ('bogus', 'a')`),
    ],
    [
      'token_ledger_kind_check',
      (tx: Tx) =>
        tx.execute(
          sql`insert into token_ledger (user_id, kind, balance_delta) values (gen_random_uuid(), 'bogus', 1)`,
        ),
    ],
    [
      'token_ledger_ref_type_check',
      (tx: Tx) =>
        tx.execute(
          sql`insert into token_ledger (user_id, kind, balance_delta, ref_type, ref_id) values (gen_random_uuid(), 'adjustment', 1, 'bogus', gen_random_uuid())`,
        ),
    ],
    [
      'token_ledger_ref_pair_check',
      (tx: Tx) =>
        tx.execute(
          sql`insert into token_ledger (user_id, kind, balance_delta, ref_type) values (gen_random_uuid(), 'adjustment', 1, 'manual')`,
        ),
    ],
    [
      'token_ledger_delta_check',
      (tx: Tx) =>
        tx.execute(
          sql`insert into token_ledger (user_id, kind) values (gen_random_uuid(), 'adjustment')`,
        ),
    ],
    [
      'deposit_events_status_check',
      (tx: Tx) =>
        tx.execute(
          sql`insert into deposit_events (postback_id, payload, status) values ('x', '{}'::jsonb, 'bogus')`,
        ),
    ],
    [
      'bonus_rules_validity_check',
      (tx: Tx) =>
        tx.execute(
          sql`insert into bonus_rules (code, kind, valid_from, valid_to) values ('c', 'k', now(), now() - interval '1 day')`,
        ),
    ],
    [
      'notification_jobs_status_check',
      (tx: Tx) =>
        tx.execute(
          sql`insert into notification_jobs (user_id, kind, status) values (gen_random_uuid(), 'k', 'bogus')`,
        ),
    ],
    [
      'broker_accounts_status_check',
      (tx: Tx) =>
        tx.execute(
          sql`insert into broker_accounts (user_id, broker_user_id, access_token_enc, refresh_token_enc, token_key_id, access_token_expires_at, status) values (gen_random_uuid(), 'b', '\\x00', '\\x00', 'k', now(), 'bogus')`,
        ),
    ],
    [
      'trading_sessions_mode_check',
      (tx: Tx) =>
        tx.execute(
          sql`insert into trading_sessions (broker_account_id, mode) values (gen_random_uuid(), 'bogus')`,
        ),
    ],
    [
      'trading_sessions_status_check',
      (tx: Tx) =>
        tx.execute(
          sql`insert into trading_sessions (broker_account_id, mode, status) values (gen_random_uuid(), 'demo', 'bogus')`,
        ),
    ],
  ])('rejects a value outside %s', async (constraint, insert) => {
    await rolledBack(async (tx) => {
      await rejectsWith(insert(tx), '23514', constraint);
    });
  });

  it.each([
    ['trade_intents_mode_check', { mode: 'bogus' }],
    ['trade_intents_action_check', { action: 'bogus' }],
    ['trade_intents_transport_check', { transport: 'bogus' }],
    ['trade_intents_last_error_check', { lastError: 'bogus' }],
    ['trade_intents_tokens_reserved_check', { tokensReserved: -1n }],
  ])('rejects a value outside %s', async (constraint, patch) => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      await rejectsWith(
        tx.insert(tradeIntents).values(intent(seed, 'r1', patch)),
        '23514',
        constraint,
      );
    });
  });

  it.each([
    ['broker_trades_mode_check', { mode: 'bogus' }],
    ['broker_trades_action_check', { action: 'bogus' }],
    ['broker_trades_status_check', { status: 'bogus' }],
    ['broker_trades_asset_id_check', { assetId: 0 }],
  ])('rejects a value outside %s', async (constraint, patch) => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      await rejectsWith(tx.insert(brokerTrades).values(trade(seed, patch)), '23514', constraint);
    });
  });

  // these two need a real intent and a well-formed payload, or the FK and the payload CHECK
  // would fire first and the test would pass for the wrong reason
  it.each([
    ['outbox_events_status_check', { status: 'bogus' as never }],
    ['outbox_events_topic_check', { topic: 'bogus' as never }],
    ['outbox_events_last_error_check', { lastError: 'bogus' as never }],
  ])('rejects a value outside %s', async (constraint, patch) => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const [row] = await tx.insert(tradeIntents).values(intent(seed, 'r1')).returning();
      await rejectsWith(
        tx
          .insert(outboxEvents)
          .values({ intentId: row!.id, payload: { intent_id: row!.id }, ...patch }),
        '23514',
        constraint,
      );
    });
  });

  it('enforces users_telegram_user_id_idx', async () => {
    await rolledBack(async (tx) => {
      await tx.insert(users).values({ telegramUserId: 971_001n });
      await rejectsWith(
        tx.insert(users).values({ telegramUserId: 971_001n }),
        '23505',
        'users_telegram_user_id_idx',
      );
    });
  });

  // a broker account is bound to one Binarius user: a second user cannot claim the same
  // broker_user_id
  it('enforces broker_accounts_broker_user_id_idx', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const [claimed] = await tx
        .select({ brokerUserId: brokerAccounts.brokerUserId })
        .from(brokerAccounts)
        .where(eq(brokerAccounts.id, seed.accountId));
      const [other] = await tx
        .insert(users)
        .values({ telegramUserId: 972_001n })
        .returning({ id: users.id });
      await rejectsWith(
        tx.insert(brokerAccounts).values({
          userId: other!.id,
          brokerUserId: claimed!.brokerUserId,
          accessTokenEnc: Buffer.from('enc'),
          refreshTokenEnc: Buffer.from('enc'),
          tokenKeyId: 'k1',
          accessTokenExpiresAt: new Date(),
        }),
        '23505',
        'broker_accounts_broker_user_id_idx',
      );
    });
  });

  it.each([
    [
      'auth_sessions_token_hash_idx',
      (tx: Tx, userId: string) =>
        tx.execute(
          sql`insert into auth_sessions (user_id, token_hash, expires_at) values (${userId}, 'same', now())`,
        ),
    ],
    [
      // per user: see the per-user test below for the other half of this key
      'notification_jobs_dedupe_key_idx',
      (tx: Tx, userId: string) =>
        tx.execute(
          sql`insert into notification_jobs (user_id, kind, dedupe_key) values (${userId}, 'k', 'same')`,
        ),
    ],
  ])('enforces %s', async (constraint, insert) => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      await insert(tx, seed.userId);
      await rejectsWith(insert(tx, seed.userId), '23505', constraint);
    });
  });

  it.each([
    ['bonus_rules_code_idx', sql`insert into bonus_rules (code, kind) values ('dup', 'k')`],
    [
      'deposit_events_payment_id_idx',
      sql`insert into deposit_events (postback_id, payment_id, payload) values (gen_random_uuid()::text, 'pay-1', '{}'::jsonb)`,
    ],
  ])('enforces %s', async (constraint, statement) => {
    await rolledBack(async (tx) => {
      await tx.execute(statement);
      await rejectsWith(tx.execute(statement), '23505', constraint);
    });
  });

  // a broadcast keyed by date must reach every user, so the key is per user, not global
  it('accepts one dedupe_key across two users', async () => {
    await rolledBack(async (tx) => {
      const first = await seedAccount(tx);
      const second = await seedAccount(tx);
      for (const seed of [first, second]) {
        await tx.execute(
          sql`insert into notification_jobs (user_id, kind, dedupe_key)
              values (${seed.userId}, 'daily-summary', 'daily-summary-2026-09-22')`,
        );
      }
      const { rows } = await tx.execute<{ count: string }>(
        sql`select count(*)::text as count from notification_jobs
              where dedupe_key = 'daily-summary-2026-09-22'`,
      );
      expect(rows[0]!.count).toBe('2');
    });
  });

  it('enforces broker_trades_account_trade_key', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const first = trade(seed);
      await tx.insert(brokerTrades).values(first);
      await rejectsWith(
        tx.insert(brokerTrades).values({ ...trade(seed), brokerTradeId: first.brokerTradeId }),
        '23505',
        'broker_trades_account_trade_key',
      );
    });
  });

  // these five cannot be violated by an insert — a composite unique on (id, …) is unreachable
  // while id is the PK — so they are covered by asserting the catalog, and registered in the
  // coverage set only once that assertion has passed
  it('keeps the composite FK targets in place', async () => {
    const expected = [
      'broker_accounts_id_user_id_key',
      'deposit_events_id_user_key',
      'trade_intents_id_account_mode_key',
      'trade_intents_id_user_key',
      'trading_sessions_id_account_mode_key',
    ];
    const { rows } = await pool.query<{ conname: string }>(
      `select conname from pg_constraint
         where contype = 'u' and connamespace = 'public'::regnamespace and conname = any($1)`,
      [expected],
    );
    expect(rows.map((r) => r.conname).sort()).toEqual(expected);
    for (const name of expected) observed.add(name);
  });
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

  it('rejects a second oauth state with the same hash and refuses impossible timestamps', async () => {
    await rolledBack(async (tx) => {
      const values = {
        stateHash: `state-${++seq}`,
        telegramUserId: 990_001n,
        redirectUri: 'https://example.test/callback',
        expiresAt: sql`now() + interval '10 minutes'`,
      };
      await tx.insert(oauthStates).values(values);
      await rejectsWith(
        tx.insert(oauthStates).values(values),
        '23505',
        'oauth_states_state_hash_idx',
      );
    });
    await rolledBack(async (tx) => {
      await rejectsWith(
        tx.insert(oauthStates).values({
          stateHash: `state-${++seq}`,
          telegramUserId: 990_002n,
          redirectUri: 'https://example.test/callback',
          expiresAt: sql`now() - interval '1 second'`,
        }),
        '23514',
        'oauth_states_expires_after_created_check',
      );
    });
    await rolledBack(async (tx) => {
      await rejectsWith(
        tx.insert(oauthStates).values({
          stateHash: `state-${++seq}`,
          telegramUserId: 990_003n,
          redirectUri: 'https://example.test/callback',
          expiresAt: sql`now() + interval '10 minutes'`,
          usedAt: sql`now() - interval '1 minute'`,
        }),
        '23514',
        'oauth_states_used_after_created_check',
      );
    });
  });

  it('rejects an auth revocation reason outside the allowlist', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      await rejectsWith(
        tx
          .update(brokerAccounts)
          .set({ authRevokedReason: 'bogus' as never })
          .where(eq(brokerAccounts.id, seed.accountId)),
        '23514',
        'broker_accounts_auth_revoked_reason_check',
      );
    });
  });

  it('rejects a second intent with the same client_request_id for the user', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      await tx.insert(tradeIntents).values(intent(seed, 'r1', { status: 'settled' }));
      await rejectsWith(
        tx.insert(tradeIntents).values(intent(seed, 'r1')),
        '23505',
        'trade_intents_user_request_idx',
      );
    });
  });

  // per user, not per account (0002): a retry that names the user's other account must not
  // slip past the key and reserve a second token
  it('rejects the same client_request_id on another account of the same user', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const [second] = await tx
        .insert(brokerAccounts)
        .values({
          userId: seed.userId,
          brokerUserId: `broker-second-${++seq}`,
          accessTokenEnc: Buffer.from('enc'),
          refreshTokenEnc: Buffer.from('enc'),
          tokenKeyId: 'k1',
          accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
        })
        .returning({ id: brokerAccounts.id });
      await tx.insert(tradeIntents).values(intent(seed, 'r1', { status: 'settled' }));
      await rejectsWith(
        tx.insert(tradeIntents).values(intent({ ...seed, accountId: second!.id }, 'r1')),
        '23505',
        'trade_intents_user_request_idx',
      );
    });
  });

  it('allows only one non-terminal intent per account', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      await tx.insert(tradeIntents).values(intent(seed, 'r1', { status: 'unknown' }));
      await rejectsWith(
        tx.insert(tradeIntents).values(intent(seed, 'r2')),
        '23505',
        'trade_intents_active_account_idx',
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
      await rejectsWith(
        tx.insert(tradeIntents).values(intent({ ...seed, userId: other.userId }, 'r1')),
        '23503',
        'trade_intents_account_owner_fk',
      );
    });
  });

  it('rejects an intent whose mode disagrees with its trading session', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const [session] = await tx
        .insert(tradingSessions)
        .values({ brokerAccountId: seed.accountId, mode: 'demo' })
        .returning({ id: tradingSessions.id });
      await rejectsWith(
        tx
          .insert(tradeIntents)
          .values(intent(seed, 'r1', { tradingSessionId: session!.id, mode: 'real' })),
        '23503',
        'trade_intents_session_account_fk',
      );
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
      await rejectsWith(
        tx.insert(tradeIntents).values(intent(seed, 'r1', patch)),
        '23514',
        constraint,
      );
    });
  });
});

describe('users and token_ledger', () => {
  it('rejects a negative balance', async () => {
    await rolledBack(async (tx) => {
      await rejectsWith(
        tx.insert(users).values({ telegramUserId: 990_001n, tokenBalance: -1n }),
        '23514',
        'users_token_balance_check',
      );
    });
  });

  it('rejects a reserve above the balance', async () => {
    await rolledBack(async (tx) => {
      await rejectsWith(
        tx.insert(users).values({ telegramUserId: 990_002n, tokenBalance: 5n, tokenReserved: 6n }),
        '23514',
        'users_token_reserved_check',
      );
    });
  });

  it('allows one reservation per intent', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const [row] = await tx.insert(tradeIntents).values(intent(seed, 'r1')).returning();
      const ref = { userId: seed.userId, intentId: row!.id };
      await tx.insert(tokenLedger).values({ ...ref, kind: 'reserve', reservedDelta: 1n });
      await rejectsWith(
        tx.insert(tokenLedger).values({ ...ref, kind: 'reserve', reservedDelta: 1n }),
        '23505',
        'token_ledger_reserve_intent_idx',
      );
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
      await rejectsWith(
        tx.insert(tokenLedger).values({ ...ref, kind: 'release', reservedDelta: -1n }),
        '23505',
        'token_ledger_terminal_intent_idx',
      );
    });
  });

  it('rejects a ledger row referencing another user’s intent', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const other = await seedAccount(tx);
      const [row] = await tx.insert(tradeIntents).values(intent(seed, 'r1')).returning();
      await rejectsWith(
        tx
          .insert(tokenLedger)
          .values({ userId: other.userId, intentId: row!.id, kind: 'reserve', reservedDelta: 1n }),
        '23503',
        'token_ledger_intent_owner_fk',
      );
    });
  });

  it('rejects a reservation without an intent reference', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      await rejectsWith(
        tx.insert(tokenLedger).values({ userId: seed.userId, kind: 'reserve', reservedDelta: 1n }),
        '23514',
        'token_ledger_reference_check',
      );
    });
  });

  it('rejects a non-intent kind carrying an intent reference', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const [row] = await tx.insert(tradeIntents).values(intent(seed, 'r1')).returning();
      await rejectsWith(
        tx.insert(tokenLedger).values({
          userId: seed.userId,
          intentId: row!.id,
          kind: 'purchase',
          balanceDelta: 10n,
        }),
        '23514',
        'token_ledger_reference_check',
      );
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
      await rejectsWith(
        tx.insert(tokenLedger).values({ userId: seed.userId, intentId: row!.id, ...patch }),
        '23514',
        'token_ledger_delta_shape_check',
      );
    });
  });

  it('rejects a negative purchase', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const deposit = await seedDeposit(tx, seed);
      await rejectsWith(
        tx.insert(tokenLedger).values({
          userId: seed.userId,
          kind: 'purchase',
          balanceDelta: -10n,
          depositEventId: deposit,
        }),
        '23514',
        'token_ledger_delta_shape_check',
      );
    });
  });

  // one row per deposit PER KIND. Keying on the deposit alone would let whichever of the two
  // arrived first take the only slot and block the other forever, on an append-only table.
  it('accepts a purchase and a deposit-linked bonus for the same deposit', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const deposit = await seedDeposit(tx, seed);
      await tx.insert(tokenLedger).values({
        userId: seed.userId,
        kind: 'purchase',
        balanceDelta: 1000n,
        depositEventId: deposit,
      });
      const [bonus] = await tx
        .insert(tokenLedger)
        .values({ userId: seed.userId, kind: 'bonus', balanceDelta: 100n, depositEventId: deposit })
        .returning({ id: tokenLedger.id });
      expect(bonus!.id).toBeDefined();
    });
  });

  it.each([
    ['purchase' as const, 1000n],
    ['bonus' as const, 100n],
  ])('credits one deposit only once per kind (%s)', async (kind, delta) => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const deposit = await seedDeposit(tx, seed);
      const row = { userId: seed.userId, kind, balanceDelta: delta, depositEventId: deposit };
      await tx.insert(tokenLedger).values(row);
      await rejectsWith(
        tx.insert(tokenLedger).values(row),
        '23505',
        'token_ledger_deposit_event_idx',
      );
    });
  });

  it('rejects a credit for another user’s deposit', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const other = await seedAccount(tx);
      const deposit = await seedDeposit(tx, seed);
      await rejectsWith(
        tx.insert(tokenLedger).values({
          userId: other.userId,
          kind: 'purchase',
          balanceDelta: 1000n,
          depositEventId: deposit,
        }),
        '23503',
        'token_ledger_deposit_owner_fk',
      );
    });
  });

  it.each([
    ['a purchase without a deposit reference', { kind: 'purchase' as const, balanceDelta: 10n }],
    [
      'an adjustment occupying a deposit slot',
      { kind: 'adjustment' as const, balanceDelta: 10n, useDeposit: true },
    ],
  ])('rejects %s', async (_label, patch) => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const { useDeposit, ...values } = patch as typeof patch & { useDeposit?: boolean };
      const depositEventId = useDeposit ? await seedDeposit(tx, seed) : undefined;
      await rejectsWith(
        tx.insert(tokenLedger).values({ userId: seed.userId, ...values, depositEventId }),
        '23514',
        'token_ledger_reference_check',
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
      await rejectsAsAppendOnly(mutate(tx, row!.id), 'token_ledger', 'append_only');
    });
  });

  it.each(['token_ledger', 'audit_log'])('is append-only against TRUNCATE on %s', async (table) => {
    await rolledBack(async (tx) => {
      await rejectsAsAppendOnly(tx.execute(sql.raw(`truncate ${table}`)), table, 'no_truncate');
    });
  });

  it('protects audit_log against UPDATE', async () => {
    await rolledBack(async (tx) => {
      await tx.execute(sql`insert into audit_log (actor_type, action) values ('system', 'probe')`);
      await rejectsAsAppendOnly(
        tx.execute(sql`update audit_log set action = 'changed' where action = 'probe'`),
        'audit_log',
        'append_only',
      );
    });
  });
});

describe('outbox_events', () => {
  it('accepts a well-formed payload and rejects a duplicate', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const [row] = await tx.insert(tradeIntents).values(intent(seed, 'r1')).returning();
      await tx.insert(outboxEvents).values({ intentId: row!.id, payload: { intent_id: row!.id } });
      await rejectsWith(
        tx.insert(outboxEvents).values({ intentId: row!.id, payload: { intent_id: row!.id } }),
        '23505',
        'outbox_events_topic_intent_key',
      );
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
    ['a non-object payload', [1, 2]],
  ])('rejects %s', async (_label, payload) => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const [row] = await tx.insert(tradeIntents).values(intent(seed, 'r1')).returning();
      await rejectsWith(
        tx
          .insert(outboxEvents)
          .values({ intentId: row!.id, payload: payload as { intent_id: string } }),
        '23514',
        'outbox_events_payload_check',
      );
    });
  });

  // the publisher builds jobId from the payload, so a case-shifted id would enqueue the same
  // intent under a second job id — the equality is byte-for-byte, not case-insensitive
  it('rejects a case-shifted intent_id', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const [row] = await tx.insert(tradeIntents).values(intent(seed, 'r1')).returning();
      await rejectsWith(
        tx
          .insert(outboxEvents)
          .values({ intentId: row!.id, payload: { intent_id: row!.id.toUpperCase() } }),
        '23514',
        'outbox_events_payload_check',
      );
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
      await rejectsWith(
        tx.insert(brokerTrades).values(trade(seed, { intentId: row!.id })),
        '23505',
        'broker_trades_intent_id_key',
      );
    });
  });

  it('rejects a trade linked to another account’s intent', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const other = await seedAccount(tx);
      const [row] = await tx.insert(tradeIntents).values(intent(seed, 'r1')).returning();
      await rejectsWith(
        tx.insert(brokerTrades).values(trade(other, { intentId: row!.id })),
        '23503',
        'broker_trades_intent_account_fk',
      );
    });
  });

  it('rejects a real trade against a demo intent', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const [row] = await tx.insert(tradeIntents).values(intent(seed, 'r1')).returning();
      await rejectsWith(
        tx.insert(brokerTrades).values(trade(seed, { intentId: row!.id, mode: 'real' })),
        '23503',
        'broker_trades_intent_account_fk',
      );
    });
  });

  // profit is the one signed money column: this case exists so that re-tightening the
  // constraint to `> 0` cannot pass a suite made only of rejections
  it('accepts a settled trade with a negative profit', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const [row] = await tx
        .insert(brokerTrades)
        .values(
          trade(seed, {
            status: 'closed' as const,
            closeTimestampMs: 1790028556624,
            closePrice: 1.07,
            profit: '-10.00',
          }),
        )
        .returning();
      expect(row!.profit).toBe('-10.00000000');
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
      await rejectsWith(
        tx.insert(brokerTrades).values(trade(seed, patch)),
        '23514',
        'broker_trades_settlement_check',
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
    ['a NaN payout', { payout: Number.NaN }, 'broker_trades_payout_check'],
    ['a non-positive open timestamp', { openTimestampMs: 0 }, 'broker_trades_open_timestamp_check'],
    ['a NaN potential profit', { potentialProfit: 'NaN' }, 'broker_trades_potential_profit_check'],
    [
      'a non-positive close price on a settled trade',
      {
        status: 'closed' as const,
        closeTimestampMs: 1790028556624,
        closePrice: 0,
        profit: '8.50',
      },
      'broker_trades_close_price_check',
    ],
    [
      'a NaN profit on a settled trade',
      {
        status: 'closed' as const,
        closeTimestampMs: 1790028556624,
        closePrice: 1.09,
        profit: 'NaN',
      },
      'broker_trades_profit_check',
    ],
    [
      'a non-positive close timestamp on a settled trade',
      { status: 'closed' as const, closeTimestampMs: -1, closePrice: 1.09, profit: '8.50' },
      'broker_trades_close_timestamp_check',
    ],
  ])('rejects %s', async (_label, patch, constraint) => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      await rejectsWith(tx.insert(brokerTrades).values(trade(seed, patch)), '23514', constraint);
    });
  });
});

describe('trade_intents blocking', () => {
  // ARCH-04 parks an intent in manual_review when reconciliation could not determine whether
  // the order reached the broker: tokens are still reserved and a position may be open, so the
  // account must not start another trade until an operator resolves it
  it('blocks a new intent while one sits in manual_review', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      await tx
        .insert(tradeIntents)
        .values(intent(seed, 'r1', { status: 'manual_review', tokensReserved: 5n }));
      await rejectsWith(
        tx.insert(tradeIntents).values(intent(seed, 'r2')),
        '23505',
        'trade_intents_active_account_idx',
      );
    });
  });

  // the one assertion that ties the shared transition table to the index predicate: they live
  // in different packages and nothing else connects them
  it('unblocks the account once the operator resolves manual_review', async () => {
    expect(canTransition('manual_review', 'settled')).toBe(true);
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const [parked] = await tx
        .insert(tradeIntents)
        .values(intent(seed, 'r1', { status: 'manual_review', tokensReserved: 5n }))
        .returning({ id: tradeIntents.id });
      await tx
        .update(tradeIntents)
        .set({ status: 'settled' })
        .where(eq(tradeIntents.id, parked!.id));
      const [next] = await tx.insert(tradeIntents).values(intent(seed, 'r2')).returning();
      expect(next!.status).toBe('planned');
    });
  });
});

describe('deposit_events', () => {
  it('rejects a deposit whose account belongs to another user', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const other = await seedAccount(tx);
      await rejectsWith(
        tx.insert(depositEvents).values({
          userId: other.userId,
          brokerAccountId: seed.accountId,
          postbackId: 'p-1',
          payload: {},
        }),
        '23503',
        'deposit_events_account_owner_fk',
      );
    });
  });

  it('rejects a negative amount', async () => {
    await rolledBack(async (tx) => {
      await rejectsWith(
        tx.insert(depositEvents).values({
          postbackId: 'p-2',
          amount: '-500.00' as DecimalString,
          payload: {},
        }),
        '23514',
        'deposit_events_amount_check',
      );
    });
  });

  // the composite FK is MATCH SIMPLE, so it is satisfied whenever either column is NULL;
  // this CHECK is what stops a credit claimed for a user with no account behind it
  it('rejects a user without an account', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      await rejectsWith(
        tx.insert(depositEvents).values({
          userId: seed.userId,
          postbackId: 'p-pair',
          payload: {},
          status: 'credited',
        }),
        '23514',
        'deposit_events_owner_pair_check',
      );
    });
  });

  it.each([
    ['an unattributed postback', {}],
    ['an account without a user yet', { withAccount: true }],
  ])('accepts %s', async (_label, shape) => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const withAccount = (shape as { withAccount?: boolean }).withAccount === true;
      const [row] = await tx
        .insert(depositEvents)
        .values({
          postbackId: `p-ok-${++seq}`,
          payload: {},
          ...(withAccount ? { brokerAccountId: seed.accountId } : {}),
        })
        .returning();
      expect(row!.status).toBe('received');
    });
  });

  it('rejects a NaN amount', async () => {
    await rolledBack(async (tx) => {
      await rejectsWith(
        tx
          .insert(depositEvents)
          .values({ postbackId: 'p-nan', amount: 'NaN' as DecimalString, payload: {} }),
        '23514',
        'deposit_events_amount_check',
      );
    });
  });

  it('dedupes by postback id', async () => {
    await rolledBack(async (tx) => {
      await tx.insert(depositEvents).values({ postbackId: 'p-3', payload: {} });
      await rejectsWith(
        tx.insert(depositEvents).values({ postbackId: 'p-3', payload: {} }),
        '23505',
        'deposit_events_postback_id_idx',
      );
    });
  });
});

// Every simple FK the migrations declare. The ones below can be violated on their own: the
// composite FK sharing the table is either absent or skipped under MATCH SIMPLE because one of
// its columns is NULL, so a dangling id reaches exactly the constraint named.
describe('foreign keys', () => {
  const dangling = randomUUID();
  it.each<[string, (tx: Tx) => Promise<unknown>]>([
    [
      'auth_sessions_user_id_users_id_fk',
      (tx) =>
        tx.execute(
          sql`insert into auth_sessions (user_id, token_hash, expires_at) values (${dangling}, ${`fk-${++seq}`}, now())`,
        ),
    ],
    [
      'broker_accounts_user_id_users_id_fk',
      (tx) =>
        tx.insert(brokerAccounts).values({
          userId: dangling,
          brokerUserId: `broker-fk-${++seq}`,
          accessTokenEnc: Buffer.from('enc'),
          refreshTokenEnc: Buffer.from('enc'),
          tokenKeyId: 'k1',
          accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
        }),
    ],
    [
      // no user_id: the ownership composite is skipped, and the owner-pair CHECK allows it
      'deposit_events_broker_account_id_broker_accounts_id_fk',
      (tx) =>
        tx
          .insert(depositEvents)
          .values({ brokerAccountId: dangling, postbackId: `pb-fk-${++seq}`, payload: {} }),
    ],
    [
      'notification_jobs_user_id_users_id_fk',
      (tx) =>
        tx.execute(sql`insert into notification_jobs (user_id, kind) values (${dangling}, 'k')`),
    ],
    [
      'outbox_events_intent_id_trade_intents_id_fk',
      (tx) =>
        tx.insert(outboxEvents).values({ intentId: dangling, payload: { intent_id: dangling } }),
    ],
    [
      // no intent or deposit: both ownership composites are skipped
      'token_ledger_user_id_users_id_fk',
      (tx) =>
        tx.insert(tokenLedger).values({ userId: dangling, kind: 'adjustment', balanceDelta: 1n }),
    ],
    [
      'trading_sessions_broker_account_id_broker_accounts_id_fk',
      (tx) => tx.insert(tradingSessions).values({ brokerAccountId: dangling, mode: 'demo' }),
    ],
    [
      // no intent_id: the intent composite is skipped
      'broker_trades_broker_account_id_broker_accounts_id_fk',
      (tx) => tx.insert(brokerTrades).values(trade({ accountId: dangling })),
    ],
  ])('rejects a dangling reference through %s', async (constraint, insert) => {
    await rolledBack(async (tx) => {
      await rejectsWith(insert(tx), '23503', constraint);
    });
  });

  // These five cannot be violated by an insert while their composite is in place: the composite
  // covers the same columns, so any dangling value fails it too, and which of the two fires is
  // an undocumented trigger order. Dropping the composite to isolate them would be DDL against a
  // shared database (see the top of this file). So, as with the composite FK targets above, the
  // catalog is asserted instead — and only once every premise of the implication has been seen
  // enforced by a test earlier in this file. `confdeltype = 'r'` pins the one property the
  // composite does not share (these are ON DELETE RESTRICT, the composites NO ACTION).
  it('keeps the simple FKs implied by a composite in place', async () => {
    const implied = [
      {
        name: 'trade_intents_broker_account_id_broker_accounts_id_fk',
        from: 'trade_intents(broker_account_id)',
        to: 'broker_accounts(id)',
        premises: ['trade_intents_account_owner_fk'],
      },
      {
        name: 'trade_intents_user_id_users_id_fk',
        from: 'trade_intents(user_id)',
        to: 'users(id)',
        premises: ['trade_intents_account_owner_fk', 'broker_accounts_user_id_users_id_fk'],
      },
      {
        name: 'trade_intents_trading_session_id_trading_sessions_id_fk',
        from: 'trade_intents(trading_session_id)',
        to: 'trading_sessions(id)',
        premises: ['trade_intents_session_account_fk'],
      },
      {
        name: 'broker_trades_intent_id_trade_intents_id_fk',
        from: 'broker_trades(intent_id)',
        to: 'trade_intents(id)',
        premises: ['broker_trades_intent_account_fk'],
      },
      {
        // a user without an account would slip past the composite under MATCH SIMPLE; the
        // owner-pair CHECK is what rejects that shape first
        name: 'deposit_events_user_id_users_id_fk',
        from: 'deposit_events(user_id)',
        to: 'users(id)',
        premises: [
          'deposit_events_account_owner_fk',
          'deposit_events_owner_pair_check',
          'broker_accounts_user_id_users_id_fk',
        ],
      },
    ];
    const missingPremises = implied
      .flatMap((fk) => fk.premises.filter((premise) => !observed.has(premise)))
      .sort();
    expect(missingPremises, 'premises no earlier test observed').toEqual([]);

    const { rows } = await pool.query<{
      conname: string;
      from: string;
      to: string;
      convalidated: boolean;
      confdeltype: string;
      confmatchtype: string;
    }>(
      `select c.conname,
              c.conrelid::regclass::text || '(' || (
                select string_agg(a.attname, ',' order by k.ord) from unnest(c.conkey) with ordinality k(attnum, ord)
                  join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
              ) || ')' as "from",
              c.confrelid::regclass::text || '(' || (
                select string_agg(a.attname, ',' order by k.ord) from unnest(c.confkey) with ordinality k(attnum, ord)
                  join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.attnum
              ) || ')' as "to",
              c.convalidated, c.confdeltype::text, c.confmatchtype::text
         from pg_constraint c
        where c.contype = 'f' and c.connamespace = 'public'::regnamespace and c.conname = any($1)
        order by c.conname`,
      [implied.map((fk) => fk.name)],
    );
    expect(rows).toEqual(
      implied
        .map(({ name, from, to }) => ({
          conname: name,
          from,
          to,
          convalidated: true,
          confdeltype: 'r',
          confmatchtype: 's',
        }))
        .sort((a, b) => a.conname.localeCompare(b.conname)),
    );
    for (const fk of implied) observed.add(fk.name);
  });
});

// The gate is the last test in the file, not an afterAll: as a test it is excluded by a
// name filter along with everything else, so debugging one case does not produce a red file
// about the constraints that run did not touch. It must run last, which
// `sequence.shuffle: false` in vitest.config.ts pins for the default run; passing
// `--sequence.shuffle` explicitly overrides that and fails this gate — the safe direction.
// A constraint counts as covered only when a test actually observed the database enforcing
// it — the helpers register after their assertion passes, and the two catalog tests (composite
// FK targets, simple FKs implied by a composite) register only after their own assertions. Textual matching was the previous bar and it accepted a name
// in a comment, in a skipped test, or spelled as part of another name.
describe('constraint coverage', () => {
  it('has seen the database enforce every CHECK, unique index, foreign key and trigger', async () => {
    const { rows } = await pool.query<{ conname: string }>(`
      select conname from pg_constraint
        where contype in ('c', 'u', 'f') and connamespace = 'public'::regnamespace
      union
      select indexname as conname from pg_indexes
        where schemaname = 'public' and indexdef like 'CREATE UNIQUE%'
      union
      select t.tgname as conname from pg_trigger t
        join pg_class c on c.oid = t.tgrelid
        join pg_namespace n on n.oid = c.relnamespace
        where not t.tgisinternal and n.nspname = 'public'
    `);
    const declared = rows.map((r) => r.conname).filter((n) => !n.endsWith('_pkey'));
    const uncovered = declared.filter((name) => !observed.has(name)).sort();
    expect(declared.length).toBeGreaterThan(60);
    expect(uncovered, 'constraints no test observed the database enforcing').toEqual([]);
  });
});
