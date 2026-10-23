import { and, asc, desc, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';
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
  STARS_PAYSUPPORT_LIST_LIMIT,
  type AdminStarPaymentView,
  type StarPaymentView,
} from '@binarius/shared';
import type { Db } from './client';
import { auditLog } from './schema/audit-log';
import { brokerAccounts } from './schema/broker-accounts';
import { starPayments } from './schema/star-payments';
import { starRefundRequests } from './schema/star-refund-requests';
import { tokenLedger } from './schema/token-ledger';
import { users } from './schema/users';
import type { DbExecutor, Tx } from './trade-intent-ops';

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

// The only writer that inserts star_payments rows and of the Stars purchase rows of the ledger, and
// the sixth writer of the balance cache (Rule 2); the refund is recordStarRefund's (#118). Composed into the caller's transaction. Lock order (Rule 5):
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
      payerTelegramUserId: payment.payerTelegramUserId,
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

// --- Refunds (#118, docs/stars.md → Refunds) ---------------------------------------------------

// Who records a refund: `stars refund` after Telegram's answer, the reconciler that saw the
// refund among the bot's Star transactions, or a staff member in the admin (#510). Recorded in the
// audit row only.
export const StarsRefundSource = { Cli: 'cli', Reconciler: 'reconciler', Admin: 'admin' } as const;
export type StarsRefundSource = (typeof StarsRefundSource)[keyof typeof StarsRefundSource];

// What told us the Stars went back: refundStarPayment's `true`, its CHARGE_ALREADY_REFUNDED
// refusal, or the outgoing transaction the reconciler read.
export const StarsRefundEvidence = {
  Refunded: 'refunded',
  AlreadyRefunded: 'already_refunded',
  Transaction: 'transaction',
} as const;
export type StarsRefundEvidence = (typeof StarsRefundEvidence)[keyof typeof StarsRefundEvidence];

export interface StarRefundInput {
  telegramPaymentChargeId: string;
  source: StarsRefundSource;
  telegramAnswer: StarsRefundEvidence;
  // the reconciler's: the transaction's receiver, which must be the payer
  receiverTelegramUserId?: bigint;
  // the reconciler's: the receiver's transaction_type as Telegram gave it, kept for the owner's
  // check of what a refund looks like (docs/stars.md → Refunds, assumption 1)
  transactionType?: string;
  // the CLI's --reason
  reason?: string;
}

export type StarRefundRecord =
  | {
      outcome: 'refunded';
      paymentId: string;
      userId: string;
      payerTelegramUserId: bigint;
      packageCode: string;
      totalAmount: number;
      fromStatus: typeof StarPaymentStatus.Paid | typeof StarPaymentStatus.Held;
      taken: bigint;
      notRecovered: bigint;
      balance: bigint;
    }
  // recorded before, by the CLI or the reconciler: nothing written
  | { outcome: 'already_recorded'; paymentId: string; refundedAt: Date }
  // the transaction's receiver is not the payer: nothing written, a person looks
  | { outcome: 'receiver_mismatch'; paymentId: string }
  | { outcome: 'not_found' };

// The only writer of the refund state of star_payments and of the `refund` rows of the ledger, and
// the seventh writer of the balance cache (Rule 2). Composed into the caller's transaction, which
// holds no other lock: Telegram is never called inside it. Lock order (Rule 5): the payment's
// users row FOR NO KEY UPDATE, then the payment row FOR NO KEY UPDATE (compatible with the KEY
// SHARE that the FKs of token_ledger and star_refund_requests take), then the ledger row and the
// cache. The barrier against a second record — a CLI repeat, the CLI racing the reconciler, two
// ticks — is the status read under that lock and the CAS on it; token_ledger_star_payment_idx is
// the second barrier on the ledger side, and the only one a refund that takes no token lacks.
// It writes no audit row: its callers do, in the same transaction (recordStarRefundBySystem,
// recordStarRefundByStaff), so the row names who recorded the refund (#510).
// What is taken is what is left of the payment's tokens and available now (balance − reserved):
// tokens already spent are not recovered, and a reserve held by a live intent is never touched.
export async function recordStarRefund(tx: Tx, input: StarRefundInput): Promise<StarRefundRecord> {
  // user_id never changes, so it may be read before the lock that orders by it
  const [owner] = await tx
    .select({ userId: starPayments.userId })
    .from(starPayments)
    .where(eq(starPayments.telegramPaymentChargeId, input.telegramPaymentChargeId));
  if (owner === undefined) return { outcome: 'not_found' };

  const [user] = await tx
    .select({ balance: users.tokenBalance, reserved: users.tokenReserved })
    .from(users)
    .where(eq(users.id, owner.userId))
    .for('no key update');
  // unreachable: star_payments.user_id is a restrict FK and users rows are never deleted
  if (user === undefined) throw new Error('star refund lost its users row');

  const [payment] = await tx
    .select()
    .from(starPayments)
    .where(eq(starPayments.telegramPaymentChargeId, input.telegramPaymentChargeId))
    .for('no key update');
  if (payment === undefined) throw new Error('star refund lost its payment row');

  if (payment.status === StarPaymentStatus.Refunded) {
    // the pair CHECK keeps refunded_at set on a refunded row
    return { outcome: 'already_recorded', paymentId: payment.id, refundedAt: payment.refundedAt! };
  }
  if (
    input.receiverTelegramUserId !== undefined &&
    input.receiverTelegramUserId !== payment.payerTelegramUserId
  ) {
    return { outcome: 'receiver_mismatch', paymentId: payment.id };
  }

  const fromStatus = payment.status;
  const credited = fromStatus === StarPaymentStatus.Paid ? (payment.tokens ?? 0n) : 0n;
  // never negative: users_token_reserved_check
  const available = user.balance - user.reserved;
  const taken = credited < available ? credited : available;
  const notRecovered = credited - taken;

  let balance = user.balance;
  if (taken > 0n) {
    await tx.insert(tokenLedger).values({
      userId: payment.userId,
      kind: TokenLedgerKind.Refund,
      balanceDelta: -taken,
      starPaymentId: payment.id,
    });
    const [after] = await tx
      .update(users)
      .set({ tokenBalance: sql`${users.tokenBalance} - ${taken}` })
      .where(
        and(
          eq(users.id, payment.userId),
          sql`${users.tokenBalance} - ${taken} >= ${users.tokenReserved}`,
        ),
      )
      .returning({ balance: users.tokenBalance });
    // unreachable under the users lock: the cache moved under it, so the read above is wrong
    if (after === undefined) throw new Error('star refund: the balance cache diverged');
    balance = after.balance;
  }

  const [refunded] = await tx
    .update(starPayments)
    .set({ status: StarPaymentStatus.Refunded, refundedAt: sql`now()` })
    .where(
      and(
        eq(starPayments.id, payment.id),
        inArray(starPayments.status, [StarPaymentStatus.Paid, StarPaymentStatus.Held]),
      ),
    )
    .returning({ id: starPayments.id });
  // unreachable under the payment lock: the status was read as paid or held
  if (refunded === undefined) throw new Error('star refund: the payment changed under its lock');

  return {
    outcome: 'refunded',
    paymentId: payment.id,
    userId: payment.userId,
    payerTelegramUserId: payment.payerTelegramUserId,
    packageCode: payment.packageCode,
    totalAmount: payment.totalAmount,
    fromStatus,
    taken,
    notRecovered,
    balance,
  };
}

type RecordedRefund = Extract<StarRefundRecord, { outcome: 'refunded' }>;

// The one payload of a recorded refund's stars_refunded row, whoever writes it. Amounts as strings
// (Rule 2).
export function starsRefundedPayload(
  input: StarRefundInput,
  record: RecordedRefund,
): Record<string, unknown> {
  return {
    userId: record.userId,
    payerTelegramUserId: record.payerTelegramUserId.toString(),
    fromStatus: record.fromStatus,
    packageCode: record.packageCode,
    totalAmount: record.totalAmount,
    tokensTaken: record.taken.toString(),
    tokensNotRecovered: record.notRecovered.toString(),
    via: input.source,
    telegramAnswer: input.telegramAnswer,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.transactionType === undefined ? {} : { transactionType: input.transactionType }),
  };
}

// The CLI's and the reconciler's record: the writer and its row, actor `system`.
export async function recordStarRefundBySystem(
  tx: Tx,
  input: StarRefundInput,
): Promise<StarRefundRecord> {
  const record = await recordStarRefund(tx, input);
  if (record.outcome === 'refunded') {
    await tx.insert(auditLog).values({
      actorType: AuditActorType.System,
      actorId: null,
      action: AuditAction.StarsRefunded,
      entityType: AuditEntityType.StarPayment,
      entityId: record.paymentId,
      payload: starsRefundedPayload(input, record),
    });
  }
  return record;
}

export interface StaffRefundActor {
  staffId: string;
  sessionId: string;
  path: string;
}

export interface StaffStarRefundInput {
  telegramPaymentChargeId: string;
  reason: string;
  // null: Telegram was not asked, the payment was read as refunded already
  telegramAnswer:
    typeof StarsRefundEvidence.Refunded | typeof StarsRefundEvidence.AlreadyRefunded | null;
}

// The admin's record (#510): the writer and one row by the staff member, for a refund recorded
// now and for one recorded before. receiver_mismatch and not_found write nothing: the admin gives
// no receiver and has read the payment, so the route treats them as a failure.
export async function recordStarRefundByStaff(
  tx: Tx,
  input: StaffStarRefundInput,
  actor: StaffRefundActor,
): Promise<StarRefundRecord> {
  const record = await recordStarRefund(tx, {
    telegramPaymentChargeId: input.telegramPaymentChargeId,
    source: StarsRefundSource.Admin,
    telegramAnswer: input.telegramAnswer ?? StarsRefundEvidence.AlreadyRefunded,
    reason: input.reason,
  });
  if (record.outcome === 'refunded') {
    // unreachable: refunded is the last status, and the route asks Telegram unless it read it
    if (input.telegramAnswer === null) throw new Error('a refund recorded without an answer');
    await writeStaffRefundRow(tx, actor, {
      result: 'refunded',
      paymentId: record.paymentId,
      payload: starsRefundedPayload(
        {
          telegramPaymentChargeId: input.telegramPaymentChargeId,
          source: StarsRefundSource.Admin,
          telegramAnswer: input.telegramAnswer,
          reason: input.reason,
        },
        record,
      ),
    });
  } else if (record.outcome === 'already_recorded') {
    await writeStaffRefundRow(tx, actor, {
      result: 'already_recorded',
      paymentId: record.paymentId,
      payload: {
        via: StarsRefundSource.Admin,
        ...(input.telegramAnswer === null ? {} : { telegramAnswer: input.telegramAnswer }),
      },
    });
  }
  return record;
}

export type StaffRefundAttemptResult = 'refused' | 'unknown' | 'not_found';

// A staff member's refund that recorded nothing (#510): Telegram refused, its answer told nothing,
// or no such payment. The row names the attempt; no amounts, since none moved.
export async function recordStarRefundAttemptByStaff(
  db: DbExecutor,
  actor: StaffRefundActor,
  attempt: { result: StaffRefundAttemptResult; paymentId?: string; telegramErrorCode?: number },
): Promise<void> {
  await writeStaffRefundRow(db, actor, {
    result: attempt.result,
    paymentId: attempt.paymentId,
    payload: {
      via: StarsRefundSource.Admin,
      ...(attempt.telegramErrorCode === undefined
        ? {}
        : { telegramErrorCode: attempt.telegramErrorCode }),
    },
  });
}

async function writeStaffRefundRow(
  db: DbExecutor,
  actor: StaffRefundActor,
  row: { result: string; paymentId: string | undefined; payload: Record<string, unknown> },
): Promise<void> {
  await db.insert(auditLog).values({
    actorType: AuditActorType.Admin,
    actorId: actor.staffId,
    action: AuditAction.StarsRefunded,
    entityType: AuditEntityType.StarPayment,
    entityId: row.paymentId ?? null,
    payload: {
      path: actor.path,
      result: row.result,
      sessionId: actor.sessionId,
      ...(row.paymentId === undefined ? {} : { paymentId: row.paymentId }),
      ...row.payload,
    },
  });
}

export interface StarPaymentRow {
  id: string;
  userId: string;
  telegramPaymentChargeId: string;
  payerTelegramUserId: bigint;
  packageCode: string;
  totalAmount: number;
  tokens: bigint | null;
  status: StarPaymentStatus;
  paidAt: Date;
  refundedAt: Date | null;
}

const starPaymentColumns = {
  id: starPayments.id,
  userId: starPayments.userId,
  telegramPaymentChargeId: starPayments.telegramPaymentChargeId,
  payerTelegramUserId: starPayments.payerTelegramUserId,
  packageCode: starPayments.packageCode,
  totalAmount: starPayments.totalAmount,
  tokens: starPayments.tokens,
  status: starPayments.status,
  paidAt: starPayments.paidAt,
  refundedAt: starPayments.refundedAt,
};

export interface AdminStarPaymentRow extends StarPaymentRow {
  requestedAt: Date | null;
}

// The admin refund's read before it calls Telegram (#510), by the payment's id: advisory, as
// readStarPaymentByCharge.
export async function readStarPaymentById(
  db: DbExecutor,
  id: string,
): Promise<AdminStarPaymentRow | undefined> {
  const [row] = await db
    .select({ ...starPaymentColumns, requestedAt: starRefundRequests.requestedAt })
    .from(starPayments)
    .leftJoin(starRefundRequests, eq(starRefundRequests.starPaymentId, starPayments.id))
    .where(eq(starPayments.id, id));
  return row;
}

// The user card's «Оплаты Stars» (#510): the user's newest payments, by the owner (users row), with
// the /paysupport request's time when one was made.
export async function listStarPaymentsForAdmin(
  tx: Tx,
  userId: string,
  limit: number,
): Promise<AdminStarPaymentRow[]> {
  return tx
    .select({ ...starPaymentColumns, requestedAt: starRefundRequests.requestedAt })
    .from(starPayments)
    .leftJoin(starRefundRequests, eq(starRefundRequests.starPaymentId, starPayments.id))
    .where(eq(starPayments.userId, userId))
    .orderBy(desc(starPayments.paidAt), desc(starPayments.id))
    .limit(limit);
}

// Key by key, the row is never spread (Rule 9).
export function toAdminStarPaymentView(
  row: StarPaymentRow,
  requestedAt: Date | null,
): AdminStarPaymentView {
  return {
    id: row.id,
    userId: row.userId,
    telegramPaymentChargeId: row.telegramPaymentChargeId,
    payerTelegramUserId: row.payerTelegramUserId.toString(),
    packageCode: row.packageCode,
    totalAmount: row.totalAmount,
    tokens: row.tokens === null ? null : row.tokens.toString(),
    status: row.status,
    paidAt: row.paidAt.toISOString(),
    refundedAt: row.refundedAt === null ? null : row.refundedAt.toISOString(),
    requestedAt: requestedAt === null ? null : requestedAt.toISOString(),
  };
}

// `stars refund`'s read before it calls Telegram, without a lock: advisory, the record re-reads
// under its lock.
export async function readStarPaymentByCharge(
  db: Db,
  telegramPaymentChargeId: string,
): Promise<StarPaymentRow | undefined> {
  const [row] = await db
    .select(starPaymentColumns)
    .from(starPayments)
    .where(eq(starPayments.telegramPaymentChargeId, telegramPaymentChargeId));
  return row;
}

// The charge ids among `ids` whose payment is paid or held: the refunds the reconciler records.
export async function listStarChargesToRefund(
  db: Db,
  ids: readonly string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: starPayments.telegramPaymentChargeId })
    .from(starPayments)
    .where(
      and(
        inArray(starPayments.telegramPaymentChargeId, [...ids]),
        inArray(starPayments.status, [StarPaymentStatus.Paid, StarPaymentStatus.Held]),
      ),
    );
  return new Set(rows.map((row) => row.id));
}

// /paysupport's list: the payer's newest payments (Rule 13: scoped by the payer, not by the users
// row, so a forwarded invoice's payer sees the payment they made).
export async function listStarPaymentsForPayer(
  db: Db,
  payerTelegramUserId: bigint,
): Promise<StarPaymentView[]> {
  const rows = await db
    .select({
      id: starPayments.id,
      paidAt: starPayments.paidAt,
      packageCode: starPayments.packageCode,
      totalAmount: starPayments.totalAmount,
      status: starPayments.status,
      requestId: starRefundRequests.id,
    })
    .from(starPayments)
    .leftJoin(starRefundRequests, eq(starRefundRequests.starPaymentId, starPayments.id))
    .where(eq(starPayments.payerTelegramUserId, payerTelegramUserId))
    .orderBy(desc(starPayments.paidAt), desc(starPayments.id))
    .limit(STARS_PAYSUPPORT_LIST_LIMIT);
  return rows.map((row) => ({
    id: row.id,
    paidAt: Math.floor(row.paidAt.getTime() / 1000),
    packageCode: row.packageCode,
    totalAmount: row.totalAmount,
    status: row.status,
    requested: row.requestId !== null,
  }));
}

export type StarRefundRequestResult =
  | { outcome: 'requested'; payment: StarPaymentRow }
  | { outcome: 'already_requested' }
  | { outcome: 'already_refunded' }
  // no payment by that id, or another payer's: one answer for both (Rule 13)
  | { outcome: 'not_found' };

// The «Нужен возврат» button. One statement decides who may ask: the INSERT … SELECT matches only
// the payer's own payment that is not refunded, and the unique key keeps one request per payment.
// The audit row is written with the request, in its transaction.
export async function requestStarRefund(
  db: Db,
  { telegramUserId, paymentId }: { telegramUserId: bigint; paymentId: string },
): Promise<StarRefundRequestResult> {
  return db.transaction(async (tx) => {
    const { rows } = await tx.execute<{ id: string }>(sql`
      insert into ${starRefundRequests} (star_payment_id, requested_by_telegram_user_id)
      select ${starPayments.id}, ${telegramUserId} from ${starPayments}
       where ${starPayments.id} = ${paymentId}
         and ${starPayments.payerTelegramUserId} = ${telegramUserId}
         and ${starPayments.status} <> ${StarPaymentStatus.Refunded}
      on conflict (star_payment_id) do nothing
      returning id`);
    const [payment] = await tx
      .select(starPaymentColumns)
      .from(starPayments)
      .where(
        and(eq(starPayments.id, paymentId), eq(starPayments.payerTelegramUserId, telegramUserId)),
      );
    if (rows[0] === undefined) {
      if (payment === undefined) return { outcome: 'not_found' };
      if (payment.status === StarPaymentStatus.Refunded) return { outcome: 'already_refunded' };
      return { outcome: 'already_requested' };
    }
    // unreachable: the insert selected this row
    if (payment === undefined) throw new Error('star refund request without its payment');
    await tx.insert(auditLog).values({
      actorType: AuditActorType.User,
      actorId: telegramUserId.toString(),
      action: AuditAction.StarsRefundRequested,
      entityType: AuditEntityType.StarPayment,
      entityId: payment.id,
      payload: { userId: payment.userId, status: payment.status, requestId: rows[0].id },
    });
    return { outcome: 'requested', payment };
  });
}

export interface OpenStarRefundRequest {
  requestId: string;
  requestedAt: Date;
  payment: StarPaymentRow;
}

export const STAR_REFUND_REQUESTS_LIST_LIMIT = 50;

// The requests whose payment is not refunded yet, oldest first: `stars requests` (one page of
// STAR_REFUND_REQUESTS_LIST_LIMIT) and the admin's page (#510, keyset by the request's id).
export async function listOpenStarRefundRequests(
  db: DbExecutor,
  options: { cursor?: string; limit: number },
): Promise<{ rows: OpenStarRefundRequest[]; nextCursor: string | null }> {
  const conditions: SQL[] = [ne(starPayments.status, StarPaymentStatus.Refunded)];
  if (options.cursor !== undefined) {
    conditions.push(
      sql`(${starRefundRequests.requestedAt}, ${starRefundRequests.id}) > (select c.requested_at, c.id from ${starRefundRequests} as c where c.id = ${options.cursor})`,
    );
  }
  const rows = await db
    .select({
      requestId: starRefundRequests.id,
      requestedAt: starRefundRequests.requestedAt,
      payment: starPaymentColumns,
    })
    .from(starRefundRequests)
    .innerJoin(starPayments, eq(starPayments.id, starRefundRequests.starPaymentId))
    .where(and(...conditions))
    .orderBy(asc(starRefundRequests.requestedAt), asc(starRefundRequests.id))
    .limit(options.limit + 1);
  const page = rows.slice(0, options.limit);
  const last = page.at(-1);
  return {
    rows: page,
    nextCursor: rows.length > options.limit && last !== undefined ? last.requestId : null,
  };
}
