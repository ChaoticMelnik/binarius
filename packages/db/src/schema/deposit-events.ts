import { DepositEventStatus, PostbackSource } from '@binarius/shared';
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, id, inList, money, positiveNumeric } from './columns';
import { brokerAccounts } from './broker-accounts';
import { users } from './users';

// One row per payment of a source (#141, docs/postbacks.md): the Deposit and the FTD postback of
// one payment, and any re-delivery, land on the same row. Each delivery itself — its postback id,
// event and raw query — is a row of postback_deliveries. Nothing credits yet (#386).
// Not enforced here, and #386's to enforce at credit time: `status` and `amount` stay mutable
// after a token_ledger row references the deposit, and a deposit in `failed`/`ignored` can
// still be credited — the FK keys on (id, user_id), not on status.
export const depositEvents = pgTable(
  'deposit_events',
  {
    id: id(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'restrict' }),
    brokerAccountId: uuid('broker_account_id').references(() => brokerAccounts.id, {
      onDelete: 'restrict',
    }),
    source: text('source').$type<PostbackSource>().notNull(),
    // the postback's trader id (macro `a`); kept on an unattributed row, which activation of the
    // account with this broker_user_id attaches (attachDepositsToAccount)
    brokerUserId: text('broker_user_id').notNull(),
    paymentId: text('payment_id').notNull(),
    amount: money('amount').notNull(),
    // the `coin` macro as delivered, NULL when absent
    currency: text('currency'),
    status: text('status')
      .$type<DepositEventStatus>()
      .notNull()
      .default(DepositEventStatus.Received),
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
    // the account must be the one of the trader the postback named: an attributed deposit cannot
    // sit on a card whose broker_user_id differs from its own
    foreignKey({
      name: 'deposit_events_account_trader_fk',
      columns: [t.brokerAccountId, t.brokerUserId],
      foreignColumns: [brokerAccounts.id, brokerAccounts.brokerUserId],
    }),
    // ...and the FKs alone are not enough: it is MATCH SIMPLE, so it is satisfied whenever either
    // column is NULL. A claimed user must always name the account it was claimed through;
    // the unattributed postback (both NULL) and the account-without-user row stay legal.
    check(
      'deposit_events_owner_pair_check',
      sql`${t.userId} is null or ${t.brokerAccountId} is not null`,
    ),
    // FK target for token_ledger.deposit_event_id
    unique('deposit_events_id_user_key').on(t.id, t.userId),
    positiveNumeric('deposit_events_amount_check', t.amount),
    inList('deposit_events_source_check', t.source, PostbackSource),
    // one deposit per payment: the Deposit and the FTD postback of one payment cannot make two
    uniqueIndex('deposit_events_source_payment_idx').on(t.source, t.paymentId),
    index('deposit_events_user_id_idx').on(t.userId),
    index('deposit_events_broker_account_id_idx').on(t.brokerAccountId),
    index('deposit_events_broker_user_id_idx').on(t.brokerUserId),
    inList('deposit_events_status_check', t.status, DepositEventStatus),
  ],
);
