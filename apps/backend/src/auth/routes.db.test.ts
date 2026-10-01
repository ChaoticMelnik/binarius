import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { confirmLoginResponseSchema, emailLoginResponseSchema } from '@binarius/shared';
import {
  LINK_BONUS_TOKENS,
  brokerAccounts,
  createDb,
  createTokenCipher,
  hashToken,
  oauthStates,
  tokenLedger,
  users,
} from '@binarius/db';
import { createTempDatabase, seedUser, type TempDatabase } from '@binarius/db/testing';
import { buildApp } from '../app';
import {
  BrokerOAuthError,
  BrokerOAuthErrorCode,
  createBrokerOAuthClient,
  type BrokerOAuthClient,
} from '../broker/oauth-client';
import { startOAuthStub, type OAuthStub } from '../broker/testing/oauth-stub';
import type { AuthRoutesDeps } from './routes';
import { unusedAdminDeps } from '../admin/testing';

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
    partnerCode: PARTNER_REF,
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

const testApp = (auth: AuthRoutesDeps, logs?: { write(line: string): void }) =>
  buildApp({
    admin: unusedAdminDeps(),
    checkPostgres: () => Promise.resolve(),
    checkRedis: () => Promise.resolve(),
    // trace, so a level below production's info cannot hide a line from the log tests
    logLevel: logs === undefined ? 'silent' : 'trace',
    ...(logs === undefined ? {} : { logDestination: logs }),
    checkTimeoutMs: 20,
    trading: { db: tmp.db, internalApiToken: TOKEN, onIntentQueued: () => {} },
    auth,
    users: { db: tmp.db, internalApiToken: TOKEN },
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

const stateFor = async (telegramUserId: string, instance = app): Promise<string> =>
  ((await start(telegramUserId, `Bearer ${TOKEN}`, instance)).json() as { state: string }).state;

async function login(telegramUserId: string, brokerUserId: string, isPartnerClient?: boolean) {
  const started = await start(telegramUserId);
  const { state } = started.json() as { state: string };
  const code = stub.issueCode({ brokerUserId, isPartnerClient });
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
    const state = await stateFor(telegramId());
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
    const state = await stateFor(telegram);
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
    const state = await stateFor(telegram);
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
    const state = await stateFor(telegram);
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
    const first = await stateFor(telegram);
    expect((await callback({ state: first, code })).statusCode).toBe(200);

    const second = await stateFor(telegram);
    const response = await callback({ state: second, code });
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
    const state = await stateFor(seeded.telegramUserId);
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
    const state = await stateFor(telegram);
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

  it('stops a flood before it reaches the database', async () => {
    const instance = await limited({ callbackMaxPerMinute: 2 });
    try {
      const before = stub.tokenRequests;
      expect((await callback({ state: 'a', code: 'c' }, instance)).statusCode).toBe(400);
      expect((await callback({ state: 'b', code: 'c' }, instance)).statusCode).toBe(400);
      const blocked = await callback({ state: 'c', code: 'c' }, instance);
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json()).toEqual({ error: 'too_many_requests' });
      // the ceiling applies to a well-formed request too: it is checked before the body is read
      expect((await callback('not-even-an-object', instance)).statusCode).toBe(429);
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
        const state = await stateFor(telegram, instance);
        const response = await callback(
          {
            state,
            code: stub.issueCode({ brokerUserId: `broker-${telegram}` }),
          },
          instance,
        );
        expect(response.statusCode).toBe(200);
      }

      expect((await callback({ state: 'miss-1', code: 'c' }, instance)).statusCode).toBe(400);
      expect((await callback({ state: 'miss-2', code: 'c' }, instance)).statusCode).toBe(400);
      expect((await callback({ state: 'miss-3', code: 'c' }, instance)).statusCode).toBe(429);
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
        [1, 2, 3, 4, 5, 6].map((n) => callback({ state: `burst-${n}`, code: 'c' }, instance)),
      );
      const statuses = responses.map((r) => r.statusCode).sort();
      expect(statuses).toEqual([400, 400, 429, 429, 429, 429]);
    } finally {
      await instance.close();
    }
  });

  it('refuses before it reaches the state row at all', async () => {
    const telegram = telegramId();
    const state = await stateFor(telegram);
    const instance = await limited({ callbackMaxPerMinute: 0 });
    try {
      const response = await callback(
        {
          state,
          code: stub.issueCode({ brokerUserId: `broker-${telegram}` }),
        },
        instance,
      );
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
        const response = await callback({ state: `outage-${i}`, code: 'c' }, instance);
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

  // partner status is spelled out at every call: the stub's default is not what a test means
  const linked = async (isPartnerClient: boolean, telegram = telegramId()) => {
    const { response } = await login(telegram, `broker-${telegram}-${++seq}`, isPartnerClient);
    const { account } = response.json() as { account: { id: string; status: string } };
    return { telegram, account };
  };

  it('requires the internal token', async () => {
    const { telegram, account } = await linked(false);
    expect(
      (await confirm({ telegramUserId: telegram, accountId: account.id }, 'Bearer nope'))
        .statusCode,
    ).toBe(401);
  });

  it('turns the pending account the login created into a usable one', async () => {
    const { telegram, account } = await linked(false);
    expect(account.status).toBe('pending');

    const response = await confirm({ telegramUserId: telegram, accountId: account.id });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      account: { id: account.id, status: 'active' },
      grant: { granted: false, reason: 'not_partner_client' },
    });
    expect(
      (
        await tmp.db
          .select({ status: brokerAccounts.status })
          .from(brokerAccounts)
          .where(eq(brokerAccounts.id, account.id))
      )[0]?.status,
    ).toBe('active');
  });

  it('pays the starter pack for a partner account, and says so', async () => {
    const { telegram, account } = await linked(true);
    const response = await confirm({ telegramUserId: telegram, accountId: account.id });
    expect(response.statusCode).toBe(200);
    const body = response.json() as unknown;
    expect(confirmLoginResponseSchema.parse(body)).toEqual(body);
    expect(body).toMatchObject({
      account: { id: account.id, status: 'active', isPartnerClient: true },
      grant: { granted: true, tokens: LINK_BONUS_TOKENS.toString() },
    });
    const [user] = await tmp.db
      .select({ balance: users.tokenBalance })
      .from(users)
      .where(eq(users.telegramUserId, BigInt(telegram)));
    expect(user?.balance).toBe(LINK_BONUS_TOKENS);
  });

  it('pays nothing for the same user’s second partner account', async () => {
    const first = await linked(true);
    await confirm({ telegramUserId: first.telegram, accountId: first.account.id });
    const second = await linked(true, first.telegram);
    const response = await confirm({
      telegramUserId: first.telegram,
      accountId: second.account.id,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      account: { id: second.account.id, status: 'active' },
      grant: { granted: false, reason: 'already_granted' },
    });
  });

  it('refuses an account that belongs to someone else', async () => {
    const { account } = await linked(false);
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
    const { telegram, account } = await linked(false);
    expect((await confirm({ telegramUserId: telegram, accountId: account.id })).statusCode).toBe(
      200,
    );
    const again = await confirm({ telegramUserId: telegram, accountId: account.id });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: 'account_not_pending' });
  });

  it('refuses a blocked user', async () => {
    const { telegram, account } = await linked(false);
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
    const state = await stateFor(telegram);
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

// --- Email login (issue #162) ------------------------------------------------------------------

const bearer = { authorization: `Bearer ${TOKEN}` };
let mailSeq = 0;
const address = (label = 'user') => `${label}-${++mailSeq}@example.test`;

const sendCode = (payload: unknown, instance = app, headers = bearer) =>
  postJson(instance, '/auth/binodex/email/send-code', payload, headers);
const emailLogin = (payload: unknown, instance = app, headers = bearer) =>
  postJson(instance, '/auth/binodex/email/login', payload, headers);

// asks the stub for a code and redeems it; the stub answers the newest code per address
async function loginByEmail(telegramUserId: string, email: string, instance = app) {
  expect((await sendCode({ telegramUserId, email }, instance)).statusCode).toBe(200);
  const code = stub.codeFor(email);
  if (code === undefined) throw new Error('the stub sent no code');
  return emailLogin({ telegramUserId, email, code }, instance);
}

const accountOf = async (brokerUserId: string) => {
  const [row] = await tmp.db
    .select()
    .from(brokerAccounts)
    .where(eq(brokerAccounts.brokerUserId, brokerUserId));
  return row;
};
const userIdOf = async (telegramUserId: string) => {
  const [row] = await tmp.db
    .select({ id: users.id, balance: users.tokenBalance })
    .from(users)
    .where(eq(users.telegramUserId, BigInt(telegramUserId)));
  return row;
};

// a broker whose email calls fail the way `fail` says, for the outcomes the stub cannot produce
const failingBroker = (fail: () => never): BrokerOAuthClient => ({
  ...authDeps.broker,
  sendEmailCode: async () => fail(),
  emailLogin: async () => fail(),
});

const own = async (over: Partial<AuthRoutesDeps>, logs?: { write(line: string): void }) => {
  const instance = testApp({ ...authDeps, ...over }, logs);
  await instance.ready();
  return instance;
};

describe('POST /auth/binodex/email/send-code', () => {
  it('requires the internal token', async () => {
    const payload = { telegramUserId: telegramId(), email: address() };
    expect((await sendCode(payload, app, { authorization: 'Bearer nope' })).statusCode).toBe(401);
    expect(
      (await emailLogin({ ...payload, code: '1' }, app, { authorization: '' })).statusCode,
    ).toBe(401);
  });

  it('asks the broker for a code and answers codeSent', async () => {
    const email = address();
    const response = await sendCode({ telegramUserId: telegramId(), email });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ codeSent: true });
    expect(stub.codeFor(email)).toBeDefined();
  });

  it('trims the address before sending it', async () => {
    const email = address();
    const response = await sendCode({ telegramUserId: telegramId(), email: `  ${email}  ` });
    expect(response.statusCode).toBe(200);
    expect(stub.codeFor(email)).toBeDefined();
  });

  it.each([
    ['no address', {}],
    ['an address without @', { email: 'ada.example.test' }],
    ['an address with a space inside', { email: 'ada @example.test' }],
  ])('rejects %s with 400 validation, before the broker', async (_label, patch) => {
    const before = stub.tokenRequests;
    const response = await sendCode({ telegramUserId: telegramId(), ...patch });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('validation');
    expect(stub.tokenRequests).toBe(before);
  });

  it('refuses a blocked user before the broker', async () => {
    const blocked = await seedUser(tmp.db, { status: 'blocked' });
    const before = stub.tokenRequests;
    const response = await sendCode({ telegramUserId: blocked.telegramUserId, email: address() });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'user_blocked' });
    expect(stub.tokenRequests).toBe(before);
  });

  it('refuses the fourth code for one Telegram user within the window', async () => {
    const telegramUserId = telegramId();
    for (let i = 0; i < 3; i += 1) {
      expect((await sendCode({ telegramUserId, email: address() })).statusCode).toBe(200);
    }
    const before = stub.tokenRequests;
    const fourth = await sendCode({ telegramUserId, email: address() });
    expect(fourth.statusCode).toBe(429);
    expect(fourth.json()).toEqual({ error: 'too_many_attempts' });
    expect(stub.tokenRequests).toBe(before);
  });

  it('refuses the fourth code for one address, whatever its case and whoever asks', async () => {
    const email = address('shared');
    for (const variant of [email, email.toUpperCase(), email]) {
      expect((await sendCode({ telegramUserId: telegramId(), email: variant })).statusCode).toBe(
        200,
      );
    }
    const fourth = await sendCode({ telegramUserId: telegramId(), email });
    expect(fourth.statusCode).toBe(429);
    expect(fourth.json()).toEqual({ error: 'too_many_attempts' });
  });

  it('holds a route ceiling that a caller without the token cannot spend', async () => {
    const instance = await own({ emailSendCodeMaxPerMinute: 1 });
    try {
      for (let i = 0; i < 3; i += 1) {
        const anonymous = await sendCode(
          { telegramUserId: telegramId(), email: address() },
          instance,
          {
            authorization: 'Bearer nope',
          },
        );
        expect(anonymous.statusCode).toBe(401);
      }
      expect(
        (await sendCode({ telegramUserId: telegramId(), email: address() }, instance)).statusCode,
      ).toBe(200);
      const over = await sendCode({ telegramUserId: telegramId(), email: address() }, instance);
      expect(over.statusCode).toBe(429);
      expect(over.json()).toEqual({ error: 'too_many_requests' });
    } finally {
      await instance.close();
    }
  });

  it.each([
    [BrokerOAuthErrorCode.InvalidGrant, 400, 'invalid_email'],
    [BrokerOAuthErrorCode.Rejected, 502, 'broker_contract_violation'],
    [BrokerOAuthErrorCode.ContractViolation, 502, 'broker_contract_violation'],
    [BrokerOAuthErrorCode.Unavailable, 502, 'broker_unavailable'],
  ] as const)('maps a broker %s to %i %s', async (brokerCode, status, error) => {
    const instance = await own({
      broker: failingBroker(() => {
        throw new BrokerOAuthError(brokerCode, 400);
      }),
    });
    try {
      const response = await sendCode({ telegramUserId: telegramId(), email: address() }, instance);
      expect(response.statusCode).toBe(status);
      expect(response.json()).toEqual({ error });
    } finally {
      await instance.close();
    }
  });
});

describe('POST /auth/binodex/email/login', () => {
  it('registers a new partner account, activates it and pays the starter pack', async () => {
    const telegramUserId = telegramId();
    const email = address('new');
    const response = await loginByEmail(telegramUserId, email);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(Object.keys(body).sort()).toEqual(['account', 'grant']);
    expect(emailLoginResponseSchema.parse(body)).toMatchObject({
      account: { status: 'active', isPartnerClient: true, email },
      grant: { granted: true, tokens: LINK_BONUS_TOKENS.toString() },
    });
    expect(stub.lastEmailLoginBodyKeys).toContain('partner_code');

    const row = await accountOf(body.account.brokerUserId);
    expect(row).toMatchObject({ status: 'active', authRevokedReason: null });
    expect(row?.refreshTokenHash).toMatch(/^[0-9a-f]{64}$/);
    const user = await userIdOf(telegramUserId);
    expect(user?.balance).toBe(LINK_BONUS_TOKENS);
    const ledger = await tmp.db
      .select({ delta: tokenLedger.balanceDelta })
      .from(tokenLedger)
      .where(eq(tokenLedger.userId, user!.id));
    expect(ledger).toEqual([{ delta: LINK_BONUS_TOKENS }]);
  });

  it('signs an existing broker user in to the same account', async () => {
    const email = address('old');
    stub.registerEmailUser({ email, brokerUserId: 'broker-email-old', isPartnerClient: false });
    const response = await loginByEmail(telegramId(), email);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      account: { brokerUserId: 'broker-email-old', status: 'active' },
      grant: { granted: false, reason: 'not_partner_client' },
    });
  });

  it('activates the pending account an unfinished OAuth login left, and pays', async () => {
    const telegramUserId = telegramId();
    const email = address('pending');
    stub.registerEmailUser({ email, brokerUserId: 'broker-email-pending', isPartnerClient: true });
    const { response: linked } = await login(telegramUserId, 'broker-email-pending', true);
    expect(linked.json().account.status).toBe('pending');

    const response = await loginByEmail(telegramUserId, email);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      account: { id: linked.json().account.id, status: 'active' },
      grant: { granted: true },
    });
  });

  it('brings a revoked account back to active', async () => {
    const telegramUserId = telegramId();
    const email = address('revoked');
    const first = await loginByEmail(telegramUserId, email);
    await tmp.db
      .update(brokerAccounts)
      .set({ status: 'revoked', authRevokedReason: 'refresh_invalid_grant' })
      .where(eq(brokerAccounts.id, first.json().account.id));

    const again = await loginByEmail(telegramUserId, email);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({
      account: { id: first.json().account.id, status: 'active' },
      grant: { granted: false, reason: 'already_granted' },
    });
    expect((await accountOf(first.json().account.brokerUserId))?.authRevokedReason).toBeNull();
  });

  it('refuses an account that already belongs to another Telegram user', async () => {
    const email = address('taken');
    const first = await loginByEmail(telegramId(), email);
    const before = await accountOf(first.json().account.brokerUserId);

    const response = await loginByEmail(telegramId(), email);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'broker_account_taken' });
    expect(await accountOf(first.json().account.brokerUserId)).toEqual(before);
  });

  it('pays nothing for the same user’s second partner account', async () => {
    const telegramUserId = telegramId();
    expect((await loginByEmail(telegramUserId, address('first'))).json().grant.granted).toBe(true);
    const second = await loginByEmail(telegramUserId, address('second'));
    expect(second.statusCode).toBe(200);
    expect(second.json().grant).toEqual({ granted: false, reason: 'already_granted' });
    expect((await userIdOf(telegramUserId))?.balance).toBe(LINK_BONUS_TOKENS);
  });

  it('maps a wrong code to 400 invalid_code and writes nothing', async () => {
    const telegramUserId = telegramId();
    const email = address('wrong');
    await sendCode({ telegramUserId, email });
    const response = await emailLogin({ telegramUserId, email, code: 'not-the-code' });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid_code' });
    expect(await userIdOf(telegramUserId)).toBeUndefined();
  });

  it('refuses the sixth attempt within the window even with the right code', async () => {
    const telegramUserId = telegramId();
    const email = address('sixth');
    await sendCode({ telegramUserId, email });
    for (let i = 0; i < 5; i += 1) {
      expect((await emailLogin({ telegramUserId, email, code: `wrong-${i}` })).statusCode).toBe(
        400,
      );
    }
    const before = stub.tokenRequests;
    const sixth = await emailLogin({ telegramUserId, email, code: stub.codeFor(email) });
    expect(sixth.statusCode).toBe(429);
    expect(sixth.json()).toEqual({ error: 'too_many_attempts' });
    expect(stub.tokenRequests).toBe(before);
  });

  it('counts attempts per address across Telegram users', async () => {
    const email = address('spread');
    await sendCode({ telegramUserId: telegramId(), email });
    for (let i = 0; i < 5; i += 1) {
      const attempt = await emailLogin({ telegramUserId: telegramId(), email, code: `wrong-${i}` });
      expect(attempt.statusCode).toBe(400);
    }
    const sixth = await emailLogin({ telegramUserId: telegramId(), email, code: 'wrong-6' });
    expect(sixth.statusCode).toBe(429);
    expect(sixth.json()).toEqual({ error: 'too_many_attempts' });
  });

  it('holds a route ceiling', async () => {
    const instance = await own({ emailLoginMaxPerMinute: 1 });
    try {
      const payload = () => ({ telegramUserId: telegramId(), email: address(), code: 'x' });
      expect((await emailLogin(payload(), instance)).statusCode).toBe(400);
      const over = await emailLogin(payload(), instance);
      expect(over.statusCode).toBe(429);
      expect(over.json()).toEqual({ error: 'too_many_requests' });
    } finally {
      await instance.close();
    }
  });

  it.each([
    ['an empty code', { code: '   ' }],
    ['no code', { code: undefined }],
    ['an address without @', { email: 'ada.example.test' }],
  ])('rejects %s with 400 validation', async (_label, patch) => {
    const response = await emailLogin({
      telegramUserId: telegramId(),
      email: address(),
      code: '123456',
      ...patch,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('validation');
  });

  it('refuses a blocked user before the broker', async () => {
    const blocked = await seedUser(tmp.db, { status: 'blocked' });
    const before = stub.tokenRequests;
    const response = await emailLogin({
      telegramUserId: blocked.telegramUserId,
      email: address(),
      code: '123456',
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'user_blocked' });
    expect(stub.tokenRequests).toBe(before);
  });

  it('reports a wrong client secret as 502, not as a bad code', async () => {
    const instance = await own({
      broker: createBrokerOAuthClient({
        baseUrl: stub.url,
        clientId: CLIENT_ID,
        clientSecret: 'not-the-secret',
      }),
    });
    try {
      const response = await emailLogin(
        { telegramUserId: telegramId(), email: address(), code: '1' },
        instance,
      );
      expect(response.statusCode).toBe(502);
      expect(response.json()).toEqual({ error: 'broker_contract_violation' });
    } finally {
      await instance.close();
    }
  });

  it('makes the account visible to /users/start as active', async () => {
    const telegramUserId = telegramId();
    expect((await loginByEmail(telegramUserId, address('start'))).statusCode).toBe(200);
    const started = await postJson(
      app,
      '/users/start',
      { telegramUserId, displayName: 'Ada' },
      bearer,
    );
    expect(started.json().user.hasActiveBrokerAccount).toBe(true);
  });

  it('leaves the OAuth callback linking as pending', async () => {
    const { response } = await login(telegramId(), 'broker-oauth-regression', true);
    expect(response.json().account.status).toBe('pending');
  });
});

describe('the email login logs', () => {
  it('writes neither the address nor the code on its failure paths', async () => {
    const lines: string[] = [];
    const sink = { write: (line: string) => void lines.push(line) };
    const outcomes = [
      new BrokerOAuthError(BrokerOAuthErrorCode.InvalidGrant, 400),
      new BrokerOAuthError(BrokerOAuthErrorCode.Unavailable),
    ];
    // the success path as well, through the stub
    const working = await own({}, sink);
    try {
      const telegramUserId = telegramId();
      const email = `MARKER-ADDRESS-${++mailSeq}@example.test`;
      await sendCode({ telegramUserId, email }, working);
      const ok = await emailLogin({ telegramUserId, email, code: stub.codeFor(email) }, working);
      expect(ok.statusCode).toBe(200);
    } finally {
      await working.close();
    }
    for (const outcome of outcomes) {
      const instance = await own(
        {
          broker: failingBroker(() => {
            throw outcome;
          }),
        },
        sink,
      );
      try {
        const telegramUserId = telegramId();
        const email = `MARKER-ADDRESS-${++mailSeq}@example.test`;
        await sendCode({ telegramUserId, email }, instance);
        await emailLogin({ telegramUserId, email, code: 'MARKER-CODE' }, instance);
      } finally {
        await instance.close();
      }
    }
    // the warn lines are there, so the absence below is about their content
    expect(lines.filter((line) => line.includes('the email code could not be sent'))).toHaveLength(
      2,
    );
    expect(
      lines.filter((line) => line.includes('the email code could not be redeemed')),
    ).toHaveLength(2);
    const all = lines.join('\n');
    expect(all).not.toContain('MARKER-ADDRESS');
    expect(all).not.toContain('MARKER-CODE');
  });
});
