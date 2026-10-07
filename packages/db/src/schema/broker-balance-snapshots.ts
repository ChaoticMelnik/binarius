import { sql } from 'drizzle-orm';
import { check, foreignKey, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { createdAt, inList, money, nonNegativeNumeric, updatedAt } from './columns';
import { brokerAccounts } from './broker-accounts';

// Why the last refresh of a snapshot failed. Broker-side codes mirror BrokerRestErrorCode
// (@binarius/broker-rest) without `aborted`, which is our own limit and never recorded;
// account_* and key_unavailable come from the access-token lookup.
export const BalanceRefreshError = {
  Unauthorized: 'unauthorized',
  RateLimited: 'rate_limited',
  Rejected: 'rejected',
  Unavailable: 'unavailable',
  ContractViolation: 'contract_violation',
  AccountMismatch: 'account_mismatch',
  AccountPending: 'account_pending',
  AccountRevoked: 'account_revoked',
  KeyUnavailable: 'key_unavailable',
} as const;
export type BalanceRefreshError = (typeof BalanceRefreshError)[keyof typeof BalanceRefreshError];

// level.rank is a JSON number the broker sends that is not money: the broker_trades.payout shape
export const LEVEL_RANK_INTEGER_DIGITS = 4;
export const LEVEL_RANK_SCALE = 4;
// level_code has no CHECK: upsertBalanceSnapshot bounds it (balance-snapshot-ops.ts)
export const LEVEL_CODE_MAX_LENGTH = 64;

// The broker's balance for one account, as last seen. Written only by balance-snapshot-ops.ts,
// each operation one autocommit statement outside the users → broker_accounts → trade_intents
// lock chain. Amounts are stored as the broker sent them: total = available + held is not
// checked, because that is a rule of the mock's fixtures, not something observed live.
// *_observed_at / *_event_at are the database clock at the write.
export const brokerBalanceSnapshots = pgTable(
  'broker_balance_snapshots',
  {
    brokerAccountId: uuid('broker_account_id').primaryKey(),
    realAvailable: money('real_available').notNull(),
    realHeld: money('real_held').notNull(),
    realTotal: money('real_total').notNull(),
    demoAvailable: money('demo_available').notNull(),
    demoHeld: money('demo_held').notNull(),
    demoTotal: money('demo_total').notNull(),
    minTradeAmount: money('min_trade_amount').notNull(),
    levelCode: text('level_code').notNull(),
    levelRank: numeric('level_rank', {
      precision: LEVEL_RANK_INTEGER_DIGITS + LEVEL_RANK_SCALE,
      scale: LEVEL_RANK_SCALE,
      mode: 'number',
    }).notNull(),
    restObservedAt: timestamp('rest_observed_at', { withTimezone: true }).notNull(),
    // set by the session manager's writers (#101); NULL until one of them runs
    realEventAt: timestamp('real_event_at', { withTimezone: true }),
    demoEventAt: timestamp('demo_event_at', { withTimezone: true }),
    lastRequestedAt: timestamp('last_requested_at', { withTimezone: true }),
    lastRefreshError: text('last_refresh_error').$type<BalanceRefreshError>(),
    lastRefreshFailedAt: timestamp('last_refresh_failed_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // named: the generated name is 64 characters and PostgreSQL would cut it to 63
    foreignKey({
      name: 'broker_balance_snapshots_account_fk',
      columns: [t.brokerAccountId],
      foreignColumns: [brokerAccounts.id],
    }).onDelete('restrict'),
    nonNegativeNumeric('broker_balance_snapshots_real_available_check', t.realAvailable),
    nonNegativeNumeric('broker_balance_snapshots_real_held_check', t.realHeld),
    nonNegativeNumeric('broker_balance_snapshots_real_total_check', t.realTotal),
    nonNegativeNumeric('broker_balance_snapshots_demo_available_check', t.demoAvailable),
    nonNegativeNumeric('broker_balance_snapshots_demo_held_check', t.demoHeld),
    nonNegativeNumeric('broker_balance_snapshots_demo_total_check', t.demoTotal),
    nonNegativeNumeric('broker_balance_snapshots_min_trade_amount_check', t.minTradeAmount),
    nonNegativeNumeric('broker_balance_snapshots_level_rank_check', t.levelRank),
    inList(
      'broker_balance_snapshots_last_refresh_error_check',
      t.lastRefreshError,
      BalanceRefreshError,
    ),
    check(
      'broker_balance_snapshots_failure_pair_check',
      sql`(${t.lastRefreshError} is null) = (${t.lastRefreshFailedAt} is null)`,
    ),
  ],
);
