import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { DecimalString } from '@binarius/shared';
import { createdAt, id, inList, nullablePositiveNumeric } from './columns';
import { brokerAccounts } from './broker-accounts';
import { users } from './users';

export const DepositEventStatus = {
  Received: 'received',
  Credited: 'credited',
  Ignored: 'ignored',
  Failed: 'failed',
} as const;
export type DepositEventStatus = (typeof DepositEventStatus)[keyof typeof DepositEventStatus];

// skeleton (#7): the postback contract is confirmed in #12; a postback is stored before it
// is credited and deduplicated by postback_id and payment_id
export const depositEvents = pgTable(
  'deposit_events',
  {
    id: id(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'restrict' }),
    brokerAccountId: uuid('broker_account_id').references(() => brokerAccounts.id, {
      onDelete: 'restrict',
    }),
    postbackId: text('postback_id').notNull(),
    paymentId: text('payment_id'),
    amount: numeric('amount', { precision: 20, scale: 8, mode: 'string' }).$type<DecimalString>(),
    currency: text('currency'),
    status: text('status')
      .$type<DepositEventStatus>()
      .notNull()
      .default(DepositEventStatus.Received),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    // when both are present the account must belong to the named user, or a postback
    // credits someone who did not pay
    foreignKey({
      name: 'deposit_events_account_owner_fk',
      columns: [t.brokerAccountId, t.userId],
      foreignColumns: [brokerAccounts.id, brokerAccounts.userId],
    }),
    // ...and the FK alone is not enough: it is MATCH SIMPLE, so it is satisfied whenever either
    // column is NULL. A claimed user must always name the account it was claimed through;
    // the unattributed postback (both NULL) and the account-without-user row stay legal.
    check(
      'deposit_events_owner_pair_check',
      sql`${t.userId} is null or ${t.brokerAccountId} is not null`,
    ),
    // FK target for token_ledger.deposit_event_id
    unique('deposit_events_id_user_key').on(t.id, t.userId),
    nullablePositiveNumeric('deposit_events_amount_check', t.amount),
    uniqueIndex('deposit_events_postback_id_idx').on(t.postbackId),
    uniqueIndex('deposit_events_payment_id_idx')
      .on(t.paymentId)
      .where(sql`${t.paymentId} is not null`),
    index('deposit_events_user_id_idx').on(t.userId),
    index('deposit_events_broker_account_id_idx').on(t.brokerAccountId),
    inList('deposit_events_status_check', t.status, DepositEventStatus),
  ],
);
