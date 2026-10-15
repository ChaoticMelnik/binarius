import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  AuditAction,
  AuditActorType,
  AuditEntityType,
  BrokerAccountStatus,
  STARS_CURRENCY,
  StarPaymentHoldReason,
  StarPaymentStatus,
  TokenLedgerKind,
  UserStatus,
  starPackageOf,
} from '@binarius/shared';
import type { Db } from './client';
import { auditLog } from './schema/audit-log';
import { brokerAccounts } from './schema/broker-accounts';
import { starPayments } from './schema/star-payments';
import { tokenLedger } from './schema/token-ledger';
import { users } from './schema/users';
import type { Tx } from './trade-intent-ops';

// Buying tokens for Telegram Stars (#117, docs/stars.md): the credit, and the reads the invoice,
// the pre-checkout and the reconciler need.

export interface StarsBuyer {
  userId: string;
  status: UserStatus;
  hasActiveBrokerAccount: boolean;
}

// What the invoice and the pre-checkout routes check before Telegram charges anything: the user,
// their status and an active account. Reads only; undefined for a Telegram id with no users row.
export async function readStarsBuyer(
  db: Db,
  telegramUserId: bigint,
): Promise<StarsBuyer | undefined> {
  const [user] = await db
    .select({ id: users.id, status: users.status })
    .from(users)
    .where(eq(users.telegramUserId, telegramUserId));
  if (user === undefined) return undefined;
  const [account] = await db
    .select({ id: brokerAccounts.id })
    .from(brokerAccounts)
    .where(
      and(
        eq(brokerAccounts.userId, user.id),
        eq(brokerAccounts.status, BrokerAccountStatus.Active),
      ),
    )
    .limit(1);
  return { userId: user.id, status: user.status, hasActiveBrokerAccount: account !== undefined };
}

// The charge ids among `ids` already recorded: the reconciler credits only the others.
export async function listKnownStarCharges(db: Db, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: starPayments.telegramPaymentChargeId })
    .from(starPayments)
    .where(inArray(starPayments.telegramPaymentChargeId, [...ids]));
  return new Set(rows.map((row) => row.id));
}

// Who reported the payment: the bot's successful_payment or the reconciler. Recorded in the audit
// row only.
export const StarsCreditSource = { Bot: 'bot', Reconciler: 'reconciler' } as const;
export type StarsCreditSource = (typeof StarsCreditSource)[keyof typeof StarsCreditSource];

export interface StarPaymentInput {
  telegramPaymentChargeId: string;
  providerPaymentChargeId: string | null;
  // the invoice payload, parsed by its one parser (parseStarsInvoicePayload)
  packageCode: string;
  userId: string;
  currency: string;
  totalAmount: number;
  // the Telegram user who paid: the payload's user must be them (a forwarded invoice has a Pay
  // button too)
  payerTelegramUserId: bigint;
  paidAt: Date;
  source: StarsCreditSource;
}

export type StarPaymentCredit =
  | { outcome: 'credited'; paymentId: string; tokens: bigint; balance: bigint }
  | { outcome: 'held'; paymentId: string; reason: StarPaymentHoldReason }
  // the charge was recorded before: by the bot, its retry or the reconciler
  | {
      outcome: 'already_recorded';
      paymentId: string;
      status: StarPaymentStatus;
      tokens: bigint | null;
      balance: bigint;
    }
  // the payload names no users row: nothing can own the payment, so nothing is written
  | { outcome: 'user_unknown' };

// The first check the payment fails, in this order, with the package's tokens when it has one; or
// the tokens to credit.
type Verdict =
  | { credit: false; reason: StarPaymentHoldReason; tokens: bigint | null }
  | { credit: true; tokens: bigint };

function verdictOf(payment: StarPaymentInput, payerOfPayload: bigint): Verdict {
  const pack = starPackageOf(payment.packageCode);
  const tokens = pack?.tokens ?? null;
  if (payment.currency !== STARS_CURRENCY) {
    return { credit: false, reason: StarPaymentHoldReason.Currency, tokens };
  }
  if (pack === undefined) return { credit: false, reason: StarPaymentHoldReason.Package, tokens };
  if (payment.totalAmount !== pack.stars) {
    return { credit: false, reason: StarPaymentHoldReason.Amount, tokens };
  }
  if (payment.payerTelegramUserId !== payerOfPayload) {
    return { credit: false, reason: StarPaymentHoldReason.Payer, tokens };
  }
  return { credit: true, tokens: pack.tokens };
}

// The only writer of star_payments and of the Stars purchase rows of the ledger, and the sixth
// writer of the balance cache (Rule 2). Composed into the caller's transaction. Lock order (Rule 5):
// the payload's users row FOR NO KEY UPDATE first, then the star_payments insert (its FK takes KEY
// SHARE on the same row, compatible), the ledger row and the cache UPDATE. The charge id is the
// key: star_payments_charge_key makes the first insert the only one, so the bot's credit, its retry
// and the reconciler's credit of one charge credit once; token_ledger_star_payment_idx is the
// ledger's own guard behind it. A payment that fails a check is recorded once as `held`, with no
// ledger row, so the reconciler never meets it again and its audit row is written once.
export async function creditStarPayment(
  tx: Tx,
  payment: StarPaymentInput,
): Promise<StarPaymentCredit> {
  const [user] = await tx
    .select({ telegramUserId: users.telegramUserId, balance: users.tokenBalance })
    .from(users)
    .where(eq(users.id, payment.userId))
    .for('no key update');
  if (user === undefined) return { outcome: 'user_unknown' };

  const verdict = verdictOf(payment, user.telegramUserId);
  const [inserted] = await tx
    .insert(starPayments)
    .values({
      userId: payment.userId,
      telegramPaymentChargeId: payment.telegramPaymentChargeId,
      providerPaymentChargeId: payment.providerPaymentChargeId,
      packageCode: payment.packageCode,
      currency: payment.currency,
      totalAmount: payment.totalAmount,
      tokens: verdict.tokens,
      status: verdict.credit ? StarPaymentStatus.Paid : StarPaymentStatus.Held,
      paidAt: payment.paidAt,
    })
    .onConflictDoNothing({ target: starPayments.telegramPaymentChargeId })
    .returning({ id: starPayments.id });

  if (inserted === undefined) {
    const [stored] = await tx
      .select({ id: starPayments.id, status: starPayments.status, tokens: starPayments.tokens })
      .from(starPayments)
      .where(eq(starPayments.telegramPaymentChargeId, payment.telegramPaymentChargeId));
    // unreachable: the conflict that skipped the insert is this row
    if (stored === undefined) throw new Error('star payment conflict without a row');
    return {
      outcome: 'already_recorded',
      paymentId: stored.id,
      status: stored.status,
      tokens: stored.tokens,
      balance: user.balance,
    };
  }

  const audit = {
    actorType: AuditActorType.User,
    actorId: payment.payerTelegramUserId.toString(),
    entityType: AuditEntityType.StarPayment,
    entityId: inserted.id,
  };
  if (!verdict.credit) {
    await tx.insert(auditLog).values({
      ...audit,
      action: AuditAction.StarsPaymentHeld,
      payload: {
        userId: payment.userId,
        reason: verdict.reason,
        packageCode: payment.packageCode,
        currency: payment.currency,
        totalAmount: payment.totalAmount,
        via: payment.source,
      },
    });
    return { outcome: 'held', paymentId: inserted.id, reason: verdict.reason };
  }
  const { tokens } = verdict;

  await tx.insert(tokenLedger).values({
    userId: payment.userId,
    kind: TokenLedgerKind.Purchase,
    balanceDelta: tokens,
    starPaymentId: inserted.id,
  });
  const [after] = await tx
    .update(users)
    .set({ tokenBalance: sql`${users.tokenBalance} + ${tokens}` })
    .where(eq(users.id, payment.userId))
    .returning({ balance: users.tokenBalance });
  if (after === undefined) throw new Error('star payment credit lost its users row');
  await tx.insert(auditLog).values({
    ...audit,
    action: AuditAction.StarsPurchased,
    payload: {
      userId: payment.userId,
      packageCode: payment.packageCode,
      tokens: tokens.toString(),
      totalAmount: payment.totalAmount,
      via: payment.source,
    },
  });
  return { outcome: 'credited', paymentId: inserted.id, tokens, balance: after.balance };
}
