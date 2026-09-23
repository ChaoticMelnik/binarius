import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { brokerAccounts, createTokenCipher, hashToken, oauthStates, users } from '@binarius/db';
import { createTempDatabase, seedUser, type TempDatabase } from '@binarius/db/testing';
import { buildApp } from '../app';
import { createBrokerOAuthClient } from '../broker/oauth-client';
import { startOAuthStub, type OAuthStub } from '../broker/testing/oauth-stub';
import type { AuthRoutesDeps } from './routes';

const baseUrl = process.env.DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error('DATABASE_URL is required for apps/backend integration tests (see README)');
}

const TOKEN = 'internal-token-for-tests';
const CLIENT_ID = 'client-id';
const CLIENT_SECRET = 'client-secret-value';
const REDIRECT_URI = 'https://bot.example/oauth/callback';
const AUTHORIZE_URL = 'https://binodex.app/oauth/authorize';
const PARTNER_REF = 'partner-ref';

const cipher = createTokenCipher({ keyId: 'test-key', key: randomBytes(32) });

let tmp: TempDatabase;
let stub: OAuthStub;
let app: ReturnType<typeof buildApp>;
let authDeps: AuthRoutesDeps;

beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
  stub = await startOAuthStub({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
  });
  authDeps = {
    db: tmp.db,
    cipher,
    broker: createBrokerOAuthClient({
      baseUrl: stub.url,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    }),
    internalApiToken: TOKEN,
    authorizeUrl: AUTHORIZE_URL,
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    partnerRef: PARTNER_REF,
  };
  app = buildApp({
    checkPostgres: () => Promise.resolve(),
    checkRedis: () => Promise.resolve(),
    logLevel: 'silent',
    checkTimeoutMs: 20,
    trading: { db: tmp.db, internalApiToken: TOKEN, onIntentQueued: () => {} },
    auth: authDeps,
  });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await stub.close();
  await tmp.drop();
});

let seq = 0;
const telegramId = () => String(800_000 + ++seq);

const start = (telegramUserId: string, authorization = `Bearer ${TOKEN}`) =>
  app.inject({
    method: 'POST',
    url: '/auth/binodex/start',
    headers: { authorization, 'content-type': 'application/json' },
    payload: JSON.stringify({ telegramUserId }),
  });

const callback = (payload: unknown) =>
  app.inject({
    method: 'POST',
    url: '/auth/binodex/callback',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });

async function login(telegramUserId: string, brokerUserId: string) {
  const started = await start(telegramUserId);
  const { state } = started.json() as { state: string };
  const code = stub.issueCode({ brokerUserId });
  return { started, response: await callback({ state, code }), state };
}

describe('POST /auth/binodex/start', () => {
  it('requires the internal token', async () => {
    expect((await start(telegramId(), 'Bearer nope')).statusCode).toBe(401);
    expect((await start(telegramId(), '')).statusCode).toBe(401);
  });

  it('returns an authorize url carrying every documented parameter', async () => {
    const response = await start(telegramId());
    expect(response.statusCode).toBe(200);
    const body = response.json() as { authorizeUrl: string; state: string; expiresAt: string };
    const url = new URL(body.authorizeUrl);
    expect(`${url.origin}${url.pathname}`).toBe(AUTHORIZE_URL);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      state: body.state,
      ref: PARTNER_REF,
      response_mode: 'web_message',
    });
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('refuses a blocked user before a state or a code is spent', async () => {
    const blocked = await seedUser(tmp.db, { status: 'blocked' });
    const response = await start(blocked.telegramUserId);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'user_blocked' });
    const states = await tmp.db
      .select({ id: oauthStates.id })
      .from(oauthStates)
      .where(eq(oauthStates.telegramUserId, BigInt(blocked.telegramUserId)));
    expect(states).toEqual([]);
  });

  it('stores only the hash of the state', async () => {
    const { state } = (await start(telegramId())).json() as { state: string };
    const byHash = await tmp.db
      .select({ id: oauthStates.id })
      .from(oauthStates)
      .where(eq(oauthStates.stateHash, hashToken(state)));
    const byRaw = await tmp.db
      .select({ id: oauthStates.id })
      .from(oauthStates)
      .where(eq(oauthStates.stateHash, state));
    expect(byHash).toHaveLength(1);
    expect(byRaw).toEqual([]);
  });

  it.each([
    ['missing id', {}],
    ['numeric id', { telegramUserId: 42 }],
    ['id above int8', { telegramUserId: '9223372036854775808' }],
  ])('rejects %s with 400', async (_label, payload) => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/binodex/start',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: JSON.stringify(payload),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('validation');
  });
});

describe('POST /auth/binodex/callback', () => {
  it('needs no internal token and links the account', async () => {
    const telegram = telegramId();
    const { response } = await login(telegram, `broker-${telegram}`);
    expect(response.statusCode).toBe(200);
    const { account } = response.json() as { account: Record<string, unknown> };
    expect(Object.keys(account).sort()).toEqual([
      'brokerUserId',
      'createdAt',
      'email',
      'id',
      'isPartnerClient',
      'status',
    ]);
    expect(account).toMatchObject({ brokerUserId: `broker-${telegram}`, status: 'active' });

    const [row] = await tmp.db
      .select()
      .from(brokerAccounts)
      .where(eq(brokerAccounts.id, account.id as string));
    expect(row?.refreshTokenHash).not.toBeNull();
    expect(row?.authRevokedReason).toBeNull();
  });

  it.each([
    ['an unknown state', 'never-issued'],
    ['an empty state', ''],
  ])('refuses %s without calling the broker', async (_label, state) => {
    const before = stub.tokenRequests;
    const response = await callback({ state, code: 'some-code' });
    expect([400]).toContain(response.statusCode);
    expect(stub.tokenRequests).toBe(before);
  });

  it('refuses a replayed state and never exchanges twice', async () => {
    const telegram = telegramId();
    const { state } = (await start(telegram)).json() as { state: string };
    const first = await callback({
      state,
      code: stub.issueCode({ brokerUserId: `broker-${telegram}` }),
    });
    expect(first.statusCode).toBe(200);

    const before = stub.tokenRequests;
    const replayed = await callback({ state, code: stub.issueCode({ brokerUserId: 'other' }) });
    expect(replayed.statusCode).toBe(400);
    expect(replayed.json()).toEqual({ error: 'invalid_state' });
    expect(stub.tokenRequests).toBe(before);
  });

  it('refuses an expired state without calling the broker', async () => {
    const telegram = telegramId();
    const { state } = (await start(telegram)).json() as { state: string };
    await tmp.db
      .update(oauthStates)
      .set({
        createdAt: sql`now() - interval '2 hours'`,
        expiresAt: sql`now() - interval '1 hour'`,
      })
      .where(eq(oauthStates.stateHash, hashToken(state)));

    const before = stub.tokenRequests;
    const response = await callback({ state, code: stub.issueCode({ brokerUserId: 'x' }) });
    expect(response.json()).toEqual({ error: 'invalid_state' });
    expect(stub.tokenRequests).toBe(before);
  });

  it('lets exactly one of two parallel callbacks through', async () => {
    const telegram = telegramId();
    const { state } = (await start(telegram)).json() as { state: string };
    const code = stub.issueCode({ brokerUserId: `broker-${telegram}` });
    const before = stub.tokenRequests;
    const [a, b] = await Promise.all([callback({ state, code }), callback({ state, code })]);
    const statuses = [a.statusCode, b.statusCode].sort();
    expect(statuses).toEqual([200, 400]);
    expect(stub.tokenRequests).toBe(before + 1);
  });

  it('maps a replayed or expired code to invalid_code', async () => {
    const telegram = telegramId();
    const code = stub.issueCode({ brokerUserId: `broker-${telegram}` });
    const first = (await start(telegram)).json() as { state: string };
    expect((await callback({ state: first.state, code })).statusCode).toBe(200);

    const second = (await start(telegram)).json() as { state: string };
    const response = await callback({ state: second.state, code });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid_code' });
  });

  it('refuses an account that already belongs to another telegram user', async () => {
    const owner = telegramId();
    const brokerUserId = `broker-${owner}`;
    expect((await login(owner, brokerUserId)).response.statusCode).toBe(200);

    const intruder = telegramId();
    const { response } = await login(intruder, brokerUserId);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'broker_account_taken' });
  });

  // the second gate: /start already refuses a blocked user, but the block can land while the
  // user is on the broker's page, and then the callback is the last thing standing
  it('refuses a user blocked after their state was issued', async () => {
    const seeded = await seedUser(tmp.db);
    const { state } = (await start(seeded.telegramUserId)).json() as { state: string };
    await tmp.db.update(users).set({ status: 'blocked' }).where(eq(users.id, seeded.userId));

    const response = await callback({
      state,
      code: stub.issueCode({ brokerUserId: `broker-${seeded.telegramUserId}` }),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'user_blocked' });
    const [row] = await tmp.db
      .select({ status: users.status })
      .from(users)
      .where(eq(users.id, seeded.userId));
    expect(row?.status).toBe('blocked');
  });

  it('keeps a trading halt while clearing an OAuth revocation', async () => {
    const telegram = telegramId();
    const first = await login(telegram, `broker-${telegram}`);
    const accountId = (first.response.json() as { account: { id: string } }).account.id;
    await tmp.db
      .update(brokerAccounts)
      .set({
        status: 'revoked',
        authRevokedReason: 'refresh_invalid_grant',
        tradingHalted: true,
        haltedReason: 'reconciliation',
      })
      .where(eq(brokerAccounts.id, accountId));

    const again = await login(telegram, `broker-${telegram}`);
    expect(again.response.statusCode).toBe(200);
    const [row] = await tmp.db
      .select()
      .from(brokerAccounts)
      .where(eq(brokerAccounts.id, accountId));
    expect(row).toMatchObject({
      status: 'active',
      authRevokedReason: null,
      tradingHalted: true,
      haltedReason: 'reconciliation',
    });
  });

  // a rejection is our configuration being wrong, not the browser's request: it must not look
  // like a bad code, which is the one thing the user could retry
  it('reports a broker rejection as 502, not 400', async () => {
    const telegram = telegramId();
    const { state } = (await start(telegram)).json() as { state: string };
    const wrongSecret = buildApp({
      checkPostgres: () => Promise.resolve(),
      checkRedis: () => Promise.resolve(),
      logLevel: 'silent',
      checkTimeoutMs: 20,
      trading: { db: tmp.db, internalApiToken: TOKEN, onIntentQueued: () => {} },
      auth: {
        ...authDeps,
        broker: createBrokerOAuthClient({
          baseUrl: stub.url,
          clientId: CLIENT_ID,
          clientSecret: 'not-the-secret',
        }),
      },
    });
    await wrongSecret.ready();
    try {
      const response = await wrongSecret.inject({
        method: 'POST',
        url: '/auth/binodex/callback',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ state, code: stub.issueCode({ brokerUserId: 'broker-x' }) }),
      });
      expect(response.statusCode).toBe(502);
      expect(response.json()).toEqual({ error: 'broker_contract_violation' });
    } finally {
      await wrongSecret.close();
    }
  });

  it.each([
    ['a missing code', { state: 'x' }],
    ['an oversized code', { state: 'x', code: 'c'.repeat(513) }],
    ['a non-object body', 'text'],
  ])('rejects %s with 400', async (_label, payload) => {
    const response = await callback(payload);
    expect(response.statusCode).toBe(400);
  });
});

describe('the callback rate limits', () => {
  // its own app, so the windows it exhausts are not the ones every other case shares
  const limited = async (over: Partial<AuthRoutesDeps>) => {
    const instance = buildApp({
      checkPostgres: () => Promise.resolve(),
      checkRedis: () => Promise.resolve(),
      logLevel: 'silent',
      checkTimeoutMs: 20,
      trading: { db: tmp.db, internalApiToken: TOKEN, onIntentQueued: () => {} },
      auth: { ...authDeps, ...over },
    });
    await instance.ready();
    return instance;
  };

  const post = (instance: Awaited<ReturnType<typeof limited>>, payload: unknown) =>
    instance.inject({
      method: 'POST',
      url: '/auth/binodex/callback',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(payload),
    });

  it('stops a flood before it reaches the database', async () => {
    const instance = await limited({ callbackMaxPerMinute: 2 });
    try {
      const before = stub.tokenRequests;
      expect((await post(instance, { state: 'a', code: 'c' })).statusCode).toBe(400);
      expect((await post(instance, { state: 'b', code: 'c' })).statusCode).toBe(400);
      const blocked = await post(instance, { state: 'c', code: 'c' });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json()).toEqual({ error: 'too_many_requests' });
      // the ceiling applies to a well-formed request too: it is checked before the body is read
      expect((await post(instance, 'not-even-an-object')).statusCode).toBe(429);
      expect(stub.tokenRequests).toBe(before);
    } finally {
      await instance.close();
    }
  });

  it('spends the narrow window only on a state that resolved to nothing', async () => {
    const instance = await limited({ callbackMaxFailuresPerMinute: 2 });
    try {
      // two real logins first: neither may count towards the failure window
      for (let i = 0; i < 2; i += 1) {
        const telegram = telegramId();
        const started = await instance.inject({
          method: 'POST',
          url: '/auth/binodex/start',
          headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
          payload: JSON.stringify({ telegramUserId: telegram }),
        });
        const { state } = started.json() as { state: string };
        const response = await post(instance, {
          state,
          code: stub.issueCode({ brokerUserId: `broker-${telegram}` }),
        });
        expect(response.statusCode).toBe(200);
      }

      expect((await post(instance, { state: 'miss-1', code: 'c' })).statusCode).toBe(400);
      expect((await post(instance, { state: 'miss-2', code: 'c' })).statusCode).toBe(400);
      expect((await post(instance, { state: 'miss-3', code: 'c' })).statusCode).toBe(429);
    } finally {
      await instance.close();
    }
  });
});

describe('secrecy', () => {
  it('keeps the state out of the callback response and out of errors', async () => {
    const telegram = telegramId();
    const { state } = (await start(telegram)).json() as { state: string };
    const ok = await callback({
      state,
      code: stub.issueCode({ brokerUserId: `broker-${telegram}` }),
    });
    expect(ok.body).not.toContain(state);

    const failed = await callback({ state, code: 'whatever' });
    expect(failed.body).not.toContain(state);
  });

  it('never returns a token or the client secret', async () => {
    const telegram = telegramId();
    const { response } = await login(telegram, `broker-${telegram}`);
    expect(response.body).not.toContain('access-');
    expect(response.body).not.toContain('refresh-');
    expect(response.body).not.toContain(CLIENT_SECRET);
  });
});
