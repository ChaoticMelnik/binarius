import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { STAR_CHARGE_ID_MAX, STARS_CURRENCY, StarPaymentStatus } from '@binarius/shared';
import { createdAt, id, inList, literal, sqlTextLiteral } from './columns';
import { users } from './users';

// One row per Telegram Stars payment (#117, docs/stars.md), keyed by Telegram's charge id: the
// bot's successful_payment, its retry and the reconciler's credit all insert here first, and the
// one that inserts is the one that credits (creditStarPayment, star-payment-ops.ts). The price and
// the tokens are frozen here, so a deploy that changes STAR_PACKAGES rewrites no past purchase.
// No CHECK ties paid_at or refunded_at to created_at: paid_at is Telegram's clock, not ours (#158).
export const starPayments = pgTable(
  'star_payments',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    telegramPaymentChargeId: text('telegram_payment_charge_id').notNull(),
    // absent in a payment the reconciler found: a Star transaction carries none
    providerPaymentChargeId: text('provider_payment_charge_id'),
    // the payload's, as written: a package removed by a deploy is still named
    packageCode: text('package_code').notNull(),
    // what Telegram reported, checked against the package at credit time
    currency: text('currency').notNull(),
    totalAmount: integer('total_amount').notNull(),
    // credited tokens; the package's (or none) on a held payment
    tokens: bigint('tokens', { mode: 'bigint' }),
    // The Telegram user who paid, and the one a refund goes to (refundStarPayment refunds the
    // payer). Not always the users row's own account: a forwarded invoice is held with reason
    // `payer` (#118). Rows before 0048 were backfilled from their stars_purchased /
    // stars_payment_held audit row, whose actor is the payer.
    payerTelegramUserId: bigint('payer_telegram_user_id', { mode: 'bigint' }).notNull(),
    status: text('status').$type<StarPaymentStatus>().notNull(),
    paidAt: timestamp('paid_at', { withTimezone: true }).notNull(),
    refundedAt: timestamp('refunded_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('star_payments_charge_key').on(t.telegramPaymentChargeId),
    // FK target for token_ledger.star_payment_id
    unique('star_payments_id_user_key').on(t.id, t.userId),
    check(
      'star_payments_charge_id_check',
      sql`char_length(${t.telegramPaymentChargeId}) between 1 and ${sql.raw(String(STAR_CHARGE_ID_MAX))}`,
    ),
    check('star_payments_total_amount_check', sql`${t.totalAmount} > 0`),
    check('star_payments_payer_check', sql`${t.payerTelegramUserId} > 0`),
    check('star_payments_tokens_check', sql`${t.tokens} is null or ${t.tokens} > 0`),
    inList('star_payments_status_check', t.status, StarPaymentStatus),
    // a credited payment names its tokens and is in Stars; status is NOT NULL, so this never passes
    // on a NULL status
    check(
      'star_payments_paid_check',
      sql`${t.status} <> ${literal(StarPaymentStatus.Paid)} or (${t.tokens} is not null and ${t.currency} = ${sqlTextLiteral(STARS_CURRENCY, 'STARS_CURRENCY')})`,
    ),
    check(
      'star_payments_refund_pair_check',
      sql`(${t.status} = ${literal(StarPaymentStatus.Refunded)}) = (${t.refundedAt} is not null)`,
    ),
  ],
);
