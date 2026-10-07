import Fastify, { type FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createBrokerRestClient } from '@binarius/broker-rest';
import { startMockBroker, type MockBroker } from '@binarius/mock-broker';
import {
  BrokerAccountStatus,
  TRADING_ACCESS_BUDGET_MS,
  TradeIntentErrorCode,
  UserErrorCode,
  UserStatus,
  safeParseTradingAccessResponse,
} from '@binarius/shared';
import { INTEGRATION_WAIT_CEILING_MS, until } from '@binarius/shared/testing';
import {
  closeTradingSwitch,
  createTempDatabase,
  intentRequest,
  seedBrokerAccount,
  seedUser,
  seedUserWithAccount,
  type TempDatabase,
} from '@binarius/db/testing';
import {
  brokerBalanceSnapshots,
  openTrading,
  tokenLedger,
  tradingSwitch,
  users,
} from '@binarius/db';
import type { AccessTokenResult } from '../auth/token-service';
import { createBalanceReconciler, type BalanceReconciler } from '../broker/balance-reconciler';
import { tradingRoutes } from './routes';
import { unusedAccessTokenDeps } from './testing';

const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for apps/backend integration tests (see README → Test database)',
  );
}

const TOKEN = 'internal-token-for-tests';
let tmp: TempDatabase;
let app: FastifyInstance;
let broker: MockBroker;
let balance: BalanceReconciler;
// the token lookup is faked: an account missing here answers account_not_found
const tokenAnswers = new Map<string, AccessTokenResult>();

// The tradingRoutes plugin on a bare Fastify, not buildApp: the bearer hook and the
// registerTradingAccess call both live in the plugin, and a dependency buildApp gains later
// (#138's `pairs`) does not reach this file. No case here asserts a 500 body or an unknown
// route — those are buildApp's handlers (app.test.ts).
const createReconciler = () =>
  createBalanceReconciler({
    db: tmp.db,
    client: createBrokerRestClient({ baseUrl: broker.url }),
    accessToken: (accountId) =>
      Promise.resolve(
        tokenAnswers.get(accountId) ?? { ok: false, reason: 'account_not_found' as const },
      ),
    logger: Fastify({ logger: false }).log,
    config: { intervalMs: 60_000, maxPerMinute: 200 },
  });

async function buildAccessApp(reconciler: BalanceReconciler): Promise<FastifyInstance> {
  const built = Fastify();
  await built.register(tradingRoutes, {
    db: tmp.db,
    internalApiToken: TOKEN,
    onIntentQueued: () => {},
    balance: reconciler,
    accessToken: unusedAccessTokenDeps(),
  });
  await built.ready();
  return built;
}

beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
  broker = await startMockBroker();
  balance = createReconciler();
  app = await buildAccessApp(balance);
});

afterAll(async () => {
  await app.close();
  await balance.stop();
  await broker.close();
  await tmp.drop();
});

// null, not undefined: an explicit undefined would fall back to the default parameter and the
// "no header" case would have tested the happy path
const post = (
  url: string,
  payload: unknown,
  authorization: string | null = `Bearer ${TOKEN}`,
  target: FastifyInstance = app,
) =>
  target.inject({
    method: 'POST',
    url,
    headers: {
      'content-type': 'application/json',
      ...(authorization === null ? {} : { authorization }),
    },
    payload: JSON.stringify(payload),
  });

const access = (payload: unknown, authorization?: string | null) =>
  post('/trading/access', payload, authorization);

describe('POST /trading/access authorization', () => {
  it.each([
    ['no header', null],
    ['another bearer', 'Bearer some-other-token'],
    ['a non-bearer scheme', `Basic ${TOKEN}`],
  ])('refuses %s', async (_label, authorization) => {
    const user = await seedUser(tmp.db);
    const response = await access({ telegramUserId: user.telegramUserId }, authorization);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'unauthorized' });
  });
});

describe('POST /trading/access validation', () => {
  it.each([
    ['an empty body', {}],
    ['a non-numeric telegram id', { telegramUserId: 'abc' }],
    ['an id above int8', { telegramUserId: '9223372036854775808' }],
    ['a non-object body', ['1']],
  ])('refuses %s with 400', async (_label, payload) => {
    const response = await access(payload);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'validation' });
  });
});

describe('POST /trading/access', () => {
  it('answers 404 user_not_found for a Telegram id with no users row', async () => {
    const response = await access({ telegramUserId: '777000222' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: UserErrorCode.UserNotFound });
  });

  it('answers exactly the view, and a reserve made through /trading/intents shows in it', async () => {
    const seed = await seedUserWithAccount(tmp.db, { balance: 5n });
    const first = await access({ telegramUserId: seed.telegramUserId });
    expect(first.statusCode).toBe(200);
    const body = first.json();
    expect(Object.keys(body).sort()).toEqual([
      'broker',
      'brokerUnavailable',
      'status',
      'tokens',
      'tradingOpen',
    ]);
    expect(Object.keys(body.tokens).sort()).toEqual(['available', 'balance', 'reserved']);
    // the seeded account has no token here, so the broker side is unavailable
    expect(body).toEqual({
      status: UserStatus.Active,
      tokens: { balance: '5', reserved: '0', available: '5' },
      broker: null,
      brokerUnavailable: 'broker_unavailable',
      tradingOpen: true,
    });
    expect(safeParseTradingAccessResponse(body).success).toBe(true);

    const created = await post('/trading/intents', intentRequest(seed.telegramUserId));
    expect(created.statusCode).toBe(201);
    const second = await access({ telegramUserId: seed.telegramUserId });
    expect(second.json()).toMatchObject({
      status: UserStatus.Active,
      tokens: { balance: '5', reserved: '1', available: '4' },
    });
  });

  it('answers 200 with the numbers for a blocked user', async () => {
    const user = await seedUser(tmp.db, { balance: 2n, status: UserStatus.Blocked });
    const response = await access({ telegramUserId: user.telegramUserId });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: UserStatus.Blocked,
      tokens: { balance: '2', reserved: '0', available: '2' },
      broker: null,
      brokerUnavailable: 'no_account',
      tradingOpen: true,
    });
  });

  it('writes nothing', async () => {
    const user = await seedUser(tmp.db, { balance: 3n });
    const before = await usersRow(user.userId);
    const response = await access({ telegramUserId: user.telegramUserId });
    expect(response.statusCode).toBe(200);
    expect(await usersRow(user.userId)).toEqual(before);
    const ledger = await tmp.db
      .select({ id: tokenLedger.id })
      .from(tokenLedger)
      .where(eq(tokenLedger.userId, user.userId));
    expect(ledger).toEqual([]);
  });
});

const usersRow = async (userId: string) => {
  const [row] = await tmp.db
    .select({
      balance: users.tokenBalance,
      reserved: users.tokenReserved,
      updatedAt: users.updatedAt,
    })
    .from(users)
    .where(eq(users.id, userId));
  return row;
};

// --- The broker section (#137) -----------------------------------------------------------------

let mockSeq = 8_000;
async function linkedUser(
  patch: { accessTokenExpiresAt?: Date; userStatus?: UserStatus } = {},
): Promise<{ telegramUserId: string; userId: string; accountId: string; mockId: number }> {
  const mockId = ++mockSeq;
  const token = `access-token-${mockId}`;
  broker.users.register({ id: mockId, accessToken: token });
  const user = await seedUser(tmp.db, { status: patch.userStatus ?? UserStatus.Active });
  const accountId = await seedBrokerAccount(tmp.db, user.userId, {
    brokerUserId: String(mockId),
    ...(patch.accessTokenExpiresAt === undefined
      ? {}
      : { accessTokenExpiresAt: patch.accessTokenExpiresAt }),
  });
  tokenAnswers.set(accountId, { ok: true, accessToken: token });
  return { ...user, accountId, mockId };
}

const snapshotRow = async (accountId: string) => {
  const [row] = await tmp.db
    .select()
    .from(brokerBalanceSnapshots)
    .where(eq(brokerBalanceSnapshots.brokerAccountId, accountId));
  return row;
};

const age = (accountId: string, by: string) =>
  tmp.db.execute(
    sql`update broker_balance_snapshots set rest_observed_at = now() + ${by}::interval where broker_account_id = ${accountId}`,
  );

const userGets = () => broker.rest.journal.filter((entry) => entry.endpoint === 'user').length;

describe('POST /trading/access → broker', () => {
  beforeEach(() => broker.rest.clearJournal());

  it('says there is no account, beside the tokens', async () => {
    const user = await seedUser(tmp.db, { balance: 4n });
    const response = await access({ telegramUserId: user.telegramUserId });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: UserStatus.Active,
      tokens: { balance: '4', reserved: '0', available: '4' },
      broker: null,
      brokerUnavailable: 'no_account',
      tradingOpen: true,
    });
    expect(userGets()).toBe(0);
  });

  // the field is the trading_switch row (#144), read on every request
  it('answers tradingOpen from the switch row in both states', async () => {
    const user = await seedUser(tmp.db, { balance: 4n });
    const ask = async () =>
      (await access({ telegramUserId: user.telegramUserId })).json() as { tradingOpen: boolean };
    expect((await ask()).tradingOpen).toBe(true);
    await closeTradingSwitch(tmp.db);
    try {
      expect((await ask()).tradingOpen).toBe(false);
      await tmp.db.delete(tradingSwitch);
      expect((await ask()).tradingOpen).toBe(false);
    } finally {
      await openTrading(tmp.db);
    }
    expect((await ask()).tradingOpen).toBe(true);
  });

  it('fetches a first snapshot, then serves it from the database while it is fresh', async () => {
    const user = await linkedUser();
    const first = await access({ telegramUserId: user.telegramUserId });
    expect(first.statusCode).toBe(200);
    const body = first.json();
    expect(safeParseTradingAccessResponse(body).success).toBe(true);
    expect(body.brokerUnavailable).toBeNull();
    expect(Object.keys(body.broker).sort()).toEqual([
      'balanceEventAgeSec',
      'demo',
      'fresh',
      'level',
      'minTradeAmount',
      'real',
      'restSnapshotAgeSec',
    ]);
    expect(body.broker).toMatchObject({
      demo: { available: '10000.00000000', held: '0.00000000' },
      restSnapshotAgeSec: 0,
      balanceEventAgeSec: null,
      fresh: true,
    });
    expect(userGets()).toBe(1);
    expect((await snapshotRow(user.accountId))!.lastRequestedAt).toBeInstanceOf(Date);

    const second = await access({ telegramUserId: user.telegramUserId });
    expect(second.json().broker.fresh).toBe(true);
    expect(userGets()).toBe(1);
  });

  it('refreshes a stale snapshot, and keeps it with fresh: false when the broker fails', async () => {
    const user = await linkedUser();
    await access({ telegramUserId: user.telegramUserId });
    await age(user.accountId, '-61 seconds');
    broker.rest.clearJournal();

    const refreshed = await access({ telegramUserId: user.telegramUserId });
    expect(refreshed.json().broker.fresh).toBe(true);
    expect(userGets()).toBe(1);

    await age(user.accountId, '-61 seconds');
    broker.rest.failNext('user', { status: 503 });
    const failed = await access({ telegramUserId: user.telegramUserId });
    expect(failed.json()).toMatchObject({ brokerUnavailable: null, broker: { fresh: false } });
    expect(failed.json().broker.restSnapshotAgeSec).toBeGreaterThanOrEqual(61);
    expect((await snapshotRow(user.accountId))!.lastRefreshError).toBe('unavailable');
  });

  it('says the broker is unavailable when there is no snapshot to fall back on', async () => {
    const user = await linkedUser();
    broker.rest.failNext('user', { status: 503 });
    const response = await access({ telegramUserId: user.telegramUserId });
    expect(response.json()).toMatchObject({
      broker: null,
      brokerUnavailable: 'broker_unavailable',
    });
  });

  // the exchange may take BROKER_HTTP_TIMEOUT_MS, so it runs behind the answer
  it.each([
    ['no snapshot', false],
    ['a stale snapshot', true],
  ])('answers at once when the token needs an exchange: %s', async (_label, withSnapshot) => {
    const user = await linkedUser();
    if (withSnapshot) {
      await access({ telegramUserId: user.telegramUserId });
      await age(user.accountId, '-5 minutes');
    }
    await tmp.db.execute(
      sql`update broker_accounts set access_token_expires_at = now() + interval '30 seconds' where id = ${user.accountId}`,
    );
    // its own reconciler and app, so the hang it leaves is ended here and not seen by a later case
    const own = createReconciler();
    // the route's refresh, counted when it settles: it is still hanging when the answer arrives
    let refreshesSettled = 0;
    const ownApp = await buildAccessApp({
      ...own,
      refresh: (...args) =>
        own.refresh(...args).finally(() => {
          refreshesSettled += 1;
        }),
    });
    try {
      expect(broker.rest.pendingHangs).toBe(0);
      broker.rest.clearJournal();
      broker.rest.failNext('user', { hang: true });

      const started = Date.now();
      const response = await post(
        '/trading/access',
        { telegramUserId: user.telegramUserId },
        `Bearer ${TOKEN}`,
        ownApp,
      );
      expect(Date.now() - started).toBeLessThan(INTEGRATION_WAIT_CEILING_MS);
      expect(refreshesSettled).toBe(0);
      if (withSnapshot) {
        expect(response.json()).toMatchObject({
          brokerUnavailable: null,
          broker: { fresh: false },
        });
      } else {
        expect(response.json()).toMatchObject({ broker: null, brokerUnavailable: 'refreshing' });
      }
      // the background refresh went out and is the one hanging
      await until('the background refresh', () => broker.rest.pendingHangs === 1);
    } finally {
      await ownApp.close();
      await own.stop();
      await until('the hang to end', () => broker.rest.pendingHangs === 0);
    }
  });

  it('never calls the broker for a blocked user, and still shows what is stored', async () => {
    const user = await linkedUser();
    await access({ telegramUserId: user.telegramUserId });
    await age(user.accountId, '-5 minutes');
    await tmp.db.update(users).set({ status: UserStatus.Blocked }).where(eq(users.id, user.userId));
    broker.rest.clearJournal();

    const stored = await access({ telegramUserId: user.telegramUserId });
    expect(stored.json()).toMatchObject({ status: 'blocked', broker: { fresh: false } });

    const empty = await linkedUser({ userStatus: UserStatus.Blocked });
    const none = await access({ telegramUserId: empty.telegramUserId });
    expect(none.json()).toMatchObject({ broker: null, brokerUnavailable: 'user_blocked' });
    expect(userGets()).toBe(0);
  });

  // blocked after the route read users.status: the token lookup sees it under the account lock
  it('says user_blocked when the user is blocked between the lookup and the token', async () => {
    const user = await linkedUser();
    tokenAnswers.set(user.accountId, { ok: false, reason: 'user_blocked' });
    const response = await access({ telegramUserId: user.telegramUserId });
    expect(response.json()).toMatchObject({ broker: null, brokerUnavailable: 'user_blocked' });
    expect(userGets()).toBe(0);
  });

  it('picks an account by id when the user has several, and only among their own', async () => {
    const user = await linkedUser();
    const second = await seedBrokerAccount(tmp.db, user.userId, { brokerUserId: 'second-account' });
    const pending = await seedBrokerAccount(tmp.db, user.userId, {
      status: BrokerAccountStatus.Pending,
    });
    const stranger = await linkedUser();

    const ambiguous = await access({ telegramUserId: user.telegramUserId });
    expect(ambiguous.json()).toMatchObject({
      broker: null,
      brokerUnavailable: 'ambiguous_account',
    });

    const picked = await access({
      telegramUserId: user.telegramUserId,
      brokerAccountId: user.accountId,
    });
    expect(picked.json()).toMatchObject({ brokerUnavailable: null, broker: { fresh: true } });

    const foreign = await access({
      telegramUserId: user.telegramUserId,
      brokerAccountId: stranger.accountId,
    });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toEqual({ error: TradeIntentErrorCode.BrokerAccountNotFound });

    broker.rest.clearJournal();
    const notConfirmed = await access({
      telegramUserId: user.telegramUserId,
      brokerAccountId: pending,
    });
    expect(notConfirmed.json()).toMatchObject({
      broker: null,
      brokerUnavailable: 'account_pending',
    });
    expect(userGets()).toBe(0);
    expect(second).toBeDefined();
  });

  it('refuses a broker account id that is not a uuid', async () => {
    const user = await linkedUser();
    const response = await access({ telegramUserId: user.telegramUserId, brokerAccountId: 'x' });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'validation' });
  });

  it('answers within its budget when the broker is slow, without recording a failure', async () => {
    const user = await linkedUser();
    await access({ telegramUserId: user.telegramUserId });
    await age(user.accountId, '-5 minutes');
    broker.rest.failNext('user', { delayMs: 3_500 });

    const started = Date.now();
    const response = await access({ telegramUserId: user.telegramUserId });
    expect(Date.now() - started).toBeLessThan(TRADING_ACCESS_BUDGET_MS);
    expect(response.json()).toMatchObject({ brokerUnavailable: null, broker: { fresh: false } });
    expect((await snapshotRow(user.accountId))!.lastRefreshError).toBeNull();
  });
});
