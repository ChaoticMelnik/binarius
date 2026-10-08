import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  AccountHaltReason,
  confirmLoginResponseSchema,
  emailLoginResponseSchema,
  INIT_DATA_MAX_LENGTH,
} from '@binarius/shared';
import {
  LINK_BONUS_TOKENS,
  NotificationJobStatus,
  brokerAccounts,
  createDb,
  createOAuthState,
  createTokenCipher,
  hashToken,
  notificationJobs,
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
import {
  callsTo,
  captureApi,
  inlineButtons,
  unusedAdminDeps,
  type CapturedApi,
} from '../admin/testing';
import { createLinkNotifier } from './link-notifier';
import { INIT_DATA_MAX_AGE_MS, OAUTH_STATE_TTL_MS } from './oauth-timing';
import { createInitDataVerifier } from './telegram-init-data';
import { signInitData } from './testing/init-data';
import { CLIENT_LABELS, CLIENT_TEXTS } from './texts';
import {
  unusedAccessTokenDeps,
  unusedBalanceDeps,
  unusedPairsDeps,
  unusedSignalDeps,
  unusedSessionDeps,
  unusedSignalsDeps,
} from '../trading/testing';

const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for apps/backend integration tests (see README → Test database)',
  );
}

const TOKEN = 'internal-token-for-tests';
const CLIENT_ID = 'client-id';
const CLIENT_SECRET = 'client-secret-value';
const REDIRECT_URI = 'https://bot.example/oauth/callback';
const AUTHORIZE_URL = 'https://binodex.app/oauth/authorize';
const PARTNER_REF = 'partner-ref';
const PUSH_BOT_TOKEN = '5678:MARKER-PUSH-TOKEN';

const cipher = createTokenCipher({ keyId: 'test-key', key: randomBytes(32) });

let tmp: TempDatabase;
let stub: OAuthStub;
let app: ReturnType<typeof buildApp>;
let authDeps: AuthRoutesDeps;
// every push the shared app sends; a case reads only the ones addressed to its own Telegram id
let pushApi: CapturedApi;

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
    linkNotifier: createLinkNotifier({ token: PUSH_BOT_TOKEN }),
    // the one public bot both sends the push and launched the Mini App (until #314), as in
    // production
    initDataVerifier: createInitDataVerifier({
      botToken: PUSH_BOT_TOKEN,
      maxAgeMs: INIT_DATA_MAX_AGE_MS,
    }),
  };
  pushApi = captureApi(authDeps.linkNotifier);
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
    pairs: unusedPairsDeps(),
    sessions: unusedSessionDeps(),
    signal: unusedSignalDeps(),
    signals: unusedSignalsDeps(),
    admin: unusedAdminDeps(),
    checkPostgres: () => Promise.resolve(),
    checkRedis: () => Promise.resolve(),
    // trace, so a level below production's info cannot hide a line from the log tests
    logLevel: logs === undefined ? 'silent' : 'trace',
    ...(logs === undefined ? {} : { logDestination: logs }),
    checkTimeoutMs: 20,
    trading: {
      db: tmp.db,
      internalApiToken: TOKEN,
      onIntentQueued: () => {},
      balance: unusedBalanceDeps(),
      accessToken: unusedAccessTokenDeps(),
    },
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

// who each issued state belongs to, so a callback can carry that user's initData by default
const stateOwners = new Map<string, string>();
// signs the initData of a callback whose state no test issued
const STRANGER_TELEGRAM_ID = '7999999';

const initDataFor = (telegramUserId: string | bigint, authDate?: number) =>
  signInitData({
    botToken: PUSH_BOT_TOKEN,
    telegramUserId: BigInt(telegramUserId),
    ...(authDate === undefined ? {} : { authDate }),
  });

// No route issues a state since #314, so the cases seed one as the removed start route did.
const stateFor = async (telegramUserId: string): Promise<string> => {
  const { state } = await createOAuthState(tmp.db, {
    telegramUserId: BigInt(telegramUserId),
    redirectUri: REDIRECT_URI,
    ttlMs: OAUTH_STATE_TTL_MS,
  });
  stateOwners.set(state, telegramUserId);
  return state;
};

// The state owner's own signed initData is added to every object body that names no initData
// key of its own, so the cases written before #113 still test what they say. A case about the
// proof itself passes `initData` explicitly — `undefined` to leave it out of the body.
const callback = (payload: unknown, instance = app) => {
  if (typeof payload !== 'object' || payload === null || 'initData' in payload) {
    return postJson(instance, '/auth/binodex/callback', payload);
  }
  const { state } = payload as { state?: unknown };
  const owner = (typeof state === 'string' && stateOwners.get(state)) || STRANGER_TELEGRAM_ID;
  return postJson(instance, '/auth/binodex/callback', {
    ...payload,
    initData: initDataFor(owner),
  });
};

async function login(telegramUserId: string, brokerUserId: string, isPartnerClient?: boolean) {
  const state = await stateFor(telegramUserId);
  const code = stub.issueCode({ brokerUserId, isPartnerClient });
  return { response: await callback({ state, code }), state };
}

// #314: the bot offers only the email login, so the route that issued a state is gone
describe('POST /auth/binodex/start', () => {
  it('answers 404 with and without the internal token and issues no state', async () => {
    const telegram = telegramId();
    for (const authorization of [`Bearer ${TOKEN}`, '']) {
      const response = await postJson(
        app,
        '/auth/binodex/start',
        { telegramUserId: telegram },
        { authorization },
      );
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: 'not_found' });
    }
    const states = await tmp.db
      .select({ id: oauthStates.id })
      .from(oauthStates)
      .where(eq(oauthStates.telegramUserId, BigInt(telegram)));
    expect(states).toEqual([]);
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
        haltedReason: AccountHaltReason.ReconciliationAmbiguous,
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
      haltedReason: AccountHaltReason.ReconciliationAmbiguous,
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
        const state = await stateFor(telegram);
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

// --- The Telegram proof on the callback (issue #113) ---------------------------------------------

const nowSeconds = () => Math.floor(Date.now() / 1000);
const MAX_AGE_SECONDS = INIT_DATA_MAX_AGE_MS / 1000;

const forged = (initData: string) => {
  const params = new URLSearchParams(initData);
  params.set('hash', 'f'.repeat(64));
  return params.toString();
};

const stateUsedAt = async (state: string) => {
  const [row] = await tmp.db
    .select({ usedAt: oauthStates.usedAt })
    .from(oauthStates)
    .where(eq(oauthStates.stateHash, hashToken(state)));
  return row?.usedAt;
};

const accountsOf = (brokerUserId: string) =>
  tmp.db
    .select({ id: brokerAccounts.id })
    .from(brokerAccounts)
    .where(eq(brokerAccounts.brokerUserId, brokerUserId));

describe('the Telegram proof on the callback', () => {
  it('refuses a callback without initData and leaves the state usable', async () => {
    const telegram = telegramId();
    const state = await stateFor(telegram);
    const before = stub.tokenRequests;
    const refused = await callback({ state, code: 'c', initData: undefined });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ error: 'validation' });
    expect(stub.tokenRequests).toBe(before);

    const ok = await callback({
      state,
      code: stub.issueCode({ brokerUserId: `broker-${telegram}` }),
    });
    expect(ok.statusCode).toBe(200);
  });

  it.each([
    ['a forged signature', (telegram: string) => forged(initDataFor(telegram))],
    [
      "another bot's signature",
      (telegram: string) =>
        signInitData({ botToken: '9999:ANOTHER-BOT', telegramUserId: BigInt(telegram) }),
    ],
    ['free text', () => 'user=1&auth_date=1'],
  ])('refuses %s with 401 before the state is touched', async (_label, makeInitData) => {
    const telegram = telegramId();
    const state = await stateFor(telegram);
    const before = stub.tokenRequests;
    const code = stub.issueCode({ brokerUserId: `broker-${telegram}` });
    const refused = await callback({ state, code, initData: makeInitData(telegram) });
    expect(refused.statusCode).toBe(401);
    expect(refused.json()).toEqual({ error: 'invalid_telegram_auth' });
    expect(stub.tokenRequests).toBe(before);
    expect(await stateUsedAt(state)).toBeNull();
    // the owner is not known before the state is read, so nobody is told
    expect(pushesTo(telegram)).toEqual([]);

    expect((await callback({ state, code })).statusCode).toBe(200);
  });

  it('refuses initData older than the window and accepts it just inside', async () => {
    const telegram = telegramId();
    const state = await stateFor(telegram);
    const code = stub.issueCode({ brokerUserId: `broker-${telegram}` });
    const stale = await callback({
      state,
      code,
      initData: initDataFor(telegram, nowSeconds() - MAX_AGE_SECONDS - 2),
    });
    expect(stale.statusCode).toBe(401);
    expect(stale.json()).toEqual({ error: 'invalid_telegram_auth' });
    expect(await stateUsedAt(state)).toBeNull();

    const fresh = await callback({
      state,
      code,
      initData: initDataFor(telegram, nowSeconds() - MAX_AGE_SECONDS + 2),
    });
    expect(fresh.statusCode).toBe(200);
  });

  it('burns the state of a login another Telegram user finishes, and tells only its owner', async () => {
    const owner = telegramId();
    const other = telegramId();
    const state = await stateFor(owner);
    const before = stub.tokenRequests;
    const code = stub.issueCode({ brokerUserId: `broker-${owner}` });

    const refused = await callback({ state, code, initData: initDataFor(other) });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual({ error: 'telegram_user_mismatch' });
    expect(await stateUsedAt(state)).not.toBeNull();

    // the owner's own proof cannot revive it
    const retried = await callback({ state, code, initData: initDataFor(owner) });
    expect(retried.statusCode).toBe(400);
    expect(retried.json()).toEqual({ error: 'invalid_state' });

    expect(stub.tokenRequests).toBe(before);
    expect(await accountsOf(`broker-${owner}`)).toEqual([]);
    expect(pushesTo(owner).map((push) => [push.text, inlineButtons(push)])).toEqual([
      [CLIENT_TEXTS.oauthLoginFailed.value, CONNECT_AGAIN],
    ]);
    expect(pushesTo(other)).toEqual([]);
  });

  it('spends the narrow window on neither a bad proof nor a mismatch', async () => {
    const instance = await own({ callbackMaxFailuresPerMinute: 2 });
    try {
      for (let i = 0; i < 3; i += 1) {
        const telegram = telegramId();
        const state = await stateFor(telegram);
        const response = await callback(
          { state, code: 'c', initData: forged(initDataFor(telegram)) },
          instance,
        );
        expect(response.statusCode).toBe(401);
      }
      for (let i = 0; i < 3; i += 1) {
        const state = await stateFor(telegramId());
        const response = await callback(
          { state, code: 'c', initData: initDataFor(telegramId()) },
          instance,
        );
        expect(response.statusCode).toBe(403);
      }
      const telegram = telegramId();
      const state = await stateFor(telegram);
      const response = await callback(
        { state, code: stub.issueCode({ brokerUserId: `broker-${telegram}` }) },
        instance,
      );
      expect(response.statusCode).toBe(200);
    } finally {
      await instance.close();
    }
  });

  // the body limit has to admit what the schema admits, or the largest valid initData would be
  // refused as 413 before it is ever checked
  it('reads a body with every field at its schema maximum', async () => {
    const response = await callback({
      state: 's'.repeat(256),
      code: 'c'.repeat(512),
      initData: 'i'.repeat(INIT_DATA_MAX_LENGTH),
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'invalid_telegram_auth' });

    const over = await callback({
      state: 's',
      code: 'c',
      initData: 'i'.repeat(INIT_DATA_MAX_LENGTH + 1),
    });
    expect(over.statusCode).toBe(400);
  });

  it('writes neither the initData, its hash, the state nor a Telegram id', async () => {
    const lines: string[] = [];
    const instance = await own({}, { write: (line: string) => void lines.push(line) });
    const owner = telegramId();
    const other = telegramId();
    const markers = { user: { first_name: 'MARKER-NAME' }, fields: { query_id: 'MARKER-QUERY' } };
    const otherProof = signInitData({
      botToken: PUSH_BOT_TOKEN,
      telegramUserId: BigInt(other),
      ...markers,
    });
    const badProof = forged(otherProof);
    const states = [await stateFor(owner), await stateFor(owner)];
    const bodies: string[] = [];
    try {
      const refused = await callback({ state: states[0], code: 'c', initData: badProof }, instance);
      expect(refused.statusCode).toBe(401);
      const mismatched = await callback(
        { state: states[1], code: 'c', initData: otherProof },
        instance,
      );
      expect(mismatched.statusCode).toBe(403);
      bodies.push(refused.body, mismatched.body);
    } finally {
      await instance.close();
    }

    const warned = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.level === 40);
    // the warn lines are there, so the absence below is about their content
    expect(warned.map((line) => line.msg)).toEqual([
      'the callback carried no valid Telegram proof',
      "the callback came from a Telegram user other than the state's owner",
    ]);
    expect(warned[0]).toMatchObject({ reason: 'bad_signature' });
    expect(warned[1]).toMatchObject({ outcome: 'telegram_user_mismatch' });
    for (const line of warned) {
      expect(JSON.stringify(line)).not.toContain(owner);
      expect(JSON.stringify(line)).not.toContain(other);
    }
    const otherHash = new URLSearchParams(otherProof).get('hash') ?? '';
    for (const text of [lines.join('\n'), ...bodies]) {
      expect(text).not.toContain('MARKER-NAME');
      expect(text).not.toContain('MARKER-QUERY');
      expect(text).not.toContain(otherHash);
      expect(text).not.toContain('f'.repeat(64));
      for (const state of states) expect(text).not.toContain(state);
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

// --- The push after the callback (issue #128) --------------------------------------------------

// #350: a failed login's push offers connecting again and the menu
const CONNECT_AGAIN = [
  { text: CLIENT_LABELS.connectButton, callback_data: 'connect' },
  { text: CLIENT_LABELS.menuButton, callback_data: 'menu' },
];

const pushesTo = (telegramUserId: string, captured = pushApi) =>
  callsTo(captured.calls, 'sendMessage')
    .filter((call) => call.payload.chat_id === telegramUserId)
    .map((call) => call.payload);

describe('the push after the callback', () => {
  it('offers the confirm button for the account a new login linked', async () => {
    const telegram = telegramId();
    const { response } = await login(telegram, `broker-${telegram}`);
    expect(response.statusCode).toBe(200);
    const { account } = response.json() as { account: { id: string } };

    const pushes = pushesTo(telegram);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.text).toBe(CLIENT_TEXTS.confirmPrompt.value);
    expect(pushes[0]?.parse_mode).toBe('HTML');
    expect(inlineButtons(pushes[0])).toEqual([
      {
        text: `✅ Подтвердить: broker-${telegram}@example.test`,
        callback_data: `confirm:${account.id}`,
      },
    ]);
  });

  it('offers the plain confirm button for a blank address', async () => {
    const telegram = telegramId();
    const state = await stateFor(telegram);
    const response = await callback({
      state,
      code: stub.issueCode({ brokerUserId: `broker-${telegram}`, email: '' }),
    });
    expect(response.statusCode).toBe(200);
    const { account } = response.json() as { account: { id: string; email: string | null } };
    expect(account.email).toBeNull();

    const pushes = pushesTo(telegram);
    expect(pushes).toHaveLength(1);
    expect(inlineButtons(pushes[0])).toEqual([
      { text: '✅ Подтвердить привязку', callback_data: `confirm:${account.id}` },
    ]);
  });

  it('offers the button again when a still pending account logs in again', async () => {
    const telegram = telegramId();
    await login(telegram, `broker-${telegram}`);
    const again = await login(telegram, `broker-${telegram}`);
    expect(again.response.statusCode).toBe(200);

    const pushes = pushesTo(telegram);
    expect(pushes).toHaveLength(2);
    expect(pushes[1]?.text).toBe(CLIENT_TEXTS.confirmPrompt.value);
    expect(inlineButtons(pushes[1])).toHaveLength(1);
  });

  it.each(['active', 'revoked'] as const)(
    'says the account is connected, with the demo button (#350), on a re-login of a %s account',
    async (status) => {
      const telegram = telegramId();
      const first = await login(telegram, `broker-${telegram}`);
      const accountId = (first.response.json() as { account: { id: string } }).account.id;
      await tmp.db.update(brokerAccounts).set({ status }).where(eq(brokerAccounts.id, accountId));

      const again = await login(telegram, `broker-${telegram}`);
      expect(again.response.statusCode).toBe(200);
      const pushes = pushesTo(telegram);
      expect(pushes).toHaveLength(2);
      expect(pushes[1]?.text).toBe(CLIENT_TEXTS.linkedActive.value);
      expect(inlineButtons(pushes[1])).toEqual([
        { text: CLIENT_LABELS.demoButton, callback_data: 'demo' },
      ]);
    },
  );

  it('tells the user who started the login, not the owner, that the account is taken', async () => {
    const owner = telegramId();
    const brokerUserId = `broker-${owner}`;
    await login(owner, brokerUserId);
    const intruder = telegramId();
    const { response } = await login(intruder, brokerUserId);
    expect(response.statusCode).toBe(409);

    expect(pushesTo(intruder).map((push) => [push.text, inlineButtons(push)])).toEqual([
      [CLIENT_TEXTS.accountTaken.value, CONNECT_AGAIN],
    ]);
    // the owner heard only about their own login
    expect(pushesTo(owner)).toHaveLength(1);
  });

  it('tells a user blocked after their state was issued that access is restricted', async () => {
    const seeded = await seedUser(tmp.db);
    const state = await stateFor(seeded.telegramUserId);
    await tmp.db.update(users).set({ status: 'blocked' }).where(eq(users.id, seeded.userId));

    const response = await callback({
      state,
      code: stub.issueCode({ brokerUserId: `broker-${seeded.telegramUserId}` }),
    });
    expect(response.statusCode).toBe(409);
    expect(pushesTo(seeded.telegramUserId).map((push) => push.text)).toEqual([
      CLIENT_TEXTS.blocked.value,
    ]);
  });

  it('tells the user to start over when the code is refused', async () => {
    const telegram = telegramId();
    const state = await stateFor(telegram);
    const response = await callback({ state, code: 'never-issued' });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid_code' });
    expect(pushesTo(telegram).map((push) => push.text)).toEqual([
      CLIENT_TEXTS.oauthLoginFailed.value,
    ]);
  });

  it('tells the user to start over when the broker fails', async () => {
    const telegram = telegramId();
    const state = await stateFor(telegram);
    const instance = await own({
      broker: {
        ...authDeps.broker,
        exchangeCode: () => Promise.reject(new BrokerOAuthError(BrokerOAuthErrorCode.Unavailable)),
      },
    });
    try {
      const response = await callback({ state, code: 'c' }, instance);
      expect(response.statusCode).toBe(502);
    } finally {
      await instance.close();
    }
    expect(pushesTo(telegram).map((push) => push.text)).toEqual([
      CLIENT_TEXTS.oauthLoginFailed.value,
    ]);
  });

  // nobody to address: the state is what names the Telegram user
  it('pushes nothing for a state that resolves to no row', async () => {
    const telegram = telegramId();
    const state = await stateFor(telegram);
    await callback({ state, code: stub.issueCode({ brokerUserId: `broker-${telegram}` }) });
    const before = callsTo(pushApi.calls, 'sendMessage').length;

    const replayed = await callback({ state, code: stub.issueCode({ brokerUserId: 'other' }) });
    expect(replayed.json()).toEqual({ error: 'invalid_state' });
    expect(callsTo(pushApi.calls, 'sendMessage')).toHaveLength(before);
  });

  // a 500 leaves the outcome unknown, so nothing is said
  it('pushes nothing when the database fails', async () => {
    const dead = new Pool({ connectionString: tmp.url });
    const instance = await own({ db: createDb(dead) });
    await dead.end();
    const before = callsTo(pushApi.calls, 'sendMessage').length;
    try {
      const response = await callback({ state: 'any', code: 'c' }, instance);
      expect(response.statusCode).toBe(500);
    } finally {
      await instance.close();
    }
    expect(callsTo(pushApi.calls, 'sendMessage')).toHaveLength(before);
  });
});

describe('a push that fails', () => {
  const failing = async (
    notifier: AuthRoutesDeps['linkNotifier'],
    prepare?: (telegram: string) => Promise<void>,
  ) => {
    const lines: string[] = [];
    const instance = await own(
      { linkNotifier: notifier },
      { write: (line: string) => void lines.push(line) },
    );
    const telegram = telegramId();
    const state = await stateFor(telegram);
    await prepare?.(telegram);
    const code = stub.issueCode({ brokerUserId: `MARKER-BROKER-${telegram}` });
    try {
      const response = await callback({ state, code }, instance);
      // the response does not depend on the push
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ account: { status: 'pending' } });
    } finally {
      await instance.close();
    }
    const warned = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.msg === 'the link outcome could not be pushed to Telegram');
    expect(warned).toHaveLength(1);
    const all = lines.join('\n');
    // neither the state, the code, the token nor the email on the button
    expect(all).not.toContain(state);
    expect(all).not.toContain(code);
    expect(all).not.toContain('MARKER-PUSH-TOKEN');
    expect(all).not.toContain('MARKER-BROKER');
    return { warned: warned[0], telegram };
  };

  const blockedAtOf = async (telegram: string) => {
    const [row] = await tmp.db
      .select({ at: users.telegramBlockedAt })
      .from(users)
      .where(eq(users.telegramUserId, BigInt(telegram)));
    return row?.at;
  };

  const refusing = (error_code: number, description: string) => {
    const notifier = createLinkNotifier({ token: PUSH_BOT_TOKEN });
    const captured = captureApi(notifier);
    captured.apiErrors.set('sendMessage', { ok: false, error_code, description });
    return { notifier, captured };
  };

  it('logs a refusal by Telegram by its code and still answers the callback', async () => {
    const { notifier, captured } = refusing(403, 'Forbidden: bot was blocked by the user');
    const { warned } = await failing(notifier);
    expect(warned).toMatchObject({
      level: 40,
      err: { name: 'GrammyError' },
      method: 'sendMessage',
      telegramErrorCode: 403,
      push: 'pending',
    });
    expect(callsTo(captured.calls, 'sendMessage')).toHaveLength(1);
  });

  // the real transport, so the message grammY builds — with the token in its URL — is the one
  // that could leak
  it('logs a transport failure by its identity', async () => {
    const { warned, telegram } = await failing(
      createLinkNotifier({ token: PUSH_BOT_TOKEN, apiRoot: 'http://127.0.0.1:1' }),
    );
    expect(await blockedAtOf(telegram)).toBeNull();
    expect(warned).toMatchObject({
      level: 40,
      err: { name: 'HttpError' },
      method: 'sendMessage',
      transportError: { name: expect.any(String) as string },
      push: 'pending',
    });
  });

  // #119: a 403 means the user cannot be reached; it is recorded without touching the response
  it('marks the state owner unreachable on a 403 and cancels their pending job', async () => {
    const { notifier } = refusing(403, 'Forbidden: bot was blocked by the user');
    let jobId = '';
    // the row the bot's /start would have created; the callback's upsert finds it
    const { warned, telegram } = await failing(notifier, async (owner) => {
      const [user] = await tmp.db
        .insert(users)
        .values({ telegramUserId: BigInt(owner) })
        .returning({ id: users.id });
      const [job] = await tmp.db
        .insert(notificationJobs)
        .values({ userId: user!.id, kind: 'test' })
        .returning({ id: notificationJobs.id });
      jobId = job!.id;
    });
    expect(warned).toMatchObject({ telegramErrorCode: 403, push: 'pending' });
    expect(await blockedAtOf(telegram)).toBeInstanceOf(Date);
    const [job] = await tmp.db
      .select({ status: notificationJobs.status })
      .from(notificationJobs)
      .where(eq(notificationJobs.id, jobId));
    expect(job?.status).toBe(NotificationJobStatus.Canceled);
  });

  it('does not mark the user on a refusal other than 403', async () => {
    const { notifier } = refusing(400, 'Bad Request: chat not found');
    const { telegram } = await failing(notifier);
    expect(await blockedAtOf(telegram)).toBeNull();
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
