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
import { captureApi, callsTo, inlineButtons } from '../admin/testing';
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
    expect(payload.text).toBe(
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
