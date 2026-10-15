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
  readStarPaymentByCharge,
  readStarsBuyer,
  recordStarRefund,
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

const refund = (input: StarRefundInput) => tmp.db.transaction((tx) => recordStarRefund(tx, input));

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
      const result = await recordStarRefund(tx, refundOf(payment.telegramPaymentChargeId));
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

describe('listOpenStarRefundRequests (#118)', () => {
  it('lists open requests oldest first and hides refunded ones', async () => {
    const user = await seedUser(tmp.db, { balance: 0n });
    const payer = BigInt(user.telegramUserId);
    const rows = [];
    for (let i = 0; i < 3; i += 1) {
      const payment = paymentOf(user);
      await credit(payment);
      const row = await paymentRow(payment.telegramPaymentChargeId);
      await tmp.db
        .insert(starRefundRequests)
        .values({ starPaymentId: row.id, requestedByTelegramUserId: payer });
      rows.push(row);
    }
    await refund(refundOf(rows[1]!.telegramPaymentChargeId));
    const open = (await listOpenStarRefundRequests(tmp.db)).filter(
      (request) => request.payment.userId === user.userId,
    );
    expect(open.map((request) => request.payment.id)).toEqual([rows[0]!.id, rows[2]!.id]);
    expect(open[0]!.requestedAt).toBeInstanceOf(Date);
  });
});
