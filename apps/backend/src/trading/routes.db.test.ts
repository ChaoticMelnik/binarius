import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTempDatabase, seedUserWithAccount, type TempDatabase } from '@binarius/db/testing';
import { brokerAccounts, findTradeIntent, users } from '@binarius/db';
import { buildApp } from '../app';

const baseUrl = process.env.DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error('DATABASE_URL is required for apps/backend integration tests (see README)');
}

const token = 'internal-token-for-tests';
let tmp: TempDatabase;
let wakes: string[] = [];
let wakeThrows = false;
let probeUserId: string | undefined;
let probe: Promise<string | undefined> | undefined;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
  app = buildApp({
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
    },
  });
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

const get = (id: string, authorization = `Bearer ${token}`) =>
  app.inject({ method: 'GET', url: `/trading/intents/${id}`, headers: { authorization } });

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
    expect((await get('00000000-0000-0000-0000-000000000000', 'Bearer nope')).statusCode).toBe(401);
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
      .set({ tradingHalted: true })
      .where(eq(brokerAccounts.id, other.brokerAccountId));
    const halted = await post(body(other.telegramUserId));
    expect(halted.statusCode).toBe(409);
    expect(halted.json()).toEqual({ error: 'account_halted' });

    await tmp.db
      .update(brokerAccounts)
      .set({ tradingHalted: false, status: 'revoked' })
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

describe('GET /trading/intents/:id', () => {
  it('returns the view for an existing intent and 404 otherwise', async () => {
    const s = await seed();
    const created = (await post(body(s.telegramUserId))).json().intent;
    const found = await get(created.id);
    expect(found.statusCode).toBe(200);
    expect(found.json().intent).toEqual(created);

    expect((await get('00000000-0000-0000-0000-000000000000')).statusCode).toBe(404);
    expect((await get('not-a-uuid')).statusCode).toBe(404);
    expect((await get('not-a-uuid')).json()).toEqual({ error: 'not_found' });
  });
});
