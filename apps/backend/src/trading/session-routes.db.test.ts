import type { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  AccountHaltReason,
  TRADING_SESSIONS_PATH,
  TradeAction,
  TradeIntentStatus,
  TradeMode,
  TradingSessionErrorCode,
  TradingSessionStatus,
  TradingSessionStopReason,
  decimalStringSchema,
  safeParseTradingSessionRefusal,
  safeParseTradingSessionResponse,
  type BinaryPair,
  type BrokerUser,
  type PairsCatalogView,
  type TradingSessionView,
} from '@binarius/shared';
import { until } from '@binarius/shared/testing';
import {
  createTempDatabase,
  seedBrokerAccount,
  seedTradingSession,
  seedUser,
  seedUserWithAccount,
  type SeededAccount,
  type TempDatabase,
} from '@binarius/db/testing';
import {
  brokerAccounts,
  brokerBalanceSnapshots,
  createTradeIntent,
  tradeIntents,
  tradingSessions,
  upsertBalanceSnapshot,
  users,
} from '@binarius/db';
import { buildApp } from '../app';
import { unusedAdminDeps } from '../admin/testing';
import type { AuthRoutesDeps } from '../auth/routes';
import type { UsersRoutesDeps } from '../users/routes';
import type { TradingRoutesDeps } from './routes';
import type { TradingSessionRoutesDeps } from './session-routes';
import {
  PAIRS_TEST_TOKEN,
  unusedAccessTokenDeps,
  unusedBalanceDeps,
  unusedPairsDeps,
  unusedSignalDeps,
} from './testing';

const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for apps/backend integration tests (see README → Test database)',
  );
}

const NOW = Date.UTC(2026, 9, 7, 12);
const ASSET = 101;

const pair: BinaryPair = {
  id: ASSET,
  symbol: 'EUR/USD',
  type: 'forex',
  digits: 5,
  payout: 85,
  maxPayout: 90,
  minTimeframe: 60,
  maxTimeframe: 3600,
  scheduledUntil: 0,
};

const freshCatalog = (pairs: BinaryPair[] = [pair]): PairsCatalogView => ({
  pairs,
  fetchedAt: NOW,
  ageMs: 0,
  fresh: true,
});

const brokerUser: BrokerUser = {
  id: 'broker-user',
  level: { code: 'standard', rank: 1 },
  minTradeAmount: decimalStringSchema.parse('1.00000000'),
  real: {
    available: decimalStringSchema.parse('100'),
    held: decimalStringSchema.parse('0'),
    total: decimalStringSchema.parse('100'),
  },
  demo: {
    available: decimalStringSchema.parse('10000'),
    held: decimalStringSchema.parse('0'),
    total: decimalStringSchema.parse('10000'),
  },
};

type Refresh = TradingSessionRoutesDeps['balance']['refresh'];

let tmp: TempDatabase;
let app: FastifyInstance | undefined;
let lines: string[] = [];
let refreshCalls: { accountId: string; options: Parameters<Refresh>[1] }[] = [];
let catalogReads = 0;

beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
});
afterEach(async () => {
  await app?.close();
  app = undefined;
  lines = [];
  refreshCalls = [];
  catalogReads = 0;
});
afterAll(() => tmp.drop());

function appWith(
  options: {
    catalog?: PairsCatalogView | undefined;
    refresh?: (accountId: string) => Promise<unknown>;
  } = {},
): FastifyInstance {
  const catalog = 'catalog' in options ? options.catalog : freshCatalog();
  const refresh: Refresh = (accountId, refreshOptions) => {
    refreshCalls.push({ accountId, options: refreshOptions });
    if (options.refresh === undefined) throw new Error('unexpected balance refresh');
    return options.refresh(accountId).then(() => 'ok' as const);
  };
  app = buildApp({
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
      realTradingEnabled: false,
      accessToken: unusedAccessTokenDeps(),
    } satisfies TradingRoutesDeps,
    pairs: unusedPairsDeps(),
    sessions: {
      db: tmp.db,
      catalog: {
        read: () => {
          catalogReads += 1;
          return catalog;
        },
      },
      balance: { refresh },
      internalApiToken: PAIRS_TEST_TOKEN,
      now: () => NOW,
    },
    signal: unusedSignalDeps(),
    auth: { internalApiToken: PAIRS_TEST_TOKEN } as AuthRoutesDeps,
    users: { db: {} as UsersRoutesDeps['db'], internalApiToken: PAIRS_TEST_TOKEN },
    admin: unusedAdminDeps(),
  });
  return app;
}

const auth = { authorization: `Bearer ${PAIRS_TEST_TOKEN}` };

const start = (target: FastifyInstance, body: object, headers: Record<string, string> = auth) =>
  target.inject({ method: 'POST', url: TRADING_SESSIONS_PATH, headers, payload: body });

const read = (target: FastifyInstance, id: string, telegramUserId?: string) =>
  target.inject({
    method: 'GET',
    url: `${TRADING_SESSIONS_PATH}/${id}`,
    headers: auth,
    query: telegramUserId === undefined ? {} : { telegramUserId },
  });

const stop = (target: FastifyInstance, id: string, body: object) =>
  target.inject({
    method: 'POST',
    url: `${TRADING_SESSIONS_PATH}/${id}/stop`,
    headers: auth,
    payload: body,
  });

const sessionCount = async () => {
  const { rows } = await tmp.db.execute<{ n: number }>(
    sql`select count(*)::int as n from trading_sessions`,
  );
  return rows[0]!.n;
};

const snapshotFor = (brokerAccountId: string) =>
  upsertBalanceSnapshot(tmp.db, { brokerAccountId, user: brokerUser, requested: false });

async function seedReady(options: { balance?: bigint } = {}): Promise<SeededAccount> {
  const seed = await seedUserWithAccount(tmp.db, options);
  await snapshotFor(seed.brokerAccountId);
  return seed;
}

const bodyFor = (seed: { telegramUserId: string }, patch: object = {}) => ({
  telegramUserId: seed.telegramUserId,
  assetId: ASSET,
  durationSec: 60,
  ...patch,
});

function sessionOf(response: { json: () => unknown }): TradingSessionView {
  const parsed = safeParseTradingSessionResponse(response.json());
  if (!parsed.success) throw new Error(`not a session response: ${parsed.error.message}`);
  return parsed.data.session;
}

// the refusal parses against the wire schema, and no session row was written
async function expectRefusal(
  response: { statusCode: number; json: () => unknown },
  status: number,
  error: string,
  rowsBefore: number,
) {
  expect({ status: response.statusCode, body: response.json() }).toMatchObject({
    status,
    body: { error },
  });
  expect(safeParseTradingSessionRefusal(response.json()).success).toBe(true);
  expect(await sessionCount()).toBe(rowsBefore);
}

describe('POST /trading/sessions', () => {
  it('R1 creates a demo session with the stake from the snapshot', async () => {
    const seed = await seedReady();
    const response = await start(appWith(), bodyFor(seed));
    expect(response.statusCode).toBe(201);
    const session = sessionOf(response);
    expect(session).toMatchObject({
      mode: TradeMode.Demo,
      status: TradingSessionStatus.Active,
      stopReason: null,
      endedAt: null,
      settings: {
        version: 1,
        assetId: ASSET,
        durationSec: 60,
        trades: 5,
        stake: { baseStake: '1', stakeScale: 0 },
      },
      trades: { planned: 5, settled: 0, rejected: 0, won: 0, lost: 0, tied: 0 },
      lastIntent: null,
    });
    const [row] = await tmp.db
      .select()
      .from(tradingSessions)
      .where(eq(tradingSessions.id, session.id));
    expect(row).toMatchObject({ brokerAccountId: seed.brokerAccountId, mode: 'demo' });
    expect(refreshCalls).toEqual([]);
  });

  it('R2 a bad body is 400 and no bearer is 401', async () => {
    const seed = await seedReady();
    const before = await sessionCount();
    const target = appWith();
    const invalid = await start(target, bodyFor(seed, { trades: 0 }));
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: 'validation' });
    expect((await start(target, bodyFor(seed), {})).statusCode).toBe(401);
    expect(await sessionCount()).toBe(before);
  });

  it.each([
    [
      'user_not_found',
      404,
      async () => ({ telegramUserId: '999999999', brokerAccountId: undefined }),
    ],
    [
      'broker_account_not_found',
      404,
      async () => {
        const owner = await seedReady();
        const other = await seedReady();
        return { telegramUserId: owner.telegramUserId, brokerAccountId: other.brokerAccountId };
      },
    ],
    [
      'ambiguous_broker_account',
      409,
      async () => {
        const seed = await seedReady();
        await seedBrokerAccount(tmp.db, seed.userId);
        return { telegramUserId: seed.telegramUserId, brokerAccountId: undefined };
      },
    ],
    [
      'account_not_confirmed',
      409,
      async () => {
        const user = await seedUser(tmp.db);
        await seedBrokerAccount(tmp.db, user.userId, { status: 'pending' });
        return { telegramUserId: user.telegramUserId, brokerAccountId: undefined };
      },
    ],
    [
      'account_revoked',
      409,
      async () => {
        const user = await seedUser(tmp.db);
        const id = await seedBrokerAccount(tmp.db, user.userId, { status: 'revoked' });
        return { telegramUserId: user.telegramUserId, brokerAccountId: id };
      },
    ],
    [
      'account_halted',
      409,
      async () => {
        const user = await seedUser(tmp.db);
        await seedBrokerAccount(tmp.db, user.userId, {
          tradingHalted: true,
          haltedReason: AccountHaltReason.TradeMismatch,
        });
        return { telegramUserId: user.telegramUserId, brokerAccountId: undefined };
      },
    ],
    [
      'user_blocked',
      409,
      async () => {
        const seed = await seedUserWithAccount(tmp.db, { status: 'blocked' });
        return { telegramUserId: seed.telegramUserId, brokerAccountId: undefined };
      },
    ],
    [
      'insufficient_tokens',
      409,
      async () => {
        const seed = await seedReady({ balance: 0n });
        return { telegramUserId: seed.telegramUserId, brokerAccountId: undefined };
      },
    ],
  ] as const)('R3 %s answers %i before any broker call', async (error, status, seedCase) => {
    const { telegramUserId, brokerAccountId } = await seedCase();
    const before = await sessionCount();
    const response = await start(
      appWith(),
      bodyFor(
        { telegramUserId },
        brokerAccountId === undefined ? {} : { brokerAccountId: brokerAccountId },
      ),
    );
    await expectRefusal(response, status, error, before);
    expect(refreshCalls).toEqual([]);
  });

  it('R4 a second start is 409 active_session_exists with the first session', async () => {
    const seed = await seedReady();
    const target = appWith();
    const first = sessionOf(await start(target, bodyFor(seed)));
    const before = await sessionCount();
    const second = await start(target, bodyFor(seed));
    await expectRefusal(second, 409, 'active_session_exists', before);
    expect(second.json()).toMatchObject({ session: { id: first.id, status: 'active' } });
  });

  it('R5 a session that cannot fit the deadline is refused before the catalog and the balance', async () => {
    const seed = await seedUserWithAccount(tmp.db);
    const target = appWith({ refresh: () => Promise.resolve() });
    const before = await sessionCount();
    const response = await start(target, bodyFor(seed, { durationSec: 900 }));
    await expectRefusal(response, 409, 'session_too_long', before);
    expect(refreshCalls).toEqual([]);
    expect(catalogReads).toBe(0);
  });

  it.each([
    ['missing', undefined],
    ['stale', { ...freshCatalog(), ageMs: 600_000, fresh: false }],
  ] as const)('R6 a %s catalog is 503 catalog_unavailable', async (_label, catalog) => {
    const seed = await seedReady();
    const before = await sessionCount();
    const response = await start(appWith({ catalog }), bodyFor(seed));
    await expectRefusal(response, 503, 'catalog_unavailable', before);
  });

  it.each([
    ['absent', freshCatalog([{ ...pair, id: ASSET + 1 }]), 60],
    ['closed', freshCatalog([{ ...pair, scheduledUntil: NOW + 60_000 }]), 60],
    ['below its range', freshCatalog([{ ...pair, minTimeframe: 120 }]), 60],
    ['above its range', freshCatalog([{ ...pair, maxTimeframe: 30 }]), 60],
  ] as const)('R7 a pair %s is 409 pair_unavailable', async (_label, catalog, durationSec) => {
    const seed = await seedReady();
    const before = await sessionCount();
    const response = await start(appWith({ catalog }), bodyFor(seed, { durationSec }));
    await expectRefusal(response, 409, 'pair_unavailable', before);
  });

  it('R8 a pair with a past scheduledUntil is open', async () => {
    const seed = await seedReady();
    const response = await start(
      appWith({ catalog: freshCatalog([{ ...pair, scheduledUntil: NOW - 1 }]) }),
      bodyFor(seed),
    );
    expect(response.statusCode).toBe(201);
  });

  it('R9 without a snapshot it awaits a bounded refresh and uses what it wrote', async () => {
    const seed = await seedUserWithAccount(tmp.db);
    const response = await start(
      appWith({ refresh: async (accountId) => void (await snapshotFor(accountId)) }),
      bodyFor(seed),
    );
    expect(response.statusCode).toBe(201);
    expect(refreshCalls).toEqual([
      {
        accountId: seed.brokerAccountId,
        options: { requested: true, signal: expect.any(AbortSignal) },
      },
    ]);
  });

  it('R9 a refresh that wrote nothing is 409 balance_unavailable', async () => {
    const seed = await seedUserWithAccount(tmp.db);
    const before = await sessionCount();
    const response = await start(appWith({ refresh: () => Promise.resolve() }), bodyFor(seed));
    await expectRefusal(response, 409, 'balance_unavailable', before);
    expect(refreshCalls).toHaveLength(1);
  });

  it('R10 an expiring token kicks the refresh into the background and answers at once', async () => {
    const user = await seedUser(tmp.db);
    const brokerAccountId = await seedBrokerAccount(tmp.db, user.userId, {
      accessTokenExpiresAt: new Date(),
    });
    const before = await sessionCount();
    const response = await start(appWith({ refresh: () => new Promise(() => {}) }), bodyFor(user));
    await expectRefusal(response, 409, 'balance_unavailable', before);
    expect(refreshCalls).toEqual([{ accountId: brokerAccountId, options: { requested: true } }]);
  });

  it('R11 a stale snapshot serves without a refresh', async () => {
    const seed = await seedReady();
    await tmp.db
      .update(brokerBalanceSnapshots)
      .set({ restObservedAt: sql`now() - interval '1 hour'` })
      .where(eq(brokerBalanceSnapshots.brokerAccountId, seed.brokerAccountId));
    const response = await start(appWith(), bodyFor(seed));
    expect(response.statusCode).toBe(201);
    expect(refreshCalls).toEqual([]);
  });

  it.each([
    [
      'user_blocked',
      (seed: SeededAccount) =>
        tmp.db.update(users).set({ status: 'blocked' }).where(eq(users.id, seed.userId)),
    ],
    [
      'account_halted',
      (seed: SeededAccount) =>
        tmp.db
          .update(brokerAccounts)
          .set({ tradingHalted: true, haltedReason: AccountHaltReason.TradeMismatch })
          .where(eq(brokerAccounts.id, seed.brokerAccountId)),
    ],
    [
      'active_session_exists',
      (seed: SeededAccount) => seedTradingSession(tmp.db, seed.brokerAccountId),
    ],
  ] as const)(
    'R12 a change between the check and the insert answers %s from the transaction',
    async (error, race) => {
      const seed = await seedUserWithAccount(tmp.db);
      let racerRows = 0;
      const response = await start(
        appWith({
          refresh: async (accountId) => {
            await snapshotFor(accountId);
            await race(seed);
            racerRows = await sessionCount();
          },
        }),
        bodyFor(seed),
      );
      await expectRefusal(response, 409, error, racerRows);
      if (error === 'active_session_exists') {
        expect(response.json()).toMatchObject({ session: { status: 'active' } });
      }
    },
  );

  it('L1 a background refresh failure logs the error identity, not its text', async () => {
    const user = await seedUser(tmp.db);
    await seedBrokerAccount(tmp.db, user.userId, { accessTokenExpiresAt: new Date() });
    const response = await start(
      appWith({ refresh: () => Promise.reject(new Error('secret-text')) }),
      bodyFor(user),
    );
    expect(response.statusCode).toBe(409);
    await until('the refresh failure line', () =>
      lines.some((line) => line.includes('balance refresh threw')),
    );
    const line = lines.find((candidate) => candidate.includes('balance refresh threw'))!;
    expect(JSON.parse(line)).toMatchObject({ err: { name: 'Error' } });
    expect(lines.join('\n')).not.toContain('secret-text');
  });
});

async function seedSession(): Promise<SeededAccount & { sessionId: string }> {
  const seed = await seedUserWithAccount(tmp.db);
  const session = await seedTradingSession(tmp.db, seed.brokerAccountId);
  return { ...seed, sessionId: session.id };
}

describe('GET /trading/sessions/:id', () => {
  it('G1 the owner reads the view', async () => {
    const seed = await seedSession();
    const response = await read(appWith(), seed.sessionId, seed.telegramUserId);
    expect(response.statusCode).toBe(200);
    expect(sessionOf(response)).toMatchObject({ id: seed.sessionId, status: 'active' });
  });

  it("G2/G3 another user's session answers as a missing one", async () => {
    const seed = await seedSession();
    const other = await seedUser(tmp.db);
    const target = appWith();
    const foreign = await read(target, seed.sessionId, other.telegramUserId);
    const missing = await read(target, '00000000-0000-4000-8000-000000000000', seed.telegramUserId);
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toEqual({ error: 'not_found' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual(foreign.json());
  });

  it('G4 a non-uuid id is 404 and a missing telegramUserId is 400', async () => {
    const seed = await seedSession();
    const target = appWith();
    expect((await read(target, 'nope', seed.telegramUserId)).statusCode).toBe(404);
    expect((await read(target, seed.sessionId)).statusCode).toBe(400);
  });
});

describe('POST /trading/sessions/:id/stop', () => {
  it('S1 the owner stops the session with user_stopped', async () => {
    const seed = await seedSession();
    const response = await stop(appWith(), seed.sessionId, {
      telegramUserId: seed.telegramUserId,
    });
    expect(response.statusCode).toBe(200);
    const session = sessionOf(response);
    expect(session).toMatchObject({
      status: TradingSessionStatus.Stopped,
      stopReason: TradingSessionStopReason.UserStopped,
    });
    expect(session.endedAt).not.toBeNull();
  });

  it("S2 another user's stop is 404 and the session stays active", async () => {
    const seed = await seedSession();
    const other = await seedUser(tmp.db);
    const response = await stop(appWith(), seed.sessionId, {
      telegramUserId: other.telegramUserId,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'not_found' });
    const [row] = await tmp.db
      .select({ status: tradingSessions.status })
      .from(tradingSessions)
      .where(eq(tradingSessions.id, seed.sessionId));
    expect(row!.status).toBe('active');
  });

  it('S3 a second stop is 409 session_not_active', async () => {
    const seed = await seedSession();
    const target = appWith();
    await stop(target, seed.sessionId, { telegramUserId: seed.telegramUserId });
    const again = await stop(target, seed.sessionId, { telegramUserId: seed.telegramUserId });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: TradingSessionErrorCode.SessionNotActive });
    expect(safeParseTradingSessionRefusal(again.json()).success).toBe(true);
  });

  it('S4 a non-uuid id is 404 and a bad body is 400', async () => {
    const seed = await seedSession();
    const target = appWith();
    expect((await stop(target, 'nope', { telegramUserId: seed.telegramUserId })).statusCode).toBe(
      404,
    );
    expect((await stop(target, seed.sessionId, {})).statusCode).toBe(400);
  });

  it('S5 a stop with a live intent leaves the intent alone', async () => {
    const seed = await seedSession();
    const { intent } = await createTradeIntent(
      tmp.db,
      {
        telegramUserId: seed.telegramUserId,
        mode: TradeMode.Demo,
        assetId: ASSET,
        amount: decimalStringSchema.parse('1'),
        action: TradeAction.Up,
        durationSec: 60,
        clientRequestId: `session:${seed.sessionId}:1`,
      },
      { realTradingEnabled: false },
      { id: seed.sessionId },
    );
    const response = await stop(appWith(), seed.sessionId, {
      telegramUserId: seed.telegramUserId,
    });
    expect(response.statusCode).toBe(200);
    const [row] = await tmp.db
      .select({ status: tradeIntents.status })
      .from(tradeIntents)
      .where(eq(tradeIntents.id, intent.id));
    expect(row!.status).toBe(TradeIntentStatus.Queued);
  });
});
