import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createBrokerRestClient } from '@binarius/broker-rest';
import {
  AccessTokenRefusal,
  BrokerAccountStatus,
  DEPOSIT_WIDGET_SESSION_PATH,
  DepositErrorCode,
  UserStatus,
  safeParseDepositRefusal,
  safeParseDepositWidgetSessionResponse,
} from '@binarius/shared';
import { hashToken, type Db } from '@binarius/db';
import {
  createTempDatabase,
  seedBrokerAccount,
  seedUser,
  seedUserWithAccount,
  type TempDatabase,
} from '@binarius/db/testing';
import { startMockBroker, type MockBroker } from '@binarius/mock-broker';
import { buildApp } from '../app';
import { unusedAdminDeps } from '../admin/testing';
import type { AuthRoutesDeps } from '../auth/routes';
import type { AccessTokenOptions, AccessTokenResult } from '../auth/token-service';
import { DEPOSIT_INIT_DATA_MAX_AGE_MS } from '../auth/oauth-timing';
import { createInitDataVerifier } from '../auth/telegram-init-data';
import { signInitData } from '../auth/testing/init-data';
import type { UsersRoutesDeps } from '../users/routes';
import {
  PAIRS_TEST_TOKEN,
  unusedAccessTokenDeps,
  unusedBalanceDeps,
  unusedPairsDeps,
  unusedSessionDeps,
  unusedSignalDeps,
  unusedSignalsDeps,
} from '../trading/testing';
import type { DepositRoutesDeps } from './routes';
import { unusedDepositDeps } from './testing';

const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for apps/backend integration tests (see README → Test database)',
  );
}

const BOT_TOKEN = '5678:deposit-test-bot';
const WEB_ORIGIN = 'https://cashier.example';
const PLATFORM = 'https://binodex.app';
const PAY = 'https://pay.binodex.app';
const CLIENT_ID = 'client-id';
const FALLBACK_URL = `${PLATFORM}/embed/pay?mode=deposit&client_id=${CLIENT_ID}`;

let tmp: TempDatabase;
let broker: MockBroker;
let app: FastifyInstance;
const lines: string[] = [];
const extraApps: FastifyInstance[] = [];

// the access token per account, as ensureFreshAccessToken would hand it out; a test overrides one
// account's answer, and every call is recorded
const tokenCalls: { accountId: string; options: AccessTokenOptions }[] = [];
const tokenAnswers = new Map<string, AccessTokenResult | (() => Promise<AccessTokenResult>)>();
const tokenOf = (accountId: string) => `token-${accountId}`;
async function accessToken(
  accountId: string,
  options: AccessTokenOptions,
): Promise<AccessTokenResult> {
  tokenCalls.push({ accountId, options });
  const answer = tokenAnswers.get(accountId);
  if (typeof answer === 'function') return answer();
  return answer ?? { ok: true, accessToken: tokenOf(accountId) };
}

let brokerUserSeq = 0;

// a user with one active account the mock broker knows by its token
async function payer(options: { status?: UserStatus } = {}) {
  const seeded = await seedUserWithAccount(tmp.db, options);
  brokerUserSeq += 1;
  broker.users.register({ id: brokerUserSeq, accessToken: tokenOf(seeded.brokerAccountId) });
  return { ...seeded, brokerUserId: brokerUserSeq };
}

function depositDeps(overrides: Partial<DepositRoutesDeps> = {}): DepositRoutesDeps {
  return {
    db: tmp.db,
    accessToken,
    rest: createBrokerRestClient({ baseUrl: broker.url }),
    initDataVerifier: createInitDataVerifier({
      botToken: BOT_TOKEN,
      maxAgeMs: DEPOSIT_INIT_DATA_MAX_AGE_MS,
    }),
    demoOnly: false,
    webOrigin: WEB_ORIGIN,
    platformOrigin: PLATFORM,
    clientId: CLIENT_ID,
    widgetOrigins: [PLATFORM, PAY],
    balance: unusedDepositDeps().balance,
    clientPush: unusedDepositDeps().clientPush,
    ...overrides,
  };
}

function testApp(deposit: DepositRoutesDeps): FastifyInstance {
  return buildApp({
    deposit,
    checkPostgres: () => Promise.resolve(),
    checkRedis: () => Promise.resolve(),
    logLevel: 'trace',
    checkTimeoutMs: 20,
    logDestination: { write: (line: string) => void lines.push(line) },
    trading: {
      db: tmp.db,
      internalApiToken: PAIRS_TEST_TOKEN,
      onIntentQueued: () => {},
      balance: unusedBalanceDeps(),
      accessToken: unusedAccessTokenDeps(),
      demoOnly: false,
    },
    pairs: unusedPairsDeps(),
    sessions: unusedSessionDeps(),
    signal: unusedSignalDeps(),
    signals: unusedSignalsDeps(),
    auth: { internalApiToken: PAIRS_TEST_TOKEN } as AuthRoutesDeps,
    users: { db: {} as UsersRoutesDeps['db'], internalApiToken: PAIRS_TEST_TOKEN },
    admin: unusedAdminDeps(),
  });
}

async function extraApp(overrides: Partial<DepositRoutesDeps>): Promise<FastifyInstance> {
  const extra = testApp(depositDeps(overrides));
  extraApps.push(extra);
  await extra.ready();
  return extra;
}

// a database that fails the test on any use: the paths before the account resolution read nothing
const noDb = new Proxy({} as Db, {
  get: () => {
    throw new Error('the database was read');
  },
});

const initDataFor = (telegramUserId: string | bigint, authDate?: number) =>
  signInitData({
    botToken: BOT_TOKEN,
    telegramUserId: BigInt(telegramUserId),
    ...(authDate === undefined ? {} : { authDate }),
  });

const mint = (target: FastifyInstance, payload: object, headers: Record<string, string> = {}) =>
  target.inject({ method: 'POST', url: DEPOSIT_WIDGET_SESSION_PATH, payload, headers });

const mintFor = (telegramUserId: string, extra: object = {}, target: FastifyInstance = app) =>
  mint(target, { initData: initDataFor(telegramUserId), ...extra });

function expectRefusal(
  response: { statusCode: number; json: () => unknown },
  status: number,
  error: DepositErrorCode,
) {
  expect(response.statusCode).toBe(status);
  expect(response.json()).toEqual({ error });
  expect(safeParseDepositRefusal(response.json()).success).toBe(true);
}

const sessionsOf = (brokerUserId: number) =>
  broker.widgetSessions.list().filter((record) => record.userId === brokerUserId);
const callsFor = (accountId: string) => tokenCalls.filter((call) => call.accountId === accountId);
const logged = (msg: string) =>
  lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((l) => l.msg === msg);

beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
  broker = await startMockBroker();
  app = testApp(depositDeps());
  await app.ready();
});
afterAll(async () => {
  await app.close();
  for (const extra of extraApps) await extra.close();
  await broker.close();
  await tmp.drop();
});
beforeEach(() => {
  broker.rest.clearJournal();
});

describe('POST /deposit/widget-session', () => {
  it('D6 mints a session for the active account and builds the fallback widget URL', async () => {
    const user = await payer();
    const response = await mintFor(user.telegramUserId);
    expect(response.statusCode).toBe(200);
    const body = safeParseDepositWidgetSessionResponse(response.json());
    expect(body.success).toBe(true);
    expect(response.json()).toMatchObject({
      expiresInSec: 60,
      widgetUrl: FALLBACK_URL,
      widgetOrigin: PLATFORM,
    });
    expect(sessionsOf(user.brokerUserId)).toEqual([
      { userId: user.brokerUserId, origin: WEB_ORIGIN, mode: 'deposit' },
    ]);
    // a user action: the token may be exchanged (Rule 12)
    expect(callsFor(user.brokerAccountId)).toEqual([
      { accountId: user.brokerAccountId, options: { mayRefresh: true } },
    ]);
  });

  it('D6 passes a widget URL and origin from the allowlist through', async () => {
    const user = await payer();
    broker.rest.failNext('widgetSession', {
      status: 200,
      body: {
        session: 'wss_PASSED',
        expires_in: 45,
        widget_url: `${PAY}/embed?x=1`,
        widget_origin: PAY,
        region: 'ru',
      },
    });
    const response = await mintFor(user.telegramUserId);
    expect(response.statusCode).toBe(200);
    // region and anything else the broker adds never reach the page (Rule 9)
    expect(response.json()).toStrictEqual({
      session: 'wss_PASSED',
      expiresInSec: 45,
      widgetUrl: `${PAY}/embed?x=1`,
      widgetOrigin: PAY,
    });
  });

  it('D6 takes the widget origin from the widget URL when the broker names none', async () => {
    const user = await payer();
    broker.rest.failNext('widgetSession', {
      status: 200,
      body: { session: 'wss_URL', expires_in: 60, widget_url: `${PAY}/w` },
    });
    const response = await mintFor(user.telegramUserId);
    expect(response.json()).toMatchObject({ widgetUrl: `${PAY}/w`, widgetOrigin: PAY });
  });

  it.each([
    ['a widget origin outside the allowlist', { widget_origin: 'https://evil.example' }],
    ['a widget URL outside the allowlist', { widget_url: 'https://evil.example/embed' }],
    ['a widget URL over http', { widget_url: 'http://binodex.app/embed' }],
    ['a widget origin over http', { widget_url: `${PAY}/w`, widget_origin: 'http://binodex.app' }],
  ])('D7 refuses %s as broker_rejected, and logs the origin', async (_name, fields) => {
    const user = await payer();
    const session = `wss_REFUSED_${user.brokerAccountId}`;
    broker.rest.failNext('widgetSession', {
      status: 200,
      body: { session, expires_in: 60, ...fields },
    });
    lines.length = 0;
    expectRefusal(await mintFor(user.telegramUserId), 502, DepositErrorCode.BrokerRejected);
    const [line] = logged('deposit widget session: widget origin not allowed');
    expect(line).toMatchObject({ accountId: user.brokerAccountId });
    expect(String(line?.origin)).toMatch(/^http/);
    // D9: the session the broker minted is not in the log
    expect(lines.join('\n')).not.toContain(session);
  });

  it('D9 never writes the session to the log', async () => {
    const user = await payer();
    lines.length = 0;
    const response = await mintFor(user.telegramUserId);
    const { session } = response.json<{ session: string }>();
    expect(session).toMatch(/^wss_/);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain(session);
  });

  it('D9 redacts a session logged under its key', async () => {
    lines.length = 0;
    app.log.info({ nested: { session: 'wss_LOGGED' } }, 'probe');
    expect(lines.join('\n')).not.toContain('wss_LOGGED');
  });

  it('D1 refuses a forged, stale or malformed initData before any read or broker call', async () => {
    const guarded = await extraApp({ db: noDb });
    const user = await payer();
    const stale = Math.floor((Date.now() - DEPOSIT_INIT_DATA_MAX_AGE_MS - 5_000) / 1000);
    const forged = signInitData({
      botToken: '1:other',
      telegramUserId: BigInt(user.telegramUserId),
    });
    for (const initData of [forged, initDataFor(user.telegramUserId, stale), 'hash=x']) {
      expectRefusal(await mint(guarded, { initData }), 401, DepositErrorCode.InvalidTelegramAuth);
    }
    expect(callsFor(user.brokerAccountId)).toEqual([]);
    expect(broker.rest.journal).toEqual([]);
  });

  // a literal, not the constant: the cashier stays open while the user pays (docs/deposit.md)
  it('D1 still accepts an initData 59 minutes old', async () => {
    const user = await payer();
    const recent = Math.floor((Date.now() - 59 * 60_000) / 1000);
    const response = await mint(app, { initData: initDataFor(user.telegramUserId, recent) });
    expect(response.statusCode).toBe(200);
  });

  it('refuses a body outside the strict schema with 400', async () => {
    const user = await payer();
    const response = await mintFor(user.telegramUserId, { accountId: user.brokerAccountId });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'validation' });
    expect(callsFor(user.brokerAccountId)).toEqual([]);
  });

  it('D10 refuses on a DEMO_ONLY process before any read, token or broker call (#396)', async () => {
    const demoOnly = await extraApp({ db: noDb, demoOnly: true });
    const user = await payer();
    expectRefusal(await mintFor(user.telegramUserId, {}, demoOnly), 409, DepositErrorCode.DemoOnly);
    // before initData too: a forged one gets the same answer
    expectRefusal(await mint(demoOnly, { initData: 'hash=x' }), 409, DepositErrorCode.DemoOnly);
    expect(callsFor(user.brokerAccountId)).toEqual([]);
    expect(broker.rest.journal).toEqual([]);
  });

  it('D2 answers no_active_account without a user, an account or an active one', async () => {
    const noUser = '999999999';
    const bare = await seedUser(tmp.db);
    const pending = await seedUser(tmp.db);
    await seedBrokerAccount(tmp.db, pending.userId, { status: BrokerAccountStatus.Pending });
    const revoked = await seedUser(tmp.db);
    await seedBrokerAccount(tmp.db, revoked.userId, { status: BrokerAccountStatus.Revoked });
    for (const id of [
      noUser,
      bare.telegramUserId,
      pending.telegramUserId,
      revoked.telegramUserId,
    ]) {
      expectRefusal(await mintFor(id), 409, DepositErrorCode.NoActiveAccount);
    }
    expect(broker.rest.journal).toEqual([]);
  });

  it('D11 answers ambiguous_account for two active accounts', async () => {
    const user = await seedUserWithAccount(tmp.db);
    const second = await seedBrokerAccount(tmp.db, user.userId);
    expectRefusal(await mintFor(user.telegramUserId), 409, DepositErrorCode.AmbiguousAccount);
    expect([...callsFor(user.brokerAccountId), ...callsFor(second)]).toEqual([]);
    expect(broker.rest.journal).toEqual([]);
  });

  it('D3 answers user_blocked for a blocked user without taking a token', async () => {
    const user = await payer({ status: UserStatus.Blocked });
    expectRefusal(await mintFor(user.telegramUserId), 409, DepositErrorCode.UserBlocked);
    expect(callsFor(user.brokerAccountId)).toEqual([]);
    expect(broker.rest.journal).toEqual([]);
  });

  it.each([
    [AccessTokenRefusal.UserBlocked, 409, DepositErrorCode.UserBlocked],
    [AccessTokenRefusal.AccountRevoked, 409, DepositErrorCode.TokenUnavailable],
    [AccessTokenRefusal.AccountPending, 409, DepositErrorCode.TokenUnavailable],
    [AccessTokenRefusal.AccountNotFound, 409, DepositErrorCode.TokenUnavailable],
    [AccessTokenRefusal.RefreshRateLimited, 502, DepositErrorCode.BrokerUnavailable],
    [AccessTokenRefusal.KeyUnavailable, 502, DepositErrorCode.BrokerUnavailable],
  ] as const)('D4 maps the token refusal %s to %i %s', async (reason, status, error) => {
    const user = await payer();
    tokenAnswers.set(
      user.brokerAccountId,
      reason === AccessTokenRefusal.AccountRevoked
        ? { ok: false, reason, revokedReason: null }
        : { ok: false, reason },
    );
    lines.length = 0;
    expectRefusal(await mintFor(user.telegramUserId), status, error);
    expect(logged('deposit widget session: no access token')).toMatchObject([
      { accountId: user.brokerAccountId, reason },
    ]);
    expect(broker.rest.journal).toEqual([]);
  });

  it('D5 reports the token a broker 401 refused, without an exchange, and answers broker_unavailable', async () => {
    const user = await seedUserWithAccount(tmp.db);
    // the broker knows no user by this account's token
    tokenAnswers.set(user.brokerAccountId, { ok: true, accessToken: 'TOKEN-THE-BROKER-REFUSES' });
    lines.length = 0;
    expectRefusal(await mintFor(user.telegramUserId), 502, DepositErrorCode.BrokerUnavailable);
    expect(callsFor(user.brokerAccountId)).toEqual([
      { accountId: user.brokerAccountId, options: { mayRefresh: true } },
      {
        accountId: user.brokerAccountId,
        options: { mayRefresh: false, refusedToken: hashToken('TOKEN-THE-BROKER-REFUSES') },
      },
    ]);
    expect(logged('refused token reported')).toHaveLength(1);
    expect(lines.join('\n')).not.toContain('TOKEN-THE-BROKER-REFUSES');
  });

  it('D5 still answers broker_unavailable when the refused-token report throws', async () => {
    const user = await seedUserWithAccount(tmp.db);
    let call = 0;
    tokenAnswers.set(user.brokerAccountId, () => {
      call += 1;
      if (call === 1) return Promise.resolve({ ok: true, accessToken: 'TOKEN-REFUSED-AGAIN' });
      return Promise.reject(new Error('lock timeout'));
    });
    lines.length = 0;
    expectRefusal(await mintFor(user.telegramUserId), 502, DepositErrorCode.BrokerUnavailable);
    expect(logged('refused token report failed')).toHaveLength(1);
  });

  it.each([
    [{ status: 429 }, DepositErrorCode.BrokerUnavailable],
    [{ status: 503 }, DepositErrorCode.BrokerUnavailable],
    [{ status: 500 }, DepositErrorCode.BrokerUnavailable],
    [{ status: 200, body: { session: 'wss_x' } }, DepositErrorCode.BrokerUnavailable],
    [
      { status: 302, headers: { location: 'https://elsewhere.example' } },
      DepositErrorCode.BrokerUnavailable,
    ],
    [{ status: 400 }, DepositErrorCode.BrokerRejected],
    [{ status: 403 }, DepositErrorCode.BrokerRejected],
  ] as const)('D5 maps the broker answer %j to %s', async (script, error) => {
    const user = await payer();
    broker.rest.failNext('widgetSession', script);
    lines.length = 0;
    expectRefusal(await mintFor(user.telegramUserId), 502, error);
    expect(logged('deposit widget session: the broker call failed')).toHaveLength(1);
    // no refused-token report for anything but a 401
    expect(callsFor(user.brokerAccountId)).toHaveLength(1);
  });

  it('D5 ends a hanging broker call at its own budget as broker_unavailable', async () => {
    const user = await payer();
    broker.rest.failNext('widgetSession', { hang: true });
    lines.length = 0;
    expectRefusal(await mintFor(user.telegramUserId), 502, DepositErrorCode.BrokerUnavailable);
    // aborted, not unavailable: the route's own budget ended the call, not the client's timeout
    expect(logged('deposit widget session: the broker call failed')).toMatchObject([
      { err: { code: 'aborted' } },
    ]);
  });

  it('answers an opaque 500 when the token service throws', async () => {
    const user = await payer();
    tokenAnswers.set(user.brokerAccountId, () => Promise.reject(new Error('db down')));
    const response = await mintFor(user.telegramUserId);
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'internal' });
    expect(broker.rest.journal).toEqual([]);
  });

  it('D12 forwards a client IP that parses as an IP, and drops one that does not', async () => {
    const user = await payer();
    expect((await mintFor(user.telegramUserId, { clientIp: '2001:db8::7' })).statusCode).toBe(200);
    expect((await mintFor(user.telegramUserId, { clientIp: 'not-an-ip' })).statusCode).toBe(200);
    expect(sessionsOf(user.brokerUserId)).toEqual([
      { userId: user.brokerUserId, origin: WEB_ORIGIN, mode: 'deposit', userIp: '2001:db8::7' },
      { userId: user.brokerUserId, origin: WEB_ORIGIN, mode: 'deposit' },
    ]);
  });

  it('D8 holds one Telegram user to ten sessions a minute', async () => {
    const user = await payer();
    for (let i = 0; i < 10; i += 1) {
      expect((await mintFor(user.telegramUserId)).statusCode).toBe(200);
    }
    expectRefusal(await mintFor(user.telegramUserId), 429, DepositErrorCode.TooManyRequests);
    expect(sessionsOf(user.brokerUserId)).toHaveLength(10);
    // another user is not held by it
    const other = await payer();
    expect((await mintFor(other.telegramUserId)).statusCode).toBe(200);
  });

  it('D8 refuses over the route ceiling before the body is read', async () => {
    const capped = await extraApp({ db: noDb, maxPerMinute: 1 });
    expect((await mint(capped, {})).statusCode).toBe(400);
    expectRefusal(await mint(capped, {}), 429, DepositErrorCode.TooManyRequests);
  });

  it('D13 answers a proxied request with the not-found body', async () => {
    const user = await payer();
    const response = await mint(
      app,
      { initData: initDataFor(user.telegramUserId) },
      { 'x-forwarded-for': '203.0.113.1' },
    );
    expect(response.statusCode).toBe(404);
    expect(callsFor(user.brokerAccountId)).toEqual([]);
  });
});
