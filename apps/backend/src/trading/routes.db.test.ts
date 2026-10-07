import { eq } from 'drizzle-orm';
import { AccountHaltReason } from '@binarius/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  closeTradingSwitch,
  createTempDatabase,
  seedUserWithAccount,
  type TempDatabase,
} from '@binarius/db/testing';
import { brokerAccounts, findTradeIntent, openTrading, tradeIntents, users } from '@binarius/db';
import { buildApp } from '../app';
import { unusedAdminDeps } from '../admin/testing';
import {
  unusedAccessTokenDeps,
  unusedBalanceDeps,
  unusedPairsDeps,
  unusedSignalDeps,
  unusedSessionDeps,
} from './testing';

const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for apps/backend integration tests (see README → Test database)',
  );
}

const token = 'internal-token-for-tests';
let tmp: TempDatabase;
let wakes: string[] = [];
let wakeThrows = false;
let probeUserId: string | undefined;
let probe: Promise<string | undefined> | undefined;
let app: ReturnType<typeof buildApp>;

const appWith = () =>
  buildApp({
    pairs: unusedPairsDeps(),
    sessions: unusedSessionDeps(),
    signal: unusedSignalDeps(),
    admin: unusedAdminDeps(),
    checkPostgres: () => Promise.resolve(),
    checkRedis: () => Promise.resolve(),
    logLevel: 'silent',
    checkTimeoutMs: 20,
    auth: {
      db: tmp.db,
      cipher: {} as never,
      broker: {} as never,
      internalApiToken: token,
      authorizeUrl: 'https://binodex.app/oauth/authorize',
      clientId: 'client-id',
      redirectUri: 'https://bot.example/oauth/callback',
      partnerRef: 'partner-ref',
      linkNotifier: {} as never,
      initDataVerifier: {} as never,
    },
    users: {
      db: tmp.db,
      internalApiToken: token,
    },
    trading: {
      db: tmp.db,
      internalApiToken: token,
      onIntentQueued: () => {
        wakes.push('wake');
        if (probeUserId !== undefined) {
          probe = tmp.pool
            .query('select status from trade_intents where user_id = $1', [probeUserId])
            .then((r) => r.rows[0]?.status as string | undefined);
        }
        if (wakeThrows) throw new Error('publisher down');
      },
      balance: unusedBalanceDeps(),
      accessToken: unusedAccessTokenDeps(),
    },
  });

beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
  app = appWith();
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await tmp.drop();
});

let seq = 0;
const seed = (balance = 5n) => seedUserWithAccount(tmp.db, { balance });

const body = (telegramUserId: string, patch: Record<string, unknown> = {}) => ({
  telegramUserId,
  mode: 'demo',
  assetId: 91,
  amount: '10.00',
  action: 'up',
  durationSec: 60,
  clientRequestId: `req-${++seq}`,
  ...patch,
});

const post = (payload: unknown, authorization = `Bearer ${token}`) =>
  app.inject({
    method: 'POST',
    url: '/trading/intents',
    headers: { authorization, 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });

const get = (id: string, telegramUserId?: string, authorization = `Bearer ${token}`) =>
  app.inject({
    method: 'GET',
    url: `/trading/intents/${id}`,
    ...(telegramUserId === undefined ? {} : { query: { telegramUserId } }),
    headers: { authorization },
  });

const VIEW_KEYS = [
  'id',
  'brokerAccountId',
  'telegramUserId',
  'mode',
  'assetId',
  'amount',
  'action',
  'durationSec',
  'clientRequestId',
  'createdAt',
  'status',
  'version',
  'tokensReserved',
  'transport',
  'submittedAt',
  'lastError',
  'updatedAt',
].sort();

describe('auth', () => {
  it('rejects both routes without the internal token', async () => {
    const s = await seed();
    expect((await post(body(s.telegramUserId), 'Bearer nope')).statusCode).toBe(401);
    expect((await get('00000000-0000-0000-0000-000000000000', '1', 'Bearer nope')).statusCode).toBe(
      401,
    );
  });
});

describe('POST /trading/intents', () => {
  it('creates a queued intent (201) and replays it (200) with the same id', async () => {
    const s = await seed();
    const payload = body(s.telegramUserId);
    wakes = [];

    const created = await post(payload);
    expect(created.statusCode).toBe(201);
    const view = created.json().intent;
    expect(Object.keys(view).sort()).toEqual(VIEW_KEYS);
    expect(view).toMatchObject({
      brokerAccountId: s.brokerAccountId,
      telegramUserId: s.telegramUserId,
      status: 'queued',
      version: 3,
      tokensReserved: '1',
      amount: '10.00000000',
      transport: null,
      submittedAt: null,
      lastError: null,
    });
    expect(wakes).toEqual(['wake']);

    const replayed = await post(payload);
    expect(replayed.statusCode).toBe(200);
    expect(replayed.json().intent.id).toBe(view.id);
    expect(wakes).toEqual(['wake']);
  });

  it('wakes the publisher only after the row is committed', async () => {
    const s = await seed();
    probeUserId = s.userId;
    try {
      expect((await post(body(s.telegramUserId))).statusCode).toBe(201);
      // the probe ran on its own connection from inside the callback
      expect(await probe).toBe('queued');
    } finally {
      probeUserId = undefined;
      probe = undefined;
    }
  });

  it('keeps the 201 when the wake callback throws', async () => {
    const s = await seed();
    wakeThrows = true;
    try {
      const response = await post(body(s.telegramUserId));
      expect(response.statusCode).toBe(201);
      expect((await findTradeIntent(tmp.db, response.json().intent.id))?.status).toBe('queued');
    } finally {
      wakeThrows = false;
    }
  });

  it.each([
    ['missing telegramUserId', { telegramUserId: undefined }],
    ['non-numeric telegramUserId', { telegramUserId: 'abc' }],
    ['telegramUserId above int8', { telegramUserId: '9223372036854775808' }],
    ['numeric amount', { amount: 10 }],
    ['amount with 9 fractional digits', { amount: '1.123456789' }],
    ['amount with 13 integer digits', { amount: '1234567890123' }],
    ['zero amount', { amount: '0' }],
    ['assetId above int4', { assetId: 2_147_483_648 }],
    ['durationSec zero', { durationSec: 0 }],
    ['null brokerAccountId', { brokerAccountId: null }],
    ['empty brokerAccountId', { brokerAccountId: '' }],
    ['unknown mode', { mode: 'live' }],
    ['clientRequestId too long', { clientRequestId: 'x'.repeat(129) }],
  ])('returns 400 for %s', async (_label, patch) => {
    const s = await seed();
    const response = await post(body(s.telegramUserId, patch));
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('validation');
    expect(Array.isArray(response.json().issues)).toBe(true);
  });

  it('returns 400 for a body that is not an object', async () => {
    expect((await post('"text"')).statusCode).toBe(400);
  });

  it('maps lookup failures to 404 and state failures to 409', async () => {
    expect((await post(body('999999999'))).json()).toEqual({ error: 'user_not_found' });

    const s = await seed(0n);
    const insufficient = await post(body(s.telegramUserId));
    expect(insufficient.statusCode).toBe(409);
    expect(insufficient.json()).toEqual({ error: 'insufficient_tokens' });

    const other = await seed();
    const foreign = await post(body(s.telegramUserId, { brokerAccountId: other.brokerAccountId }));
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toEqual({ error: 'broker_account_not_found' });

    const active = await seed();
    const first = body(active.telegramUserId);
    expect((await post(first)).statusCode).toBe(201);
    const second = await post(body(active.telegramUserId));
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: 'active_intent_exists' });
    const conflict = await post({ ...first, action: 'down' });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({ error: 'client_request_id_conflict' });

    await tmp.db
      .update(brokerAccounts)
      .set({ tradingHalted: true, haltedReason: AccountHaltReason.ReconciliationAmbiguous })
      .where(eq(brokerAccounts.id, other.brokerAccountId));
    const halted = await post(body(other.telegramUserId));
    expect(halted.statusCode).toBe(409);
    expect(halted.json()).toEqual({ error: 'account_halted' });

    await tmp.db
      .update(brokerAccounts)
      .set({ tradingHalted: false, haltedReason: null, status: 'revoked' })
      .where(eq(brokerAccounts.id, other.brokerAccountId));
    const revoked = await post(
      body(other.telegramUserId, { brokerAccountId: other.brokerAccountId }),
    );
    expect(revoked.statusCode).toBe(409);
    expect(revoked.json()).toEqual({ error: 'account_revoked' });

    await tmp.db.update(users).set({ status: 'blocked' }).where(eq(users.id, s.userId));
    const blocked = await post(body(s.telegramUserId));
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toEqual({ error: 'user_blocked' });
  });
});

describe('POST /trading/intents: the global trading switch (#144)', () => {
  const reservedOf = async (userId: string) =>
    (await tmp.db.select({ v: users.tokenReserved }).from(users).where(eq(users.id, userId)))[0]!.v;

  afterEach(() => openTrading(tmp.db));

  it.each(['demo', 'real'])(
    'answers 409 trading_paused for a %s intent while closed and creates nothing',
    async (mode) => {
      const s = await seed();
      await closeTradingSwitch(tmp.db);
      wakes = [];
      const response = await post(body(s.telegramUserId, { mode }));
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error: 'trading_paused' });
      expect(
        await tmp.db.select().from(tradeIntents).where(eq(tradeIntents.userId, s.userId)),
      ).toEqual([]);
      expect(await reservedOf(s.userId)).toBe(0n);
      expect(wakes).toEqual([]);
    },
  );

  it('creates a real intent while open', async () => {
    const s = await seed();
    const response = await post(body(s.telegramUserId, { mode: 'real' }));
    expect(response.statusCode).toBe(201);
    expect(response.json().intent.mode).toBe('real');
  });

  it('replays while closed what was created while open', async () => {
    const s = await seed();
    const payload = body(s.telegramUserId);
    const created = await post(payload);
    expect(created.statusCode).toBe(201);
    await closeTradingSwitch(tmp.db);
    const replayed = await post(payload);
    expect(replayed.statusCode).toBe(200);
    expect(replayed.json().intent.id).toBe(created.json().intent.id);
  });
});

describe('GET /trading/intents/:id', () => {
  it("returns the owner's view and 404 otherwise", async () => {
    const s = await seed();
    const created = (await post(body(s.telegramUserId))).json().intent;
    const found = await get(created.id, s.telegramUserId);
    expect(found.statusCode).toBe(200);
    expect(found.json().intent).toEqual(created);

    expect((await get('00000000-0000-0000-0000-000000000000', s.telegramUserId)).statusCode).toBe(
      404,
    );
    expect((await get('not-a-uuid', s.telegramUserId)).statusCode).toBe(404);
    expect((await get('not-a-uuid', s.telegramUserId)).json()).toEqual({ error: 'not_found' });
  });

  it("answers another user's id exactly as a missing one (#127)", async () => {
    const owner = await seed();
    const other = await seed();
    const created = (await post(body(owner.telegramUserId))).json().intent;
    const foreign = await get(created.id, other.telegramUserId);
    const missing = await get('00000000-0000-0000-0000-000000000000', other.telegramUserId);
    expect(foreign.statusCode).toBe(404);
    expect(foreign.body).toBe(missing.body);
    expect(foreign.json()).toEqual({ error: 'not_found' });
  });

  it('refuses a read without the owner as validation (#127)', async () => {
    const s = await seed();
    const created = (await post(body(s.telegramUserId))).json().intent;
    for (const response of [await get(created.id), await get(created.id, 'abc')]) {
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: 'validation', issues: expect.any(Array) });
    }
  });
});
