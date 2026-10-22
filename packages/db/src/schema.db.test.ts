import { randomUUID } from 'node:crypto';
import { TransactionRollbackError, eq, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AuditAction,
  TradeIntentFailureReason,
  TradeIntentStatus,
  canTransition,
  staffLoginSchema,
} from '@binarius/shared';
import { createDb, type Db } from './client';
import {
  auditLog,
  bonusRules,
  botTextOverrides,
  brokerAccounts,
  brokerBalanceSnapshots,
  brokerSessionLeases,
  brokerTrades,
  decisionTicks,
  depositEvents,
  oauthStates,
  postbackDeliveries,
  outboxEvents,
  referralCodes,
  referrals,
  signalDecisions,
  starPayments,
  starRefundRequests,
  staff,
  staffLoginChallenges,
  staffLoginLinks,
  staffSessions,
  tokenLedger,
  tradeIntents,
  tradingSessions,
  tradingSwitch,
  users,
} from './schema/index';
import {
  AccountHaltReason,
  TradingSessionStopReason,
  botTextOverrideSchema,
  type DecimalString,
} from '@binarius/shared';
import { STAFF_LOGIN_CORPUS } from '@binarius/shared/testing';
import { bonusRuleRef } from './testing';
// Integration tests: a migrated Postgres named by TEST_DATABASE_URL (README → Test database).
// Each case runs in one transaction that is rolled back at the end; Postgres aborts a
// transaction after its first error, so every case expects exactly one error code.
// This file shares that database with a locally running compose stack, so no case runs DDL:
// its locks would sit in front of the stack's own writers, in an order they do not expect.
const url = process.env.TEST_DATABASE_URL;
if (url === undefined || url === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for packages/db integration tests (see README → Test database)',
  );
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
  return { userId: user!.id, accountId: account!.id, brokerUserId: `broker-${n}` };
}

async function seedDeposit(
  tx: Tx,
  seed: { accountId: string; userId: string; brokerUserId: string },
): Promise<string> {
  const [row] = await tx
    .insert(depositEvents)
    .values({
      source: 'binodex',
      userId: seed.userId,
      brokerAccountId: seed.accountId,
      brokerUserId: seed.brokerUserId,
      paymentId: `pay-${++seq}`,
      amount: '10' as DecimalString,
    })
    .returning({ id: depositEvents.id });
  return row!.id;
}

// the columns every deposit_events row needs (#141), unattributed
const depositShape = () => ({
  source: 'binodex' as const,
  brokerUserId: `trader-${++seq}`,
  paymentId: `pay-${++seq}`,
  amount: '10' as DecimalString,
});

// a finished intent holds no reserve and a live one holds its token
// (trade_intents_terminal_reserve_check), so the reserve follows the status unless patched
const reserveFor = (status: unknown): bigint =>
  status === 'rejected' || status === 'settled' ? 0n : 1n;

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
  tokensReserved: reserveFor(patch.status),
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

describe('users.language (#508)', () => {
  it('takes ru and en, refuses another case, an empty string and NULL', async () => {
    for (const language of ['ru', 'en'] as const) {
      await rolledBack(async (tx) => {
        await tx.insert(users).values({ telegramUserId: 970_007n, language });
      });
    }
    for (const language of ['RU', '']) {
      await rolledBack((tx) =>
        rejectsWith(
          tx.insert(users).values({ telegramUserId: 970_008n, language: language as never }),
          '23514',
          'users_language_check',
        ),
      );
    }
    await rolledBack(async (tx) => {
      const error = await tx
        .execute(sql`insert into users (telegram_user_id, language) values (970009, null)`)
        .then(
          () => undefined,
          (thrown: unknown) => thrown,
        );
      expect(caught(error)).toMatchObject({ code: '23502', column: 'language' });
    });
  });
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
      'users_notification_level_check',
      async (tx: Tx) =>
        tx.insert(users).values({ telegramUserId: 970_002n, notificationLevel: 'bogus' as never }),
    ],
    [
      'users_language_check',
      async (tx: Tx) =>
        tx.insert(users).values({ telegramUserId: 970_006n, language: 'de' as never }),
    ],
    [
      'users_trading_mode_check',
      async (tx: Tx) =>
        tx.insert(users).values({ telegramUserId: 970_005n, tradingMode: 'REAL' as never }),
    ],
    [
      'audit_log_actor_type_check',
      (tx: Tx) =>
        tx.execute(
          sql`insert into audit_log (actor_type, action) values ('bogus', 'staff_logout')`,
        ),
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
          sql`insert into token_ledger (user_id, kind, balance_delta, ref_type, ref_id, note) values (gen_random_uuid(), 'adjustment', 1, 'bogus', gen_random_uuid(), 'n')`,
        ),
    ],
    [
      'token_ledger_ref_pair_check',
      (tx: Tx) =>
        tx.execute(
          sql`insert into token_ledger (user_id, kind, balance_delta, ref_type, note) values (gen_random_uuid(), 'adjustment', 1, 'manual', 'n')`,
        ),
    ],
    [
      'token_ledger_delta_check',
      (tx: Tx) =>
        tx.execute(
          sql`insert into token_ledger (user_id, kind, note) values (gen_random_uuid(), 'adjustment', 'n')`,
        ),
    ],
    [
      'deposit_events_status_check',
      (tx: Tx) =>
        tx.execute(
          sql`insert into deposit_events (source, broker_user_id, payment_id, amount, status) values ('binodex', 't', 'x', 1, 'bogus')`,
        ),
    ],
    [
      'bonus_rules_validity_check',
      (tx: Tx) =>
        tx.execute(
          sql`insert into bonus_rules (code, version, kind, valid_from, valid_to) values ('c', 1, 'link_bonus', now(), now() - interval '1 day')`,
        ),
    ],
    [
      'notification_jobs_status_check',
      (tx: Tx) =>
        tx.execute(
          sql`insert into notification_jobs (user_id, kind, status) values (gen_random_uuid(), 'first_session_1h', 'bogus')`,
        ),
    ],
    [
      'notification_jobs_kind_check',
      (tx: Tx) =>
        tx.execute(
          sql`insert into notification_jobs (user_id, kind) values (gen_random_uuid(), 'bogus')`,
        ),
    ],
    [
      'notification_kinds_kind_check',
      (tx: Tx) => tx.execute(sql`insert into notification_kinds (kind) values ('bogus')`),
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

  // every member of the constant, on each table: a migration that lags the constant fails here
  it.each(Object.values(TradeIntentFailureReason))(
    'accepts last_error %s on trade_intents',
    async (lastError) => {
      await rolledBack(async (tx) => {
        const seed = await seedAccount(tx);
        const [row] = await tx
          .insert(tradeIntents)
          .values(intent(seed, 'r1', { lastError }))
          .returning();
        expect(row!.lastError).toBe(lastError);
      });
    },
  );

  it.each(Object.values(TradeIntentFailureReason))(
    'accepts last_error %s on outbox_events',
    async (lastError) => {
      await rolledBack(async (tx) => {
        const seed = await seedAccount(tx);
        const [row] = await tx.insert(tradeIntents).values(intent(seed, 'r1')).returning();
        const [event] = await tx
          .insert(outboxEvents)
          .values({ intentId: row!.id, payload: { intent_id: row!.id }, lastError })
          .returning();
        expect(event!.lastError).toBe(lastError);
      });
    },
  );

  // the corpus that proves this CHECK and startPayloadSchema agree row by row lives in
  // user-ops.db.test.ts; here one observation of each, for the coverage gate
  it('rejects an acquisition source outside the start-payload pattern', async () => {
    await rolledBack(async (tx) => {
      await rejectsWith(
        tx.insert(users).values({
          telegramUserId: 973_001n,
          acquisitionSource: 'a'.repeat(65),
          acquiredAt: sql`now()`,
        }),
        '23514',
        'users_acquisition_source_check',
      );
    });
  });

  it('rejects an acquisition source without the time it was recorded', async () => {
    await rolledBack(async (tx) => {
      await rejectsWith(
        tx.insert(users).values({ telegramUserId: 973_002n, acquisitionSource: 'src_ab-CD9' }),
        '23514',
        'users_acquisition_pair_check',
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
          sql`insert into notification_jobs (user_id, kind, dedupe_key) values (${userId}, 'first_session_1h', 'same')`,
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
    [
      'bonus_rules_code_version_key',
      sql`insert into bonus_rules (code, version, kind) values ('dup', 1, 'link_bonus')`,
    ],
    [
      'bonus_rules_active_code_idx',
      sql`insert into bonus_rules (code, version, kind, is_active) values ('dup', (select coalesce(max(version), 0) + 1 from bonus_rules where code = 'dup'), 'link_bonus', true)`,
    ],
    [
      // the second trader id does not matter: one deposit per payment of a source
      'deposit_events_source_payment_idx',
      sql`insert into deposit_events (source, broker_user_id, payment_id, amount) values ('binodex', gen_random_uuid()::text, 'pay-1', 1)`,
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
              values (${seed.userId}, 'first_session_1h', 'daily-summary-2026-09-22')`,
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

  // these cannot be violated by an insert — a composite unique on (id, …) is unreachable
  // while id is the PK — so they are covered by asserting the catalog, and registered in the
  // coverage set only once that assertion has passed
  it('keeps the composite FK targets in place', async () => {
    const expected = [
      'bonus_rules_id_kind_key',
      'broker_accounts_id_broker_user_id_key',
      'broker_accounts_id_user_id_key',
      'deposit_events_id_user_key',
      'referrals_id_inviter_key',
      // #666: an intent's decision is of its session
      'signal_decisions_id_session_key',
      'star_payments_id_user_key',
      'trade_intents_id_account_mode_key',
      // #700: the open block's intent is one of the session's own
      'trade_intents_id_session_key',
      'trade_intents_id_user_key',
      // #666: a session's decision names the session's account
      'trading_sessions_id_account_key',
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
      expect(row).toMatchObject({
        status: 'planned',
        version: 1,
        tokensReserved: 1n,
        reconcileClaimedAt: null,
      });
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

  // each row breaks exactly one of the two: (true, 'bogus') satisfies the pair, (true, NULL)
  // satisfies the allowlist (NULL in (...) is NULL, which a CHECK lets through)
  it('rejects a halt reason outside the allowlist (#90)', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      await rejectsWith(
        tx
          .update(brokerAccounts)
          .set({ tradingHalted: true, haltedReason: 'bogus' as never })
          .where(eq(brokerAccounts.id, seed.accountId)),
        '23514',
        'broker_accounts_halted_reason_check',
      );
    });
  });

  it('rejects a halt without a reason and a reason without a halt (#90)', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      await rejectsWith(
        tx
          .update(brokerAccounts)
          .set({ tradingHalted: true })
          .where(eq(brokerAccounts.id, seed.accountId)),
        '23514',
        'broker_accounts_halt_reason_pair_check',
      );
    });
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      await rejectsWith(
        tx
          .update(brokerAccounts)
          .set({ haltedReason: 'trade_mismatch' })
          .where(eq(brokerAccounts.id, seed.accountId)),
        '23514',
        'broker_accounts_halt_reason_pair_check',
      );
    });
  });

  it('accepts a halt with its reason and lifts both together (#90)', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const halt = (tradingHalted: boolean, haltedReason: AccountHaltReason | null) =>
        tx
          .update(brokerAccounts)
          .set({ tradingHalted, haltedReason })
          .where(eq(brokerAccounts.id, seed.accountId));
      for (const reason of Object.values(AccountHaltReason)) await halt(true, reason);
      await halt(false, null);
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

describe.each([
  ['demo_stake', 'demoStake', 'users_demo_stake_check'],
  ['real_stake', 'realStake', 'users_real_stake_check'],
] as const)('users.%s (#297, #326)', (_column, field, constraint) => {
  it.each([['0'], ['-1'], ['NaN'], ['0.000000001']])('rejects %s', async (value) => {
    await rolledBack(async (tx) => {
      await rejectsWith(
        tx.insert(users).values({ telegramUserId: 990_101n, [field]: value as DecimalString }),
        '23514',
        constraint,
      );
    });
  });

  it.each([[null], ['0.00000001'], ['999999999999.99999999']])('accepts %s', async (value) => {
    await rolledBack(async (tx) => {
      const [row] = await tx
        .insert(users)
        .values({ telegramUserId: 990_102n, [field]: value as DecimalString | null })
        .returning({ stake: users[field] });
      expect(row?.stake ?? null).toBe(value === null ? null : value);
    });
  });

  it('defaults to NULL, the broker minimum', async () => {
    await rolledBack(async (tx) => {
      const [row] = await tx
        .insert(users)
        .values({ telegramUserId: 990_103n })
        .returning({ stake: users[field] });
      expect(row?.stake).toBeNull();
    });
  });
});

// #484: the last analysis is one fact, all three columns or none
describe('users.last_analysis_* (#484)', () => {
  const at = sql`now()`;
  it.each([
    ['a time alone', { lastAnalysisAt: at }],
    ['a time and a duration', { lastAnalysisAt: at, lastAnalysisDurationSec: 15 }],
    ['a pair and a duration alone', { lastAnalysisAssetId: 101, lastAnalysisDurationSec: 15 }],
    ['pair 0', { lastAnalysisAt: at, lastAnalysisAssetId: 0, lastAnalysisDurationSec: 15 }],
    ['duration 0', { lastAnalysisAt: at, lastAnalysisAssetId: 101, lastAnalysisDurationSec: 0 }],
  ] as const)('rejects %s', async (_, values) => {
    await rolledBack(async (tx) => {
      await rejectsWith(
        tx.insert(users).values({ telegramUserId: 990_201n, ...values }),
        '23514',
        'users_last_analysis_check',
      );
    });
  });

  it.each([
    ['none', {}],
    ['all three', { lastAnalysisAt: at, lastAnalysisAssetId: 101, lastAnalysisDurationSec: 15 }],
    [
      'the int4 bounds',
      { lastAnalysisAt: at, lastAnalysisAssetId: 2_147_483_647, lastAnalysisDurationSec: 3600 },
    ],
  ] as const)('accepts %s', async (_, values) => {
    await rolledBack(async (tx) => {
      const [row] = await tx
        .insert(users)
        .values({ telegramUserId: 990_202n, ...values })
        .returning({ id: users.id });
      expect(row).toBeDefined();
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
        .values({
          userId: seed.userId,
          kind: 'bonus',
          balanceDelta: 100n,
          depositEventId: deposit,
          ...(await bonusRuleRef(tx, 'deposit_bonus')),
        })
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
      const rule = kind === 'bonus' ? await bonusRuleRef(tx, 'deposit_bonus') : {};
      const row = {
        userId: seed.userId,
        kind,
        balanceDelta: delta,
        depositEventId: deposit,
        ...rule,
      };
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
      { kind: 'adjustment' as const, balanceDelta: 10n, note: 'n', useDeposit: true },
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

  // The starter pack (#10): a bonus that names the broker account it was earned by.
  it.each([
    ['a reserve', { kind: 'reserve' as const, reservedDelta: 1n }, 'intent'],
    ['a purchase', { kind: 'purchase' as const, balanceDelta: 10n }, 'deposit'],
    ['an adjustment', { kind: 'adjustment' as const, balanceDelta: 10n, note: 'n' }, 'none'],
    ['a bonus that also names a deposit', { kind: 'bonus' as const, balanceDelta: 10n }, 'deposit'],
  ])('rejects %s carrying a broker account reference', async (_label, values, other) => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const reference =
        other === 'intent'
          ? {
              intentId: (await tx.insert(tradeIntents).values(intent(seed, 'r1')).returning())[0]!
                .id,
            }
          : other === 'deposit'
            ? { depositEventId: await seedDeposit(tx, seed) }
            : {};
      // a bonus names a valid rule, so token_ledger_bonus_rule_check (which runs first, by name)
      // passes and the reference check is the one that refuses
      const rule = values.kind === 'bonus' ? await bonusRuleRef(tx, 'link_bonus') : {};
      await rejectsWith(
        tx.insert(tokenLedger).values({
          userId: seed.userId,
          brokerAccountId: seed.accountId,
          ...reference,
          ...values,
          ...rule,
        }),
        '23514',
        'token_ledger_reference_check',
      );
    });
  });

  it.each([
    ['a dangling broker account', () => randomUUID()],
    ['another user’s broker account', (other: { accountId: string }) => other.accountId],
  ])('rejects a starter pack naming %s', async (_label, accountOf) => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const other = await seedAccount(tx);
      await rejectsWith(
        tx.insert(tokenLedger).values({
          userId: seed.userId,
          kind: 'bonus',
          balanceDelta: 10n,
          brokerAccountId: accountOf(other),
          ...(await bonusRuleRef(tx, 'link_bonus')),
        }),
        '23503',
        'token_ledger_account_owner_fk',
      );
    });
  });

  it('pays one starter pack per user, across accounts, beside any deposit bonus', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const [second] = await tx
        .insert(brokerAccounts)
        .values({
          userId: seed.userId,
          brokerUserId: `broker-${++seq}`,
          accessTokenEnc: Buffer.from('enc'),
          refreshTokenEnc: Buffer.from('enc'),
          tokenKeyId: 'k1',
          accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
        })
        .returning({ id: brokerAccounts.id });
      const link = await bonusRuleRef(tx, 'link_bonus');
      const pack = { userId: seed.userId, kind: 'bonus' as const, balanceDelta: 10n, ...link };
      await tx.insert(tokenLedger).values({ ...pack, brokerAccountId: seed.accountId });
      await tx.insert(tokenLedger).values({
        ...pack,
        ...(await bonusRuleRef(tx, 'deposit_bonus')),
        depositEventId: await seedDeposit(tx, seed),
      });
      await rejectsWith(
        tx.insert(tokenLedger).values({ ...pack, brokerAccountId: second!.id }),
        '23505',
        'token_ledger_link_bonus_user_idx',
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
        .values({ userId: seed.userId, kind: 'adjustment', balanceDelta: 10n, note: 'n' })
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
      await tx.execute(
        sql`insert into audit_log (actor_type, action) values ('system', 'staff_logout')`,
      );
      await rejectsAsAppendOnly(
        tx.execute(
          sql`update audit_log set action = 'staff_login_completed' where action = 'staff_logout'`,
        ),
        'audit_log',
        'append_only',
      );
    });
  });
});

// The reason is mandatory for a manual adjustment and bounded in code points (#246); other kinds
// keep a free, optional note.
describe('token_ledger_adjustment_note_check (#246)', () => {
  it.each([
    ['no note', null],
    ['an empty note', ''],
    ['a note of 513 characters', 'ж'.repeat(513)],
  ])('rejects an adjustment with %s', async (_label, note) => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      await rejectsWith(
        tx
          .insert(tokenLedger)
          .values({ userId: seed.userId, kind: 'adjustment', balanceDelta: 1n, note }),
        '23514',
        'token_ledger_adjustment_note_check',
      );
    });
  });

  // a blank note passes here: refusing it is the writer's checkTokenNote, which is stricter
  it.each([
    ['one character', 'x'],
    ['512 two-byte characters', 'ж'.repeat(512)],
    ['a blank note', ' '],
  ])('accepts an adjustment with %s', async (_label, note) => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      await tx
        .insert(tokenLedger)
        .values({ userId: seed.userId, kind: 'adjustment', balanceDelta: 1n, note });
    });
  });

  it('leaves the note of every other kind optional', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      await tx.insert(tokenLedger).values({
        userId: seed.userId,
        kind: 'bonus',
        balanceDelta: 1n,
        brokerAccountId: seed.accountId,
        ...(await bonusRuleRef(tx, 'link_bonus')),
      });
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
        .set({ status: 'settled', version: sql`${tradeIntents.version} + 1`, tokensReserved: 0n })
        .where(eq(tradeIntents.id, parked!.id));
      const [next] = await tx.insert(tradeIntents).values(intent(seed, 'r2')).returning();
      expect(next!.status).toBe('planned');
    });
  });
});

// #17: the graph and the version bump at the database (0014), the reserve rule as a CHECK (0013)
describe('trade_intents state machine', () => {
  const STATUSES = Object.values(TradeIntentStatus);

  it.each([
    ['rejected', 1n],
    ['settled', 1n],
    ['planned', 0n],
    ['manual_review', 0n],
  ])('refuses a %s intent with reserve %s', async (status, tokensReserved) => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      await rejectsWith(
        tx.insert(tradeIntents).values(intent(seed, 'r1', { status, tokensReserved })),
        '23514',
        'trade_intents_terminal_reserve_check',
      );
    });
  });

  it.each([
    ['planned', 1n],
    ['queued', 1n],
    ['unknown', 1n],
    ['manual_review', 1n],
    ['settled', 0n],
    ['rejected', 0n],
  ])('accepts a %s intent with reserve %s', async (status, tokensReserved) => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const [row] = await tx
        .insert(tradeIntents)
        .values(intent(seed, 'r1', { status, tokensReserved }))
        .returning();
      expect(row).toMatchObject({ status, tokensReserved });
    });
  });

  // the single-source check for the trigger's hand copy of TRADE_INTENT_TRANSITIONS: every
  // target is tried in its own savepoint, so one source row serves all nine
  it.each(STATUSES)('lets %s move exactly along the shared graph', async (from) => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const [row] = await tx
        .insert(tradeIntents)
        .values(intent(seed, 'r1', { status: from }))
        .returning({ id: tradeIntents.id });
      const actual: [string, boolean][] = [];
      for (const to of STATUSES.filter((status) => status !== from)) {
        const outcome = await tx
          .transaction(async (sp) => {
            await sp
              .update(tradeIntents)
              .set({
                status: to,
                version: sql`${tradeIntents.version} + 1`,
                tokensReserved: reserveFor(to),
              })
              .where(eq(tradeIntents.id, row!.id));
            sp.rollback();
          })
          .then(
            () => 'committed' as const,
            (error: unknown) => error,
          );
        if (outcome instanceof TransactionRollbackError) {
          actual.push([to, true]);
        } else {
          expect(caught(outcome)).toMatchObject({
            code: 'P0001',
            constraint: 'trade_intents_transition_guard',
          });
          actual.push([to, false]);
        }
      }
      observed.add('trade_intents_transition_guard');
      const expected = STATUSES.filter((status) => status !== from).map((to) => [
        to,
        canTransition(from, to),
      ]);
      expect(actual).toEqual(expected);
    });
  });

  it.each([
    ['leaves the version as it is', sql`${tradeIntents.version}`],
    ['moves the version by two', sql`${tradeIntents.version} + 2`],
  ])('refuses a status change that %s', async (_label, version) => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const [row] = await tx
        .insert(tradeIntents)
        .values(intent(seed, 'r1', { status: 'queued' }))
        .returning({ id: tradeIntents.id });
      await rejectsWith(
        tx
          .update(tradeIntents)
          .set({ status: 'submitting', version })
          .where(eq(tradeIntents.id, row!.id)),
        'P0001',
        'trade_intents_transition_guard',
      );
    });
  });

  it('lets an UPDATE that keeps the status or touches another column through', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const [row] = await tx
        .insert(tradeIntents)
        .values(intent(seed, 'r1', { status: 'submitting' }))
        .returning({ id: tradeIntents.id });
      await tx
        .update(tradeIntents)
        .set({ status: 'submitting' })
        .where(eq(tradeIntents.id, row!.id));
      const [after] = await tx
        .update(tradeIntents)
        .set({ lastError: 'stale_submitting' })
        .where(eq(tradeIntents.id, row!.id))
        .returning();
      expect(after).toMatchObject({ status: 'submitting', version: 1 });
    });
  });
});

describe('deposit_events', () => {
  it('accepts a deposit attributed to the account of its own trader', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      await seedDeposit(tx, seed);
    });
  });

  // #141: the account named must be the one whose broker_user_id the postback carried
  it('rejects a deposit naming the account of another trader', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      await rejectsWith(
        tx.insert(depositEvents).values({
          ...depositShape(),
          userId: seed.userId,
          brokerAccountId: seed.accountId,
        }),
        '23503',
        'deposit_events_account_trader_fk',
      );
    });
  });

  it('rejects a deposit whose account belongs to another user', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const other = await seedAccount(tx);
      await rejectsWith(
        tx.insert(depositEvents).values({
          ...depositShape(),
          brokerUserId: seed.brokerUserId,
          userId: other.userId,
          brokerAccountId: seed.accountId,
        }),
        '23503',
        'deposit_events_account_owner_fk',
      );
    });
  });

  it.each([
    ['a negative amount', '-500.00'],
    ['a zero amount', '0'],
    ['a NaN amount', 'NaN'],
  ])('rejects %s', async (_label, amount) => {
    await rolledBack(async (tx) => {
      await rejectsWith(
        tx.insert(depositEvents).values({ ...depositShape(), amount: amount as DecimalString }),
        '23514',
        'deposit_events_amount_check',
      );
    });
  });

  it.each([
    ['amount', { amount: null }],
    ['payment_id', { paymentId: null }],
    ['broker_user_id', { brokerUserId: null }],
    ['source', { source: null }],
  ])('rejects a NULL %s', async (column, patch) => {
    await rolledBack(async (tx) => {
      const error = await tx
        .insert(depositEvents)
        .values({ ...depositShape(), ...(patch as object) })
        .then(
          () => undefined,
          (thrown: unknown) => thrown,
        );
      expect(caught(error)).toMatchObject({ code: '23502', column });
    });
  });

  it('rejects an unknown source', async () => {
    await rolledBack(async (tx) => {
      await rejectsWith(
        tx.insert(depositEvents).values({ ...depositShape(), source: 'other' as never }),
        '23514',
        'deposit_events_source_check',
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
          ...depositShape(),
          userId: seed.userId,
          status: 'credited',
        }),
        '23514',
        'deposit_events_owner_pair_check',
      );
    });
  });

  it.each([
    ['an unattributed postback', false],
    ['an account without a user yet', true],
  ])('accepts %s', async (_label, withAccount) => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const [row] = await tx
        .insert(depositEvents)
        .values({
          ...depositShape(),
          ...(withAccount
            ? { brokerAccountId: seed.accountId, brokerUserId: seed.brokerUserId }
            : {}),
        })
        .returning();
      expect(row!.status).toBe('received');
    });
  });

  it('keeps one deposit per payment of a source, whatever the trader', async () => {
    await rolledBack(async (tx) => {
      const first = depositShape();
      await tx.insert(depositEvents).values(first);
      const inserted = await tx
        .insert(depositEvents)
        .values({ ...depositShape(), paymentId: first.paymentId })
        .onConflictDoNothing()
        .returning({ id: depositEvents.id });
      expect(inserted).toEqual([]);
      await rejectsWith(
        tx.insert(depositEvents).values({ ...depositShape(), paymentId: first.paymentId }),
        '23505',
        'deposit_events_source_payment_idx',
      );
    });
  });
});

// --- Postback deliveries (#141) ----------------------------------------------------------------

describe('postback_deliveries', () => {
  type DeliveryPatch = Partial<typeof postbackDeliveries.$inferInsert>;
  const recorded = (depositEventId: string, patch: DeliveryPatch = {}) => ({
    source: 'binodex' as const,
    postbackId: `pb-${++seq}`,
    event: 'deposit' as const,
    outcome: 'recorded' as const,
    depositEventId,
    payload: { id: 'x' },
    ...patch,
  });
  const rejected = (patch: DeliveryPatch = {}) => ({
    source: 'binodex' as const,
    outcome: 'rejected' as const,
    rejectReason: 'missing_postback_id' as const,
    payload: {},
    ...patch,
  });
  const unattributedDeposit = async (tx: Tx) => {
    const [row] = await tx
      .insert(depositEvents)
      .values(depositShape())
      .returning({ id: depositEvents.id });
    return row!.id;
  };

  it('keeps one recorded delivery per postback id', async () => {
    await rolledBack(async (tx) => {
      const deposit = await unattributedDeposit(tx);
      const first = recorded(deposit);
      await tx.insert(postbackDeliveries).values(first);
      await rejectsWith(
        tx
          .insert(postbackDeliveries)
          .values(recorded(deposit, { postbackId: first.postbackId, outcome: 'repeated' })),
        '23505',
        'postback_deliveries_source_postback_idx',
      );
    });
  });

  it('lets a rejected delivery take no slot, so a corrected re-send of its id is recorded', async () => {
    await rolledBack(async (tx) => {
      const deposit = await unattributedDeposit(tx);
      await tx.insert(postbackDeliveries).values(rejected());
      const id = { postbackId: `pb-${++seq}`, rejectReason: 'invalid_amount' as const };
      await tx.insert(postbackDeliveries).values(rejected({ ...id, event: 'ftd' }));
      await tx.insert(postbackDeliveries).values(rejected({ ...id, event: 'ftd' }));
      await tx.insert(postbackDeliveries).values(recorded(deposit, { postbackId: id.postbackId }));
      await tx
        .insert(postbackDeliveries)
        .values(rejected({ postbackId: id.postbackId, rejectReason: 'unknown_event' }));
    });
  });

  it.each<[string, (deposit: string) => object]>([
    ['recorded without a deposit', (d) => recorded(d, { depositEventId: null })],
    ['recorded with a reason', (d) => recorded(d, { rejectReason: 'invalid_amount' })],
    ['recorded without a postback id', (d) => recorded(d, { postbackId: null })],
    ['repeated without an event', (d) => recorded(d, { outcome: 'repeated', event: null })],
    ['rejected with a deposit', (d) => rejected({ depositEventId: d })],
    ['rejected without a reason', () => rejected({ rejectReason: null })],
  ])('rejects a row %s', async (_label, row) => {
    await rolledBack(async (tx) => {
      const deposit = await unattributedDeposit(tx);
      await rejectsWith(
        tx.insert(postbackDeliveries).values(row(deposit) as never),
        '23514',
        'postback_deliveries_outcome_shape_check',
      );
    });
  });

  it.each([
    ['postback_deliveries_source_check', { source: 'other' }],
    ['postback_deliveries_event_check', { event: 'withdrawal' }],
    ['postback_deliveries_outcome_check', { outcome: 'duplicate' }],
    ['postback_deliveries_reject_reason_check', { rejectReason: 'bogus' }],
  ])('enforces %s', async (constraint, patch) => {
    await rolledBack(async (tx) => {
      await rejectsWith(
        tx.insert(postbackDeliveries).values(rejected(patch as never)),
        '23514',
        constraint,
      );
    });
  });

  it('rejects a NULL outcome', async () => {
    await rolledBack(async (tx) => {
      const error = await tx
        .insert(postbackDeliveries)
        .values(rejected({ outcome: null as never }))
        .then(
          () => undefined,
          (thrown: unknown) => thrown,
        );
      expect(caught(error)).toMatchObject({ code: '23502', column: 'outcome' });
    });
  });

  it('keeps a deposit a delivery references', async () => {
    await rolledBack(async (tx) => {
      const deposit = await unattributedDeposit(tx);
      await tx.insert(postbackDeliveries).values(recorded(deposit));
      await rejectsWith(
        tx.delete(depositEvents).where(eq(depositEvents.id, deposit)),
        // ON DELETE RESTRICT answers restrict_violation, not 23503
        '23001',
        'postback_deliveries_deposit_event_id_deposit_events_id_fk',
      );
    });
  });
});

// The trade log's decision rows (#666, docs/trade-log.md): every CHECK on the rows its writers
// build and on the boundary and NULL rows next to them (the architect's probe corpus).
describe('signal_decisions (#666)', () => {
  async function seedSession(tx: Tx) {
    const seed = await seedAccount(tx);
    const [session] = await tx
      .insert(tradingSessions)
      .values({ brokerAccountId: seed.accountId, mode: 'demo' })
      .returning({ id: tradingSessions.id });
    return { ...seed, sessionId: session!.id };
  }
  const decisionRow = (
    seed: { accountId: string; sessionId: string },
    patch: Record<string, unknown> = {},
  ) =>
    ({
      context: 'session',
      tradingSessionId: seed.sessionId,
      brokerAccountId: seed.accountId,
      step: 1,
      assetId: 101,
      interval: '15s',
      version: 'v2',
      decidedAtMs: 1_760_000_000_000,
      takenAtMs: 1_760_000_000_050,
      kind: 'signal',
      action: 'up',
      payout: 92,
      digits: 5,
      params: { emaFast: 9 },
      decision: { kind: 'signal' },
      source: { kind: 'socket' },
      series: [[1_760_000_000_000, 1.1, 1.2, 1.0, 1.15]],
      lastTick: { price: 1.15, timestamp: 1_760_000_000_010, receivedAtMs: 1_760_000_000_020 },
      outcome: 'intent',
      detail: null,
      ...patch,
    }) as typeof signalDecisions.$inferInsert;

  it.each<[string, Record<string, unknown>]>([
    ['a session decision with its intent', {}],
    [
      'a no_signal hold without a tick, a payout or digits',
      {
        kind: 'no_signal',
        action: null,
        outcome: 'no_signal',
        lastTick: null,
        payout: null,
        digits: null,
      },
    ],
    [
      'a start without a session (no_signal)',
      {
        context: 'session_start',
        tradingSessionId: null,
        step: null,
        kind: 'no_signal',
        action: null,
        outcome: 'no_signal',
      },
    ],
    ['a start with its session', { context: 'session_start', step: null, outcome: 'started' }],
    [
      'a shadow row of a tick-based version without interval, account or session',
      {
        context: 'shadow',
        tradingSessionId: null,
        brokerAccountId: null,
        step: null,
        interval: null,
        version: 'h1',
        outcome: 'shadow',
        result: { won: true },
        ticksUntilMs: 1_760_000_007_000,
      },
    ],
    [
      'a shadow row whose tick window ends a millisecond after its decision (#669)',
      {
        context: 'shadow',
        tradingSessionId: null,
        brokerAccountId: null,
        step: null,
        interval: null,
        version: 'h1',
        outcome: 'shadow',
        ticksUntilMs: 1_760_000_000_001,
      },
    ],
    ['a session decision with a tick window end (#669)', { ticksUntilMs: 1_760_000_007_000 }],
    ['a refusal with its code', { outcome: 'refused', detail: 'client_request_id_conflict' }],
    ['a stake stop with its code', { outcome: 'stake_stop', detail: 'max_session_loss' }],
    ['a zero payout and the digits bounds', { payout: 0, digits: 10 }],
  ])('accepts %s', async (_label, patch) => {
    await rolledBack(async (tx) => {
      const seed = await seedSession(tx);
      const [row] = await tx
        .insert(signalDecisions)
        .values(decisionRow(seed, patch))
        .returning({ id: signalDecisions.id });
      expect(row!.id).toBeDefined();
    });
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['an unknown context', { context: 'bot' }, 'signal_decisions_context_check'],
    [
      'a session decision without its session',
      { tradingSessionId: null },
      'signal_decisions_session_pair_check',
    ],
    [
      'a start without its session',
      { context: 'session_start', tradingSessionId: null, step: null, outcome: 'started' },
      'signal_decisions_session_pair_check',
    ],
    [
      'a session decision without its account',
      { brokerAccountId: null },
      'signal_decisions_account_pair_check',
    ],
    [
      'a start without its account',
      { context: 'session_start', tradingSessionId: null, brokerAccountId: null, step: null },
      'signal_decisions_account_pair_check',
    ],
    ['a zero step', { step: 0 }, 'signal_decisions_step_check'],
    ['a session decision without a step', { step: null }, 'signal_decisions_step_pair_check'],
    [
      'a start with a step',
      { context: 'session_start', outcome: 'started' },
      'signal_decisions_step_pair_check',
    ],
    ['a zero asset id', { assetId: 0 }, 'signal_decisions_asset_id_check'],
    ['an unknown interval', { interval: '2m' }, 'signal_decisions_interval_check'],
    ['an upper-case version', { version: 'V2' }, 'signal_decisions_version_check'],
    ['a 17-character version', { version: 'v'.repeat(17) }, 'signal_decisions_version_check'],
    ['an empty version', { version: '' }, 'signal_decisions_version_check'],
    ['a zero decision time', { decidedAtMs: 0 }, 'signal_decisions_decided_at_ms_check'],
    ['a zero taking time', { takenAtMs: 0 }, 'signal_decisions_taken_at_ms_check'],
    ['an unknown kind', { kind: 'maybe', action: null }, 'signal_decisions_kind_check'],
    ['an unknown action', { action: 'sideways' }, 'signal_decisions_action_check'],
    ['a signal without its action', { action: null }, 'signal_decisions_action_pair_check'],
    [
      'a no_signal with an action',
      { kind: 'no_signal', outcome: 'no_signal' },
      'signal_decisions_action_pair_check',
    ],
    ['a negative payout', { payout: -1 }, 'signal_decisions_payout_check'],
    ['a NaN payout', { payout: Number.NaN }, 'signal_decisions_payout_check'],
    ['digits above MAX_PAIR_DIGITS', { digits: 11 }, 'signal_decisions_digits_check'],
    ['negative digits', { digits: -1 }, 'signal_decisions_digits_check'],
    ['params as an array', { params: [] }, 'signal_decisions_params_check'],
    ['a decision as a string', { decision: 'up' }, 'signal_decisions_decision_check'],
    ['a source as a number', { source: 1 }, 'signal_decisions_source_check'],
    ['a series as an object', { series: {} }, 'signal_decisions_series_check'],
    ['a last tick as an array', { lastTick: [] }, 'signal_decisions_last_tick_check'],
    ['a result as an array', { result: [] }, 'signal_decisions_result_check'],
    ['an unknown outcome', { outcome: 'won' }, 'signal_decisions_outcome_check'],
    [
      'a signal recorded as no_signal',
      { outcome: 'no_signal' },
      'signal_decisions_outcome_kind_check',
    ],
    [
      'a no_signal decision with an intent',
      { kind: 'no_signal', action: null },
      'signal_decisions_outcome_kind_check',
    ],
    [
      'a detail outside the pattern',
      { outcome: 'refused', detail: 'Bad-Code' },
      'signal_decisions_detail_check',
    ],
    [
      'a 65-character detail',
      { outcome: 'refused', detail: 'x'.repeat(65) },
      'signal_decisions_detail_check',
    ],
    ['a refusal without its code', { outcome: 'refused' }, 'signal_decisions_detail_pair_check'],
    [
      'a stake stop without its code',
      { outcome: 'stake_stop' },
      'signal_decisions_detail_pair_check',
    ],
    ['an intent with a detail', { detail: 'trading_paused' }, 'signal_decisions_detail_pair_check'],
    [
      'a pause with the stop reason as its detail',
      { outcome: 'paused', detail: 'no_signal_timeout' },
      'signal_decisions_detail_pair_check',
    ],
    [
      'a shadow row without its tick window end (#669)',
      {
        context: 'shadow',
        tradingSessionId: null,
        brokerAccountId: null,
        step: null,
        interval: null,
        version: 'h1',
        outcome: 'shadow',
      },
      'signal_decisions_ticks_until_pair_check',
    ],
    [
      'a shadow row whose tick window ends at its decision (#669)',
      {
        context: 'shadow',
        tradingSessionId: null,
        brokerAccountId: null,
        step: null,
        interval: null,
        version: 'h1',
        outcome: 'shadow',
        ticksUntilMs: 1_760_000_000_000,
      },
      'signal_decisions_ticks_until_check',
    ],
    [
      'a session decision whose tick window ends before it (#669)',
      { ticksUntilMs: 1_759_999_999_999 },
      'signal_decisions_ticks_until_check',
    ],
  ])('rejects %s', async (_label, patch, constraint) => {
    await rolledBack(async (tx) => {
      const seed = await seedSession(tx);
      await rejectsWith(
        tx.insert(signalDecisions).values(decisionRow(seed, patch)),
        '23514',
        constraint,
      );
    });
  });

  it("rejects a session decision naming another account than its session's", async () => {
    await rolledBack(async (tx) => {
      const seed = await seedSession(tx);
      const other = await seedAccount(tx);
      await rejectsWith(
        tx.insert(signalDecisions).values(decisionRow({ ...seed, accountId: other.accountId })),
        '23503',
        'signal_decisions_session_account_fk',
      );
    });
  });

  it("rejects an intent naming another session's decision, and a second intent of one decision", async () => {
    await rolledBack(async (tx) => {
      const seed = await seedSession(tx);
      const [decision] = await tx
        .insert(signalDecisions)
        .values(decisionRow(seed))
        .returning({ id: signalDecisions.id });
      const [otherSession] = await tx
        .insert(tradingSessions)
        .values({
          brokerAccountId: seed.accountId,
          mode: 'demo',
          status: 'stopped',
          stopReason: 'completed',
          endedAt: new Date(),
        })
        .returning({ id: tradingSessions.id });
      await tx.execute(sql`savepoint other_session`);
      await rejectsWith(
        tx.insert(tradeIntents).values(
          intent(seed, 'd1', {
            tradingSessionId: otherSession!.id,
            signalDecisionId: decision!.id,
          }),
        ),
        '23503',
        'trade_intents_decision_session_fk',
      );
      await tx.execute(sql`rollback to savepoint other_session`);
      await tx.insert(tradeIntents).values(
        intent(seed, 'd2', {
          tradingSessionId: seed.sessionId,
          signalDecisionId: decision!.id,
          status: 'settled',
        }),
      );
      await rejectsWith(
        tx.insert(tradeIntents).values(
          intent(seed, 'd3', {
            tradingSessionId: seed.sessionId,
            signalDecisionId: decision!.id,
          }),
        ),
        '23505',
        'trade_intents_decision_key',
      );
    });
  });

  // the composite FK is MATCH SIMPLE and skips a row whose session is NULL: the CHECK alone refuses it
  it('rejects an intent naming a decision without a session', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedSession(tx);
      const [decision] = await tx
        .insert(signalDecisions)
        .values(decisionRow(seed))
        .returning({ id: signalDecisions.id });
      await rejectsWith(
        tx
          .insert(tradeIntents)
          .values(intent(seed, 'd4', { tradingSessionId: null, signalDecisionId: decision!.id })),
        '23514',
        'trade_intents_decision_session_check',
      );
    });
  });

  describe('decision_ticks (#668)', () => {
    const ticksRow = (decisionId: string, patch: Record<string, unknown> = {}) =>
      ({
        decisionId,
        fromMs: 1_759_999_940_000,
        untilMs: 1_760_000_020_000,
        status: 'complete',
        detail: null,
        count: 2,
        ticks: [
          [1_759_999_950_000, 1_759_999_950_100, 1.1],
          [1_760_000_010_000, 1_760_000_010_100, 1.2],
        ],
        ...patch,
      }) as typeof decisionTicks.$inferInsert;
    async function seedDecision(tx: Tx) {
      const seed = await seedSession(tx);
      const [decision] = await tx
        .insert(signalDecisions)
        .values(decisionRow(seed))
        .returning({ id: signalDecisions.id });
      return decision!.id;
    }

    it.each<[string, Record<string, unknown>]>([
      ['a complete window with two ticks', {}],
      [
        'a truncated window with one tick',
        { status: 'truncated', detail: 'hole', count: 1, ticks: [[1_759_999_950_000, 1, 1.1]] },
      ],
      [
        'an unavailable empty window whose end is its start',
        {
          status: 'unavailable',
          detail: 'quiet',
          count: 0,
          ticks: [],
          untilMs: 1_759_999_940_000,
        },
      ],
    ])('accepts %s', async (_label, patch) => {
      await rolledBack(async (tx) => {
        const decisionId = await seedDecision(tx);
        await tx.insert(decisionTicks).values(ticksRow(decisionId, patch));
        const [row] = await tx
          .select({ capturedAt: decisionTicks.capturedAt })
          .from(decisionTicks)
          .where(eq(decisionTicks.decisionId, decisionId));
        expect(row?.capturedAt).toBeInstanceOf(Date);
      });
    });

    it.each<[string, Record<string, unknown>, string]>([
      ['a window starting at 0', { fromMs: 0, untilMs: 1 }, 'decision_ticks_from_ms_check'],
      ['a window ending before it starts', { untilMs: 1 }, 'decision_ticks_window_check'],
      ['an unknown status', { status: 'partial', detail: 'hole' }, 'decision_ticks_status_check'],
      [
        'an unknown detail',
        { status: 'truncated', detail: 'restart' },
        'decision_ticks_detail_check',
      ],
      ['a complete window with a detail', { detail: 'hole' }, 'decision_ticks_detail_pair_check'],
      ['a truncated window without one', { status: 'truncated' }, 'decision_ticks_detail_pair_check'],
      [
        'a negative count',
        { status: 'truncated', detail: 'hole', count: -1 },
        'decision_ticks_count_check',
      ],
      [
        'an unavailable window with a tick',
        { status: 'unavailable', detail: 'quiet', count: 1, ticks: [[1, 1, 1.1]] },
        'decision_ticks_count_pair_check',
      ],
      [
        'a complete window without ticks',
        { count: 0, ticks: [] },
        'decision_ticks_count_pair_check',
      ],
      ['ticks as an object', { ticks: { a: 1 } }, 'decision_ticks_ticks_check'],
      ['ticks of another length than count', { count: 3 }, 'decision_ticks_ticks_check'],
    ])('rejects %s', async (_label, patch, constraint) => {
      await rolledBack(async (tx) => {
        const decisionId = await seedDecision(tx);
        await rejectsWith(
          tx.insert(decisionTicks).values(ticksRow(decisionId, patch)),
          '23514',
          constraint,
        );
      });
    });

    it('rejects a second row for a decision', async () => {
      await rolledBack(async (tx) => {
        const decisionId = await seedDecision(tx);
        await tx.insert(decisionTicks).values(ticksRow(decisionId));
        await rejectsWith(
          tx.insert(decisionTicks).values(ticksRow(decisionId)),
          '23505',
          'decision_ticks_pkey',
        );
      });
    });

    it('keeps the decision while its ticks row exists', async () => {
      await rolledBack(async (tx) => {
        const decisionId = await seedDecision(tx);
        await tx.insert(decisionTicks).values(ticksRow(decisionId));
        await rejectsWith(
          tx.delete(signalDecisions).where(eq(signalDecisions.id, decisionId)),
          '23001',
          'decision_ticks_decision_id_signal_decisions_id_fk',
        );
      });
    });

    it('has the partial index of the shadow retention band', async () => {
      const { rows } = await pool.query<{ indexdef: string }>(
        `select indexdef from pg_indexes where indexname = 'signal_decisions_shadow_recorded_idx'`,
      );
      expect(rows[0]?.indexdef).toMatch(/\(recorded_at\) WHERE \(context = 'shadow'::text\)$/);
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
      'postback_deliveries_deposit_event_id_deposit_events_id_fk',
      (tx) =>
        tx.execute(
          sql`insert into postback_deliveries (source, postback_id, event, outcome, deposit_event_id, payload) values ('binodex', ${`pb-fk-${++seq}`}, 'deposit', 'recorded', ${dangling}, '{}'::jsonb)`,
        ),
    ],
    [
      'notification_jobs_user_id_users_id_fk',
      (tx) =>
        tx.execute(
          sql`insert into notification_jobs (user_id, kind) values (${dangling}, 'first_session_1h')`,
        ),
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
        tx
          .insert(tokenLedger)
          .values({ userId: dangling, kind: 'adjustment', balanceDelta: 1n, note: 'n' }),
    ],
    [
      // no account: the session composite is skipped (#666)
      'signal_decisions_trading_session_id_trading_sessions_id_fk',
      (tx) =>
        tx.execute(
          sql`insert into signal_decisions (context, trading_session_id, asset_id, version, decided_at_ms, taken_at_ms, kind, action, params, decision, source, series, outcome, ticks_until_ms) values ('shadow', ${dangling}, 101, 'h1', 1, 1, 'signal', 'up', '{}', '{}', '{}', '[]', 'shadow', 2)`,
        ),
    ],
    [
      // no session: the session composite is skipped (#666)
      'signal_decisions_broker_account_id_broker_accounts_id_fk',
      (tx) =>
        tx.execute(
          sql`insert into signal_decisions (context, broker_account_id, asset_id, interval, version, decided_at_ms, taken_at_ms, kind, params, decision, source, series, outcome) values ('session_start', ${dangling}, 101, '15s', 'v2', 1, 1, 'no_signal', '{}', '{}', '{}', '[]', 'no_signal')`,
        ),
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

  // These six cannot be violated by an insert while their composite is in place: the composite
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
        // broker_user_id is NOT NULL (#141), so a dangling account id always reaches the trader
        // composite too
        name: 'deposit_events_broker_account_id_broker_accounts_id_fk',
        from: 'deposit_events(broker_account_id)',
        to: 'broker_accounts(id)',
        premises: ['deposit_events_account_trader_fk'],
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

// --- Staff authentication (#68) ---------------------------------------------------------------
// Every constraint the three new tables declare, plus the audit action list. The coverage gate
// at the end of this file will not accept one that no case here saw the database enforce.

const STAFF_HASH = '$scrypt$ln=10,r=8,p=1$c2FsdA$aGFzaA';

async function seedStaffRow(tx: Tx, patch: Record<string, unknown> = {}): Promise<string> {
  const n = ++seq;
  const [row] = await tx
    .insert(staff)
    .values({
      login: `ada-${n}`,
      passwordHash: STAFF_HASH,
      telegramUserId: BigInt(980_000 + n),
      ...patch,
    })
    .returning({ id: staff.id });
  return row!.id;
}

const challenge = (staffId: string, patch: Record<string, unknown> = {}) => ({
  staffId,
  ip: '203.0.113.7',
  userAgent: 'Mozilla/5.0',
  expiresAt: sql`now() + interval '5 minutes'`,
  ...patch,
});

const session = (staffId: string, patch: Record<string, unknown> = {}) => ({
  staffId,
  tokenHash: `token-${++seq}`,
  ip: '203.0.113.7',
  userAgent: 'Mozilla/5.0',
  expiresAt: sql`now() + interval '24 hours'`,
  ...patch,
});

describe('staff', () => {
  it.each([
    ['too short', { login: 'ab' }],
    ['too long', { login: 'a'.repeat(65) }],
    ['with a space', { login: 'ada l' }],
    ['cyrillic', { login: 'ада' }],
  ])('refuses a login %s', async (_label, patch) => {
    await rolledBack(async (tx) => {
      await rejectsWith(seedStaffRow(tx, patch), '23514', 'staff_login_check');
    });
  });

  it.each([3, 64])('accepts a login of %i characters', async (length) => {
    await rolledBack(async (tx) => {
      await expect(seedStaffRow(tx, { login: 'a'.repeat(length) })).resolves.toBeTypeOf('string');
    });
  });

  // zod and the CHECK are built from one regex, but PostgreSQL's POSIX engine and JavaScript's
  // are not the same engine, so the two verdicts are compared row by row over one corpus
  it.each(STAFF_LOGIN_CORPUS)('$label: zod and the CHECK agree (valid=$valid)', async (row) => {
    expect(staffLoginSchema.safeParse(row.value).success).toBe(row.valid);
    await rolledBack(async (tx) => {
      const insert = seedStaffRow(tx, { login: row.value });
      if (row.valid) await expect(insert).resolves.toBeTypeOf('string');
      else await rejectsWith(insert, '23514', 'staff_login_check');
    });
  });

  it('refuses a hash from another KDF', async () => {
    await rolledBack(async (tx) => {
      await rejectsWith(
        seedStaffRow(tx, { passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA' }),
        '23514',
        'staff_password_hash_check',
      );
    });
  });

  it('refuses a status outside the list', async () => {
    await rolledBack(async (tx) => {
      await rejectsWith(
        seedStaffRow(tx, { status: 'locked' as never }),
        '23514',
        'staff_status_check',
      );
    });
  });

  it('refuses a negative attempt count', async () => {
    await rolledBack(async (tx) => {
      await rejectsWith(
        seedStaffRow(tx, { failedPasswordAttempts: -1 }),
        '23514',
        'staff_failed_attempts_check',
      );
    });
  });

  // a lockout with the counter already back at zero is the shape reset-password leaves
  it('accepts a lockout alongside a zero counter', async () => {
    await rolledBack(async (tx) => {
      await expect(
        seedStaffRow(tx, { failedPasswordAttempts: 0, lockedUntil: sql`now()` }),
      ).resolves.toBeTypeOf('string');
    });
  });

  it('refuses a non-positive Telegram id', async () => {
    await rolledBack(async (tx) => {
      await rejectsWith(
        seedStaffRow(tx, { telegramUserId: 0n }),
        '23514',
        'staff_telegram_user_id_check',
      );
    });
  });

  // two rows differing only in case would be two accounts one password prompt cannot tell apart
  it('refuses a second login differing only in case', async () => {
    await rolledBack(async (tx) => {
      await seedStaffRow(tx, { login: 'Ada' });
      await rejectsWith(seedStaffRow(tx, { login: 'ada' }), '23505', 'staff_login_lower_idx');
    });
  });

  it('refuses a second row on one Telegram account', async () => {
    await rolledBack(async (tx) => {
      await seedStaffRow(tx, { telegramUserId: 991_001n });
      await rejectsWith(
        seedStaffRow(tx, { telegramUserId: 991_001n }),
        '23505',
        'staff_telegram_user_id_idx',
      );
    });
  });
});

describe('staff_login_challenges', () => {
  it('refuses a challenge for a staff member that does not exist', async () => {
    await rolledBack(async (tx) => {
      await rejectsWith(
        tx.insert(staffLoginChallenges).values(challenge(randomUUID())),
        '23503',
        'staff_login_challenges_staff_id_staff_id_fk',
      );
    });
  });

  it('refuses a status outside the list', async () => {
    await rolledBack(async (tx) => {
      const staffId = await seedStaffRow(tx);
      await rejectsWith(
        tx.insert(staffLoginChallenges).values(challenge(staffId, { status: 'open' as never })),
        '23514',
        'staff_login_challenges_status_check',
      );
    });
  });

  it('refuses a negative attempt count', async () => {
    await rolledBack(async (tx) => {
      const staffId = await seedStaffRow(tx);
      await rejectsWith(
        tx.insert(staffLoginChallenges).values(challenge(staffId, { codeAttempts: -1 })),
        '23514',
        'staff_login_challenges_code_attempts_check',
      );
    });
  });

  it('refuses a window that closes the moment it opens', async () => {
    await rolledBack(async (tx) => {
      const staffId = await seedStaffRow(tx);
      await rejectsWith(
        tx.insert(staffLoginChallenges).values(challenge(staffId, { expiresAt: sql`now()` })),
        '23514',
        'staff_login_challenges_expires_after_created_check',
      );
    });
  });

  // `denied` is used for the pair cases: the code/status CHECK lets it hold a code or not, so
  // the row violates exactly the constraint each case is about
  it('refuses a code with no moment it was issued', async () => {
    await rolledBack(async (tx) => {
      const staffId = await seedStaffRow(tx);
      await rejectsWith(
        tx
          .insert(staffLoginChallenges)
          .values(challenge(staffId, { status: 'denied', codeHash: 'h', confirmedAt: null })),
        '23514',
        'staff_login_challenges_confirmed_pair_check',
      );
    });
  });

  it('refuses a confirmation older than the challenge', async () => {
    await rolledBack(async (tx) => {
      const staffId = await seedStaffRow(tx);
      await rejectsWith(
        tx.insert(staffLoginChallenges).values(
          challenge(staffId, {
            status: 'denied',
            codeHash: 'h',
            confirmedAt: sql`now() - interval '1 second'`,
          }),
        ),
        '23514',
        'staff_login_challenges_confirmed_after_created_check',
      );
    });
  });

  it.each([
    ['pending with a code', { status: 'pending', codeHash: 'h', confirmedAt: sql`now()` }],
    ['confirmed without one', { status: 'confirmed' }],
    ['completed without one', { status: 'completed' }],
    ['exhausted without one', { status: 'exhausted' }],
  ])('refuses %s', async (_label, patch) => {
    await rolledBack(async (tx) => {
      const staffId = await seedStaffRow(tx);
      await rejectsWith(
        tx.insert(staffLoginChallenges).values(challenge(staffId, patch)),
        '23514',
        'staff_login_challenges_code_status_check',
      );
    });
  });

  it.each([
    ['denied with no code', { status: 'denied' }],
    ['expired holding a code', { status: 'expired', codeHash: 'h', confirmedAt: sql`now()` }],
    ['failed holding a code', { status: 'failed', codeHash: 'h', confirmedAt: sql`now()` }],
  ])('accepts %s', async (_label, patch) => {
    await rolledBack(async (tx) => {
      const staffId = await seedStaffRow(tx);
      await expect(
        tx.insert(staffLoginChallenges).values(challenge(staffId, patch)),
      ).resolves.toBeDefined();
    });
  });

  it('refuses an invitation delivered before the challenge existed', async () => {
    await rolledBack(async (tx) => {
      const staffId = await seedStaffRow(tx);
      await rejectsWith(
        tx
          .insert(staffLoginChallenges)
          .values(challenge(staffId, { promptSentAt: sql`now() - interval '1 second'` })),
        '23514',
        'staff_login_challenges_prompt_sent_check',
      );
    });
  });

  it('accepts an invitation delivered the moment the challenge was created', async () => {
    await rolledBack(async (tx) => {
      const staffId = await seedStaffRow(tx);
      await expect(
        tx.insert(staffLoginChallenges).values(challenge(staffId, { promptSentAt: sql`now()` })),
      ).resolves.toBeDefined();
    });
  });

  it('refuses a delivered code that does not exist', async () => {
    await rolledBack(async (tx) => {
      const staffId = await seedStaffRow(tx);
      await rejectsWith(
        tx
          .insert(staffLoginChallenges)
          .values(challenge(staffId, { status: 'denied', codeSentAt: sql`now()` })),
        '23514',
        'staff_login_challenges_code_sent_check',
      );
    });
  });

  // the window between issuing a code and Telegram taking it: this is what the second button
  // press reads
  it('accepts a code that exists but has not been delivered', async () => {
    await rolledBack(async (tx) => {
      const staffId = await seedStaffRow(tx);
      await expect(
        tx
          .insert(staffLoginChallenges)
          .values(
            challenge(staffId, { status: 'confirmed', codeHash: 'h', confirmedAt: sql`now()` }),
          ),
      ).resolves.toBeDefined();
    });
  });

  it('refuses a second open challenge for one staff member', async () => {
    await rolledBack(async (tx) => {
      const staffId = await seedStaffRow(tx);
      await tx.insert(staffLoginChallenges).values(challenge(staffId));
      await rejectsWith(
        tx
          .insert(staffLoginChallenges)
          .values(
            challenge(staffId, { status: 'confirmed', codeHash: 'h', confirmedAt: sql`now()` }),
          ),
        '23505',
        'staff_login_challenges_open_idx',
      );
    });
  });

  it('accepts a new challenge once the previous one is closed', async () => {
    await rolledBack(async (tx) => {
      const staffId = await seedStaffRow(tx);
      await tx.insert(staffLoginChallenges).values(challenge(staffId, { status: 'denied' }));
      await expect(
        tx.insert(staffLoginChallenges).values(challenge(staffId)),
      ).resolves.toBeDefined();
    });
  });
});

const loginLink = (staffId: string, patch: Record<string, unknown> = {}) => ({
  staffId,
  tokenHash: `link-${++seq}`,
  expiresAt: sql`now() + interval '5 minutes'`,
  ...patch,
});

// #448: the boundaries each CHECK draws, on the rows the plan's probe ran
describe('staff_login_links', () => {
  it('refuses a status outside the list and a missing one', async () => {
    await rolledBack(async (tx) => {
      const staffId = await seedStaffRow(tx);
      await rejectsWith(
        tx.insert(staffLoginLinks).values(loginLink(staffId, { status: 'expired' as never })),
        '23514',
        'staff_login_links_status_check',
      );
    });
    await rolledBack(async (tx) => {
      const staffId = await seedStaffRow(tx);
      const error = await tx
        .insert(staffLoginLinks)
        .values(loginLink(staffId, { status: null }))
        .then(
          () => undefined,
          (thrown: unknown) => thrown,
        );
      expect(caught(error)).toMatchObject({ code: '23502', column: 'status' });
    });
  });

  it('refuses a link that expires the moment it is created, and one with no expiry', async () => {
    await rolledBack(async (tx) => {
      const staffId = await seedStaffRow(tx);
      await rejectsWith(
        tx.insert(staffLoginLinks).values(loginLink(staffId, { expiresAt: sql`now()` })),
        '23514',
        'staff_login_links_expires_after_created_check',
      );
    });
    await rolledBack(async (tx) => {
      const staffId = await seedStaffRow(tx);
      const error = await tx
        .insert(staffLoginLinks)
        .values(loginLink(staffId, { expiresAt: null }))
        .then(
          () => undefined,
          (thrown: unknown) => thrown,
        );
      expect(caught(error)).toMatchObject({ code: '23502', column: 'expires_at' });
    });
  });

  it.each([
    ['used without the moment', { status: 'used', usedAt: null }],
    ['a moment on a link not used', { status: 'issued', usedAt: sql`now()` }],
  ])('refuses %s', async (_label, patch) => {
    await rolledBack(async (tx) => {
      const staffId = await seedStaffRow(tx);
      await rejectsWith(
        tx.insert(staffLoginLinks).values(loginLink(staffId, patch)),
        '23514',
        'staff_login_links_used_pair_check',
      );
    });
  });

  it('refuses a use before the link existed, and accepts one at that same instant', async () => {
    await rolledBack(async (tx) => {
      const staffId = await seedStaffRow(tx);
      await rejectsWith(
        tx
          .insert(staffLoginLinks)
          .values(loginLink(staffId, { status: 'used', usedAt: sql`now() - interval '1 second'` })),
        '23514',
        'staff_login_links_used_after_created_check',
      );
    });
    await rolledBack(async (tx) => {
      const staffId = await seedStaffRow(tx);
      await tx
        .insert(staffLoginLinks)
        .values(loginLink(staffId, { status: 'used', usedAt: sql`now()` }));
    });
  });

  it('holds one live link per staff member, beside any number of closed ones', async () => {
    await rolledBack(async (tx) => {
      const staffId = await seedStaffRow(tx);
      await tx.insert(staffLoginLinks).values(loginLink(staffId, { status: 'superseded' }));
      await tx.insert(staffLoginLinks).values(loginLink(staffId, { status: 'revoked' }));
      await tx.insert(staffLoginLinks).values(loginLink(staffId));
      await rejectsWith(
        tx.insert(staffLoginLinks).values(loginLink(staffId)),
        '23505',
        'staff_login_links_live_idx',
      );
    });
  });

  it('refuses a second row with the same token hash', async () => {
    await rolledBack(async (tx) => {
      const staffId = await seedStaffRow(tx);
      const other = await seedStaffRow(tx);
      await tx.insert(staffLoginLinks).values(loginLink(staffId, { tokenHash: 'same' }));
      await rejectsWith(
        tx.insert(staffLoginLinks).values(loginLink(other, { tokenHash: 'same' })),
        '23505',
        'staff_login_links_token_hash_idx',
      );
    });
  });

  it('refuses a link for a staff member that does not exist', async () => {
    await rolledBack(async (tx) => {
      await rejectsWith(
        tx.insert(staffLoginLinks).values(loginLink(randomUUID())),
        '23503',
        'staff_login_links_staff_id_staff_id_fk',
      );
    });
  });
});

describe('staff_sessions', () => {
  it('refuses a session for a staff member that does not exist', async () => {
    await rolledBack(async (tx) => {
      await rejectsWith(
        tx.insert(staffSessions).values(session(randomUUID())),
        '23503',
        'staff_sessions_staff_id_staff_id_fk',
      );
    });
  });

  it('refuses a revoker that does not exist', async () => {
    await rolledBack(async (tx) => {
      const staffId = await seedStaffRow(tx);
      await rejectsWith(
        tx
          .insert(staffSessions)
          .values(session(staffId, { revokedAt: sql`now()`, revokedByStaffId: randomUUID() })),
        '23503',
        'staff_sessions_revoked_by_staff_id_staff_id_fk',
      );
    });
  });

  it('refuses a second session on one token', async () => {
    await rolledBack(async (tx) => {
      const staffId = await seedStaffRow(tx);
      await tx.insert(staffSessions).values(session(staffId, { tokenHash: 'same' }));
      await rejectsWith(
        tx.insert(staffSessions).values(session(staffId, { tokenHash: 'same' })),
        '23505',
        'staff_sessions_token_hash_idx',
      );
    });
  });

  it('refuses a session that expires the moment it starts', async () => {
    await rolledBack(async (tx) => {
      const staffId = await seedStaffRow(tx);
      await rejectsWith(
        tx.insert(staffSessions).values(session(staffId, { expiresAt: sql`now()` })),
        '23514',
        'staff_sessions_expires_after_created_check',
      );
    });
  });

  it('refuses activity older than the session', async () => {
    await rolledBack(async (tx) => {
      const staffId = await seedStaffRow(tx);
      await rejectsWith(
        tx
          .insert(staffSessions)
          .values(session(staffId, { lastSeenAt: sql`now() - interval '1 second'` })),
        '23514',
        'staff_sessions_last_seen_after_created_check',
      );
    });
  });

  it('refuses a revocation older than the session', async () => {
    await rolledBack(async (tx) => {
      const staffId = await seedStaffRow(tx);
      await rejectsWith(
        tx
          .insert(staffSessions)
          .values(session(staffId, { revokedAt: sql`now() - interval '1 second'` })),
        '23514',
        'staff_sessions_revoked_after_created_check',
      );
    });
  });

  it('refuses a revoker with no revocation', async () => {
    await rolledBack(async (tx) => {
      const staffId = await seedStaffRow(tx);
      await rejectsWith(
        tx.insert(staffSessions).values(session(staffId, { revokedByStaffId: staffId })),
        '23514',
        'staff_sessions_revoked_by_pair_check',
      );
    });
  });

  // the CLI revokes with no staff member behind it, and a session may be revoked the instant
  // it is created (disable racing a login)
  it.each([
    ['the CLI, with no revoker', { revokedAt: sql`now()`, revokedByStaffId: null }],
    ['a revocation at the moment of creation', { revokedAt: sql`now()` }],
    ['activity at the moment of creation', { lastSeenAt: sql`now()` }],
  ])('accepts %s', async (_label, patch) => {
    await rolledBack(async (tx) => {
      const staffId = await seedStaffRow(tx);
      await expect(tx.insert(staffSessions).values(session(staffId, patch))).resolves.toBeDefined();
    });
  });
});

describe('audit_log actions', () => {
  it('refuses an action outside the list', async () => {
    await rolledBack(async (tx) => {
      await rejectsWith(
        tx.execute(
          sql`insert into audit_log (actor_type, action) values ('system', 'staff_login_maybe')`,
        ),
        '23514',
        'audit_log_action_check',
      );
    });
  });

  it('accepts every action the constant declares', async () => {
    await rolledBack(async (tx) => {
      for (const action of Object.values(AuditAction)) {
        await expect(
          tx.insert(auditLog).values({ actorType: 'system', action }),
        ).resolves.toBeDefined();
      }
    });
  });

  // The two cases above cannot see a value the migration keeps that the constant dropped (or a
  // hand-edited migration's extra one); the catalog can. Postgres prints the CHECK as
  // `action = ANY (ARRAY['staff_created'::text, …])`.
  it('the CHECK lists exactly the values the constant declares', async () => {
    const { rows } = await pool.query<{ def: string }>(
      `select pg_get_constraintdef(oid) as def from pg_constraint
         where conname = 'audit_log_action_check' and connamespace = 'public'::regnamespace`,
    );
    expect(rows).toHaveLength(1);
    const listed = [...rows[0]!.def.matchAll(/'([a-z0-9_-]+)'::text/g)].map((match) => match[1]);
    expect(listed.sort()).toEqual(Object.values(AuditAction).sort());
  });
});

// --- broker_balance_snapshots (#235) ---------------------------------------------------------
// Amounts and the level rank may be zero, never negative or NaN; NOT NULL is the column's own.

const snapshot = (accountId: string, patch: Record<string, unknown> = {}) => ({
  brokerAccountId: accountId,
  realAvailable: '100' as DecimalString,
  realHeld: '0' as DecimalString,
  realTotal: '100' as DecimalString,
  demoAvailable: '10000' as DecimalString,
  demoHeld: '0' as DecimalString,
  demoTotal: '10000' as DecimalString,
  minTradeAmount: '1' as DecimalString,
  levelCode: 'standard',
  levelRank: 1,
  restObservedAt: sql`now()`,
  ...patch,
});

const SNAPSHOT_AMOUNTS = [
  ['realAvailable', 'real_available'],
  ['realHeld', 'real_held'],
  ['realTotal', 'real_total'],
  ['demoAvailable', 'demo_available'],
  ['demoHeld', 'demo_held'],
  ['demoTotal', 'demo_total'],
  ['minTradeAmount', 'min_trade_amount'],
] as const;

const SNAPSHOT_REQUIRED = [
  ...SNAPSHOT_AMOUNTS,
  ['levelCode', 'level_code'],
  ['levelRank', 'level_rank'],
  ['restObservedAt', 'rest_observed_at'],
] as const;

describe('broker_accounts.service_since (#391)', () => {
  it('S1: is NULL by default and stores a timestamp', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const [before] = await tx
        .select({ serviceSince: brokerAccounts.serviceSince })
        .from(brokerAccounts)
        .where(eq(brokerAccounts.id, seed.accountId));
      expect(before?.serviceSince).toBeNull();
      const at = new Date('2026-10-16T08:00:00.123Z');
      const [after] = await tx
        .update(brokerAccounts)
        .set({ serviceSince: at })
        .where(eq(brokerAccounts.id, seed.accountId))
        .returning({ serviceSince: brokerAccounts.serviceSince });
      expect(after?.serviceSince).toEqual(at);
    });
  });
});

describe('broker_accounts.h1_since and trade_intents.submit_deadline_at (#670)', () => {
  it('H1-D1: h1_since is NULL by default and stores a timestamp', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const [before] = await tx
        .select({ h1Since: brokerAccounts.h1Since })
        .from(brokerAccounts)
        .where(eq(brokerAccounts.id, seed.accountId));
      expect(before?.h1Since).toBeNull();
      const at = new Date('2026-10-21T20:00:00.123Z');
      const [after] = await tx
        .update(brokerAccounts)
        .set({ h1Since: at })
        .where(eq(brokerAccounts.id, seed.accountId))
        .returning({ h1Since: brokerAccounts.h1Since });
      expect(after?.h1Since).toEqual(at);
    });
  });

  it('H1-D2: submit_deadline_at is NULL by default and takes any timestamp, before created_at too', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const [plain] = await tx.insert(tradeIntents).values(intent(seed, 'd1')).returning();
      expect(plain!.submitDeadlineAt).toBeNull();
      const past = new Date('2000-01-01T00:00:00.000Z');
      const other = await seedAccount(tx);
      const [early] = await tx
        .insert(tradeIntents)
        .values(intent(other, 'd2', { submitDeadlineAt: past }))
        .returning();
      expect(early!.submitDeadlineAt).toEqual(past);
    });
  });
});

describe('broker_balance_snapshots', () => {
  it.each(SNAPSHOT_AMOUNTS)('accepts a zero %s', async (field) => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const [row] = await tx
        .insert(brokerBalanceSnapshots)
        .values(snapshot(seed.accountId, { [field]: '0' }))
        .returning();
      expect(row![field]).toBe('0.00000000');
    });
  });

  it.each(
    SNAPSHOT_AMOUNTS.flatMap(([field, column]) => [
      [field, column, '-0.00000001'],
      [field, column, 'NaN'],
    ]),
  )('rejects %s = %s', async (field, column, value) => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      await rejectsWith(
        tx.insert(brokerBalanceSnapshots).values(snapshot(seed.accountId, { [field]: value })),
        '23514',
        `broker_balance_snapshots_${column}_check`,
      );
    });
  });

  it.each(SNAPSHOT_REQUIRED)('rejects a NULL %s', async (field, column) => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const error = await tx
        .insert(brokerBalanceSnapshots)
        .values(snapshot(seed.accountId, { [field]: null }))
        .then(
          () => undefined,
          (thrown: unknown) => thrown,
        );
      expect(caught(error)).toMatchObject({ code: '23502', column });
    });
  });

  it('accepts a zero and a fractional level rank', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const other = await seedAccount(tx);
      const [zero] = await tx
        .insert(brokerBalanceSnapshots)
        .values(snapshot(seed.accountId, { levelRank: 0 }))
        .returning();
      const [fraction] = await tx
        .insert(brokerBalanceSnapshots)
        .values(snapshot(other.accountId, { levelRank: 2.5 }))
        .returning();
      expect([zero!.levelRank, fraction!.levelRank]).toEqual([0, 2.5]);
    });
  });

  it.each([
    ['negative', -1],
    ['NaN', Number.NaN],
  ])('rejects a %s level rank', async (_label, levelRank) => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      await rejectsWith(
        tx.insert(brokerBalanceSnapshots).values(snapshot(seed.accountId, { levelRank })),
        '23514',
        'broker_balance_snapshots_level_rank_check',
      );
    });
  });

  it('rejects a refresh error outside the list', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      await rejectsWith(
        tx.insert(brokerBalanceSnapshots).values(
          snapshot(seed.accountId, {
            lastRefreshError: 'timeout',
            lastRefreshFailedAt: sql`now()`,
          }),
        ),
        '23514',
        'broker_balance_snapshots_last_refresh_error_check',
      );
    });
  });

  it.each([
    ['a code without a time', { lastRefreshError: 'unavailable' }],
    ['a time without a code', { lastRefreshFailedAt: sql`now()` }],
  ])('rejects %s', async (_label, patch) => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      await rejectsWith(
        tx.insert(brokerBalanceSnapshots).values(snapshot(seed.accountId, patch)),
        '23514',
        'broker_balance_snapshots_failure_pair_check',
      );
    });
  });

  it('accepts a failure as a code with its time, and neither', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const other = await seedAccount(tx);
      const [failed] = await tx
        .insert(brokerBalanceSnapshots)
        .values(
          snapshot(seed.accountId, {
            lastRefreshError: 'unavailable',
            lastRefreshFailedAt: sql`now()`,
          }),
        )
        .returning();
      const [clean] = await tx
        .insert(brokerBalanceSnapshots)
        .values(snapshot(other.accountId))
        .returning();
      expect(failed!.lastRefreshError).toBe('unavailable');
      expect([clean!.lastRefreshError, clean!.lastRefreshFailedAt]).toEqual([null, null]);
    });
  });

  it('keeps one row per account', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      await tx.insert(brokerBalanceSnapshots).values(snapshot(seed.accountId));
      const error = await tx
        .insert(brokerBalanceSnapshots)
        .values(snapshot(seed.accountId))
        .then(
          () => undefined,
          (thrown: unknown) => thrown,
        );
      expect(caught(error)).toMatchObject({
        code: '23505',
        constraint: 'broker_balance_snapshots_pkey',
      });
    });
  });

  it('rejects a snapshot of an account that does not exist', async () => {
    await rolledBack(async (tx) => {
      await rejectsWith(
        tx.insert(brokerBalanceSnapshots).values(snapshot(randomUUID())),
        '23503',
        'broker_balance_snapshots_account_fk',
      );
    });
  });
});

// --- broker_session_leases (#93) ------------------------------------------------------------

describe('broker_session_leases (#93)', () => {
  const lease = (accountId: string, acquiredAt: string, expiresAt: string) => ({
    brokerAccountId: accountId,
    ownerId: randomUUID(),
    acquiredAt: sql`${acquiredAt}::timestamptz`,
    expiresAt: sql`${expiresAt}::timestamptz`,
  });

  it('refuses a lease that expires when it is acquired, and accepts one a microsecond later', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      await rejectsWith(
        tx
          .insert(brokerSessionLeases)
          .values(lease(seed.accountId, '2026-10-09 10:00:00+00', '2026-10-09 10:00:00+00')),
        '23514',
        'broker_session_leases_expiry_check',
      );
    });
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      await tx
        .insert(brokerSessionLeases)
        .values(lease(seed.accountId, '2026-10-09 10:00:00+00', '2026-10-09 10:00:00.000001+00'));
    });
  });

  it('refuses a missing time and a second row for the account', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const error = await tx
        .execute(
          sql`insert into broker_session_leases (broker_account_id, owner_id, acquired_at, expires_at)
              values (${seed.accountId}, ${randomUUID()}, now(), null)`,
        )
        .then(
          () => undefined,
          (thrown: unknown) => thrown,
        );
      expect(caught(error)).toMatchObject({ code: '23502', column: 'expires_at' });
    });
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const row = lease(seed.accountId, '2026-10-09 10:00:00+00', '2026-10-09 10:00:30+00');
      await tx.insert(brokerSessionLeases).values(row);
      await rejectsWith(
        tx.insert(brokerSessionLeases).values({ ...row, ownerId: randomUUID() }),
        '23505',
        'broker_session_leases_pkey',
      );
    });
  });

  it('rejects a lease of an account that does not exist', async () => {
    await rolledBack(async (tx) => {
      await rejectsWith(
        tx
          .insert(brokerSessionLeases)
          .values(lease(randomUUID(), '2026-10-09 10:00:00+00', '2026-10-09 10:00:30+00')),
        '23503',
        'broker_session_leases_account_fk',
      );
    });
  });
});

describe('trading_sessions (#130)', () => {
  const session = (accountId: string, patch: Record<string, unknown> = {}) => ({
    brokerAccountId: accountId,
    mode: 'demo' as const,
    ...patch,
  });

  it.each(Object.values(TradingSessionStopReason))(
    'accepts stop_reason %s on a stopped row with ended_at',
    async (stopReason) => {
      await rolledBack(async (tx) => {
        const seed = await seedAccount(tx);
        const [row] = await tx
          .insert(tradingSessions)
          .values(session(seed.accountId, { status: 'stopped', stopReason, endedAt: new Date() }))
          .returning();
        expect(row!.stopReason).toBe(stopReason);
      });
    },
  );

  it('rejects an unknown stop_reason', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      await rejectsWith(
        tx.insert(tradingSessions).values(
          session(seed.accountId, {
            status: 'stopped',
            stopReason: 'bogus',
            endedAt: new Date(),
          }),
        ),
        '23514',
        'trading_sessions_stop_reason_check',
      );
    });
  });

  // #379...#698: the pause's memory; the column stays until #719
  it.each([null, 'up', 'down'] as const)('accepts last_signal_action %s', async (action) => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const [row] = await tx
        .insert(tradingSessions)
        .values(session(seed.accountId, { lastSignalAction: action }))
        .returning();
      expect(row!.lastSignalAction).toBe(action);
    });
  });

  it.each(['bogus', ''])('rejects last_signal_action %j', async (action) => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      await rejectsWith(
        tx.insert(tradingSessions).values(session(seed.accountId, { lastSignalAction: action })),
        '23514',
        'trading_sessions_last_signal_action_check',
      );
    });
  });

  // #568: the direction of the signal the start route checked
  it.each([null, 'up', 'down'] as const)('accepts start_signal_action %s', async (action) => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const [row] = await tx
        .insert(tradingSessions)
        .values(session(seed.accountId, { startSignalAction: action }))
        .returning();
      expect(row!.startSignalAction).toBe(action);
    });
  });

  it.each(['bogus', ''])('rejects start_signal_action %j', async (action) => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      await rejectsWith(
        tx.insert(tradingSessions).values(session(seed.accountId, { startSignalAction: action })),
        '23514',
        'trading_sessions_start_signal_action_check',
      );
    });
  });

  it.each([
    ['active', null, false],
    ['stopped', 'completed', true],
  ] as const)('accepts %s / %s / ended_at %s', async (status, stopReason, ended) => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const [row] = await tx
        .insert(tradingSessions)
        .values(session(seed.accountId, { status, stopReason, endedAt: ended ? new Date() : null }))
        .returning();
      expect(row!.status).toBe(status);
    });
  });

  // the six rows of the plan's D2 table: each refused row names the CHECK that refuses it
  it.each([
    ['stopped', null, true, 'trading_sessions_stop_reason_pair_check'],
    ['stopped', 'completed', false, 'trading_sessions_ended_at_pair_check'],
    ['paused', 'timeout', false, 'trading_sessions_stop_reason_pair_check'],
    ['active', null, true, 'trading_sessions_ended_at_pair_check'],
    ['active', 'completed', false, 'trading_sessions_stop_reason_pair_check'],
    ['paused', null, true, 'trading_sessions_ended_at_pair_check'],
  ] as const)(
    'rejects %s / %s / ended_at %s by %s',
    async (status, stopReason, ended, constraint) => {
      await rolledBack(async (tx) => {
        const seed = await seedAccount(tx);
        await rejectsWith(
          tx
            .insert(tradingSessions)
            .values(
              session(seed.accountId, { status, stopReason, endedAt: ended ? new Date() : null }),
            ),
          '23514',
          constraint,
        );
      });
    },
  );

  it('accepts the empty default object', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const [row] = await tx.insert(tradingSessions).values(session(seed.accountId)).returning();
      expect(row!.settings).toEqual({});
    });
  });

  it.each(['[]', 'null', '1'])('rejects settings %s', async (json) => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      await rejectsWith(
        tx.execute(
          sql`insert into trading_sessions (broker_account_id, mode, settings) values (${seed.accountId}, 'demo', ${json}::jsonb)`,
        ),
        '23514',
        'trading_sessions_settings_object_check',
      );
    });
  });

  // the session notices' cursor (#464): NOT NULL refuses NULL before the CHECK sees it
  it('rejects a negative notified_trades and accepts zero', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const stopped = { status: 'stopped', stopReason: 'completed', endedAt: new Date() };
      const [row] = await tx
        .insert(tradingSessions)
        .values(session(seed.accountId, stopped))
        .returning();
      expect(row!.notifiedTrades).toBe(0);
      expect(row!.finalNoticeSentAt).toBeNull();
      await rejectsWith(
        tx.insert(tradingSessions).values({ ...session(seed.accountId), notifiedTrades: -1 }),
        '23514',
        'trading_sessions_notified_trades_check',
      );
    });
  });

  // the session's cycle message (#551): both or neither, a positive message_id, a trade index
  // from 0
  it.each([
    [1, null, 'trading_sessions_cycle_message_pair_check'],
    [null, 0, 'trading_sessions_cycle_message_pair_check'],
    [0, 0, 'trading_sessions_cycle_message_id_check'],
    [-1, 0, 'trading_sessions_cycle_message_id_check'],
    [1, -1, 'trading_sessions_cycle_message_from_check'],
  ])('rejects cycle_message_id %s with cycle_message_from %s (%s)', async (id, from, name) => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      await rejectsWith(
        tx.insert(tradingSessions).values({
          ...session(seed.accountId),
          cycleMessageId: id,
          cycleMessageFrom: from,
        }),
        '23514',
        name,
      );
    });
  });

  it.each([
    [null, null],
    [1, 0],
    [2147483647, 2147483647],
  ])('accepts cycle_message_id %s with cycle_message_from %s', async (id, from) => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const [row] = await tx
        .insert(tradingSessions)
        .values({ ...session(seed.accountId), cycleMessageId: id, cycleMessageFrom: from })
        .returning();
      expect([row!.cycleMessageId, row!.cycleMessageFrom]).toEqual([id, from]);
    });
  });

  // the open trade's block (#700): the intent is one of the session's own; NULL checks nothing
  it("rejects open_notice_intent_id naming another session's intent and accepts its own", async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const stopped = { status: 'stopped', stopReason: 'completed', endedAt: new Date() };
      const [own, other] = await tx
        .insert(tradingSessions)
        .values([session(seed.accountId), session(seed.accountId, stopped)])
        .returning({ id: tradingSessions.id });
      const [ownIntent, otherIntent] = await tx
        .insert(tradeIntents)
        .values([
          intent(seed, 'open-own', { tradingSessionId: own!.id, status: 'accepted' }),
          intent(seed, 'open-other', { tradingSessionId: other!.id, status: 'settled' }),
        ])
        .returning({ id: tradeIntents.id });
      await tx.execute(sql`savepoint foreign_intent`);
      await rejectsWith(
        tx
          .update(tradingSessions)
          .set({ openNoticeIntentId: otherIntent!.id })
          .where(eq(tradingSessions.id, own!.id)),
        '23503',
        'trading_sessions_open_notice_intent_fk',
      );
      await tx.execute(sql`rollback to savepoint foreign_intent`);
      const [row] = await tx
        .update(tradingSessions)
        .set({ openNoticeIntentId: ownIntent!.id })
        .where(eq(tradingSessions.id, own!.id))
        .returning({ openNoticeIntentId: tradingSessions.openNoticeIntentId });
      expect(row!.openNoticeIntentId).toBe(ownIntent!.id);
    });
  });

  // the bot's status message of the session (#567): a positive message_id or none
  it.each([0, -1])('rejects status_message_id %s', async (id) => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      await rejectsWith(
        tx.insert(tradingSessions).values({ ...session(seed.accountId), statusMessageId: id }),
        '23514',
        'trading_sessions_status_message_id_check',
      );
    });
  });

  it.each([null, 1, 2147483647])('accepts status_message_id %s', async (id) => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const [row] = await tx
        .insert(tradingSessions)
        .values({ ...session(seed.accountId), statusMessageId: id })
        .returning();
      expect(row!.statusMessageId).toBe(id);
    });
  });

  // the waiting message (#536): a positive message_id, a slot from 0, an id only on a slot
  it.each([
    [0, 0, 'trading_sessions_waiting_message_id_check'],
    [-1, 0, 'trading_sessions_waiting_message_id_check'],
    [null, -1, 'trading_sessions_waiting_after_message_check'],
    [5, null, 'trading_sessions_waiting_pair_check'],
  ])('rejects waiting_message_id %s with waiting_after_message %s (%s)', async (id, slot, name) => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      await rejectsWith(
        tx.insert(tradingSessions).values({
          ...session(seed.accountId),
          waitingMessageId: id,
          waitingAfterMessage: slot,
        }),
        '23514',
        name,
      );
    });
  });

  it.each([
    [null, null],
    [null, 0],
    [1, 0],
    [2147483647, 2147483647],
  ])('accepts waiting_message_id %s with waiting_after_message %s', async (id, slot) => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const [row] = await tx
        .insert(tradingSessions)
        .values({ ...session(seed.accountId), waitingMessageId: id, waitingAfterMessage: slot })
        .returning();
      expect([row!.waitingMessageId, row!.waitingAfterMessage]).toEqual([id, slot]);
    });
  });

  it('rejects a second active session of the account and accepts any number of stopped ones', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const stopped = { status: 'stopped', stopReason: 'completed', endedAt: new Date() };
      await tx.insert(tradingSessions).values(session(seed.accountId, stopped));
      await tx.insert(tradingSessions).values(session(seed.accountId, stopped));
      await tx.insert(tradingSessions).values(session(seed.accountId));
      const other = await seedAccount(tx);
      await tx.insert(tradingSessions).values(session(other.accountId));
      await rejectsWith(
        tx.insert(tradingSessions).values(session(seed.accountId)),
        '23505',
        'trading_sessions_active_account_idx',
      );
    });
  });
});

describe('trading_switch (#144)', () => {
  // Every case starts from a known row of its own inside its rolled-back transaction: the
  // database may be shared with a local stack whose operator ran kill-switch.
  const reset = async (tx: Tx) => {
    await tx.delete(tradingSwitch);
    await tx.insert(tradingSwitch).values({ tradingEnabled: true, source: 'migration' });
  };
  const notNull = async (query: Promise<unknown>) => {
    const error = await query.then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(caught(error)).toMatchObject({ code: '23502' });
  };

  it('rejects a second row: id false by the singleton CHECK, id true by the key', async () => {
    await rolledBack(async (tx) => {
      await reset(tx);
      await rejectsWith(
        tx.insert(tradingSwitch).values({ id: false, tradingEnabled: true, source: 'operator' }),
        '23514',
        'trading_switch_singleton_check',
      );
    });
    await rolledBack(async (tx) => {
      await reset(tx);
      await rejectsWith(
        tx.insert(tradingSwitch).values({ tradingEnabled: true, source: 'operator' }),
        '23505',
        'trading_switch_pkey',
      );
    });
  });

  it.each([
    ['id', { id: null }],
    ['trading_enabled', { tradingEnabled: null }],
    ['source', { source: null }],
  ])('rejects a NULL %s', async (_column, patch) => {
    await rolledBack(async (tx) => {
      await reset(tx);
      await notNull(tx.update(tradingSwitch).set(patch as never));
    });
  });

  it('rejects a source outside the list', async () => {
    await rolledBack(async (tx) => {
      await reset(tx);
      await rejectsWith(
        // a closed row: an open one with an unknown source would hit the open-source CHECK first
        tx
          .update(tradingSwitch)
          .set({ tradingEnabled: false, reason: 'x', source: 'circuit' as never }),
        '23514',
        'trading_switch_source_check',
      );
    });
  });

  it('rejects a closed row without a reason and accepts an open one without', async () => {
    await rolledBack(async (tx) => {
      await reset(tx);
      await tx
        .update(tradingSwitch)
        .set({ tradingEnabled: true, source: 'operator', reason: null });
      await rejectsWith(
        tx.update(tradingSwitch).set({ tradingEnabled: false }),
        '23514',
        'trading_switch_stop_reason_check',
      );
    });
  });

  it.each([
    ['empty', ''],
    ['201 characters', 'x'.repeat(201)],
  ])('rejects a %s reason', async (_label, reason) => {
    await rolledBack(async (tx) => {
      await reset(tx);
      await rejectsWith(
        tx.update(tradingSwitch).set({ tradingEnabled: false, source: 'operator', reason }),
        '23514',
        'trading_switch_reason_length_check',
      );
    });
  });

  it.each([
    ['1 character', 'x'],
    ['200 characters', 'я'.repeat(200)],
  ])('accepts a %s reason on a closed row', async (_label, reason) => {
    await rolledBack(async (tx) => {
      await reset(tx);
      const [row] = await tx
        .update(tradingSwitch)
        .set({ tradingEnabled: false, source: 'operator', reason })
        .returning();
      expect(row!.reason).toBe(reason);
    });
  });

  // #96: only the seed and the operator leave trading open; the circuit breaker only closes
  it.each([
    ['open by the migration', { tradingEnabled: true, source: 'migration', reason: null }],
    ['open by the operator', { tradingEnabled: true, source: 'operator', reason: null }],
    ['closed by the breaker', { tradingEnabled: false, source: 'circuit_breaker', reason: 'x' }],
    ['closed by the operator', { tradingEnabled: false, source: 'operator', reason: 'x' }],
  ] as const)('accepts a row %s', async (_label, row) => {
    await rolledBack(async (tx) => {
      await reset(tx);
      await tx.update(tradingSwitch).set(row);
    });
  });

  it('refuses an open row whose source is the breaker, so reopening goes through the operator', async () => {
    await rolledBack(async (tx) => {
      await reset(tx);
      await rejectsWith(
        tx
          .update(tradingSwitch)
          .set({ tradingEnabled: true, source: 'circuit_breaker', reason: null }),
        '23514',
        'trading_switch_open_source_check',
      );
    });
    await rolledBack(async (tx) => {
      await reset(tx);
      await tx
        .update(tradingSwitch)
        .set({ tradingEnabled: false, source: 'circuit_breaker', reason: 'x' });
      // a direct reopen keeping the breaker's source is refused...
      await rejectsWith(
        tx.update(tradingSwitch).set({ tradingEnabled: true }),
        '23514',
        'trading_switch_open_source_check',
      );
    });
    await rolledBack(async (tx) => {
      await reset(tx);
      await tx
        .update(tradingSwitch)
        .set({ tradingEnabled: false, source: 'circuit_breaker', reason: 'x' });
      // ...and the operator's, writing its own source in the same update, passes
      await tx
        .update(tradingSwitch)
        .set({ tradingEnabled: true, source: 'operator', reason: null });
    });
  });
});

describe('bot_text_overrides (#299)', () => {
  // the rows are this case's own: the table may hold a local stack's overrides
  const save = (tx: Tx, patch: Partial<typeof botTextOverrides.$inferInsert> = {}) =>
    tx
      .insert(botTextOverrides)
      .values({ key: `k${randomUUID().slice(0, 8)}`, source: 'x', ...patch })
      .returning();

  it.each(['a', 'welcome', 'cardBody', `a${'b'.repeat(63)}`])('accepts the key %s', async (key) => {
    await rolledBack(async (tx) => {
      await tx.delete(botTextOverrides).where(eq(botTextOverrides.key, key));
      await expect(save(tx, { key })).resolves.toHaveLength(1);
    });
  });

  it.each(['A', '1a', 'a_b', 'a-b', '', `a${'b'.repeat(64)}`, 'a\n'])(
    'refuses the key %j',
    async (key) => {
      await rolledBack(async (tx) => {
        await rejectsWith(save(tx, { key }), '23514', 'bot_text_overrides_key_check');
      });
    },
  );

  it.each([
    ['empty', ''],
    ['16385 characters', 'я'.repeat(16_385)],
  ])('refuses a %s source', async (_label, source) => {
    await rolledBack(async (tx) => {
      await rejectsWith(save(tx, { source }), '23514', 'bot_text_overrides_source_length_check');
    });
  });

  it('accepts a source of 16384 characters', async () => {
    await rolledBack(async (tx) => {
      await expect(save(tx, { source: 'я'.repeat(16_384) })).resolves.toHaveLength(1);
    });
  });

  it('refuses an editor that does not exist', async () => {
    await rolledBack(async (tx) => {
      await rejectsWith(
        save(tx, { updatedByStaffId: randomUUID() }),
        '23503',
        'bot_text_overrides_updated_by_staff_id_staff_id_fk',
      );
    });
  });

  // every version stays exact as the JS number the column is read into (#299 review)
  it('caps the version sequence at Number.MAX_SAFE_INTEGER', async () => {
    const { rows } = await pool.query<{ seqmax: string }>(
      `select seqmax::text from pg_sequence where seqrelid = 'bot_text_override_version_seq'::regclass`,
    );
    expect(rows).toEqual([{ seqmax: String(Number.MAX_SAFE_INTEGER) }]);
  });

  // every row the table takes passes the bot's wire schema, and every row the table refuses fails
  // it, so no hand-inserted row can stop the bot's refresh (#299 review round 2)
  const EMOJI = '\u{1F600}';
  it.each([
    ['ASCII 16384', { source: 'x'.repeat(16_384) }],
    ['ASCII 16385', { source: 'x'.repeat(16_385) }],
    ['8192 astral (16384 UTF-16)', { source: EMOJI.repeat(8_192) }],
    ['8193 astral (16386 UTF-16)', { source: EMOJI.repeat(8_193) }],
    ['16382 + astral (16384 UTF-16)', { source: 'x'.repeat(16_382) + EMOJI }],
    ['16383 + astral (16385 UTF-16)', { source: 'x'.repeat(16_383) + EMOJI }],
    ['an empty source', { source: '' }],
    ['version 0', { version: 0 }],
    ['version -5', { version: -5 }],
    ['version 2^53', { version: Number.MAX_SAFE_INTEGER + 1 }],
    ['version 1', { version: 1 }],
    ['version 2^53 - 1', { version: Number.MAX_SAFE_INTEGER }],
  ])('agrees with the bot wire schema on %s', async (_label, patch) => {
    const row = { key: `p${randomUUID().slice(0, 8)}`, source: 'x', version: 1, ...patch };
    const schemaTakes = botTextOverrideSchema.safeParse(row).success;
    let refusedBy: string | undefined;
    await rolledBack(async (tx) => {
      // as text: 2^53 is exact as a JS number, but the driver is not asked to say so
      await tx
        .execute(
          sql`insert into bot_text_overrides (key, source, version) values (${row.key}, ${row.source}, ${String(row.version)}::bigint)`,
        )
        .catch((error: unknown) => {
          const { code, constraint } = caught(error) as { code?: string; constraint?: string };
          expect(code).toBe('23514');
          refusedBy = constraint;
        });
    });
    expect(refusedBy === undefined).toBe(schemaTakes);
    if (refusedBy !== undefined) observed.add(refusedBy);
  });

  it('gives every write a new version from the sequence', async () => {
    await rolledBack(async (tx) => {
      const [first] = await save(tx);
      const [second] = await tx
        .update(botTextOverrides)
        .set({ version: sql`nextval('bot_text_override_version_seq')` })
        .where(eq(botTextOverrides.key, first!.key))
        .returning();
      expect(second!.version).toBeGreaterThan(first!.version);
    });
  });
});

// Personal start links (#115, docs/referrals.md). One observation of each constraint for the
// gate below; the behaviour that rests on them is in user-ops.db.test.ts and
// referral-ops.db.test.ts.
describe('referral_codes and referrals (#115)', () => {
  async function seedUser(tx: Tx): Promise<string> {
    const [user] = await tx
      .insert(users)
      .values({ telegramUserId: BigInt(975_000 + ++seq) })
      .returning({ id: users.id });
    return user!.id;
  }

  it('refuses a NULL code by NOT NULL, since the CHECK alone would let it through', async () => {
    await rolledBack(async (tx) => {
      const userId = await seedUser(tx);
      await expect(
        tx.execute(sql`insert into referral_codes (user_id, code) values (${userId}, null)`),
      ).rejects.toMatchObject({ cause: { code: '23502', column: 'code' } });
    });
  });

  it('takes a code of 8 base62 characters', async () => {
    await rolledBack(async (tx) => {
      const userId = await seedUser(tx);
      await tx.insert(referralCodes).values({ userId, code: 'abcdEFG1' });
    });
  });

  it.each(['abcdEFG', 'abcdEFG12', 'abcd-FG1', 'abcd_FG1', ''])(
    'refuses the code %j by referral_codes_code_check',
    async (code) => {
      await rolledBack(async (tx) => {
        const userId = await seedUser(tx);
        await rejectsWith(
          tx.insert(referralCodes).values({ userId, code }),
          '23514',
          'referral_codes_code_check',
        );
      });
    },
  );

  it('enforces referral_codes_code_key', async () => {
    await rolledBack(async (tx) => {
      const [first, second] = [await seedUser(tx), await seedUser(tx)];
      await tx.insert(referralCodes).values({ userId: first, code: 'SameCod1' });
      await rejectsWith(
        tx.insert(referralCodes).values({ userId: second, code: 'SameCod1' }),
        '23505',
        'referral_codes_code_key',
      );
    });
  });

  it('enforces referrals_invitee_key: one inviter per invitee', async () => {
    await rolledBack(async (tx) => {
      const [invitee, inviter, other] = [
        await seedUser(tx),
        await seedUser(tx),
        await seedUser(tx),
      ];
      await tx.insert(referrals).values({ inviteeUserId: invitee, inviterUserId: inviter });
      await rejectsWith(
        tx.insert(referrals).values({ inviteeUserId: invitee, inviterUserId: other }),
        '23505',
        'referrals_invitee_key',
      );
    });
  });

  it('enforces referrals_not_self_check', async () => {
    await rolledBack(async (tx) => {
      const userId = await seedUser(tx);
      await rejectsWith(
        tx.insert(referrals).values({ inviteeUserId: userId, inviterUserId: userId }),
        '23514',
        'referrals_not_self_check',
      );
    });
  });

  it.each<[string, (tx: Tx, userId: string, dangling: string) => Promise<unknown>]>([
    [
      'referral_codes_user_fk',
      (tx, _userId, dangling) =>
        tx.insert(referralCodes).values({ userId: dangling, code: 'Dangl1ng' }),
    ],
    [
      'referrals_invitee_fk',
      (tx, userId, dangling) =>
        tx.insert(referrals).values({ inviteeUserId: dangling, inviterUserId: userId }),
    ],
    [
      'referrals_inviter_fk',
      (tx, userId, dangling) =>
        tx.insert(referrals).values({ inviteeUserId: userId, inviterUserId: dangling }),
    ],
  ])('rejects a dangling reference through %s', async (constraint, insert) => {
    await rolledBack(async (tx) => {
      const userId = await seedUser(tx);
      await rejectsWith(insert(tx, userId, randomUUID()), '23503', constraint);
    });
  });
});

// --- star_payments and the Stars purchase rows of the ledger (#117) ---------------------------

const starPayment = (userId: string, patch: Record<string, unknown> = {}) => ({
  userId,
  telegramPaymentChargeId: `charge-${++seq}`,
  packageCode: 'p50',
  currency: 'XTR',
  totalAmount: 100,
  tokens: 50n,
  payerTelegramUserId: 4242n,
  status: 'paid' as const,
  paidAt: sql`now()`,
  ...patch,
});

async function seedStarPayment(tx: Tx, userId: string): Promise<string> {
  const [row] = await tx
    .insert(starPayments)
    .values(starPayment(userId))
    .returning({ id: starPayments.id });
  return row!.id;
}

describe('star_payments', () => {
  it.each([
    ['a paid payment', {}],
    [
      'a held payment with no tokens and another currency',
      { status: 'held', tokens: null, currency: 'USD' },
    ],
    ['a refunded payment with its time', { status: 'refunded', refundedAt: sql`now()` }],
    ['a charge id of 255 characters', { telegramPaymentChargeId: 'c'.repeat(255) }],
  ])('accepts %s', async (_label, patch) => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      await expect(
        tx.insert(starPayments).values(starPayment(seed.userId, patch)),
      ).resolves.toBeDefined();
    });
  });

  it.each([
    ['an empty charge id', { telegramPaymentChargeId: '' }, 'star_payments_charge_id_check'],
    [
      'a charge id of 256 characters',
      { telegramPaymentChargeId: 'c'.repeat(256) },
      'star_payments_charge_id_check',
    ],
    ['a zero amount', { totalAmount: 0 }, 'star_payments_total_amount_check'],
    ['zero tokens', { tokens: 0n }, 'star_payments_tokens_check'],
    ['negative tokens', { tokens: -1n }, 'star_payments_tokens_check'],
    ['a status outside the list', { status: 'pending' }, 'star_payments_status_check'],
    ['a paid payment without tokens', { tokens: null }, 'star_payments_paid_check'],
    ['a paid payment in another currency', { currency: 'USD' }, 'star_payments_paid_check'],
    ['a refund without its time', { status: 'refunded' }, 'star_payments_refund_pair_check'],
    [
      'a paid payment with a refund time',
      { refundedAt: sql`now()` },
      'star_payments_refund_pair_check',
    ],
  ])('rejects %s', async (_label, patch, constraint) => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      await rejectsWith(
        tx.insert(starPayments).values(starPayment(seed.userId, patch)),
        '23514',
        constraint,
      );
    });
  });

  // the pair CHECK compares a boolean with a boolean, so a NULL status would pass it: NOT NULL
  // is what keeps it from doing so
  it('rejects a NULL status by the column itself', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const error = await tx
        .insert(starPayments)
        .values(starPayment(seed.userId, { status: null }))
        .then(
          () => undefined,
          (thrown: unknown) => thrown,
        );
      expect(caught(error)).toMatchObject({ code: '23502', column: 'status' });
    });
  });

  it('records one row per charge', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const other = await seedAccount(tx);
      const first = starPayment(seed.userId);
      await tx.insert(starPayments).values(first);
      await rejectsWith(
        tx
          .insert(starPayments)
          .values(
            starPayment(other.userId, { telegramPaymentChargeId: first.telegramPaymentChargeId }),
          ),
        '23505',
        'star_payments_charge_key',
      );
    });
  });

  it('rejects a payment of a user with no row', async () => {
    await rolledBack(async (tx) => {
      await rejectsWith(
        tx.insert(starPayments).values(starPayment(randomUUID())),
        '23503',
        'star_payments_user_id_users_id_fk',
      );
    });
  });
});

describe('token_ledger: the Stars purchase (#117)', () => {
  it('accepts a purchase naming its Stars payment', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const payment = await seedStarPayment(tx, seed.userId);
      await expect(
        tx
          .insert(tokenLedger)
          .values({
            userId: seed.userId,
            kind: 'purchase',
            balanceDelta: 50n,
            starPaymentId: payment,
          }),
      ).resolves.toBeDefined();
    });
  });

  it('credits one Stars payment only once per kind', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const payment = await seedStarPayment(tx, seed.userId);
      const row = {
        userId: seed.userId,
        kind: 'purchase' as const,
        balanceDelta: 50n,
        starPaymentId: payment,
      };
      await tx.insert(tokenLedger).values(row);
      await rejectsWith(
        tx.insert(tokenLedger).values(row),
        '23505',
        'token_ledger_star_payment_idx',
      );
    });
  });

  it('rejects a credit for another user’s Stars payment', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const other = await seedAccount(tx);
      const payment = await seedStarPayment(tx, seed.userId);
      await rejectsWith(
        tx
          .insert(tokenLedger)
          .values({
            userId: other.userId,
            kind: 'purchase',
            balanceDelta: 50n,
            starPaymentId: payment,
          }),
        '23503',
        'token_ledger_star_payment_owner_fk',
      );
    });
  });

  // S6: the purchase branch takes exactly one of a deposit and a Stars payment, and nothing else
  it.each([
    ['a purchase naming both a deposit and a Stars payment', 'purchase', ['deposit']],
    ['a purchase with a Stars payment and a broker account', 'purchase', ['account']],
    ['a purchase with a Stars payment and an intent', 'purchase', ['intent']],
    ['a purchase with a Stars payment and a manual reference', 'purchase', ['ref']],
    ['a reserve naming a Stars payment', 'reserve', ['intent']],
    ['a bonus naming a Stars payment', 'bonus', ['account']],
    ['an adjustment naming a Stars payment', 'adjustment', []],
  ] as const)('rejects %s', async (_label, kind, extras) => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const payment = await seedStarPayment(tx, seed.userId);
      const values: Record<string, unknown> = {
        userId: seed.userId,
        kind,
        starPaymentId: payment,
        ...(kind === 'reserve' ? { reservedDelta: 1n } : { balanceDelta: 10n }),
        ...(kind === 'adjustment' ? { note: 'n' } : {}),
        ...(kind === 'bonus' ? await bonusRuleRef(tx, 'link_bonus') : {}),
      };
      for (const extra of extras) {
        if (extra === 'deposit') values.depositEventId = await seedDeposit(tx, seed);
        if (extra === 'account') values.brokerAccountId = seed.accountId;
        if (extra === 'intent') {
          values.intentId = (
            await tx.insert(tradeIntents).values(intent(seed, 'r1')).returning()
          )[0]!.id;
        }
        if (extra === 'ref') Object.assign(values, { refType: 'manual', refId: randomUUID() });
      }
      await rejectsWith(
        tx.insert(tokenLedger).values(values as typeof tokenLedger.$inferInsert),
        '23514',
        'token_ledger_reference_check',
      );
    });
  });
});

// --- the Stars refund (#118) -------------------------------------------------------------------

describe('star_payments: the payer (#118)', () => {
  it.each([
    ['a payer of 0', 0n],
    ['a negative payer', -1n],
  ])('rejects %s', async (_label, payer) => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      await rejectsWith(
        tx.insert(starPayments).values(starPayment(seed.userId, { payerTelegramUserId: payer })),
        '23514',
        'star_payments_payer_check',
      );
    });
  });

  it('accepts a payer of 1 and rejects a NULL one by the column itself', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      await expect(
        tx.insert(starPayments).values(starPayment(seed.userId, { payerTelegramUserId: 1n })),
      ).resolves.toBeDefined();
      const error = await tx
        .insert(starPayments)
        .values(starPayment(seed.userId, { payerTelegramUserId: null }))
        .then(
          () => undefined,
          (thrown: unknown) => thrown,
        );
      expect(caught(error)).toMatchObject({ code: '23502', column: 'payer_telegram_user_id' });
    });
  });
});

describe('star_refund_requests (#118)', () => {
  it('accepts one request per payment and refuses a second', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const payment = await seedStarPayment(tx, seed.userId);
      const request = { starPaymentId: payment, requestedByTelegramUserId: 4242n };
      await expect(tx.insert(starRefundRequests).values(request)).resolves.toBeDefined();
      await rejectsWith(
        tx.insert(starRefundRequests).values(request),
        '23505',
        'star_refund_requests_payment_key',
      );
    });
  });

  it('refuses a request for no payment', async () => {
    await rolledBack(async (tx) => {
      await rejectsWith(
        tx
          .insert(starRefundRequests)
          .values({ starPaymentId: randomUUID(), requestedByTelegramUserId: 1n }),
        '23503',
        'star_refund_requests_payment_fk',
      );
    });
  });

  it.each([
    ['a requester of 0', 0n],
    ['a negative requester', -1n],
  ])('refuses %s', async (_label, requester) => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const payment = await seedStarPayment(tx, seed.userId);
      await rejectsWith(
        tx
          .insert(starRefundRequests)
          .values({ starPaymentId: payment, requestedByTelegramUserId: requester }),
        '23514',
        'star_refund_requests_requested_by_check',
      );
    });
  });

  it('keeps a payment with a request from being deleted', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const payment = await seedStarPayment(tx, seed.userId);
      await tx
        .insert(starRefundRequests)
        .values({ starPaymentId: payment, requestedByTelegramUserId: 4242n });
      await rejectsWith(
        tx.delete(starPayments).where(eq(starPayments.id, payment)),
        '23001',
        'star_refund_requests_payment_fk',
      );
    });
  });
});

describe('token_ledger: the Stars refund (#118)', () => {
  const refundRow = (userId: string, starPaymentId: string, patch: Record<string, unknown> = {}) =>
    ({
      userId,
      kind: 'refund',
      balanceDelta: -1n,
      reservedDelta: 0n,
      starPaymentId,
      ...patch,
    }) as typeof tokenLedger.$inferInsert;

  it('accepts a refund of −1 naming its Stars payment, beside the purchase of the same payment', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const payment = await seedStarPayment(tx, seed.userId);
      await tx
        .insert(tokenLedger)
        .values({
          userId: seed.userId,
          kind: 'purchase',
          balanceDelta: 50n,
          starPaymentId: payment,
        });
      await expect(
        tx.insert(tokenLedger).values(refundRow(seed.userId, payment)),
      ).resolves.toBeDefined();
    });
  });

  it('refunds one Stars payment only once', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const payment = await seedStarPayment(tx, seed.userId);
      await tx.insert(tokenLedger).values(refundRow(seed.userId, payment));
      await rejectsWith(
        tx.insert(tokenLedger).values(refundRow(seed.userId, payment)),
        '23505',
        'token_ledger_star_payment_idx',
      );
    });
  });

  it('rejects a refund of another user’s Stars payment', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const other = await seedAccount(tx);
      const payment = await seedStarPayment(tx, seed.userId);
      await rejectsWith(
        tx.insert(tokenLedger).values(refundRow(other.userId, payment)),
        '23503',
        'token_ledger_star_payment_owner_fk',
      );
    });
  });

  // a refund only takes tokens back, and never touches the reserve
  it.each([
    ['a refund that adds tokens', { balanceDelta: 5n }],
    ['a refund that moves the reserve', { reservedDelta: 1n }],
    ['a refund that frees the reserve', { balanceDelta: 0n, reservedDelta: -1n }],
  ])('rejects %s', async (_label, patch) => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const payment = await seedStarPayment(tx, seed.userId);
      await rejectsWith(
        tx.insert(tokenLedger).values(refundRow(seed.userId, payment, patch)),
        '23514',
        'token_ledger_delta_shape_check',
      );
    });
  });

  // 0 and 0 is refused by the CHECK every row passes first
  it('rejects a refund that moves nothing', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const payment = await seedStarPayment(tx, seed.userId);
      await rejectsWith(
        tx.insert(tokenLedger).values(refundRow(seed.userId, payment, { balanceDelta: 0n })),
        '23514',
        'token_ledger_delta_check',
      );
    });
  });

  it.each([
    ['a refund naming no Stars payment', ['none']],
    ['a refund naming a deposit beside its Stars payment', ['deposit']],
    ['a refund naming a broker account', ['account']],
    ['a refund naming an intent', ['intent']],
    ['a refund with a manual reference', ['ref']],
  ] as const)('rejects %s', async (_label, extras) => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const payment = await seedStarPayment(tx, seed.userId);
      const values: Record<string, unknown> = { ...refundRow(seed.userId, payment) };
      for (const extra of extras) {
        if (extra === 'none') values.starPaymentId = null;
        if (extra === 'deposit') values.depositEventId = await seedDeposit(tx, seed);
        if (extra === 'account') values.brokerAccountId = seed.accountId;
        if (extra === 'intent') {
          values.intentId = (
            await tx.insert(tradeIntents).values(intent(seed, 'r1')).returning()
          )[0]!.id;
        }
        if (extra === 'ref') Object.assign(values, { refType: 'manual', refId: randomUUID() });
      }
      await rejectsWith(
        tx.insert(tokenLedger).values(values as typeof tokenLedger.$inferInsert),
        '23514',
        'token_ledger_reference_check',
      );
    });
  });
});

// --- bonus rules (#13) ---------------------------------------------------------------------------

// the bonus_rules triggers raise like raise_append_only, with no `constraint` field either
async function rejectsAsImmutable(
  query: Promise<unknown>,
  trigger: 'bonus_rules_immutable' | 'bonus_rules_no_delete' | 'bonus_rules_no_truncate',
) {
  const error = await query.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error, `expected ${trigger} to refuse but nothing was thrown`).toBeDefined();
  expect(caught(error)).toMatchObject({
    code: 'P0001',
    message: 'bonus_rules rows are immutable',
  });
  observed.add(trigger);
}

async function seedRule(tx: Tx, patch: Partial<typeof bonusRules.$inferInsert> = {}) {
  const [row] = await tx
    .insert(bonusRules)
    .values({
      code: `rule-${++seq}`,
      version: 1,
      kind: 'link_bonus',
      params: { tokens: '5' },
      ...patch,
    })
    .returning();
  return row!;
}

describe('bonus_rules (#13)', () => {
  it.each([
    ['id', sql`id = gen_random_uuid()`],
    ['code', sql`code = code || '-x'`],
    ['version', sql`version = version + 1`],
    ['kind', sql`kind = 'deposit_bonus'`],
    ['priority', sql`priority = priority + 1`],
    ['params', sql`params = '{"tokens": "6"}'::jsonb`],
    ['created_at', sql`created_at = created_at - interval '1 second'`],
  ])('refuses an UPDATE of %s', async (_column, assignment) => {
    await rolledBack(async (tx) => {
      const rule = await seedRule(tx);
      await rejectsAsImmutable(
        tx.execute(sql`update bonus_rules set ${assignment} where id = ${rule.id}`),
        'bonus_rules_immutable',
      );
    });
  });

  it.each([
    ['is_active', sql`is_active = not is_active`],
    ['valid_from', sql`valid_from = now() - interval '1 day'`],
    ['valid_to', sql`valid_to = now() + interval '1 day'`],
    ['updated_at', sql`updated_at = now() + interval '1 second'`],
    ['params to itself', sql`params = params`],
  ])('allows an UPDATE of %s', async (_column, assignment) => {
    await rolledBack(async (tx) => {
      const rule = await seedRule(tx);
      const result = await tx.execute(
        sql`update bonus_rules set ${assignment} where id = ${rule.id}`,
      );
      expect(result.rowCount).toBe(1);
    });
  });

  it('refuses DELETE and TRUNCATE', async () => {
    await rolledBack(async (tx) => {
      const rule = await seedRule(tx);
      await rejectsAsImmutable(
        tx.delete(bonusRules).where(eq(bonusRules.id, rule.id)),
        'bonus_rules_no_delete',
      );
    });
    await rolledBack(async (tx) => {
      await rejectsAsImmutable(
        tx.execute(sql`truncate bonus_rules cascade`),
        'bonus_rules_no_truncate',
      );
    });
  });

  it.each([
    ['version 0', { version: 0 }, '23514', 'bonus_rules_version_check'],
    ['an unknown kind', { kind: 'promo' as never }, '23514', 'bonus_rules_kind_check'],
  ])('refuses %s', async (_label, patch, code, constraint) => {
    await rolledBack(async (tx) => {
      await rejectsWith(seedRule(tx, patch), code, constraint);
    });
  });

  it('refuses a NULL version', async () => {
    await rolledBack(async (tx) => {
      const error = await tx
        .execute(
          sql`insert into bonus_rules (code, version, kind) values ('null-version', null, 'link_bonus')`,
        )
        .then(
          () => undefined,
          (thrown: unknown) => thrown,
        );
      expect(caught(error)).toMatchObject({ code: '23502', column: 'version' });
    });
  });

  it('defaults a new version to inactive', async () => {
    await rolledBack(async (tx) => {
      const rule = await seedRule(tx);
      expect(rule.isActive).toBe(false);
    });
  });
});

describe('token_ledger: the rule a bonus names (#13)', () => {
  const seededRule = async (tx: Tx, code: string) => {
    const [row] = await tx
      .select({ id: bonusRules.id })
      .from(bonusRules)
      .where(sql`${bonusRules.code} = ${code} and ${bonusRules.version} = 1`);
    return row!.id;
  };

  it('accepts a starter pack under link_bonus and a deposit bonus under deposit_bonus', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      await tx.insert(tokenLedger).values({
        userId: seed.userId,
        kind: 'bonus',
        balanceDelta: 10n,
        brokerAccountId: seed.accountId,
        ...(await bonusRuleRef(tx, 'link_bonus')),
      });
      await tx.insert(tokenLedger).values({
        userId: seed.userId,
        kind: 'bonus',
        balanceDelta: 10n,
        depositEventId: await seedDeposit(tx, seed),
        ...(await bonusRuleRef(tx, 'deposit_bonus')),
      });
    });
  });

  it.each([
    ['a starter pack naming no rule', 'pack', {}],
    ['a starter pack with a rule id and a NULL kind', 'pack', { kind: null }],
    ['a starter pack under a referral_reward rule', 'pack', { code: 'referral_reward' }],
    ['a starter pack under a deposit_bonus rule', 'pack', { code: 'deposit_bonus' }],
    ['a deposit bonus under a link_bonus rule', 'deposit', { code: 'link_bonus' }],
    ['a deposit bonus naming no rule', 'deposit', {}],
    ['a bonus naming nothing (a promo)', 'none', { code: 'link_bonus' }],
    ['an adjustment naming a rule', 'adjustment', { code: 'link_bonus' }],
    ['a purchase naming a rule', 'purchase', { code: 'link_bonus' }],
    ['a reserve naming a rule', 'reserve', { code: 'link_bonus' }],
    ['an adjustment naming only a rule kind', 'adjustment', { kindOnly: true }],
  ] as const)('refuses %s', async (_label, shape, rule) => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      const values: Record<string, unknown> = { userId: seed.userId, balanceDelta: 10n };
      if (shape === 'pack') {
        Object.assign(values, { kind: 'bonus', brokerAccountId: seed.accountId });
      }
      if (shape === 'deposit') {
        Object.assign(values, { kind: 'bonus', depositEventId: await seedDeposit(tx, seed) });
      }
      if (shape === 'none') values.kind = 'bonus';
      if (shape === 'adjustment') Object.assign(values, { kind: 'adjustment', note: 'n' });
      if (shape === 'purchase') {
        Object.assign(values, { kind: 'purchase', depositEventId: await seedDeposit(tx, seed) });
      }
      if (shape === 'reserve') {
        const [row] = await tx.insert(tradeIntents).values(intent(seed, 'r1')).returning();
        Object.assign(values, {
          kind: 'reserve',
          balanceDelta: 0n,
          reservedDelta: 1n,
          intentId: row!.id,
        });
      }
      if ('code' in rule) {
        const ref =
          rule.code === 'deposit_bonus'
            ? await bonusRuleRef(tx, 'deposit_bonus')
            : { bonusRuleId: await seededRule(tx, rule.code), bonusRuleKind: rule.code };
        Object.assign(values, ref);
      }
      if ('kind' in rule) {
        Object.assign(values, { ...(await bonusRuleRef(tx, 'link_bonus')), bonusRuleKind: null });
      }
      if ('kindOnly' in rule) values.bonusRuleKind = 'link_bonus';
      await rejectsWith(
        tx.insert(tokenLedger).values(values as typeof tokenLedger.$inferInsert),
        '23514',
        'token_ledger_bonus_rule_check',
      );
    });
  });

  // the CHECK pins the kind the reference requires; the FK pins that the named rule is of it
  it('refuses a starter pack naming a referral_reward rule labelled link_bonus', async () => {
    await rolledBack(async (tx) => {
      const seed = await seedAccount(tx);
      await rejectsWith(
        tx.insert(tokenLedger).values({
          userId: seed.userId,
          kind: 'bonus',
          balanceDelta: 10n,
          brokerAccountId: seed.accountId,
          bonusRuleId: await seededRule(tx, 'referral_reward'),
          bonusRuleKind: 'link_bonus',
        }),
        '23503',
        'token_ledger_bonus_rule_fk',
      );
    });
  });
});

describe('token_ledger: the inviter’s reward (#116)', () => {
  const ruleOf = async (tx: Tx, code: string) => {
    const [row] = await tx
      .select({ id: bonusRules.id })
      .from(bonusRules)
      .where(sql`${bonusRules.code} = ${code} and ${bonusRules.version} = 1`);
    return { bonusRuleId: row!.id, bonusRuleKind: code as 'referral_reward' };
  };
  // an inviter with an account, an invitee, and the referral between them
  const seedReferral = async (tx: Tx) => {
    const inviter = await seedAccount(tx);
    const invitee = await seedAccount(tx);
    const [row] = await tx
      .insert(referrals)
      .values({ inviteeUserId: invitee.userId, inviterUserId: inviter.userId })
      .returning({ id: referrals.id });
    return { inviter, invitee, referralId: row!.id };
  };
  const reward = async (tx: Tx, userId: string, referralId: string) =>
    ({
      userId,
      kind: 'bonus',
      balanceDelta: 50n,
      referralId,
      ...(await ruleOf(tx, 'referral_reward')),
    }) as typeof tokenLedger.$inferInsert;

  it('accepts the reward on the inviter’s ledger beside the inviter’s own starter pack', async () => {
    await rolledBack(async (tx) => {
      const { inviter, referralId } = await seedReferral(tx);
      await tx.insert(tokenLedger).values(await reward(tx, inviter.userId, referralId));
      await tx.insert(tokenLedger).values({
        userId: inviter.userId,
        kind: 'bonus',
        balanceDelta: 100n,
        brokerAccountId: inviter.accountId,
        ...(await bonusRuleRef(tx, 'link_bonus')),
      });
    });
  });

  it('refuses a second reward of the same referral', async () => {
    await rolledBack(async (tx) => {
      const { inviter, referralId } = await seedReferral(tx);
      await tx.insert(tokenLedger).values(await reward(tx, inviter.userId, referralId));
      await rejectsWith(
        tx.insert(tokenLedger).values(await reward(tx, inviter.userId, referralId)),
        '23505',
        'token_ledger_referral_idx',
      );
    });
  });

  it.each([
    ['on the invitee’s ledger', 'invitee'],
    ['on a stranger’s ledger', 'stranger'],
    ['naming a referral that does not exist', 'missing'],
  ] as const)('refuses a reward %s', async (_label, whose) => {
    await rolledBack(async (tx) => {
      const { invitee, referralId } = await seedReferral(tx);
      const userId = whose === 'stranger' ? (await seedAccount(tx)).userId : invitee.userId;
      const row =
        whose === 'missing'
          ? { ...(await reward(tx, invitee.userId, referralId)), referralId: randomUUID() }
          : await reward(tx, userId, referralId);
      await rejectsWith(
        tx.insert(tokenLedger).values(row),
        '23503',
        'token_ledger_referral_inviter_fk',
      );
    });
  });

  it.each([
    ['under a link_bonus rule', { rule: 'link_bonus' }],
    ['under a deposit_bonus rule', { rule: 'deposit_bonus' }],
    ['with a NULL rule kind', { bonusRuleKind: null }],
    ['with a NULL rule id', { bonusRuleId: null }],
  ] as const)('refuses a reward %s', async (_label, patch) => {
    await rolledBack(async (tx) => {
      const { inviter, referralId } = await seedReferral(tx);
      const row: Record<string, unknown> = await reward(tx, inviter.userId, referralId);
      if ('rule' in patch) {
        Object.assign(
          row,
          patch.rule === 'deposit_bonus'
            ? await bonusRuleRef(tx, 'deposit_bonus')
            : await bonusRuleRef(tx, 'link_bonus'),
        );
      } else {
        Object.assign(row, patch);
      }
      await rejectsWith(
        tx.insert(tokenLedger).values(row as typeof tokenLedger.$inferInsert),
        '23514',
        'token_ledger_bonus_rule_check',
      );
    });
  });

  // the other reference passes token_ledger_bonus_rule_check under its own rule, so the one that
  // refuses the pair is the reference CHECK; each kind's branch gets its own row
  it.each([
    ['a bonus naming a referral and a broker account', 'account'],
    ['a bonus naming a referral and a deposit', 'deposit'],
    ['an adjustment naming a referral', 'adjustment'],
    ['a deposit purchase naming a referral', 'purchase'],
    ['a reserve naming a referral', 'reserve'],
    ['a Stars refund naming a referral', 'refund'],
  ] as const)('refuses %s', async (_label, shape) => {
    await rolledBack(async (tx) => {
      const { inviter, referralId } = await seedReferral(tx);
      const values: Record<string, unknown> = {
        userId: inviter.userId,
        balanceDelta: 10n,
        referralId,
      };
      if (shape === 'account') {
        Object.assign(values, {
          kind: 'bonus',
          brokerAccountId: inviter.accountId,
          ...(await bonusRuleRef(tx, 'link_bonus')),
        });
      }
      if (shape === 'deposit') {
        Object.assign(values, {
          kind: 'bonus',
          depositEventId: await seedDeposit(tx, inviter),
          ...(await bonusRuleRef(tx, 'deposit_bonus')),
        });
      }
      if (shape === 'adjustment') Object.assign(values, { kind: 'adjustment', note: 'n' });
      if (shape === 'purchase') {
        Object.assign(values, { kind: 'purchase', depositEventId: await seedDeposit(tx, inviter) });
      }
      if (shape === 'reserve') {
        const [row] = await tx.insert(tradeIntents).values(intent(inviter, 'r1')).returning();
        Object.assign(values, {
          kind: 'reserve',
          balanceDelta: 0n,
          reservedDelta: 1n,
          intentId: row!.id,
        });
      }
      if (shape === 'refund') {
        Object.assign(values, {
          kind: 'refund',
          balanceDelta: -1n,
          starPaymentId: await seedStarPayment(tx, inviter.userId),
        });
      }
      await rejectsWith(
        tx.insert(tokenLedger).values(values as typeof tokenLedger.$inferInsert),
        '23514',
        'token_ledger_reference_check',
      );
    });
  });

  it('refuses a zero-delta reward', async () => {
    await rolledBack(async (tx) => {
      const { inviter, referralId } = await seedReferral(tx);
      await rejectsWith(
        tx
          .insert(tokenLedger)
          .values({ ...(await reward(tx, inviter.userId, referralId)), balanceDelta: 0n }),
        '23514',
        'token_ledger_delta_check',
      );
    });
  });

  it('refuses a link_bonus rule id labelled referral_reward', async () => {
    await rolledBack(async (tx) => {
      const { inviter, referralId } = await seedReferral(tx);
      await rejectsWith(
        tx.insert(tokenLedger).values({
          ...(await reward(tx, inviter.userId, referralId)),
          bonusRuleId: (await bonusRuleRef(tx, 'link_bonus')).bonusRuleId,
        }),
        '23503',
        'token_ledger_bonus_rule_fk',
      );
    });
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
