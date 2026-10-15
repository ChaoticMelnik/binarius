import { eq } from 'drizzle-orm';
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
import { auditLog, starPayments, tokenLedger, users } from './schema/index';
import {
  creditStarPayment,
  listKnownStarCharges,
  readStarsBuyer,
  StarsCreditSource,
  type StarPaymentInput,
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
