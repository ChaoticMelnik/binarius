import { sql } from 'drizzle-orm';
import { check, foreignKey, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { brokerAccounts } from './broker-accounts';

// Which worker process may hold the broker socket of an account (#93, docs/broker-session.md →
// The lease). One row per account, ever: a dead owner's row is overwritten by the next acquire,
// and only its owner deletes it. Written only by session-lease-ops.ts, each operation one
// autocommit statement outside the users → broker_accounts → trade_intents lock chain; the
// times are the database clock.
export const brokerSessionLeases = pgTable(
  'broker_session_leases',
  {
    brokerAccountId: uuid('broker_account_id').primaryKey(),
    // the process instance, a fresh uuid per manager: a restarted container is a new owner and
    // inherits no lease it cannot prove it still fences
    ownerId: uuid('owner_id').notNull(),
    acquiredAt: timestamp('acquired_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    foreignKey({
      name: 'broker_session_leases_account_fk',
      columns: [t.brokerAccountId],
      foreignColumns: [brokerAccounts.id],
    }).onDelete('restrict'),
    check('broker_session_leases_expiry_check', sql`${t.expiresAt} > ${t.acquiredAt}`),
  ],
);

export type BrokerSessionLeaseRow = typeof brokerSessionLeases.$inferSelect;
