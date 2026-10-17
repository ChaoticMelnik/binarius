import { eq } from 'drizzle-orm';
import type { StarTransaction } from 'grammy/types';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  logOptions,
  MENU_CALLBACK_DATA,
  StarPaymentStatus,
  starsInvoicePayload,
} from '@binarius/shared';
import { auditLog, starPayments, tokenLedger, users } from '@binarius/db';
import {
  createTempDatabase,
  seedUserWithAccount,
  type SeededAccount,
  type TempDatabase,
} from '@binarius/db/testing';
import { captureApi, callsTo, inlineButtons, pushedText } from '../admin/testing';
import { createClientPush } from '../auth/client-push';
import { CLIENT_LABELS, CLIENT_TEXTS } from '../auth/texts';
import { createStarReconciler, type StarReconcilerConfig } from './star-reconciler';

const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for apps/backend integration tests (see README → Test database)',
  );
}

let tmp: TempDatabase;
beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
});
afterAll(() => tmp.drop());

const NOW_S = 1_790_000_000;
let seq = 0;

// an incoming invoice payment of the 50-token package by the payload's own user, an hour ago
const purchase = (
  seed: SeededAccount,
  patch: Partial<StarTransaction> & { payload?: string; payer?: number } = {},
): StarTransaction => {
  const { payload, payer, ...rest } = patch;
  return {
    id: `tx-${++seq}`,
    amount: 100,
    date: NOW_S - 3600,
    source: {
      type: 'user',
      transaction_type: 'invoice_payment',
      user: { id: payer ?? Number(seed.telegramUserId), is_bot: false, first_name: 'Ada' },
      invoice_payload: payload ?? starsInvoicePayload('p50', seed.userId),
    },
    ...rest,
  };
};

// The transactions Telegram holds, served page by page from offset; every call is recorded.
function reconciler(transactions: StarTransaction[], config: Partial<StarReconcilerConfig> = {}) {
  const push = createClientPush({ token: '123456:AA-stars-push-token' });
  const captured = captureApi(push);
  const reads: { offset: number; limit: number }[] = [];
  const lines: string[] = [];
  const subject = createStarReconciler({
    db: tmp.db,
    readTransactions: (offset, limit) => {
      reads.push({ offset, limit });
      return Promise.resolve(transactions.slice(offset, offset + limit));
    },
    push,
    logger: pino(logOptions('info'), { write: (line: string) => void lines.push(line) }),
    config,
    now: () => NOW_S * 1000,
  });
  const logs = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { subject, captured, reads, logs };
}

const ledgerOf = (userId: string) =>
  tmp.db.select().from(tokenLedger).where(eq(tokenLedger.userId, userId));
const paymentsOf = (userId: string) =>
  tmp.db.select().from(starPayments).where(eq(starPayments.userId, userId));

describe('the Stars reconciler', () => {
  // S3
  it('S3 credits a charge the bot never reported, and nothing on the next tick', async () => {
    const seed = await seedUserWithAccount(tmp.db, { balance: 0n });
    const lost = purchase(seed);
    const { subject, captured } = reconciler([lost]);
    await subject.tick();
    const [payment] = await paymentsOf(seed.userId);
    expect(payment).toMatchObject({
      telegramPaymentChargeId: lost.id,
      providerPaymentChargeId: null,
      status: StarPaymentStatus.Paid,
      tokens: 50n,
      paidAt: new Date((NOW_S - 3600) * 1000),
    });
    expect(await ledgerOf(seed.userId)).toHaveLength(1);
    const [audit] = await tmp.db.select().from(auditLog).where(eq(auditLog.entityId, payment!.id));
    expect(audit?.payload).toMatchObject({ via: 'reconciler' });

    await subject.tick();
    expect(await ledgerOf(seed.userId)).toHaveLength(1);
    expect(callsTo(captured.calls, 'sendMessage')).toHaveLength(1);
    await subject.stop();
  });

  it('S3 skips a recorded charge, an outgoing one, another transaction type and an old one', async () => {
    const seed = await seedUserWithAccount(tmp.db, { balance: 0n });
    const recorded = purchase(seed);
    await reconciler([recorded]).subject.tick();
    const outgoing: StarTransaction = {
      id: `tx-${++seq}`,
      amount: 100,
      date: NOW_S - 60,
      receiver: {
        type: 'user',
        transaction_type: 'invoice_payment',
        user: { id: Number(seed.telegramUserId), is_bot: false, first_name: 'Ada' },
      },
    };
    const media = purchase(seed);
    (media.source as { transaction_type: string }).transaction_type = 'paid_media_payment';
    const old = purchase(seed, { date: NOW_S - 172_801 });
    const { subject, captured } = reconciler([recorded, outgoing, media, old]);
    await subject.tick();
    expect(await paymentsOf(seed.userId)).toHaveLength(1);
    expect(callsTo(captured.calls, 'sendMessage')).toEqual([]);
  });

  it('S3 logs a payload that is not ours once per process, by id and amount only', async () => {
    const seed = await seedUserWithAccount(tmp.db, { balance: 0n });
    const foreign = purchase(seed, { payload: 'someone-else' });
    const { subject, logs } = reconciler([foreign]);
    await subject.tick();
    await subject.tick();
    const lines = logs().filter(
      (line) => line.msg === 'stars transaction with a payload that is not ours',
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ telegramPaymentChargeId: foreign.id, totalAmount: 100 });
    expect(JSON.stringify(lines[0])).not.toContain(seed.telegramUserId);
    expect(await paymentsOf(seed.userId)).toEqual([]);
  });

  it('holds a reconciled payment of another amount and pushes nothing', async () => {
    const seed = await seedUserWithAccount(tmp.db, { balance: 0n });
    const { subject, captured } = reconciler([purchase(seed, { amount: 99 })]);
    await subject.tick();
    expect(await paymentsOf(seed.userId)).toEqual([
      expect.objectContaining({ status: StarPaymentStatus.Held }),
    ]);
    expect(await ledgerOf(seed.userId)).toEqual([]);
    expect(callsTo(captured.calls, 'sendMessage')).toEqual([]);
  });

  it('reads every page until a short one, whatever the order', async () => {
    const seeds = [await seedUserWithAccount(tmp.db, { balance: 0n })];
    const transactions = Array.from({ length: 5 }, () => purchase(seeds[0]!));
    const { subject, reads } = reconciler(transactions, { pageSize: 2 });
    await subject.tick();
    expect(reads).toEqual([
      { offset: 0, limit: 2 },
      { offset: 2, limit: 2 },
      { offset: 4, limit: 2 },
    ]);
    expect(await paymentsOf(seeds[0]!.userId)).toHaveLength(5);
  });

  it('stops at the page ceiling and says so', async () => {
    const seed = await seedUserWithAccount(tmp.db, { balance: 0n });
    const transactions = Array.from({ length: 4 }, () => purchase(seed));
    const { subject, reads, logs } = reconciler(transactions, { pageSize: 1, maxPages: 2 });
    await subject.tick();
    expect(reads).toHaveLength(2);
    expect(logs()).toContainEqual(
      expect.objectContaining({ msg: 'stars reconcile page ceiling', pages: 2 }),
    );
  });

  // S11
  it('S11 pushes the credit with the menu button, as Telegram HTML', async () => {
    const seed = await seedUserWithAccount(tmp.db, { balance: 7n });
    const { subject, captured } = reconciler([purchase(seed)]);
    await subject.tick();
    const sends = callsTo(captured.calls, 'sendMessage');
    expect(sends).toHaveLength(1);
    const payload = sends[0]!.payload;
    expect(payload.chat_id).toBe(seed.telegramUserId);
    expect(payload.parse_mode).toBe('HTML');
    expect(pushedText(payload)).toBe(
      CLIENT_TEXTS.starsCredited({ purchasedTokens: '50', tokenBalance: '57' }).value,
    );
    expect(inlineButtons(payload)).toEqual([
      { text: CLIENT_LABELS.menuButton, callback_data: MENU_CALLBACK_DATA },
    ]);
  });

  it('S11 marks a user who blocked the bot on 403 and keeps the credit', async () => {
    const seed = await seedUserWithAccount(tmp.db, { balance: 0n });
    const { subject, captured } = reconciler([purchase(seed)]);
    captured.apiErrors.set('sendMessage', {
      ok: false,
      error_code: 403,
      description: 'Forbidden: bot was blocked by the user',
    });
    await subject.tick();
    const [row] = await tmp.db
      .select({ at: users.telegramBlockedAt, balance: users.tokenBalance })
      .from(users)
      .where(eq(users.id, seed.userId));
    expect(row).toMatchObject({ balance: 50n });
    expect(row?.at).toBeInstanceOf(Date);
  });

  it('S11 keeps the credit and tries no second send when the push fails otherwise', async () => {
    const seed = await seedUserWithAccount(tmp.db, { balance: 0n });
    const { subject, captured, logs } = reconciler([purchase(seed)]);
    captured.apiErrors.set('sendMessage', {
      ok: false,
      error_code: 500,
      description: 'Internal Server Error',
    });
    await subject.tick();
    await subject.tick();
    expect(callsTo(captured.calls, 'sendMessage')).toHaveLength(1);
    expect(await ledgerOf(seed.userId)).toHaveLength(1);
    expect(logs()).toContainEqual(
      expect.objectContaining({ msg: 'stars credit push not delivered', telegramErrorCode: 500 }),
    );
    const [row] = await tmp.db
      .select({ at: users.telegramBlockedAt })
      .from(users)
      .where(eq(users.id, seed.userId));
    expect(row?.at).toBeNull();
  });

  it('logs a failed read and credits nothing', async () => {
    const lines: string[] = [];
    const subject = createStarReconciler({
      db: tmp.db,
      readTransactions: () => Promise.reject(new Error('boom')),
      push: { sendMailing: () => Promise.reject(new Error('unused')) },
      logger: pino(logOptions('info'), { write: (line: string) => void lines.push(line) }),
    });
    await subject.tick();
    expect(lines.map((line) => JSON.parse(line) as Record<string, unknown>)).toContainEqual(
      expect.objectContaining({
        msg: 'stars reconcile tick failed',
        method: 'getStarTransactions',
      }),
    );
  });

  it('starts no tick after stop()', async () => {
    const { subject, reads } = reconciler([]);
    await subject.stop();
    subject.start();
    await subject.tick();
    expect(reads).toEqual([]);
  });
});

// --- Refunds (#118) ----------------------------------------------------------------------------

// Telegram's refund of `charge`: an outgoing transaction with the charge's own id, to the payer
const refundTx = (
  charge: StarTransaction,
  seed: SeededAccount,
  patch: { receiver?: number; date?: number; transactionType?: string } = {},
): StarTransaction => ({
  id: charge.id,
  amount: charge.amount,
  date: patch.date ?? NOW_S - 60,
  receiver: {
    type: 'user',
    transaction_type: (patch.transactionType ?? 'invoice_payment') as 'invoice_payment',
    user: { id: patch.receiver ?? Number(seed.telegramUserId), is_bot: false, first_name: 'Ada' },
  },
});

const refundAudits = async (paymentId: string) =>
  (await tmp.db.select().from(auditLog).where(eq(auditLog.entityId, paymentId))).filter(
    (row) => row.action === 'stars_refunded',
  );

describe('the Stars reconciler: refunds', () => {
  it('S20 records the refund of a paid charge once, with the transaction type, and pushes nothing', async () => {
    const seed = await seedUserWithAccount(tmp.db, { balance: 0n });
    const bought = purchase(seed);
    await reconciler([bought]).subject.tick();
    const { subject, captured, logs } = reconciler([refundTx(bought, seed), bought]);
    await subject.tick();
    await subject.tick();
    const [payment] = await paymentsOf(seed.userId);
    expect(payment).toMatchObject({ status: StarPaymentStatus.Refunded });
    expect((await ledgerOf(seed.userId)).map((row) => [row.kind, row.balanceDelta])).toEqual(
      expect.arrayContaining([
        ['purchase', 50n],
        ['refund', -50n],
      ]),
    );
    const audits = await refundAudits(payment!.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.payload).toMatchObject({
      via: 'reconciler',
      telegramAnswer: 'transaction',
      transactionType: 'invoice_payment',
      tokensTaken: '50',
    });
    expect(callsTo(captured.calls, 'sendMessage')).toEqual([]);
    expect(logs().filter((line) => line.msg === 'stars refund recorded')).toHaveLength(1);
  });

  it('S21 records the refund of a held charge with no token taken', async () => {
    const seed = await seedUserWithAccount(tmp.db, { balance: 0n });
    const bought = purchase(seed, { amount: 99 });
    await reconciler([bought]).subject.tick();
    await reconciler([refundTx(bought, seed)]).subject.tick();
    const [payment] = await paymentsOf(seed.userId);
    expect(payment).toMatchObject({ status: StarPaymentStatus.Refunded });
    expect(await ledgerOf(seed.userId)).toEqual([]);
    expect((await refundAudits(payment!.id))[0]!.payload).toMatchObject({
      fromStatus: 'held',
      tokensTaken: '0',
    });
  });

  it('S22 leaves a charge refunded already alone', async () => {
    const seed = await seedUserWithAccount(tmp.db, { balance: 0n });
    const bought = purchase(seed);
    await reconciler([bought]).subject.tick();
    await reconciler([refundTx(bought, seed)]).subject.tick();
    const { subject, logs } = reconciler([refundTx(bought, seed)]);
    await subject.tick();
    const [payment] = await paymentsOf(seed.userId);
    expect(await refundAudits(payment!.id)).toHaveLength(1);
    expect(logs().filter((line) => line.level === 50)).toEqual([]);
  });

  it('S23 skips an outgoing transaction for a charge we never recorded, logged once', async () => {
    const seed = await seedUserWithAccount(tmp.db, { balance: 0n });
    const never = purchase(seed);
    const { subject, logs } = reconciler([refundTx(never, seed)]);
    await subject.tick();
    await subject.tick();
    const lines = logs().filter(
      (line) => line.msg === 'stars outgoing transaction for a charge we never recorded',
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ telegramPaymentChargeId: never.id, totalAmount: 100 });
    expect(JSON.stringify(lines[0])).not.toContain(seed.telegramUserId);
    expect(await paymentsOf(seed.userId)).toEqual([]);
  });

  it('S24 records nothing for a refund to someone who is not the payer, and says so once', async () => {
    const seed = await seedUserWithAccount(tmp.db, { balance: 0n });
    const bought = purchase(seed);
    await reconciler([bought]).subject.tick();
    const { subject, logs } = reconciler([refundTx(bought, seed, { receiver: 31_337 })]);
    await subject.tick();
    await subject.tick();
    const [payment] = await paymentsOf(seed.userId);
    expect(payment).toMatchObject({ status: StarPaymentStatus.Paid });
    expect(await ledgerOf(seed.userId)).toHaveLength(1);
    expect(
      logs().filter((line) => line.msg === 'stars refund to a user who is not the payer'),
    ).toEqual([expect.objectContaining({ telegramPaymentChargeId: bought.id, level: 50 })]);
  });

  it('S25 credits and then refunds a charge whose purchase and refund are on one page', async () => {
    const seed = await seedUserWithAccount(tmp.db, { balance: 0n });
    const bought = purchase(seed);
    // Telegram lists the newest first: the refund, then the purchase
    await reconciler([refundTx(bought, seed), bought]).subject.tick();
    const [payment] = await paymentsOf(seed.userId);
    expect(payment).toMatchObject({ status: StarPaymentStatus.Refunded });
    expect((await ledgerOf(seed.userId)).map((row) => row.kind).sort()).toEqual([
      'purchase',
      'refund',
    ]);
  });

  it('S26 ignores a refund dated outside the window', async () => {
    const seed = await seedUserWithAccount(tmp.db, { balance: 0n });
    const bought = purchase(seed);
    await reconciler([bought]).subject.tick();
    await reconciler([refundTx(bought, seed, { date: NOW_S - 172_801 })]).subject.tick();
    const [payment] = await paymentsOf(seed.userId);
    expect(payment).toMatchObject({ status: StarPaymentStatus.Paid });
  });

  it('records a refund whose receiver carries another transaction type (clarify В1)', async () => {
    const seed = await seedUserWithAccount(tmp.db, { balance: 0n });
    const bought = purchase(seed);
    await reconciler([bought]).subject.tick();
    await reconciler([
      refundTx(bought, seed, { transactionType: 'paid_media_payment' }),
    ]).subject.tick();
    const [payment] = await paymentsOf(seed.userId);
    expect(payment).toMatchObject({ status: StarPaymentStatus.Refunded });
    expect((await refundAudits(payment!.id))[0]!.payload).toMatchObject({
      transactionType: 'paid_media_payment',
    });
  });
});
