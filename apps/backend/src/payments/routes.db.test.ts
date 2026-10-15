import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BrokerAccountStatus,
  StarsErrorCode,
  StarsPreCheckoutRefusal,
  UserStatus,
  starsInvoicePayload,
  starsInvoiceResponseSchema,
  starsPaidResponseSchema,
  starsPreCheckoutResponseSchema,
} from '@binarius/shared';
import {
  createTempDatabase,
  seedBrokerAccount,
  seedUser,
  seedUserWithAccount,
  type TempDatabase,
} from '@binarius/db/testing';
import { starPayments, tokenLedger } from '@binarius/db';
import { buildApp } from '../app';
import { unusedAdminDeps } from '../admin/testing';
import { unusedDepositDeps } from '../deposit/testing';
import {
  unusedAccessTokenDeps,
  unusedBalanceDeps,
  unusedPairsDeps,
  unusedSessionDeps,
  unusedSignalDeps,
  unusedSignalsDeps,
} from '../trading/testing';

const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for apps/backend integration tests (see README → Test database)',
  );
}

const TOKEN = 'internal-token-for-tests';
let tmp: TempDatabase;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
  app = buildApp({
    pairs: unusedPairsDeps(),
    sessions: unusedSessionDeps(),
    signal: unusedSignalDeps(),
    signals: unusedSignalsDeps(),
    admin: unusedAdminDeps(),
    deposit: unusedDepositDeps(),
    checkPostgres: () => Promise.resolve(),
    checkRedis: () => Promise.resolve(),
    logLevel: 'silent',
    checkTimeoutMs: 20,
    trading: {
      db: tmp.db,
      internalApiToken: TOKEN,
      onIntentQueued: () => {},
      balance: unusedBalanceDeps(),
      accessToken: unusedAccessTokenDeps(),
      demoOnly: true,
    },
    auth: {
      db: tmp.db,
      cipher: {} as never,
      broker: {} as never,
      internalApiToken: TOKEN,
      authorizeUrl: 'https://binodex.app/oauth/authorize',
      clientId: 'client-id',
      redirectUri: 'https://bot.example/oauth/callback',
      partnerRef: 'partner-ref',
      clientPush: {} as never,
      initDataVerifier: {} as never,
    },
    users: { db: tmp.db, internalApiToken: TOKEN },
  });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await tmp.drop();
});

const post = (url: string, payload: unknown, authorization: string | null = `Bearer ${TOKEN}`) =>
  app.inject({
    method: 'POST',
    url,
    headers: {
      'content-type': 'application/json',
      ...(authorization === null ? {} : { authorization }),
    },
    payload: JSON.stringify(payload),
  });

const paymentCount = async (userId: string) =>
  (await tmp.db.select().from(starPayments).where(eq(starPayments.userId, userId))).length;

let seq = 0;

describe('the payments routes', () => {
  it.each(['/payments/stars/invoice', '/payments/stars/pre-checkout', '/payments/stars/paid'])(
    'refuses %s without the internal bearer',
    async (url) => {
      const response = await post(url, {}, null);
      expect(response.statusCode).toBe(401);
    },
  );
});

describe('POST /payments/stars/invoice', () => {
  const invoice = (telegramUserId: string, packageCode = 'p150') =>
    post('/payments/stars/invoice', { telegramUserId, packageCode });

  it('answers the payload and the package for a user with an active account', async () => {
    const seed = await seedUserWithAccount(tmp.db);
    const response = await invoice(seed.telegramUserId);
    expect(response.statusCode).toBe(200);
    const body: unknown = response.json();
    expect(body).toEqual({
      payload: starsInvoicePayload('p150', seed.userId),
      package: { code: 'p150', tokens: '150', stars: 250 },
    });
    expect(starsInvoiceResponseSchema.safeParse(body).success).toBe(true);
    // a read: nothing is recorded before the payment
    expect(await paymentCount(seed.userId)).toBe(0);
  });

  it('answers 404 user_not_found for a Telegram id with no row', async () => {
    const response = await invoice('9999999');
    expect([response.statusCode, response.json()]).toEqual([
      404,
      { error: StarsErrorCode.UserNotFound },
    ]);
  });

  it.each([
    ['a blocked user', 'blocked', StarsErrorCode.UserBlocked],
    ['a user without an active account', 'pending', StarsErrorCode.NoActiveAccount],
    ['a package no longer sold', 'unknown', StarsErrorCode.PackageUnknown],
  ] as const)('refuses %s with 409', async (_label, shape, code) => {
    const user = await seedUser(tmp.db, {
      status: shape === 'blocked' ? UserStatus.Blocked : UserStatus.Active,
    });
    await seedBrokerAccount(tmp.db, user.userId, {
      status: shape === 'pending' ? BrokerAccountStatus.Pending : BrokerAccountStatus.Active,
    });
    const response = await invoice(user.telegramUserId, shape === 'unknown' ? 'p999' : 'p50');
    expect([response.statusCode, response.json()]).toEqual([409, { error: code }]);
  });

  it('answers 400 for a body outside the contract', async () => {
    const response = await post('/payments/stars/invoice', { telegramUserId: 'x' });
    expect(response.statusCode).toBe(400);
  });
});

// S4: pre-checkout refuses before Telegram charges anything, and never writes
describe('POST /payments/stars/pre-checkout', () => {
  const check = (patch: Record<string, unknown>) =>
    post('/payments/stars/pre-checkout', { currency: 'XTR', totalAmount: 250, ...patch });

  it('says yes to the payload of an invoice it issued, at its price', async () => {
    const seed = await seedUserWithAccount(tmp.db);
    const response = await check({
      telegramUserId: seed.telegramUserId,
      invoicePayload: starsInvoicePayload('p150', seed.userId),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(await paymentCount(seed.userId)).toBe(0);
  });

  it.each([
    ['a wrong amount', { totalAmount: 249 }, StarsPreCheckoutRefusal.Amount],
    ['another currency', { currency: 'USD' }, StarsPreCheckoutRefusal.Currency],
    ['an unknown package', { packageCode: 'p999' }, StarsPreCheckoutRefusal.Package],
    [
      'a payload that is not ours',
      { invoicePayload: 'other:thing' },
      StarsPreCheckoutRefusal.Payload,
    ],
    ["another user's payload", { otherUser: true }, StarsPreCheckoutRefusal.Payer],
    ['a blocked user', { blocked: true }, StarsPreCheckoutRefusal.UserBlocked],
    [
      'a user without an active account',
      { noAccount: true },
      StarsPreCheckoutRefusal.NoActiveAccount,
    ],
    ['a Telegram id with no row', { unknownUser: true }, StarsPreCheckoutRefusal.UserNotFound],
  ] as const)('refuses %s', async (_label, shape, reason) => {
    const user = await seedUser(tmp.db, {
      status: 'blocked' in shape ? UserStatus.Blocked : UserStatus.Active,
    });
    if (!('noAccount' in shape)) await seedBrokerAccount(tmp.db, user.userId);
    const other = await seedUserWithAccount(tmp.db);
    const owner = 'otherUser' in shape ? other.userId : user.userId;
    const packageCode = 'packageCode' in shape ? shape.packageCode : 'p150';
    const response = await check({
      telegramUserId: 'unknownUser' in shape ? String(8_000_000 + ++seq) : user.telegramUserId,
      invoicePayload:
        'invoicePayload' in shape ? shape.invoicePayload : `stars:${packageCode}:${owner}`,
      ...('totalAmount' in shape ? { totalAmount: shape.totalAmount } : {}),
      ...('currency' in shape ? { currency: shape.currency } : {}),
    });
    expect(response.statusCode).toBe(200);
    const body: unknown = response.json();
    expect(body).toEqual({ ok: false, reason });
    expect(starsPreCheckoutResponseSchema.safeParse(body).success).toBe(true);
    expect(await paymentCount(user.userId)).toBe(0);
  });
});

describe('POST /payments/stars/paid', () => {
  const paid = (
    seed: { userId: string; telegramUserId: string },
    patch: Record<string, unknown> = {},
  ) =>
    post('/payments/stars/paid', {
      telegramUserId: seed.telegramUserId,
      telegramPaymentChargeId: `route-charge-${++seq}`,
      providerPaymentChargeId: '',
      invoicePayload: starsInvoicePayload('p50', seed.userId),
      currency: 'XTR',
      totalAmount: 100,
      paidAt: 1_790_000_000,
      ...patch,
    });

  // S1 through the route: the bot's retry of the same update
  it('credits once and answers the same tokens and balance to a repeated delivery', async () => {
    const seed = await seedUserWithAccount(tmp.db, { balance: 0n });
    const chargeId = `route-charge-${++seq}`;
    const first = await paid(seed, { telegramPaymentChargeId: chargeId });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ outcome: 'credited', tokens: '50', balance: '50' });
    expect(starsPaidResponseSchema.safeParse(first.json()).success).toBe(true);
    const again = await paid(seed, { telegramPaymentChargeId: chargeId });
    expect(again.json()).toEqual({ outcome: 'already_credited', tokens: '50', balance: '50' });
    const rows = await tmp.db.select().from(tokenLedger).where(eq(tokenLedger.userId, seed.userId));
    expect(rows).toHaveLength(1);
    const [payment] = await tmp.db
      .select()
      .from(starPayments)
      .where(eq(starPayments.userId, seed.userId));
    expect(payment).toMatchObject({
      telegramPaymentChargeId: chargeId,
      providerPaymentChargeId: '',
      paidAt: new Date(1_790_000_000 * 1000),
    });
  });

  // S5 through the route
  it.each([
    ['a mismatching amount', { totalAmount: 99 }],
    ['another currency', { currency: 'USD' }],
    ['a payer who is not the payload user', { telegramUserId: '7777777' }],
  ])('holds %s and answers held again on a repeat', async (_label, patch) => {
    const seed = await seedUserWithAccount(tmp.db, { balance: 0n });
    const chargeId = `route-charge-${++seq}`;
    const first = await paid(seed, { telegramPaymentChargeId: chargeId, ...patch });
    expect(first.json()).toEqual({ outcome: 'held' });
    const again = await paid(seed, { telegramPaymentChargeId: chargeId, ...patch });
    expect(again.json()).toEqual({ outcome: 'held' });
    expect(await paymentCount(seed.userId)).toBe(1);
  });

  it.each([
    ['a payload that is not ours', { invoicePayload: 'not-ours' }],
    [
      'a payload naming no user',
      { invoicePayload: starsInvoicePayload('p50', '00000000-0000-4000-8000-00000000beef') },
    ],
  ])('answers 409 payload_unknown for %s and records nothing', async (_label, patch) => {
    const seed = await seedUserWithAccount(tmp.db);
    const response = await paid(seed, patch);
    expect([response.statusCode, response.json()]).toEqual([
      409,
      { error: StarsErrorCode.PayloadUnknown },
    ]);
    expect(await paymentCount(seed.userId)).toBe(0);
  });
});
