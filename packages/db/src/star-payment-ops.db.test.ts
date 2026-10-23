import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AuditAction,
  BrokerAccountStatus,
  StarPaymentHoldReason,
  StarPaymentStatus,
  TokenLedgerKind,
  UserStatus,
} from '@binarius/shared';
import { until } from '@binarius/shared/testing';
import {
  createTempDatabase,
  lockWaiters,
  seedBrokerAccount,
  seedUser,
  type SeededUser,
  type TempDatabase,
} from './testing';
import { auditLog, starPayments, starRefundRequests, tokenLedger, users } from './schema/index';
import {
  creditStarPayment,
  listKnownStarCharges,
  listOpenStarRefundRequests,
  listStarChargesToRefund,
  listStarPaymentsForAdmin,
  listStarPaymentsForPayer,
  readStarPaymentByCharge,
  readStarPaymentById,
  readStarsBuyer,
  recordStarRefund,
  recordStarRefundBySystem,
  STAR_REFUND_REQUESTS_LIST_LIMIT,
  requestStarRefund,
  StarsCreditSource,
  StarsRefundEvidence,
  StarsRefundSource,
  type StarPaymentInput,
  type StarRefundInput,
} from './star-payment-ops';

const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for packages/db integration tests (see README → Test database)',
  );
}

let tmp: TempDatabase;
beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
});
afterAll(() => tmp.drop());

let seq = 0;
const PAID_AT = new Date('2026-10-15T01:00:00.000Z');

// the 50-token package at its price, paid by the payload's own user
const paymentOf = (user: SeededUser, patch: Partial<StarPaymentInput> = {}): StarPaymentInput => ({
  telegramPaymentChargeId: `charge-${++seq}`,
  providerPaymentChargeId: null,
  packageCode: 'p50',
  userId: user.userId,
  currency: 'XTR',
  totalAmount: 100,
  payerTelegramUserId: BigInt(user.telegramUserId),
  paidAt: PAID_AT,
  source: StarsCreditSource.Bot,
  ...patch,
});

const credit = (payment: StarPaymentInput) =>
  tmp.db.transaction((tx) => creditStarPayment(tx, payment));

const ledgerOf = (userId: string) =>
  tmp.db.select().from(tokenLedger).where(eq(tokenLedger.userId, userId));

async function balanceOf(userId: string): Promise<bigint> {
  const [row] = await tmp.db
    .select({ balance: users.tokenBalance })
    .from(users)
    .where(eq(users.id, userId));
  return row!.balance;
}

const auditOf = (paymentId: string) =>
  tmp.db.select().from(auditLog).where(eq(auditLog.entityId, paymentId));

describe('creditStarPayment', () => {
  it('credits a payment: one paid row, one purchase row, the balance and one audit row', async () => {
    const user = await seedUser(tmp.db, { balance: 0n });
    const result = await credit(paymentOf(user));
    expect(result).toMatchObject({ outcome: 'credited', tokens: 50n, balance: 50n });
    if (result.outcome !== 'credited') throw new Error(result.outcome);

    const [row] = await tmp.db
      .select()
      .from(starPayments)
      .where(eq(starPayments.id, result.paymentId));
    expect(row).toMatchObject({
      userId: user.userId,
      packageCode: 'p50',
      currency: 'XTR',
      totalAmount: 100,
      tokens: 50n,
      status: StarPaymentStatus.Paid,
      paidAt: PAID_AT,
      refundedAt: null,
    });
    expect(await ledgerOf(user.userId)).toEqual([
      expect.objectContaining({
        kind: TokenLedgerKind.Purchase,
        balanceDelta: 50n,
        reservedDelta: 0n,
        starPaymentId: result.paymentId,
        depositEventId: null,
      }),
    ]);
    expect(await balanceOf(user.userId)).toBe(50n);
    expect(await auditOf(result.paymentId)).toEqual([
      expect.objectContaining({
        action: AuditAction.StarsPurchased,
        actorId: user.telegramUserId,
        payload: {
          userId: user.userId,
          packageCode: 'p50',
          tokens: '50',
          totalAmount: 100,
          via: StarsCreditSource.Bot,
        },
      }),
    ]);
  });

  // S1: the acceptance criterion of #117
  it('S1 credits the same charge once when it is delivered twice', async () => {
    const user = await seedUser(tmp.db, { balance: 0n });
    const payment = paymentOf(user);
    const first = await credit(payment);
    const second = await credit({ ...payment, source: StarsCreditSource.Reconciler });
    expect(first).toMatchObject({ outcome: 'credited', balance: 50n });
    expect(second).toMatchObject({
      outcome: 'already_recorded',
      status: StarPaymentStatus.Paid,
      tokens: 50n,
      balance: 50n,
    });
    expect(await ledgerOf(user.userId)).toHaveLength(1);
    expect(await balanceOf(user.userId)).toBe(50n);
    if (first.outcome !== 'credited') throw new Error(first.outcome);
    expect(await auditOf(first.paymentId)).toHaveLength(1);
  });

  // S2: the second connection queues behind the first's users lock and then meets the recorded
  // charge
  it('S2 credits once when the bot and the reconciler credit the same charge at once', async () => {
    const user = await seedUser(tmp.db, { balance: 0n });
    const payment = paymentOf(user);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let markHeld!: () => void;
    const held = new Promise<void>((resolve) => (markHeld = resolve));
    const first = tmp.db.transaction(async (tx) => {
      const result = await creditStarPayment(tx, payment);
      markHeld();
      await gate;
      return result;
    });
    let second: Promise<unknown> | undefined;
    try {
      await Promise.race([held, first]);
      second = credit({ ...payment, source: StarsCreditSource.Reconciler });
      await until('the second credit to queue behind the held users row', async () => {
        return (await lockWaiters(tmp.db)) === 1;
      });
    } finally {
      release();
    }
    expect(await first).toMatchObject({ outcome: 'credited' });
    expect(await second).toMatchObject({ outcome: 'already_recorded', balance: 50n });
    expect(await ledgerOf(user.userId)).toHaveLength(1);
    expect(await balanceOf(user.userId)).toBe(50n);
  });

  it('credits two different charges of one user twice', async () => {
    const user = await seedUser(tmp.db, { balance: 0n });
    await credit(paymentOf(user));
    const second = await credit(paymentOf(user, { packageCode: 'p150', totalAmount: 250 }));
    expect(second).toMatchObject({ outcome: 'credited', tokens: 150n, balance: 200n });
    expect(await ledgerOf(user.userId)).toHaveLength(2);
  });

  // S5
  it.each([
    ['another currency', { currency: 'USD' }, StarPaymentHoldReason.Currency, 50n],
    ['another amount', { totalAmount: 99 }, StarPaymentHoldReason.Amount, 50n],
    ['a package no longer sold', { packageCode: 'p999' }, StarPaymentHoldReason.Package, null],
    ['another payer', { payerTelegramUserId: 1n }, StarPaymentHoldReason.Payer, 50n],
  ] as const)(
    'S5 holds a payment in %s: no ledger row, the balance unmoved, one audit row',
    async (_label, patch, reason, tokens) => {
      const user = await seedUser(tmp.db, { balance: 0n });
      const payment = paymentOf(user, patch);
      const result = await credit(payment);
      expect(result).toMatchObject({ outcome: 'held', reason });
      if (result.outcome !== 'held') throw new Error(result.outcome);
      const [row] = await tmp.db
        .select()
        .from(starPayments)
        .where(eq(starPayments.id, result.paymentId));
      expect(row).toMatchObject({ status: StarPaymentStatus.Held, tokens });
      expect(await ledgerOf(user.userId)).toEqual([]);
      expect(await balanceOf(user.userId)).toBe(0n);
      expect(await auditOf(result.paymentId)).toEqual([
        expect.objectContaining({
          action: AuditAction.StarsPaymentHeld,
          payload: expect.objectContaining({ reason }) as unknown,
        }),
      ]);

      // again: the stored held, not a credit, and no second audit row
      expect(await credit(payment)).toMatchObject({
        outcome: 'already_recorded',
        status: StarPaymentStatus.Held,
      });
      expect(await auditOf(result.paymentId)).toHaveLength(1);
    },
  );

  it('writes nothing for a payload whose user has no row', async () => {
    const user = await seedUser(tmp.db, { balance: 0n });
    const payment = paymentOf(user, { userId: '00000000-0000-4000-8000-00000000dead' });
    expect(await credit(payment)).toEqual({ outcome: 'user_unknown' });
    expect(await listKnownStarCharges(tmp.db, [payment.telegramPaymentChargeId])).toEqual(
      new Set(),
    );
  });

  // the user paid; a block or a revoked account after the pre-checkout does not undo it
  it('credits a blocked user', async () => {
    const user = await seedUser(tmp.db, { balance: 0n, status: UserStatus.Blocked });
    expect(await credit(paymentOf(user))).toMatchObject({ outcome: 'credited', balance: 50n });
  });
});

describe('listKnownStarCharges', () => {
  it('names the recorded charges among the given ids, held ones included', async () => {
    const user = await seedUser(tmp.db, { balance: 0n });
    const paid = paymentOf(user);
    const held = paymentOf(user, { totalAmount: 1 });
    await credit(paid);
    await credit(held);
    expect(
      await listKnownStarCharges(tmp.db, [
        paid.telegramPaymentChargeId,
        held.telegramPaymentChargeId,
        'charge-never',
      ]),
    ).toEqual(new Set([paid.telegramPaymentChargeId, held.telegramPaymentChargeId]));
    expect(await listKnownStarCharges(tmp.db, [])).toEqual(new Set());
  });
});

describe('readStarsBuyer', () => {
  it('answers undefined for an unknown Telegram id', async () => {
    expect(await readStarsBuyer(tmp.db, 999_999_998n)).toBeUndefined();
  });

  it('says whether the user has an active account', async () => {
    const user = await seedUser(tmp.db);
    const telegramUserId = BigInt(user.telegramUserId);
    expect(await readStarsBuyer(tmp.db, telegramUserId)).toEqual({
      userId: user.userId,
      status: UserStatus.Active,
      hasActiveBrokerAccount: false,
    });
    await seedBrokerAccount(tmp.db, user.userId, { status: BrokerAccountStatus.Revoked });
    expect(await readStarsBuyer(tmp.db, telegramUserId)).toMatchObject({
      hasActiveBrokerAccount: false,
    });
    await seedBrokerAccount(tmp.db, user.userId, { status: BrokerAccountStatus.Active });
    expect(await readStarsBuyer(tmp.db, telegramUserId)).toMatchObject({
      hasActiveBrokerAccount: true,
    });
  });
});

// --- Refunds (#118) ----------------------------------------------------------------------------

const refundOf = (charge: string, patch: Partial<StarRefundInput> = {}): StarRefundInput => ({
  telegramPaymentChargeId: charge,
  source: StarsRefundSource.Cli,
  telegramAnswer: StarsRefundEvidence.Refunded,
  reason: 'просьба пользователя',
  ...patch,
});

// the CLI's and the reconciler's record: the writer and its system row (#510)
const refund = (input: StarRefundInput) =>
  tmp.db.transaction((tx) => recordStarRefundBySystem(tx, input));

async function paymentRow(charge: string) {
  const [row] = await tmp.db
    .select()
    .from(starPayments)
    .where(eq(starPayments.telegramPaymentChargeId, charge));
  return row!;
}

const refundRows = async (userId: string) =>
  (await ledgerOf(userId)).filter((row) => row.kind === TokenLedgerKind.Refund);

// the reserve is moved the way a live intent holds it: only the cache, as the reserve writer does
const holdReserve = (userId: string, reserved: bigint) =>
  tmp.db.update(users).set({ tokenReserved: reserved }).where(eq(users.id, userId));

describe('creditStarPayment: the payer (#118)', () => {
  it('records the payer, also when it is not the payload’s user (a held forwarded invoice)', async () => {
    const user = await seedUser(tmp.db, { balance: 0n });
    const own = paymentOf(user);
    const forwarded = paymentOf(user, { payerTelegramUserId: 31337n });
    await credit(own);
    await credit(forwarded);
    expect((await paymentRow(own.telegramPaymentChargeId)).payerTelegramUserId).toBe(
      BigInt(user.telegramUserId),
    );
    expect(await paymentRow(forwarded.telegramPaymentChargeId)).toMatchObject({
      status: StarPaymentStatus.Held,
      payerTelegramUserId: 31337n,
    });
  });
});

describe('recordStarRefund', () => {
  it('R1 takes the tokens back from a full balance: refunded, one refund row, one audit row', async () => {
    const user = await seedUser(tmp.db, { balance: 7n });
    const payment = paymentOf(user);
    await credit(payment);
    const result = await refund(refundOf(payment.telegramPaymentChargeId));
    expect(result).toMatchObject({
      outcome: 'refunded',
      fromStatus: StarPaymentStatus.Paid,
      taken: 50n,
      notRecovered: 0n,
      balance: 7n,
    });
    if (result.outcome !== 'refunded') throw new Error(result.outcome);
    const row = await paymentRow(payment.telegramPaymentChargeId);
    expect(row.status).toBe(StarPaymentStatus.Refunded);
    expect(row.refundedAt).toBeInstanceOf(Date);
    expect(await refundRows(user.userId)).toEqual([
      expect.objectContaining({ balanceDelta: -50n, reservedDelta: 0n, starPaymentId: row.id }),
    ]);
    expect(await balanceOf(user.userId)).toBe(7n);
    const audits = (await auditOf(row.id)).filter((a) => a.action === AuditAction.StarsRefunded);
    expect(audits).toEqual([
      expect.objectContaining({
        actorType: 'system',
        actorId: null,
        payload: {
          userId: user.userId,
          payerTelegramUserId: user.telegramUserId,
          fromStatus: StarPaymentStatus.Paid,
          packageCode: 'p50',
          totalAmount: 100,
          tokensTaken: '50',
          tokensNotRecovered: '0',
          via: StarsRefundSource.Cli,
          telegramAnswer: StarsRefundEvidence.Refunded,
          reason: 'просьба пользователя',
        },
      }),
    ]);
  });

  it('R2 takes only what is available above a live reserve, and leaves the reserve', async () => {
    const user = await seedUser(tmp.db, { balance: 0n });
    const payment = paymentOf(user);
    await credit(payment);
    // 20 of the 50 held by a live intent
    await holdReserve(user.userId, 20n);
    const result = await refund(refundOf(payment.telegramPaymentChargeId));
    expect(result).toMatchObject({
      outcome: 'refunded',
      taken: 30n,
      notRecovered: 20n,
      balance: 20n,
    });
    const [after] = await tmp.db
      .select({ balance: users.tokenBalance, reserved: users.tokenReserved })
      .from(users)
      .where(eq(users.id, user.userId));
    expect(after).toEqual({ balance: 20n, reserved: 20n });
    const row = await paymentRow(payment.telegramPaymentChargeId);
    expect(
      (await auditOf(row.id)).find((a) => a.action === AuditAction.StarsRefunded)?.payload,
    ).toMatchObject({ tokensTaken: '30', tokensNotRecovered: '20' });
  });

  it('R3 refunds with nothing available: no ledger row, refunded, 0 taken in the audit row', async () => {
    const user = await seedUser(tmp.db, { balance: 0n });
    const payment = paymentOf(user);
    await credit(payment);
    await holdReserve(user.userId, 50n);
    const result = await refund(refundOf(payment.telegramPaymentChargeId));
    expect(result).toMatchObject({
      outcome: 'refunded',
      taken: 0n,
      notRecovered: 50n,
      balance: 50n,
    });
    expect(await refundRows(user.userId)).toEqual([]);
    const row = await paymentRow(payment.telegramPaymentChargeId);
    expect(row.status).toBe(StarPaymentStatus.Refunded);
    expect(
      (await auditOf(row.id)).find((a) => a.action === AuditAction.StarsRefunded)?.payload,
    ).toMatchObject({ tokensTaken: '0', tokensNotRecovered: '50' });
  });

  it.each([
    ['with tokens taken', 0n],
    ['with nothing taken', 50n],
  ])(
    'R4 records a second refund of the same charge as already recorded (%s)',
    async (_l, reserve) => {
      const user = await seedUser(tmp.db, { balance: 0n });
      const payment = paymentOf(user);
      await credit(payment);
      await holdReserve(user.userId, reserve);
      const first = await refund(refundOf(payment.telegramPaymentChargeId));
      expect(first.outcome).toBe('refunded');
      const balance = await balanceOf(user.userId);
      const row = await paymentRow(payment.telegramPaymentChargeId);
      const second = await refund(
        refundOf(payment.telegramPaymentChargeId, {
          source: StarsRefundSource.Reconciler,
          telegramAnswer: StarsRefundEvidence.Transaction,
        }),
      );
      expect(second).toEqual({
        outcome: 'already_recorded',
        paymentId: row.id,
        refundedAt: row.refundedAt,
      });
      expect(await refundRows(user.userId)).toHaveLength(reserve === 0n ? 1 : 0);
      expect(await balanceOf(user.userId)).toBe(balance);
      expect(
        (await auditOf(row.id)).filter((a) => a.action === AuditAction.StarsRefunded),
      ).toHaveLength(1);
    },
  );

  it('R5 refunds a held payment: no token taken, nothing not recovered', async () => {
    const user = await seedUser(tmp.db, { balance: 3n });
    const payment = paymentOf(user, { totalAmount: 99 });
    expect((await credit(payment)).outcome).toBe('held');
    const result = await refund(refundOf(payment.telegramPaymentChargeId));
    expect(result).toMatchObject({
      outcome: 'refunded',
      fromStatus: StarPaymentStatus.Held,
      taken: 0n,
      notRecovered: 0n,
      balance: 3n,
    });
    expect(await ledgerOf(user.userId)).toEqual([]);
    expect((await paymentRow(payment.telegramPaymentChargeId)).status).toBe(
      StarPaymentStatus.Refunded,
    );
  });

  // R6: the reconciler's record queues behind the CLI's users lock, then meets the refunded row
  it('R6 records once when the CLI and the reconciler record the same refund at once', async () => {
    const user = await seedUser(tmp.db, { balance: 0n });
    const payment = paymentOf(user);
    await credit(payment);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let markHeld!: () => void;
    const held = new Promise<void>((resolve) => (markHeld = resolve));
    const first = tmp.db.transaction(async (tx) => {
      const result = await recordStarRefundBySystem(tx, refundOf(payment.telegramPaymentChargeId));
      markHeld();
      await gate;
      return result;
    });
    let second: Promise<unknown> | undefined;
    try {
      await Promise.race([held, first]);
      second = refund(
        refundOf(payment.telegramPaymentChargeId, {
          source: StarsRefundSource.Reconciler,
          telegramAnswer: StarsRefundEvidence.Transaction,
          receiverTelegramUserId: BigInt(user.telegramUserId),
        }),
      );
      await until('the second record to queue behind the held users row', async () => {
        return (await lockWaiters(tmp.db)) === 1;
      });
    } finally {
      release();
    }
    expect(await first).toMatchObject({ outcome: 'refunded', taken: 50n });
    expect(await second).toMatchObject({ outcome: 'already_recorded' });
    expect(await refundRows(user.userId)).toHaveLength(1);
    expect(await balanceOf(user.userId)).toBe(0n);
  });

  it('R7 writes nothing for a receiver who is not the payer', async () => {
    const user = await seedUser(tmp.db, { balance: 0n });
    const payment = paymentOf(user);
    await credit(payment);
    const row = await paymentRow(payment.telegramPaymentChargeId);
    expect(
      await refund(
        refundOf(payment.telegramPaymentChargeId, {
          source: StarsRefundSource.Reconciler,
          receiverTelegramUserId: BigInt(user.telegramUserId) + 1n,
        }),
      ),
    ).toEqual({ outcome: 'receiver_mismatch', paymentId: row.id });
    expect((await paymentRow(payment.telegramPaymentChargeId)).status).toBe(StarPaymentStatus.Paid);
    expect(await refundRows(user.userId)).toEqual([]);
    expect(await balanceOf(user.userId)).toBe(50n);
  });

  it('R8 answers not_found for an unknown charge', async () => {
    expect(await refund(refundOf('charge-never-seen'))).toEqual({ outcome: 'not_found' });
  });

  // R9: users first (Rule 5). The payment row stays free while the writer waits on users.
  it('R9 waits on a held users row before it locks the payment row', async () => {
    const user = await seedUser(tmp.db, { balance: 0n });
    const payment = paymentOf(user);
    await credit(payment);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let markHeld!: () => void;
    const held = new Promise<void>((resolve) => (markHeld = resolve));
    const holder = tmp.db.transaction(async (tx) => {
      await tx.execute(sql`select 1 from users where id = ${user.userId} for no key update`);
      markHeld();
      await gate;
    });
    let record: Promise<unknown> | undefined;
    try {
      await held;
      record = refund(refundOf(payment.telegramPaymentChargeId));
      await until('the record to queue behind the held users row', async () => {
        return (await lockWaiters(tmp.db)) === 1;
      });
      // the payment row is not locked by the waiting writer: a NOWAIT lock on it succeeds
      await tmp.db.transaction(async (tx) => {
        await tx.execute(
          sql`select 1 from star_payments where telegram_payment_charge_id = ${payment.telegramPaymentChargeId} for no key update nowait`,
        );
      });
    } finally {
      release();
    }
    await holder;
    expect(await record).toMatchObject({ outcome: 'refunded' });
  });

  // #510: the row is the caller's, so it can name who recorded the refund
  it('R10 writes no stars_refunded row of its own', async () => {
    const user = await seedUser(tmp.db, { balance: 0n });
    const payment = paymentOf(user);
    await credit(payment);
    const result = await tmp.db.transaction((tx) =>
      recordStarRefund(tx, refundOf(payment.telegramPaymentChargeId)),
    );
    expect(result).toMatchObject({ outcome: 'refunded', taken: 50n });
    const row = await paymentRow(payment.telegramPaymentChargeId);
    expect(row.status).toBe(StarPaymentStatus.Refunded);
    expect((await auditOf(row.id)).filter((a) => a.action === AuditAction.StarsRefunded)).toEqual(
      [],
    );
  });
});

describe('the admin reads of Stars payments (#510)', () => {
  it('A1 lists the user’s newest payments first, with the request’s time, up to the limit', async () => {
    const user = await seedUser(tmp.db, { balance: 0n });
    const rows = [];
    for (let day = 1; day <= 3; day += 1) {
      const payment = paymentOf(user, { paidAt: new Date(`2026-09-0${day}T00:00:00.000Z`) });
      await credit(payment);
      rows.push(await paymentRow(payment.telegramPaymentChargeId));
    }
    await requestStarRefund(tmp.db, {
      telegramUserId: BigInt(user.telegramUserId),
      paymentId: rows[2]!.id,
    });
    const listed = await tmp.db.transaction((tx) => listStarPaymentsForAdmin(tx, user.userId, 2));
    expect(listed.map((p) => p.id)).toEqual([rows[2]!.id, rows[1]!.id]);
    expect(listed[0]!.requestedAt).toBeInstanceOf(Date);
    expect(listed[1]!.requestedAt).toBeNull();
  });

  it('A2 does not list another user’s payment, a forwarded invoice’s payer included', async () => {
    const owner = await seedUser(tmp.db, { balance: 0n });
    const other = await seedUser(tmp.db, { balance: 0n });
    const forwarded = paymentOf(owner, { payerTelegramUserId: BigInt(other.telegramUserId) });
    await credit(forwarded);
    const forOwner = await tmp.db.transaction((tx) =>
      listStarPaymentsForAdmin(tx, owner.userId, 20),
    );
    expect(forOwner).toEqual([
      expect.objectContaining({
        telegramPaymentChargeId: forwarded.telegramPaymentChargeId,
        payerTelegramUserId: BigInt(other.telegramUserId),
      }),
    ]);
    expect(
      await tmp.db.transaction((tx) => listStarPaymentsForAdmin(tx, other.userId, 20)),
    ).toEqual([]);
  });

  it('A3 readStarPaymentById reads a row with its request, undefined for an unknown id', async () => {
    const user = await seedUser(tmp.db, { balance: 0n });
    const payment = paymentOf(user);
    await credit(payment);
    const row = await paymentRow(payment.telegramPaymentChargeId);
    expect(await readStarPaymentById(tmp.db, row.id)).toMatchObject({
      id: row.id,
      telegramPaymentChargeId: payment.telegramPaymentChargeId,
      status: StarPaymentStatus.Paid,
      tokens: 50n,
      requestedAt: null,
    });
    expect(
      await readStarPaymentById(tmp.db, '00000000-0000-4000-8000-00000000beef'),
    ).toBeUndefined();
  });
});

describe('the refund reads (#118)', () => {
  it('readStarPaymentByCharge reads a row, undefined for an unknown charge', async () => {
    const user = await seedUser(tmp.db, { balance: 0n });
    const payment = paymentOf(user);
    await credit(payment);
    expect(await readStarPaymentByCharge(tmp.db, payment.telegramPaymentChargeId)).toMatchObject({
      userId: user.userId,
      payerTelegramUserId: BigInt(user.telegramUserId),
      status: StarPaymentStatus.Paid,
      tokens: 50n,
      refundedAt: null,
    });
    expect(await readStarPaymentByCharge(tmp.db, 'charge-never')).toBeUndefined();
  });

  it('listStarChargesToRefund names paid and held charges, not refunded or unknown ones', async () => {
    const user = await seedUser(tmp.db, { balance: 0n });
    const paid = paymentOf(user);
    const held = paymentOf(user, { totalAmount: 1 });
    const refunded = paymentOf(user);
    for (const payment of [paid, held, refunded]) await credit(payment);
    await refund(refundOf(refunded.telegramPaymentChargeId));
    expect(
      await listStarChargesToRefund(tmp.db, [
        paid.telegramPaymentChargeId,
        held.telegramPaymentChargeId,
        refunded.telegramPaymentChargeId,
        'charge-never',
      ]),
    ).toEqual(new Set([paid.telegramPaymentChargeId, held.telegramPaymentChargeId]));
    expect(await listStarChargesToRefund(tmp.db, [])).toEqual(new Set());
  });
});

describe('listStarPaymentsForPayer and requestStarRefund (#118)', () => {
  it('lists the payer’s five newest payments with their request flag', async () => {
    const user = await seedUser(tmp.db, { balance: 0n });
    const payer = BigInt(user.telegramUserId);
    const payments = [];
    for (let day = 1; day <= 6; day += 1) {
      const payment = paymentOf(user, { paidAt: new Date(`2026-10-0${day}T00:00:00.000Z`) });
      await credit(payment);
      payments.push(await paymentRow(payment.telegramPaymentChargeId));
    }
    await requestStarRefund(tmp.db, { telegramUserId: payer, paymentId: payments[5]!.id });
    const listed = await listStarPaymentsForPayer(tmp.db, payer);
    expect(listed.map((p) => p.id)).toEqual(
      payments
        .slice(1)
        .reverse()
        .map((p) => p.id),
    );
    expect(listed[0]).toEqual({
      id: payments[5]!.id,
      paidAt: Date.parse('2026-10-06T00:00:00.000Z') / 1000,
      packageCode: 'p50',
      totalAmount: 100,
      status: StarPaymentStatus.Paid,
      requested: true,
    });
    expect(listed.slice(1).every((p) => !p.requested)).toBe(true);
    // another Telegram id sees none of them
    expect(await listStarPaymentsForPayer(tmp.db, payer + 1n)).toEqual([]);
  });

  it('lists a forwarded invoice’s payment for its payer, not for the users row', async () => {
    const user = await seedUser(tmp.db, { balance: 0n });
    const payment = paymentOf(user, { payerTelegramUserId: 424_242n });
    await credit(payment);
    expect(await listStarPaymentsForPayer(tmp.db, 424_242n)).toEqual([
      expect.objectContaining({ status: StarPaymentStatus.Held }),
    ]);
    expect(await listStarPaymentsForPayer(tmp.db, BigInt(user.telegramUserId))).toEqual([]);
  });

  it('records a request once, with its audit row, and tells a repeat apart', async () => {
    const user = await seedUser(tmp.db, { balance: 0n });
    const payer = BigInt(user.telegramUserId);
    const payment = paymentOf(user);
    await credit(payment);
    const row = await paymentRow(payment.telegramPaymentChargeId);
    const first = await requestStarRefund(tmp.db, { telegramUserId: payer, paymentId: row.id });
    expect(first).toMatchObject({ outcome: 'requested', payment: { id: row.id } });
    expect(await requestStarRefund(tmp.db, { telegramUserId: payer, paymentId: row.id })).toEqual({
      outcome: 'already_requested',
    });
    const requests = await tmp.db
      .select()
      .from(starRefundRequests)
      .where(eq(starRefundRequests.starPaymentId, row.id));
    expect(requests).toEqual([expect.objectContaining({ requestedByTelegramUserId: payer })]);
    expect(
      (await auditOf(row.id)).filter((a) => a.action === AuditAction.StarsRefundRequested),
    ).toEqual([
      expect.objectContaining({
        actorType: 'user',
        actorId: user.telegramUserId,
        payload: {
          userId: user.userId,
          status: StarPaymentStatus.Paid,
          requestId: requests[0]!.id,
        },
      }),
    ]);
  });

  it('answers not_found for another payer’s payment and for no payment, writing nothing', async () => {
    const user = await seedUser(tmp.db, { balance: 0n });
    const payment = paymentOf(user);
    await credit(payment);
    const row = await paymentRow(payment.telegramPaymentChargeId);
    const stranger = BigInt(user.telegramUserId) + 7n;
    expect(
      await requestStarRefund(tmp.db, { telegramUserId: stranger, paymentId: row.id }),
    ).toEqual({ outcome: 'not_found' });
    expect(
      await requestStarRefund(tmp.db, {
        telegramUserId: stranger,
        paymentId: '00000000-0000-4000-8000-00000000beef',
      }),
    ).toEqual({ outcome: 'not_found' });
    expect(
      await tmp.db
        .select()
        .from(starRefundRequests)
        .where(eq(starRefundRequests.starPaymentId, row.id)),
    ).toEqual([]);
  });

  it('answers already_refunded for a refunded payment, writing nothing', async () => {
    const user = await seedUser(tmp.db, { balance: 0n });
    const payment = paymentOf(user);
    await credit(payment);
    await refund(refundOf(payment.telegramPaymentChargeId));
    const row = await paymentRow(payment.telegramPaymentChargeId);
    expect(
      await requestStarRefund(tmp.db, {
        telegramUserId: BigInt(user.telegramUserId),
        paymentId: row.id,
      }),
    ).toEqual({ outcome: 'already_refunded' });
    expect(
      await tmp.db
        .select()
        .from(starRefundRequests)
        .where(eq(starRefundRequests.starPaymentId, row.id)),
    ).toEqual([]);
  });

  it('Q4 listOpenStarRefundRequests without a cursor is the CLI’s list: open requests oldest first', async () => {
    const user = await seedUser(tmp.db, { balance: 0n });
    const payer = BigInt(user.telegramUserId);
    const rows = [];
    for (let i = 0; i < 3; i += 1) {
      const payment = paymentOf(user);
      await credit(payment);
      const row = await paymentRow(payment.telegramPaymentChargeId);
      await requestStarRefund(tmp.db, { telegramUserId: payer, paymentId: row.id });
      rows.push(row);
    }
    await refund(refundOf(rows[1]!.telegramPaymentChargeId));
    const { rows: listed } = await listOpenStarRefundRequests(tmp.db, {
      limit: STAR_REFUND_REQUESTS_LIST_LIMIT,
    });
    expect(listed.length).toBeLessThanOrEqual(STAR_REFUND_REQUESTS_LIST_LIMIT);
    const open = listed.filter((request) => request.payment.userId === user.userId);
    expect(open.map((request) => request.payment.id)).toEqual([rows[0]!.id, rows[2]!.id]);
    expect(open[0]!.requestedAt).toBeInstanceOf(Date);
  });
});

// The admin's page of requests (#510): keyset by the request. Their times are set in 1990, before
// any other row of this database, so these four are the first rows of the list whatever ran before.
describe('listOpenStarRefundRequests: the pages (#510)', () => {
  const requestIds: string[] = [];
  const paymentIds: string[] = [];
  beforeAll(async () => {
    const user = await seedUser(tmp.db, { balance: 0n });
    const payer = BigInt(user.telegramUserId);
    for (let i = 0; i < 4; i += 1) {
      const payment = paymentOf(user);
      await credit(payment);
      const row = await paymentRow(payment.telegramPaymentChargeId);
      const requested = await requestStarRefund(tmp.db, {
        telegramUserId: payer,
        paymentId: row.id,
      });
      if (requested.outcome !== 'requested') throw new Error(requested.outcome);
      const [request] = await tmp.db
        .update(starRefundRequests)
        .set({ requestedAt: new Date(Date.UTC(1990, 0, 1, 0, 0, i + 1)) })
        .where(eq(starRefundRequests.starPaymentId, row.id))
        .returning({ id: starRefundRequests.id });
      requestIds.push(request!.id);
      paymentIds.push(row.id);
    }
    // the newest of the four is refunded: its request is no longer open
    await refund(
      refundOf((await readStarPaymentById(tmp.db, paymentIds[3]!))!.telegramPaymentChargeId),
    );
  });

  it('Q1 lists the oldest first and names the next page’s cursor when more are open', async () => {
    const page = await listOpenStarRefundRequests(tmp.db, { limit: 2 });
    expect(page.rows.map((row) => row.requestId)).toEqual([requestIds[0], requestIds[1]]);
    expect(page.rows.map((row) => row.payment.id)).toEqual([paymentIds[0], paymentIds[1]]);
    expect(page.nextCursor).toBe(requestIds[1]);
  });

  it('Q2 hides a request whose payment is refunded', async () => {
    const page = await listOpenStarRefundRequests(tmp.db, { limit: 1000 });
    const ids = page.rows.map((row) => row.requestId);
    expect(ids).toEqual(expect.arrayContaining(requestIds.slice(0, 3)));
    expect(ids).not.toContain(requestIds[3]);
  });

  it('Q3 starts the next page after the cursor’s row and repeats nothing', async () => {
    const page = await listOpenStarRefundRequests(tmp.db, { cursor: requestIds[1], limit: 1 });
    expect(page.rows.map((row) => row.requestId)).toEqual([requestIds[2]]);
  });
});
