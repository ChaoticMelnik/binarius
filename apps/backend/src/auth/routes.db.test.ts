import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  brokerAccounts,
  createDb,
  createTokenCipher,
  hashToken,
  oauthStates,
  users,
} from '@binarius/db';
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
  app = testApp(authDeps);
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await stub.close();
  await tmp.drop();
});

let seq = 0;
const telegramId = () => String(800_000 + ++seq);

const testApp = (auth: AuthRoutesDeps) =>
  buildApp({
    checkPostgres: () => Promise.resolve(),
    checkRedis: () => Promise.resolve(),
    logLevel: 'silent',
    checkTimeoutMs: 20,
    trading: { db: tmp.db, internalApiToken: TOKEN, onIntentQueued: () => {} },
    auth,
  });

const postJson = (
  instance: ReturnType<typeof testApp>,
  url: string,
  payload: unknown,
  headers: Record<string, string> = {},
) =>
  instance.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', ...headers },
    payload: JSON.stringify(payload),
  });

const start = (telegramUserId: string, authorization = `Bearer ${TOKEN}`, instance = app) =>
  postJson(instance, '/auth/binodex/start', { telegramUserId }, { authorization });

const callback = (payload: unknown, instance = app) =>
  postJson(instance, '/auth/binodex/callback', payload);

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
    expect(account).toMatchObject({ brokerUserId: `broker-${telegram}`, status: 'pending' });

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
    const wrongSecret = testApp({
      ...authDeps,
      broker: createBrokerOAuthClient({
        baseUrl: stub.url,
        clientId: CLIENT_ID,
        clientSecret: 'not-the-secret',
      }),
    });
    await wrongSecret.ready();
    try {
      const response = await callback(
        { state, code: stub.issueCode({ brokerUserId: 'broker-x' }) },
        wrongSecret,
      );
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
    const instance = testApp({ ...authDeps, ...over });
    await instance.ready();
    return instance;
  };

  const sendCallback = (instance: ReturnType<typeof testApp>, payload: unknown) =>
    callback(payload, instance);

  it('stops a flood before it reaches the database', async () => {
    const instance = await limited({ callbackMaxPerMinute: 2 });
    try {
      const before = stub.tokenRequests;
      expect((await sendCallback(instance, { state: 'a', code: 'c' })).statusCode).toBe(400);
      expect((await sendCallback(instance, { state: 'b', code: 'c' })).statusCode).toBe(400);
      const blocked = await sendCallback(instance, { state: 'c', code: 'c' });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json()).toEqual({ error: 'too_many_requests' });
      // the ceiling applies to a well-formed request too: it is checked before the body is read
      expect((await sendCallback(instance, 'not-even-an-object')).statusCode).toBe(429);
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
        const started = await start(telegram, `Bearer ${TOKEN}`, instance);
        const { state } = started.json() as { state: string };
        const response = await sendCallback(instance, {
          state,
          code: stub.issueCode({ brokerUserId: `broker-${telegram}` }),
        });
        expect(response.statusCode).toBe(200);
      }

      expect((await sendCallback(instance, { state: 'miss-1', code: 'c' })).statusCode).toBe(400);
      expect((await sendCallback(instance, { state: 'miss-2', code: 'c' })).statusCode).toBe(400);
      expect((await sendCallback(instance, { state: 'miss-3', code: 'c' })).statusCode).toBe(429);
    } finally {
      await instance.close();
    }
  });

  // the reservation is what makes the limit hold: a counter incremented after the lookup lets
  // a whole burst through while every request in it is still waiting on the database
  it('holds the limit when the bad states arrive together', async () => {
    const instance = await limited({ callbackMaxFailuresPerMinute: 2 });
    try {
      const responses = await Promise.all(
        [1, 2, 3, 4, 5, 6].map((n) => sendCallback(instance, { state: `burst-${n}`, code: 'c' })),
      );
      const statuses = responses.map((r) => r.statusCode).sort();
      expect(statuses).toEqual([400, 400, 429, 429, 429, 429]);
    } finally {
      await instance.close();
    }
  });

  it('refuses before it reaches the state row at all', async () => {
    const telegram = telegramId();
    const { state } = (await start(telegram)).json() as { state: string };
    const instance = await limited({ callbackMaxPerMinute: 0 });
    try {
      const response = await sendCallback(instance, {
        state,
        code: stub.issueCode({ brokerUserId: `broker-${telegram}` }),
      });
      expect(response.statusCode).toBe(429);
      // the state was never consumed, which it would have been had the limiter run later
      const [row] = await tmp.db
        .select({ usedAt: oauthStates.usedAt })
        .from(oauthStates)
        .where(eq(oauthStates.stateHash, hashToken(state)));
      expect(row?.usedAt).toBeNull();
    } finally {
      await instance.close();
    }
  });

  // an outage is not a guessing client: keeping its reservations would close the callback for a
  // minute after the database comes back
  it('gives the reservation back when the lookup itself fails', async () => {
    const dead = new Pool({ connectionString: tmp.url });
    const instance = testApp({ ...authDeps, db: createDb(dead), callbackMaxFailuresPerMinute: 1 });
    await instance.ready();
    await dead.end();
    try {
      for (let i = 0; i < 4; i += 1) {
        const response = await sendCallback(instance, { state: `outage-${i}`, code: 'c' });
        expect(response.statusCode).toBe(500);
      }
    } finally {
      await instance.close();
    }
  });
});

describe('POST /auth/binodex/confirm', () => {
  const confirm = (payload: unknown, authorization = `Bearer ${TOKEN}`) =>
    postJson(app, '/auth/binodex/confirm', payload, { authorization });

  const linked = async () => {
    const telegram = telegramId();
    const { response } = await login(telegram, `broker-${telegram}`);
    const { account } = response.json() as { account: { id: string; status: string } };
    return { telegram, account };
  };

  it('requires the internal token', async () => {
    const { telegram, account } = await linked();
    expect(
      (await confirm({ telegramUserId: telegram, accountId: account.id }, 'Bearer nope'))
        .statusCode,
    ).toBe(401);
  });

  it('turns the pending account the login created into a usable one', async () => {
    const { telegram, account } = await linked();
    expect(account.status).toBe('pending');

    const response = await confirm({ telegramUserId: telegram, accountId: account.id });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { account: { status: string } }).account.status).toBe('active');
    expect((await tmp.db
      .select({ status: brokerAccounts.status })
      .from(brokerAccounts)
      .where(eq(brokerAccounts.id, account.id)))[0]?.status).toBe('active');
  });

  it('refuses an account that belongs to someone else', async () => {
    const { account } = await linked();
    // a real user row, so the lookup gets past "no such user" and actually exercises the
    // ownership predicate on broker_accounts
    const stranger = await seedUser(tmp.db);
    const response = await confirm({
      telegramUserId: stranger.telegramUserId,
      accountId: account.id,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'broker_account_not_found' });
  });

  it('refuses a second confirmation', async () => {
    const { telegram, account } = await linked();
    expect((await confirm({ telegramUserId: telegram, accountId: account.id })).statusCode).toBe(
      200,
    );
    const again = await confirm({ telegramUserId: telegram, accountId: account.id });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: 'account_not_pending' });
  });

  it('refuses a blocked user', async () => {
    const { telegram, account } = await linked();
    await tmp.db
      .update(users)
      .set({ status: 'blocked' })
      .where(eq(users.telegramUserId, BigInt(telegram)));
    const response = await confirm({ telegramUserId: telegram, accountId: account.id });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'user_blocked' });
  });

  it('rejects a malformed body with 400', async () => {
    expect((await confirm({ telegramUserId: '1' })).statusCode).toBe(400);
    expect((await confirm({ telegramUserId: '1', accountId: 'not-a-uuid' })).statusCode).toBe(400);
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
