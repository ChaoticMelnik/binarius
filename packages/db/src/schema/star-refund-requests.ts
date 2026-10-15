import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { id } from './columns';
import { starPayments } from './star-payments';

// A refund asked for from /paysupport (#118, docs/stars.md → /paysupport): a notice for the staff,
// one per payment. Its resolution is the payment's own status — `stars refund` refunds and records
// it there — so nothing updates or deletes a request; no trigger enforces that, no writer does it.
// The requester is the payer: requestStarRefund inserts by INSERT … SELECT on
// payer_telegram_user_id, so another Telegram id inserts nothing.
export const starRefundRequests = pgTable(
  'star_refund_requests',
  {
    id: id(),
    starPaymentId: uuid('star_payment_id').notNull(),
    requestedByTelegramUserId: bigint('requested_by_telegram_user_id', {
      mode: 'bigint',
    }).notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('star_refund_requests_payment_key').on(t.starPaymentId),
    foreignKey({
      name: 'star_refund_requests_payment_fk',
      columns: [t.starPaymentId],
      foreignColumns: [starPayments.id],
    }).onDelete('restrict'),
    check('star_refund_requests_requested_by_check', sql`${t.requestedByTelegramUserId} > 0`),
  ],
);
