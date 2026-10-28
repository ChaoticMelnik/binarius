import type { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  AccountHaltReason,
  H1_EXPIRY_SEC,
  H1_MIN_PAYOUT_PCT,
  H1_R1_PARAMS,
  martingaleLimitsFor,
  SESSION_SHARE_SUFFIX,
  SESSION_STATUS_MESSAGE_LOST_SUFFIX,
  SESSION_STATUS_MESSAGE_SUFFIX,
  SESSION_SUMMARY_SUFFIX,
  SessionSummaryErrorCode,
  TRADING_SESSIONS_PATH,
  TRADING_SESSIONS_STOP_PATH,
  TRADING_SESSIONS_TRACKED_PATH,
  TRACKED_SESSIONS_MAX,
  TradeAction,
  TradeIntentStatus,
  TradeMode,
  TradingSessionErrorCode,
  TradingSessionStatus,
  TradingSessionStopReason,
  SessionStakeStrategy,
  decimalStringSchema,
  safeParseSessionShareResponse,
  safeParseSessionSummaryRefusal,
  safeParseSessionSummaryResponse,
  safeParseTradingSessionRefusal,
  safeParseTradingSessionResponse,
  safeParseTradingSessionsStoppedResponse,
  safeParseTrackedSessionsResponse,
  type BinaryPair,
  type BrokerUser,
  type PairsCatalogView,
  type SessionStakeStrategy as StakeStrategy,
  type TradingSessionView,
  BotLanguage,
  logOptions,
} from '@binarius/shared';
import { closedTradeFor, openTradeFor, until } from '@binarius/shared/testing';
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
  createSessionIntent,
  createTradeIntent,
  markIntentAccepted,
  openTrading,
  listActiveH1Sessions,
  readSessionBalance,
  readSessionHistory,
  readTradingSessionView,
  recordSignalDecision,
  referralCodes,
  setStake,
  signalDecisions,
  setTradingMode,
  settleIntent,
  stopTrading,
  stopTradingSession,
  TradingSessionNotActiveError,
  takeIntent,
  tradeIntents,
  transitionIntent,
  tradingSessions,
  upsertBalanceSnapshot,
  users,
  type TradeIntentRow,
  setUserLanguage,
} from '@binarius/db';
import { buildApp } from '../app';
import { unusedAdminDeps, unusedPaymentsDeps } from '../admin/testing';
import type { AuthRoutesDeps } from '../auth/routes';
import type { UsersRoutesDeps } from '../users/routes';
import type { TradingRoutesDeps } from './routes';
import type { BalanceRefreshOutcome } from '../broker/balance-reconciler';
import type { TradingSessionRoutesDeps } from './session-routes';
import {
  PAIRS_TEST_TOKEN,
  fakeH1Driver,
  unusedAccessTokenDeps,
  unusedBalanceDeps,
  unusedPairsDeps,
  unusedSignalDeps,
  unusedSignalsDeps,
} from './testing';
import { unusedDepositDeps } from '../deposit/testing';
import { createH1Detector } from '@binarius/signal';
import pino from 'pino';
import { createH1Driver, type H1Reading, type H1SecondFacts } from '../h1/driver';
import { createSecondSeries } from '../market-data/seconds';

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
  minTimeframe: 5,
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
    // what the refresh answers once the stub ran
    outcome?: BalanceRefreshOutcome;
    demoOnly?: boolean;
    // SESSION_STAKE_STRATEGY of the process (#450); its default by default
    stakeStrategy?: StakeStrategy;
    // the trade log's writer (#666); recordSignalDecision on the suite's database by default
    decisions?: TradingSessionRoutesDeps['decisions'];
    // the H1 start's reading and hand-over (#796); none by default
    h1Driver?: TradingSessionRoutesDeps['h1Driver'];
  } = {},
): FastifyInstance {
  const catalog = 'catalog' in options ? options.catalog : freshCatalog();
  const refresh: Refresh = (accountId, refreshOptions) => {
    refreshCalls.push({ accountId, options: refreshOptions });
    if (options.refresh === undefined) throw new Error('unexpected balance refresh');
    return options.refresh(accountId).then(() => options.outcome ?? ('ok' as const));
  };
  app = buildApp({
    deposit: unusedDepositDeps(),
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
      demoOnly: options.demoOnly ?? false,
      stakeStrategy: options.stakeStrategy ?? SessionStakeStrategy.Martingale,
      decisions: options.decisions ?? {
        record: (input) => recordSignalDecision(tmp.db, input),
      },
      h1Driver: options.h1Driver,
      now: () => NOW,
    },
    signal: unusedSignalDeps(),
    signals: unusedSignalsDeps(),
    auth: { internalApiToken: PAIRS_TEST_TOKEN } as AuthRoutesDeps,
    users: { db: {} as UsersRoutesDeps['db'], internalApiToken: PAIRS_TEST_TOKEN },
    admin: unusedAdminDeps(),
    payments: unusedPaymentsDeps(),
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
  mode: TradeMode.Demo,
  assetId: ASSET,
  durationSec: H1_EXPIRY_SEC,
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

// The start's reading (#796): f the second before NOW, the R1 detector on `closes`
const F = NOW - 1_000;
const factsOf = (closes: readonly number[]): H1SecondFacts => ({
  assetId: ASSET,
  f: F,
  takenAtMs: NOW - 400,
  decision: createH1Detector(H1_R1_PARAMS).decide({ closes: Float64Array.from(closes), at: 300 }),
  digits: 5,
  closedBy: 'tick',
  closedAtMs: F + 300,
  series: [...closes],
  lastTick: { price: closes.at(-1)!, timestamp: F - 100, receivedAtMs: F - 60 },
});
const RAMP = [...Array<number>(300).fill(1.1), 1.1001];
const FALL = [...Array<number>(300).fill(1.1), 1.0999];
// a window with movement whose last close equals the one 3 s before: the current move 0
const QUIET = Array.from(
  { length: 301 },
  (_, i) => 1.1 + (((i === 300 ? 297 : i) * 7) % 11) * 0.0001,
);
const signalReading: H1Reading = { kind: 'decision', facts: factsOf(RAMP) };
const quietReading: H1Reading = { kind: 'decision', facts: factsOf(QUIET) };

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
      // #450: the process's default strategy, martingale, with the limits of the base stake; every
      // start is H1's since #828
      settings: {
        version: 5,
        assetId: ASSET,
        durationSec: H1_EXPIRY_SEC,
        cycles: 5,
        stake: {
          strategy: 'martingale',
          baseStake: '1',
          stakeScale: 0,
          limits: {
            maxSteps: 4,
            maxStake: '12',
            maxSessionLoss: '20',
            maxSessionDurationMs: 3_600_000,
          },
        },
        signal: { kind: 'h1', params: H1_R1_PARAMS, entryDelaySec: 1, expirySec: H1_EXPIRY_SEC },
      },
      trades: { settled: 0, rejected: 0, won: 0, lost: 0, tied: 0 },
      cycles: { planned: 5, closed: 0 },
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
    const invalid = await start(target, bodyFor(seed, { cycles: 0 }));
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: 'validation' });
    // #552: the length is in cycles, and no trade is shorter than the signal's shortest candle
    for (const patch of [{ trades: 5 }, { durationSec: 4 }]) {
      const refused = await start(target, bodyFor(seed, patch));
      expect(refused.statusCode).toBe(400);
      expect(refused.json()).toMatchObject({ error: 'validation' });
    }
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
    expect(catalogReads).toBe(0);
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

  // #552: the worst case of the process's strategy: four trades a martingale cycle, one a fixed
  // one; a duration that fits the hour is then H1's fence (#828)
  it.each([
    [SessionStakeStrategy.Fixed, 'h1_duration_unsupported'],
    [SessionStakeStrategy.Martingale, 'session_too_long'],
  ])('R5b five cycles of 300 s under %s answer %s', async (stakeStrategy, error) => {
    const seed = await seedReady();
    const before = await sessionCount();
    const response = await start(appWith({ stakeStrategy }), bodyFor(seed, { durationSec: 300 }));
    await expectRefusal(response, 409, error, before);
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
    ['absent', freshCatalog([{ ...pair, id: ASSET + 1 }]), H1_EXPIRY_SEC],
    ['closed', freshCatalog([{ ...pair, scheduledUntil: NOW + 60_000 }]), H1_EXPIRY_SEC],
    ['below its range', freshCatalog([{ ...pair, minTimeframe: 15 }]), H1_EXPIRY_SEC],
    [
      'above its range',
      freshCatalog([{ ...pair, minTimeframe: 1, maxTimeframe: 4 }]),
      H1_EXPIRY_SEC,
    ],
  ] as const)('R7 a pair %s is 409 pair_unavailable', async (_label, catalog, durationSec) => {
    const seed = await seedReady();
    const before = await sessionCount();
    const response = await start(appWith({ catalog }), bodyFor(seed, { durationSec }));
    await expectRefusal(response, 409, 'pair_unavailable', before);
  });

  it('R32 no balance snapshot is 409 balance_unavailable', async () => {
    const seed = await seedUserWithAccount(tmp.db);
    const before = await sessionCount();
    const response = await start(appWith({ refresh: () => Promise.resolve() }), bodyFor(seed));
    await expectRefusal(response, 409, 'balance_unavailable', before);
  });

  it('R20 a pair paying exactly 80 % starts', async () => {
    const seed = await seedReady();
    const response = await start(
      appWith({ catalog: freshCatalog([{ ...pair, payout: 80 }]) }),
      bodyFor(seed),
    );
    expect(response.statusCode).toBe(201);
  });

  // #327: a session only in the user's mode, refused before any balance refresh
  it('R21 a user in real mode asking a demo session is 409 mode_not_allowed', async () => {
    const seed = await seedReady();
    await setTradingMode(tmp.db, BigInt(seed.telegramUserId), TradeMode.Real);
    const before = await sessionCount();
    const response = await start(appWith({}), bodyFor(seed));
    await expectRefusal(response, 409, 'mode_not_allowed', before);
    expect(refreshCalls).toEqual([]);
  });

  it('R22 a user in real mode starts a real session with the saved real stake', async () => {
    const seed = await seedReady();
    await setTradingMode(tmp.db, BigInt(seed.telegramUserId), TradeMode.Real);
    await setStake(
      tmp.db,
      BigInt(seed.telegramUserId),
      TradeMode.Real,
      decimalStringSchema.parse('2.50'),
    );
    const response = await start(appWith(), bodyFor(seed, { mode: TradeMode.Real }));
    expect(response.statusCode).toBe(201);
    const session = sessionOf(response);
    expect(session.mode).toBe(TradeMode.Real);
    expect(session.settings?.stake).toMatchObject({ baseStake: '2.5', stakeScale: 2 });
    const [row] = await tmp.db
      .select()
      .from(tradingSessions)
      .where(eq(tradingSessions.id, session.id));
    expect(row).toMatchObject({ brokerAccountId: seed.brokerAccountId, mode: 'real' });
  });

  it('R23 a user in demo mode asking a real session is 409 mode_not_allowed before the catalog', async () => {
    const seed = await seedReady();
    const before = await sessionCount();
    const response = await start(appWith(), bodyFor(seed, { mode: TradeMode.Real }));
    await expectRefusal(response, 409, 'mode_not_allowed', before);
    expect(refreshCalls).toEqual([]);
    expect(catalogReads).toBe(0);
  });

  it('R24 a body without a mode is 400 validation', async () => {
    const seed = await seedReady();
    const before = await sessionCount();
    const response = await start(appWith(), {
      telegramUserId: seed.telegramUserId,
      assetId: ASSET,
      durationSec: H1_EXPIRY_SEC,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'validation' });
    expect(await sessionCount()).toBe(before);
  });

  it("R25 a real session's stake is bounded by the real balance, not the demo one", async () => {
    const above = await seedReady();
    await setTradingMode(tmp.db, BigInt(above.telegramUserId), TradeMode.Real);
    // the real balance is 100, the demo one 10000
    await setStake(
      tmp.db,
      BigInt(above.telegramUserId),
      TradeMode.Real,
      decimalStringSchema.parse('150'),
    );
    const before = await sessionCount();
    await expectRefusal(
      await start(appWith(), bodyFor(above, { mode: TradeMode.Real })),
      409,
      'insufficient_balance',
      before,
    );

    const noDemo = await seedUserWithAccount(tmp.db, { tradingMode: TradeMode.Real });
    await upsertBalanceSnapshot(tmp.db, {
      brokerAccountId: noDemo.brokerAccountId,
      user: {
        ...brokerUser,
        demo: { ...brokerUser.demo, available: decimalStringSchema.parse('0') },
      },
      requested: false,
    });
    const response = await start(appWith(), bodyFor(noDemo, { mode: TradeMode.Real }));
    expect(response.statusCode).toBe(201);
    expect(sessionOf(response).mode).toBe(TradeMode.Real);
  });

  it('R26 a switch to demo between the check and the insert answers mode_not_allowed from the transaction', async () => {
    const seed = await seedUserWithAccount(tmp.db, { tradingMode: TradeMode.Real });
    let racerRows = 0;
    const response = await start(
      appWith({
        refresh: async (accountId) => {
          await snapshotFor(accountId);
          await setTradingMode(tmp.db, BigInt(seed.telegramUserId), TradeMode.Demo);
          racerRows = await sessionCount();
        },
      }),
      bodyFor(seed, { mode: TradeMode.Real }),
    );
    await expectRefusal(response, 409, 'mode_not_allowed', racerRows);
  });

  // #396: a user left in real mode (set before the flag) passes the checks and is refused by
  // createTradingSession before its transaction
  it('R27 DEMO_ONLY: a real session is 409 demo_only, a demo one starts', async () => {
    const real = await seedReady();
    await setTradingMode(tmp.db, BigInt(real.telegramUserId), TradeMode.Real);
    const target = appWith({ demoOnly: true });
    const before = await sessionCount();
    await expectRefusal(
      await start(target, bodyFor(real, { mode: TradeMode.Real })),
      409,
      'demo_only',
      before,
    );
    const demo = await seedReady();
    const response = await start(target, bodyFor(demo));
    expect(response.statusCode).toBe(201);
    expect(sessionOf(response).mode).toBe(TradeMode.Demo);
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
      async (seed: SeededAccount) => ({
        sessionId: (await seedTradingSession(tmp.db, seed.brokerAccountId)).id,
      }),
    ],
  ] as const)(
    'R12 a change between the check and the insert answers %s from the transaction',
    async (error, race) => {
      const seed = await seedUserWithAccount(tmp.db);
      let racerRows = 0;
      let raced: unknown;
      const response = await start(
        appWith({
          refresh: async (accountId) => {
            await snapshotFor(accountId);
            raced = await race(seed);
            racerRows = await sessionCount();
          },
        }),
        bodyFor(seed),
      );
      await expectRefusal(response, 409, error, racerRows);
      if (error === 'active_session_exists') {
        expect(response.json()).toMatchObject({
          session: { id: (raced as { sessionId: string }).sessionId, status: 'active' },
        });
      }
    },
  );

  it('R15 a snapshot with a zero minimum is 409 balance_unavailable, not a 500', async () => {
    const seed = await seedUserWithAccount(tmp.db);
    await upsertBalanceSnapshot(tmp.db, {
      brokerAccountId: seed.brokerAccountId,
      user: { ...brokerUser, minTradeAmount: decimalStringSchema.parse('0.00000000') },
      requested: false,
    });
    const before = await sessionCount();
    const response = await start(appWith(), bodyFor(seed));
    await expectRefusal(response, 409, 'balance_unavailable', before);
    expect(lines.some((line) => line.includes('balance snapshot gives no session stake'))).toBe(
      true,
    );
  });

  it("R16 takes the saved demo stake on the minimum's grid (#297)", async () => {
    const seed = await seedReady();
    await setStake(
      tmp.db,
      BigInt(seed.telegramUserId),
      TradeMode.Demo,
      decimalStringSchema.parse('2.50'),
    );
    const response = await start(appWith(), bodyFor(seed));
    expect(response.statusCode).toBe(201);
    expect(sessionOf(response).settings?.stake).toMatchObject({ baseStake: '2.5', stakeScale: 2 });
  });

  // #450: SESSION_STAKE_STRATEGY of the process, frozen into the row with the saved stake's limits
  it('R40 writes the martingale limits of the saved stake', async () => {
    const seed = await seedReady();
    await setStake(
      tmp.db,
      BigInt(seed.telegramUserId),
      TradeMode.Demo,
      decimalStringSchema.parse('1.55'),
    );
    const response = await start(
      appWith({ stakeStrategy: SessionStakeStrategy.Martingale }),
      bodyFor(seed),
    );
    expect(response.statusCode).toBe(201);
    const session = sessionOf(response);
    expect(session.settings).toMatchObject({
      version: 5,
      cycles: 5,
      stake: {
        strategy: 'martingale',
        baseStake: '1.55',
        stakeScale: 2,
        limits: {
          maxSteps: 4,
          maxStake: '18.6',
          maxSessionLoss: '31',
          maxSessionDurationMs: 3_600_000,
        },
      },
    });
    const [row] = await tmp.db
      .select()
      .from(tradingSessions)
      .where(eq(tradingSessions.id, session.id));
    expect(row?.settings).toEqual(session.settings);
  });

  it('R41 writes v5 fixed under SESSION_STAKE_STRATEGY=fixed', async () => {
    const seed = await seedReady();
    const response = await start(
      appWith({ stakeStrategy: SessionStakeStrategy.Fixed }),
      bodyFor(seed),
    );
    expect(response.statusCode).toBe(201);
    const session = sessionOf(response);
    expect(session.settings?.stake).toEqual({ strategy: 'fixed', baseStake: '1', stakeScale: 0 });
  });

  it.each([
    ['0.5', 'stake_below_minimum'],
    ['10000.01', 'insufficient_balance'],
    ['1.001', 'stake_precision'],
  ])('R17 a saved stake of %s is 409 %s and writes no session (#297)', async (stake, error) => {
    const seed = await seedReady();
    await setStake(
      tmp.db,
      BigInt(seed.telegramUserId),
      TradeMode.Demo,
      decimalStringSchema.parse(stake),
    );
    const before = await sessionCount();
    await expectRefusal(await start(appWith(), bodyFor(seed)), 409, error, before);
  });

  it('R18 without a saved stake, a minimum above the demo balance is 409 (#297)', async () => {
    const seed = await seedUserWithAccount(tmp.db);
    await upsertBalanceSnapshot(tmp.db, {
      brokerAccountId: seed.brokerAccountId,
      user: {
        ...brokerUser,
        demo: { ...brokerUser.demo, available: decimalStringSchema.parse('0.5') },
      },
      requested: false,
    });
    const before = await sessionCount();
    await expectRefusal(await start(appWith(), bodyFor(seed)), 409, 'insufficient_balance', before);
  });

  it('R13 a closed trading switch is 409 trading_paused before any broker call', async () => {
    const seed = await seedUserWithAccount(tmp.db);
    await stopTrading(tmp.db, { source: 'operator', reason: 'test' });
    try {
      const before = await sessionCount();
      const response = await start(appWith({ refresh: () => Promise.resolve() }), bodyFor(seed));
      await expectRefusal(response, 409, 'trading_paused', before);
      expect(refreshCalls).toEqual([]);
      expect(catalogReads).toBe(0);
    } finally {
      await openTrading(tmp.db);
    }
  });

  it('R14 a switch closed between the check and the insert answers trading_paused from the transaction', async () => {
    const seed = await seedUserWithAccount(tmp.db);
    let racerRows = 0;
    try {
      const response = await start(
        appWith({
          refresh: async (accountId) => {
            await snapshotFor(accountId);
            await stopTrading(tmp.db, { source: 'operator', reason: 'test' });
            racerRows = await sessionCount();
          },
        }),
        bodyFor(seed),
      );
      await expectRefusal(response, 409, 'trading_paused', racerRows);
    } finally {
      await openTrading(tmp.db);
    }
  });

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

// #666, #796: the start's reading in the trade log (docs/trade-log.md → The writers and their
// outcomes): one h1 row per answer given after a reading was taken; the v2 rows of the candle start
// (S1–S7) have no writer since #828
describe('POST /trading/sessions: the start decision row (#666)', () => {
  const startRows = (brokerAccountId: string) =>
    tmp.db
      .select()
      .from(signalDecisions)
      .where(eq(signalDecisions.brokerAccountId, brokerAccountId));
  const reading = () => fakeH1Driver(signalReading).h1Driver;

  it('R39 a failed record is a warn by name and code, and the start answers as without', async () => {
    const seed = await seedReady();
    const response = await start(
      appWith({
        decisions: { record: () => Promise.reject(new TypeError('boom')) },
        h1Driver: reading(),
      }),
      bodyFor(seed),
    );
    expect(response.statusCode).toBe(201);
    const warns = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.msg === 'session start decision not recorded');
    expect(warns).toEqual([
      expect.objectContaining({
        level: 40,
        err: { name: 'TypeError' },
        accountId: seed.brokerAccountId,
      }),
    ]);
    expect(JSON.stringify(warns)).not.toContain('boom');
  });

  // the second writer of payoutInColumn: the catalog's payout is unbounded (#631)
  it('R43 a catalog payout the column cannot hold still starts; the h1 row records it as NULL', async () => {
    const seed = await seedReady();
    const response = await start(
      appWith({ catalog: freshCatalog([{ ...pair, payout: -1 }]), h1Driver: reading() }),
      bodyFor(seed),
    );
    expect(response.statusCode).toBe(201);
    expect(await startRows(seed.brokerAccountId)).toEqual([
      expect.objectContaining({
        version: 'h1',
        outcome: 'started',
        tradingSessionId: sessionOf(response).id,
        payout: null,
      }),
    ]);
    const warns = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.msg === 'session start decision not recorded');
    expect(warns).toEqual([]);
  });

  it.each<[string, Parameters<typeof appWith>[0], object]>([
    ['session_too_long', {}, { durationSec: 900 }],
    ['pair_unavailable', { catalog: freshCatalog([{ ...pair, id: ASSET + 1 }]) }, {}],
    ['catalog_unavailable', { catalog: undefined }, {}],
    ['h1_duration_unsupported', {}, { durationSec: 15 }],
  ])('R42 %s records nothing: no reading was taken', async (_label, options, patch) => {
    const seed = await seedReady();
    const driver = fakeH1Driver(signalReading);
    const response = await start(
      appWith({ h1Driver: driver.h1Driver, ...options }),
      bodyFor(seed, patch),
    );
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(await startRows(seed.brokerAccountId)).toEqual([]);
    expect(driver.currentCalls).toEqual([]);
  });
});
describe('GET /trading/sessions/:id', () => {
  it('G1 the owner reads the view, with no balance refresh for an active session', async () => {
    const seed = await seedSession();
    const response = await read(appWith(), seed.sessionId, seed.telegramUserId);
    expect(response.statusCode).toBe(200);
    expect(sessionOf(response)).toMatchObject({
      id: seed.sessionId,
      status: 'active',
      trades: { profit: '0.00000000' },
      balance: null,
    });
    expect(refreshCalls).toEqual([]);
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

  it("R35 the session's trade in the other direction moves the view's signalAction (#568)", async () => {
    const seed = await seedReady();
    const target = appWith({ h1Driver: fakeH1Driver(signalReading).h1Driver });
    const { id } = sessionOf(await start(target, bodyFor(seed)));
    expect(sessionOf(await read(target, id, seed.telegramUserId)).signalAction).toBe('up');
    await sessionIntent(seed, id, 1, TradeMode.Demo, TradeAction.Down);
    expect(sessionOf(await read(target, id, seed.telegramUserId)).signalAction).toBe('down');
  });
});

// #337: the final status carries the balance after the last trade
const sessionIntent = (
  seed: SeededAccount,
  sessionId: string,
  step: number,
  mode: TradeMode = TradeMode.Demo,
  action: TradeAction = TradeAction.Up,
) =>
  createSessionIntent(tmp.db, {
    sessionId,
    step,
    telegramUserId: seed.telegramUserId,
    brokerAccountId: seed.brokerAccountId,
    mode,
    assetId: ASSET,
    amount: decimalStringSchema.parse('1'),
    action,
    durationSec: 60,
    decision: null,
  });

async function submitted(intent: TradeIntentRow): Promise<TradeIntentRow> {
  return (await takeIntent(tmp.db, {
    id: intent.id,
    expectedVersion: intent.version,
    maxAgeMs: 60_000,
  }))!;
}

async function settled(
  seed: SeededAccount,
  sessionId: string,
  step: number,
  profit: string,
  mode: TradeMode = TradeMode.Demo,
) {
  const { intent } = await sessionIntent(seed, sessionId, step, mode);
  const taken = await submitted(intent);
  const open = openTradeFor(intent);
  await tmp.db.transaction((tx) =>
    markIntentAccepted(tx, {
      id: taken.id,
      expectedVersion: taken.version,
      transport: 'rest_fallback',
      trade: open,
    }),
  );
  await tmp.db.transaction((tx) =>
    settleIntent(tx, {
      id: intent.id,
      from: TradeIntentStatus.Accepted,
      trade: closedTradeFor(open, { profit: decimalStringSchema.parse(profit) }),
    }),
  );
}

// a session whose snapshot was written before its one trade settled, or that has none
async function finishedSession(
  reason: TradingSessionStopReason = TradingSessionStopReason.Completed,
  { snapshot = true }: { snapshot?: boolean } = {},
): Promise<SeededAccount & { sessionId: string }> {
  const seed = await seedUserWithAccount(tmp.db, { balance: 10n });
  const session = await seedTradingSession(tmp.db, seed.brokerAccountId);
  if (snapshot) await snapshotFor(seed.brokerAccountId);
  await settled(seed, session.id, 1, '0.85');
  await stopTradingSession(tmp.db, { id: session.id, reason });
  return { ...seed, sessionId: session.id };
}

const afterSession: BrokerUser = {
  ...brokerUser,
  demo: { ...brokerUser.demo, available: decimalStringSchema.parse('10000.85') },
};
const writeAfterSession = (brokerAccountId: string) =>
  upsertBalanceSnapshot(tmp.db, { brokerAccountId, user: afterSession, requested: false });

describe('GET /trading/sessions/:id: the balance after a finished session (#337)', () => {
  it('G5 refreshes once without an exchange and answers the new balance; a second read does not', async () => {
    const seed = await finishedSession();
    const target = appWith({ refresh: writeAfterSession });
    const response = await read(target, seed.sessionId, seed.telegramUserId);
    expect(response.statusCode).toBe(200);
    expect(sessionOf(response)).toMatchObject({
      trades: { settled: 1, profit: '0.85000000' },
      balance: { available: '10000.85000000', ageSec: 0, current: true },
    });
    expect(refreshCalls).toHaveLength(1);
    expect(refreshCalls[0]!.accountId).toBe(seed.brokerAccountId);
    expect(Object.keys(refreshCalls[0]!.options!).sort()).toEqual(['mayRefresh', 'signal']);
    expect(refreshCalls[0]!.options).toMatchObject({ mayRefresh: false });
    expect(refreshCalls[0]!.options!.signal).toBeInstanceOf(AbortSignal);

    await read(target, seed.sessionId, seed.telegramUserId);
    expect(refreshCalls).toHaveLength(1);
  });

  it('G6 a refresh that does not write answers the stored balance as not current', async () => {
    const seed = await finishedSession();
    const response = await read(
      appWith({ refresh: () => Promise.resolve(), outcome: 'refresh_needed' }),
      seed.sessionId,
      seed.telegramUserId,
    );
    expect(response.statusCode).toBe(200);
    expect(sessionOf(response).balance).toMatchObject({
      available: '10000.00000000',
      current: false,
    });
    expect(refreshCalls).toHaveLength(1);
  });

  it('G7 a snapshot already newer than the last settlement is not refreshed', async () => {
    const seed = await finishedSession();
    await writeAfterSession(seed.brokerAccountId);
    const response = await read(appWith(), seed.sessionId, seed.telegramUserId);
    expect(sessionOf(response).balance).toMatchObject({ current: true });
    expect(refreshCalls).toEqual([]);
  });

  it('G8 a session stopped for manual review with its trade on review is not refreshed', async () => {
    const seed = await seedUserWithAccount(tmp.db, { balance: 10n });
    const session = await seedTradingSession(tmp.db, seed.brokerAccountId);
    await snapshotFor(seed.brokerAccountId);
    await settled(seed, session.id, 1, '0.85');
    let row = await submitted((await sessionIntent(seed, session.id, 2)).intent);
    for (const [from, to] of [
      [TradeIntentStatus.Submitting, TradeIntentStatus.Unknown],
      [TradeIntentStatus.Unknown, TradeIntentStatus.Reconciling],
      [TradeIntentStatus.Reconciling, TradeIntentStatus.ManualReview],
    ] as const) {
      row = (await transitionIntent(tmp.db, {
        id: row.id,
        from,
        to,
        expectedVersion: row.version,
      }))!;
    }
    await stopTradingSession(tmp.db, {
      id: session.id,
      reason: TradingSessionStopReason.ManualReview,
    });
    const response = await read(appWith(), session.id, seed.telegramUserId);
    expect(sessionOf(response)).toMatchObject({
      trades: { settled: 1 },
      balance: { current: false },
      lastIntent: { status: TradeIntentStatus.ManualReview },
    });
    expect(refreshCalls).toEqual([]);
  });

  it('G9 a stopped session with no settled trade and no snapshot is not refreshed', async () => {
    const seed = await seedSession();
    await stopTradingSession(tmp.db, {
      id: seed.sessionId,
      reason: TradingSessionStopReason.UserStopped,
    });
    const response = await read(appWith(), seed.sessionId, seed.telegramUserId);
    expect(sessionOf(response)).toMatchObject({ trades: { settled: 0 }, balance: null });
    expect(refreshCalls).toEqual([]);
  });

  it('G11 a refresh that throws answers the opaque 500', async () => {
    const seed = await finishedSession();
    const response = await read(
      appWith({ refresh: () => Promise.reject(new Error('broker down')) }),
      seed.sessionId,
      seed.telegramUserId,
    );
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'internal' });
  });

  it('G12 a finished session with a settled trade and no snapshot is refreshed once; the written snapshot answers current', async () => {
    const seed = await finishedSession(TradingSessionStopReason.Completed, { snapshot: false });
    const target = appWith({ refresh: writeAfterSession });
    const response = await read(target, seed.sessionId, seed.telegramUserId);
    expect(response.statusCode).toBe(200);
    expect(sessionOf(response)).toMatchObject({
      trades: { settled: 1 },
      balance: { available: '10000.85000000', ageSec: 0, current: true },
    });
    expect(refreshCalls).toHaveLength(1);
    expect(refreshCalls[0]!.options).toMatchObject({ mayRefresh: false });
    expect(refreshCalls[0]!.options!.signal).toBeInstanceOf(AbortSignal);

    await read(target, seed.sessionId, seed.telegramUserId);
    expect(refreshCalls).toHaveLength(1);
  });
});

describe('POST /trading/sessions/:id/stop', () => {
  it('G10 a stop between trades answers the balance refreshed after the last one', async () => {
    const seed = await seedUserWithAccount(tmp.db, { balance: 10n });
    const session = await seedTradingSession(tmp.db, seed.brokerAccountId);
    await snapshotFor(seed.brokerAccountId);
    await settled(seed, session.id, 1, '0.85');
    const response = await stop(appWith({ refresh: writeAfterSession }), session.id, {
      telegramUserId: seed.telegramUserId,
    });
    expect(response.statusCode).toBe(200);
    expect(sessionOf(response)).toMatchObject({
      status: TradingSessionStatus.Stopped,
      stopReason: TradingSessionStopReason.UserStopped,
      balance: { available: '10000.85000000', current: true },
    });
    expect(refreshCalls).toHaveLength(1);
  });

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
      { id: seed.sessionId, decision: null },
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

// #587: the «⏹» under the waiting message hands that message to the bot
describe('POST /trading/sessions/:id/stop: the waiting message handed over (#587)', () => {
  const withWaiting = async (messageId = 50) => {
    const seed = await seedSession();
    await tmp.db
      .update(tradingSessions)
      .set({ statusMessageId: 7, waitingMessageId: messageId, waitingAfterMessage: 7 })
      .where(eq(tradingSessions.id, seed.sessionId));
    return seed;
  };
  const waitingOf = async (id: string) => {
    const [row] = await tmp.db
      .select({
        status: tradingSessions.status,
        id: tradingSessions.waitingMessageId,
        slot: tradingSessions.waitingAfterMessage,
      })
      .from(tradingSessions)
      .where(eq(tradingSessions.id, id));
    return [row!.status, row!.id, row!.slot];
  };

  it('T11 a stop naming the recorded waiting message: 200 with the stopped view, the waiting columns NULL', async () => {
    const seed = await withWaiting();
    const response = await stop(appWith(), seed.sessionId, {
      telegramUserId: seed.telegramUserId,
      waitingMessageId: 50,
    });
    expect(response.statusCode).toBe(200);
    expect(sessionOf(response)).toMatchObject({
      status: TradingSessionStatus.Stopped,
      stopReason: TradingSessionStopReason.UserStopped,
    });
    expect(await waitingOf(seed.sessionId)).toEqual(['stopped', null, null]);
  });

  it('T12 a 409 naming the recorded waiting message clears it all the same; without the field, or with another id, nothing is cleared', async () => {
    const target = appWith();
    const named = await withWaiting();
    await stopTradingSession(tmp.db, { id: named.sessionId, reason: 'completed' });
    const refused = await stop(target, named.sessionId, {
      telegramUserId: named.telegramUserId,
      waitingMessageId: 50,
    });
    expect([refused.statusCode, refused.json()]).toEqual([
      409,
      { error: TradingSessionErrorCode.SessionNotActive },
    ]);
    expect(await waitingOf(named.sessionId)).toEqual(['stopped', null, null]);

    for (const body of [{}, { waitingMessageId: 51 }]) {
      const kept = await withWaiting();
      await stopTradingSession(tmp.db, { id: kept.sessionId, reason: 'completed' });
      const again = await stop(target, kept.sessionId, {
        telegramUserId: kept.telegramUserId,
        ...body,
      });
      expect(again.statusCode).toBe(409);
      expect(await waitingOf(kept.sessionId)).toEqual(['stopped', 50, 7]);
    }
  });

  it("T12b another user's stop naming the waiting message is 404 and clears nothing", async () => {
    const seed = await withWaiting();
    await stopTradingSession(tmp.db, { id: seed.sessionId, reason: 'completed' });
    const other = await seedUser(tmp.db);
    const response = await stop(appWith(), seed.sessionId, {
      telegramUserId: other.telegramUserId,
      waitingMessageId: 50,
    });
    expect(response.statusCode).toBe(404);
    expect(await waitingOf(seed.sessionId)).toEqual(['stopped', 50, 7]);
  });

  it('T13 waitingMessageId outside 1..INT4_MAX or an extra key is 400; the stop-all route refuses the field', async () => {
    const seed = await withWaiting();
    const target = appWith();
    for (const body of [
      { waitingMessageId: 0 },
      { waitingMessageId: 2_147_483_648 },
      { waitingMessageId: 50, extra: true },
    ]) {
      const response = await stop(target, seed.sessionId, {
        telegramUserId: seed.telegramUserId,
        ...body,
      });
      expect(response.statusCode).toBe(400);
    }
    const all = await target.inject({
      method: 'POST',
      url: TRADING_SESSIONS_STOP_PATH,
      headers: auth,
      payload: { telegramUserId: seed.telegramUserId, waitingMessageId: 50 },
    });
    expect(all.statusCode).toBe(400);
    expect(await waitingOf(seed.sessionId)).toEqual(['active', 50, 7]);
  });
});

describe('POST /trading/sessions/:id/summary (#318, #537)', () => {
  const summary = (
    target: FastifyInstance,
    id: string,
    body: object,
    headers: Record<string, string> = auth,
  ) =>
    target.inject({
      method: 'POST',
      url: `${TRADING_SESSIONS_PATH}/${id}${SESSION_SUMMARY_SUFFIX}`,
      headers,
      payload: body,
    });
  const sentAt = async (sessionId: string) =>
    (
      await tmp.db
        .select({ at: tradingSessions.summarySentAt })
        .from(tradingSessions)
        .where(eq(tradingSessions.id, sessionId))
    )[0]?.at;
  const expectUnavailable = async (
    response: { statusCode: number; json: () => unknown },
    sessionId?: string,
  ) => {
    expect({ status: response.statusCode, body: response.json() }).toEqual({
      status: 409,
      body: { error: SessionSummaryErrorCode.Unavailable },
    });
    expect(safeParseSessionSummaryRefusal(response.json()).success).toBe(true);
    if (sessionId !== undefined) expect(await sentAt(sessionId)).toBeNull();
  };
  const finishedIn = async (mode: TradeMode) => {
    // a real session's intents need a user in real mode (#121)
    const seed = await seedUserWithAccount(tmp.db, { balance: 10n, tradingMode: mode });
    const session = await seedTradingSession(tmp.db, seed.brokerAccountId, { mode });
    await settled(seed, session.id, 1, '0.85', mode);
    await settled(seed, session.id, 2, '-1', mode);
    await stopTradingSession(tmp.db, {
      id: session.id,
      reason: TradingSessionStopReason.Completed,
    });
    // the notices are closed: the summary waits for them (#464, #537)
    await tmp.db
      .update(tradingSessions)
      .set({ finalNoticeSentAt: sql`now()` })
      .where(eq(tradingSessions.id, session.id));
    return { ...seed, sessionId: session.id };
  };
  const codesOf = async (userId: string) =>
    (
      await tmp.db
        .select({ code: referralCodes.code })
        .from(referralCodes)
        .where(eq(referralCodes.userId, userId))
    ).map((row) => row.code);

  it.each([TradeMode.Demo, TradeMode.Real])(
    'U1 the owner claims a finished %s session once, with no broker call',
    async (mode) => {
      const seed = await finishedIn(mode);
      const target = appWith();
      const response = await summary(target, seed.sessionId, {
        telegramUserId: seed.telegramUserId,
      });
      expect(response.statusCode).toBe(200);
      expect(safeParseSessionSummaryResponse(response.json()).success).toBe(true);
      expect(response.json()).toEqual({
        summary: {
          result: '-0.15000000',
          trades: [
            { profit: '0.85000000', openPrice: 1.08765, closePrice: 1.08712 },
            { profit: '-1.00000000', openPrice: 1.08765, closePrice: 1.08712 },
          ],
        },
      });
      expect(refreshCalls).toHaveLength(0);
      // U2: sent already
      await expectUnavailable(
        await summary(target, seed.sessionId, { telegramUserId: seed.telegramUserId }),
      );
    },
  );

  it("U3 another user's session answers as a missing one and stays unclaimed", async () => {
    const seed = await finishedIn(TradeMode.Demo);
    const other = await seedUser(tmp.db);
    const target = appWith();
    const foreign = await summary(target, seed.sessionId, {
      telegramUserId: other.telegramUserId,
    });
    await expectUnavailable(foreign, seed.sessionId);
    const missing = await summary(target, '00000000-0000-4000-8000-000000000000', {
      telegramUserId: seed.telegramUserId,
    });
    expect(missing.json()).toEqual(foreign.json());
  });

  it('U4 a session not ready (active, then stopped with a live trade) is 409 and unclaimed', async () => {
    const seed = await seedUserWithAccount(tmp.db, { balance: 10n });
    const session = await seedTradingSession(tmp.db, seed.brokerAccountId);
    await settled(seed, session.id, 1, '0.85');
    const target = appWith();
    const body = { telegramUserId: seed.telegramUserId };
    await expectUnavailable(await summary(target, session.id, body), session.id);
    await sessionIntent(seed, session.id, 2);
    await stopTradingSession(tmp.db, {
      id: session.id,
      reason: TradingSessionStopReason.UserStopped,
    });
    await expectUnavailable(await summary(target, session.id, body), session.id);
  });

  it('U5 a non-uuid id is 409, a bad body 400, no bearer 401', async () => {
    const seed = await finishedIn(TradeMode.Demo);
    const target = appWith();
    await expectUnavailable(await summary(target, 'nope', { telegramUserId: seed.telegramUserId }));
    expect((await summary(target, seed.sessionId, {})).statusCode).toBe(400);
    expect(
      (await summary(target, seed.sessionId, { telegramUserId: seed.telegramUserId }, {}))
        .statusCode,
    ).toBe(401);
    expect(await sentAt(seed.sessionId)).toBeNull();
  });

  it('U6 the claim reads and creates no referral code (#709), a blocked owner as well', async () => {
    const seed = await finishedIn(TradeMode.Demo);
    expect(await codesOf(seed.userId)).toEqual([]);
    const response = await summary(appWith(), seed.sessionId, {
      telegramUserId: seed.telegramUserId,
    });
    expect(response.statusCode).toBe(200);
    expect(await codesOf(seed.userId)).toEqual([]);

    const blocked = await finishedIn(TradeMode.Demo);
    await tmp.db.update(users).set({ status: 'blocked' }).where(eq(users.id, blocked.userId));
    const answered = await summary(appWith(), blocked.sessionId, {
      telegramUserId: blocked.telegramUserId,
    });
    expect(answered.statusCode).toBe(200);
    expect(await codesOf(blocked.userId)).toEqual([]);
  });

  it('U7 a no-signal stop without a trade is claimed: 200 with no trades', async () => {
    const seed = await seedUserWithAccount(tmp.db, { balance: 10n });
    const session = await seedTradingSession(tmp.db, seed.brokerAccountId);
    await stopTradingSession(tmp.db, {
      id: session.id,
      reason: TradingSessionStopReason.NoSignalTimeout,
    });
    await tmp.db
      .update(tradingSessions)
      .set({ finalNoticeSentAt: sql`now()` })
      .where(eq(tradingSessions.id, session.id));
    const response = await summary(appWith(), session.id, { telegramUserId: seed.telegramUserId });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ summary: { result: '0.00000000', trades: [] } });
    expect(await sentAt(session.id)).toBeInstanceOf(Date);
  });
});

describe('POST /trading/sessions/:id/share (#538)', () => {
  const share = (
    target: FastifyInstance,
    id: string,
    body: object,
    headers: Record<string, string> = auth,
  ) =>
    target.inject({
      method: 'POST',
      url: `${TRADING_SESSIONS_PATH}/${id}${SESSION_SHARE_SUFFIX}`,
      headers,
      payload: body,
    });
  const codesOf = async (userId: string) =>
    (
      await tmp.db
        .select({ code: referralCodes.code })
        .from(referralCodes)
        .where(eq(referralCodes.userId, userId))
    ).map((row) => row.code);
  const finishedIn = async (mode: TradeMode) => {
    const seed = await seedUserWithAccount(tmp.db, { balance: 10n, tradingMode: mode });
    const session = await seedTradingSession(tmp.db, seed.brokerAccountId, { mode });
    await settled(seed, session.id, 1, '0.85', mode);
    await settled(seed, session.id, 2, '-1', mode);
    await stopTradingSession(tmp.db, {
      id: session.id,
      reason: TradingSessionStopReason.Completed,
    });
    return { ...seed, sessionId: session.id };
  };

  it.each([TradeMode.Demo, TradeMode.Real])(
    'H1 the owner of a finished %s session gets the view, trades, pair and a code, the same code twice',
    async (mode) => {
      const seed = await finishedIn(mode);
      const target = appWith();
      const body = { telegramUserId: seed.telegramUserId };
      const response = await share(target, seed.sessionId, body);
      expect(response.statusCode).toBe(200);
      expect(safeParseSessionShareResponse(response.json()).success).toBe(true);
      const [code] = await codesOf(seed.userId);
      expect(code).toBeDefined();
      const view = await readTradingSessionView(tmp.db, seed.sessionId, seed.telegramUserId);
      expect(response.json()).toEqual({
        share: {
          session: view,
          trades: [
            { profit: '0.85000000', openPrice: 1.08765, closePrice: 1.08712, action: 'up' },
            { profit: '-1.00000000', openPrice: 1.08765, closePrice: 1.08712, action: 'up' },
          ],
          pair: { symbol: 'EUR/USD', digits: 5 },
          referralCode: code,
        },
      });
      const again = await share(target, seed.sessionId, body);
      expect((again.json() as { share: { referralCode: string } }).share.referralCode).toBe(code);
      expect(await codesOf(seed.userId)).toEqual([code]);
    },
  );

  it("H2 another user's session is the missing one's 404 and creates no code", async () => {
    const seed = await finishedIn(TradeMode.Demo);
    const other = await seedUser(tmp.db);
    const target = appWith();
    const foreign = await share(target, seed.sessionId, { telegramUserId: other.telegramUserId });
    expect({ status: foreign.statusCode, body: foreign.json() }).toEqual({
      status: 404,
      body: { error: TradingSessionErrorCode.NotFound },
    });
    const missing = await share(target, '00000000-0000-4000-8000-000000000000', {
      telegramUserId: seed.telegramUserId,
    });
    expect(missing.json()).toEqual(foreign.json());
    expect(await codesOf(other.userId)).toEqual([]);
    expect(await codesOf(seed.userId)).toEqual([]);
  });

  it('H3 a blocked owner gets referralCode null and no code is created', async () => {
    const seed = await finishedIn(TradeMode.Demo);
    await tmp.db.update(users).set({ status: 'blocked' }).where(eq(users.id, seed.userId));
    const response = await share(appWith(), seed.sessionId, {
      telegramUserId: seed.telegramUserId,
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { share: { referralCode: unknown } }).share.referralCode).toBeNull();
    expect(await codesOf(seed.userId)).toEqual([]);
  });

  it.each([
    ['no catalog', undefined],
    ['a stale catalog', { ...freshCatalog(), fresh: false }],
    ['a catalog without the pair', freshCatalog([{ ...pair, id: ASSET + 1 }])],
  ] as const)('H4 %s answers pair null', async (_label, catalog) => {
    const seed = await finishedIn(TradeMode.Demo);
    const response = await share(appWith({ catalog }), seed.sessionId, {
      telegramUserId: seed.telegramUserId,
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { share: { pair: unknown } }).share.pair).toBeNull();
  });

  it('H5 a non-uuid id is 404, a bad body 400, no bearer 401', async () => {
    const seed = await finishedIn(TradeMode.Demo);
    const target = appWith();
    const body = { telegramUserId: seed.telegramUserId };
    expect((await share(target, 'nope', body)).statusCode).toBe(404);
    expect((await share(target, seed.sessionId, {})).statusCode).toBe(400);
    expect((await share(target, seed.sessionId, body, {})).statusCode).toBe(401);
    expect(await codesOf(seed.userId)).toEqual([]);
  });

  it('H6 an active session answers 200 with its settled trades, and the broker is not asked', async () => {
    const seed = await seedUserWithAccount(tmp.db, { balance: 10n });
    const session = await seedTradingSession(tmp.db, seed.brokerAccountId);
    await settled(seed, session.id, 1, '0.85');
    const response = await share(appWith(), session.id, { telegramUserId: seed.telegramUserId });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      share: { session: { status: 'active' }, trades: [{ profit: '0.85000000' }] },
    });
    expect(refreshCalls).toEqual([]);
  });
});

describe('POST /trading/sessions/stop (#122)', () => {
  const stopAll = (target: FastifyInstance, body: object, headers: Record<string, string> = auth) =>
    target.inject({ method: 'POST', url: TRADING_SESSIONS_STOP_PATH, headers, payload: body });

  function sessionsOf(response: { json: () => unknown }): TradingSessionView[] {
    const parsed = safeParseTradingSessionsStoppedResponse(response.json());
    if (!parsed.success) {
      throw new Error(`not a stopped-sessions response: ${parsed.error.message}`);
    }
    return parsed.data.sessions;
  }

  const sessionRow = async (id: string) =>
    (await tmp.db.select().from(tradingSessions).where(eq(tradingSessions.id, id)))[0]!;
  const intentRow = async (id: string) =>
    (await tmp.db.select().from(tradeIntents).where(eq(tradeIntents.id, id)))[0]!;
  const tokenReservedOf = async (userId: string) =>
    (await tmp.db.select({ v: users.tokenReserved }).from(users).where(eq(users.id, userId)))[0]!.v;

  it('A1 the owner stops the one session; no intent can be created on it afterwards', async () => {
    const seed = await seedSession();
    const response = await stopAll(appWith(), { telegramUserId: seed.telegramUserId });
    expect(response.statusCode).toBe(200);
    const sessions = sessionsOf(response);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: seed.sessionId,
      status: TradingSessionStatus.Stopped,
      stopReason: TradingSessionStopReason.UserStopped,
    });
    expect(sessions[0]!.endedAt).not.toBeNull();

    const reserved = await tokenReservedOf(seed.userId);
    await expect(sessionIntent(seed, seed.sessionId, 1)).rejects.toBeInstanceOf(
      TradingSessionNotActiveError,
    );
    expect(await tokenReservedOf(seed.userId)).toBe(reserved);
    expect(refreshCalls).toEqual([]);
  });

  it('A2 no active session and no users row answers an empty list', async () => {
    const response = await stopAll(appWith(), { telegramUserId: '987654321012' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ sessions: [] });
  });

  it('A3 an extra key or a missing telegramUserId is 400; no bearer is 401', async () => {
    const seed = await seedSession();
    const target = appWith();
    const extra = await stopAll(target, { telegramUserId: seed.telegramUserId, sessionId: 'x' });
    expect(extra.statusCode).toBe(400);
    expect(extra.json()).toMatchObject({ error: 'validation' });
    expect((await stopAll(target, {})).statusCode).toBe(400);
    expect((await stopAll(target, { telegramUserId: seed.telegramUserId }, {})).statusCode).toBe(
      401,
    );
    expect((await sessionRow(seed.sessionId)).status).toBe('active');
  });

  // the acceptance criterion: the stop does not force-close an open trade
  it('A4 a queued intent stays as it was, and no broker call is made', async () => {
    const seed = await seedSession();
    const { intent } = await sessionIntent(seed, seed.sessionId, 1);
    const before = await intentRow(intent.id);
    const response = await stopAll(appWith(), { telegramUserId: seed.telegramUserId });
    expect(response.statusCode).toBe(200);
    const [session] = sessionsOf(response);
    expect(session).toMatchObject({
      status: TradingSessionStatus.Stopped,
      lastIntent: { id: intent.id, status: TradeIntentStatus.Queued },
    });
    expect(await intentRow(intent.id)).toEqual(before);
    expect(refreshCalls).toEqual([]);
  });

  it('A4 an accepted trade plays out: the intent stays as it was, and no broker call is made', async () => {
    const seed = await seedSession();
    const { intent } = await sessionIntent(seed, seed.sessionId, 1);
    const taken = await submitted(intent);
    await tmp.db.transaction((tx) =>
      markIntentAccepted(tx, {
        id: taken.id,
        expectedVersion: taken.version,
        transport: 'rest_fallback',
        trade: openTradeFor(intent),
      }),
    );
    const before = await intentRow(intent.id);
    expect(before.status).toBe(TradeIntentStatus.Accepted);
    const response = await stopAll(appWith(), { telegramUserId: seed.telegramUserId });
    expect(response.statusCode).toBe(200);
    const [session] = sessionsOf(response);
    expect(session).toMatchObject({
      status: TradingSessionStatus.Stopped,
      stopReason: TradingSessionStopReason.UserStopped,
      lastIntent: { id: intent.id, status: TradeIntentStatus.Accepted },
    });
    expect(await intentRow(intent.id)).toEqual(before);
    expect(refreshCalls).toEqual([]);
  });

  it("A5 another user's id stops nothing and answers as no sessions", async () => {
    const seed = await seedSession();
    const other = await seedUser(tmp.db);
    const response = await stopAll(appWith(), { telegramUserId: other.telegramUserId });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ sessions: [] });
    expect((await sessionRow(seed.sessionId)).status).toBe('active');
  });

  it('A6 a stop between trades answers the balance refreshed after the last one (#337)', async () => {
    const seed = await seedUserWithAccount(tmp.db, { balance: 10n });
    const session = await seedTradingSession(tmp.db, seed.brokerAccountId);
    await snapshotFor(seed.brokerAccountId);
    await settled(seed, session.id, 1, '0.85');
    const response = await stopAll(appWith({ refresh: writeAfterSession }), {
      telegramUserId: seed.telegramUserId,
    });
    expect(response.statusCode).toBe(200);
    expect(sessionsOf(response)).toMatchObject([
      {
        id: session.id,
        stopReason: TradingSessionStopReason.UserStopped,
        balance: { available: '10000.85000000', current: true },
      },
    ]);
    expect(refreshCalls).toHaveLength(1);
    expect(refreshCalls[0]!.accountId).toBe(seed.brokerAccountId);
    expect(Object.keys(refreshCalls[0]!.options!).sort()).toEqual(['mayRefresh', 'signal']);
    expect(refreshCalls[0]!.options).toMatchObject({ mayRefresh: false });
    expect(refreshCalls[0]!.options!.signal).toBeInstanceOf(AbortSignal);
  });

  it('A7 a refresh that throws answers the opaque 500 with the stop committed', async () => {
    const seed = await seedUserWithAccount(tmp.db, { balance: 10n });
    const session = await seedTradingSession(tmp.db, seed.brokerAccountId);
    await snapshotFor(seed.brokerAccountId);
    await settled(seed, session.id, 1, '0.85');
    const response = await stopAll(
      appWith({ refresh: () => Promise.reject(new Error('broker down')) }),
      { telegramUserId: seed.telegramUserId },
    );
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'internal' });
    expect(await sessionRow(session.id)).toMatchObject({
      status: 'stopped',
      stopReason: 'user_stopped',
    });
  });
});

describe('the recovery routes (#567)', () => {
  const record = (
    target: FastifyInstance,
    id: string,
    body: object,
    headers: Record<string, string> = auth,
  ) =>
    target.inject({
      method: 'POST',
      url: `${TRADING_SESSIONS_PATH}/${id}${SESSION_STATUS_MESSAGE_SUFFIX}`,
      headers,
      payload: body,
    });
  const tracked = (
    target: FastifyInstance,
    query: string = '',
    headers: Record<string, string> = auth,
  ) => target.inject({ method: 'GET', url: `${TRADING_SESSIONS_TRACKED_PATH}${query}`, headers });
  const recordedOf = async (id: string) =>
    (
      await tmp.db
        .select({ v: tradingSessions.statusMessageId })
        .from(tradingSessions)
        .where(eq(tradingSessions.id, id))
    )[0]!.v;
  const listedOf = (response: { json: () => unknown }) => {
    const parsed = safeParseTrackedSessionsResponse(response.json());
    if (!parsed.success) throw new Error(`not a tracked list: ${parsed.error.message}`);
    return parsed.data.sessions;
  };

  it('T1 records the id and answers the view, a finished session with its refreshed balance', async () => {
    const seed = await finishedSession();
    const response = await record(appWith({ refresh: writeAfterSession }), seed.sessionId, {
      telegramUserId: seed.telegramUserId,
      messageId: 41,
    });
    expect(response.statusCode).toBe(200);
    expect(sessionOf(response)).toMatchObject({
      id: seed.sessionId,
      trades: { settled: 1 },
      balance: { available: '10000.85000000', current: true },
    });
    expect(refreshCalls).toHaveLength(1);
    expect(await recordedOf(seed.sessionId)).toBe(41);
  });

  // #587: the newest id wins
  it("T2' a newer id replaces the recorded one and answers 200; an older one answers 200 and the newest stays", async () => {
    const seed = await seedSession();
    const target = appWith();
    const body = { telegramUserId: seed.telegramUserId };
    expect((await record(target, seed.sessionId, { ...body, messageId: 41 })).statusCode).toBe(200);
    const newer = await record(target, seed.sessionId, { ...body, messageId: 42 });
    expect(newer.statusCode).toBe(200);
    expect(sessionOf(newer).id).toBe(seed.sessionId);
    expect(await recordedOf(seed.sessionId)).toBe(42);
    const older = await record(target, seed.sessionId, { ...body, messageId: 41 });
    expect(older.statusCode).toBe(200);
    expect(sessionOf(older).id).toBe(seed.sessionId);
    expect(await recordedOf(seed.sessionId)).toBe(42);
  });

  it('T3 GET /trading/sessions/tracked answers the list, not the /:id route', async () => {
    const response = await tracked(appWith());
    expect(response.statusCode).toBe(200);
    expect(Array.isArray(listedOf(response))).toBe(true);
  });

  it("T4 another user's id and a non-uuid id are 404 not_found and record nothing", async () => {
    const seed = await seedSession();
    const other = await seedUser(tmp.db);
    const target = appWith();
    const foreign = await record(target, seed.sessionId, {
      telegramUserId: other.telegramUserId,
      messageId: 41,
    });
    expect([foreign.statusCode, foreign.json()]).toEqual([404, { error: 'not_found' }]);
    const missing = await record(target, '00000000-0000-4000-8000-000000000000', {
      telegramUserId: seed.telegramUserId,
      messageId: 41,
    });
    expect([missing.statusCode, missing.json()]).toEqual([404, { error: 'not_found' }]);
    const nonUuid = await record(target, 'nope', {
      telegramUserId: seed.telegramUserId,
      messageId: 41,
    });
    expect(nonUuid.statusCode).toBe(404);
    expect(await recordedOf(seed.sessionId)).toBeNull();
  });

  it('T5 a body outside the schema is 400 and records nothing', async () => {
    const seed = await seedSession();
    const target = appWith();
    for (const body of [
      { telegramUserId: seed.telegramUserId },
      { telegramUserId: seed.telegramUserId, messageId: 0 },
      { telegramUserId: seed.telegramUserId, messageId: 2_147_483_648 },
      { telegramUserId: seed.telegramUserId, messageId: 1, extra: true },
    ]) {
      expect((await record(target, seed.sessionId, body)).statusCode).toBe(400);
    }
    expect(await recordedOf(seed.sessionId)).toBeNull();
  });

  it('T6 a limit past the ceiling is 400; without one the list is capped at the ceiling', async () => {
    const target = appWith();
    const over = await tracked(target, `?limit=${TRACKED_SESSIONS_MAX + 1}`);
    expect([over.statusCode, (over.json() as { error: string }).error]).toEqual([
      400,
      'validation',
    ]);
    expect((await tracked(target, '?limit=0')).statusCode).toBe(400);
    expect((await tracked(target, `?limit=${TRACKED_SESSIONS_MAX}`)).statusCode).toBe(200);
  });

  it('T7 both routes need the bearer', async () => {
    const seed = await seedSession();
    const target = appWith();
    const none = {};
    expect(
      (
        await record(
          target,
          seed.sessionId,
          { telegramUserId: seed.telegramUserId, messageId: 41 },
          none,
        )
      ).statusCode,
    ).toBe(401);
    expect((await tracked(target, '', none)).statusCode).toBe(401);
    expect(await recordedOf(seed.sessionId)).toBeNull();
  });

  it("T8 a row carries the owner, the owner's language (#508), the message, the pair and started_at, oldest first", async () => {
    const target = appWith();
    const seeded = [];
    for (const [startedAt, language] of [
      ['1999-01-02T00:00:00.000Z', BotLanguage.En],
      ['1999-01-01T00:00:00.000Z', BotLanguage.Ru],
    ] as const) {
      const seed = await seedUserWithAccount(tmp.db);
      await setUserLanguage(tmp.db, BigInt(seed.telegramUserId), language);
      const session = await seedTradingSession(tmp.db, seed.brokerAccountId, {
        startedAt: new Date(startedAt),
      });
      await record(target, session.id, { telegramUserId: seed.telegramUserId, messageId: 9 });
      seeded.push({ id: session.id, telegramUserId: seed.telegramUserId, startedAt, language });
    }
    const rows = listedOf(await tracked(target, '?limit=2'));
    expect(rows).toEqual(
      [seeded[1]!, seeded[0]!].map((row) => ({ ...row, messageId: 9, assetId: ASSET })),
    );
  });

  it('T9 POST lost forgets the recorded message once, by its id and owner only', async () => {
    const seed = await seedSession();
    const other = await seedUser(tmp.db);
    const target = appWith();
    const lost = (id: string, body: object, headers: Record<string, string> = auth) =>
      target.inject({
        method: 'POST',
        url: `${TRADING_SESSIONS_PATH}/${id}${SESSION_STATUS_MESSAGE_LOST_SUFFIX}`,
        headers,
        payload: body,
      });
    const body = { telegramUserId: seed.telegramUserId, messageId: 41 };
    await record(target, seed.sessionId, body);
    const foreign = await lost(seed.sessionId, { ...body, telegramUserId: other.telegramUserId });
    expect([foreign.statusCode, foreign.json()]).toEqual([200, { forgotten: false }]);
    expect(await recordedOf(seed.sessionId)).toBe(41);
    expect((await lost('nope', body)).statusCode).toBe(404);
    expect((await lost(seed.sessionId, { ...body, messageId: 0 })).statusCode).toBe(400);
    expect((await lost(seed.sessionId, body, {})).statusCode).toBe(401);
    expect(await recordedOf(seed.sessionId)).toBe(41);
    const first = await lost(seed.sessionId, body);
    expect([first.statusCode, first.json()]).toEqual([200, { forgotten: true }]);
    expect(await recordedOf(seed.sessionId)).toBeNull();
    const again = await lost(seed.sessionId, body);
    expect([again.statusCode, again.json()]).toEqual([200, { forgotten: false }]);
  });

  it('T10 both the record and the lost route refuse replacesMessageId (#587)', async () => {
    const seed = await seedSession();
    const target = appWith();
    const body = { telegramUserId: seed.telegramUserId };
    expect((await record(target, seed.sessionId, { ...body, messageId: 41 })).statusCode).toBe(200);
    const replaced = await record(target, seed.sessionId, {
      ...body,
      messageId: 42,
      replacesMessageId: 41,
    });
    expect([replaced.statusCode, (replaced.json() as { error?: unknown }).error]).toEqual([
      400,
      'validation',
    ]);
    const lost = await target.inject({
      method: 'POST',
      url: `${TRADING_SESSIONS_PATH}/${seed.sessionId}${SESSION_STATUS_MESSAGE_LOST_SUFFIX}`,
      headers: auth,
      payload: { ...body, messageId: 41, replacesMessageId: 40 },
    });
    expect([lost.statusCode, (lost.json() as { error?: unknown }).error]).toEqual([
      400,
      'validation',
    ]);
    expect(await recordedOf(seed.sessionId)).toBe(41);
  });
});

// #745, #775, #828: every start from the bot writes settings v5 (docs/h1.md -> From the bot), on
// any account: a regular session with the H1 signal
describe('POST /trading/sessions: every start is H1 (#745, #775, #828)', () => {
  // a pair H1 trades: it accepts the 5 s expiry
  const h1Pair: BinaryPair = { ...pair, payout: 95 };
  let driverCalls: ReturnType<typeof fakeH1Driver> = fakeH1Driver(signalReading);
  const h1App = (
    options: Parameters<typeof appWith>[0] = {},
    pairs: BinaryPair[] = [h1Pair],
    reading: H1Reading = signalReading,
  ) => {
    driverCalls = fakeH1Driver(reading);
    return appWith({ catalog: freshCatalog(pairs), h1Driver: driverCalls.h1Driver, ...options });
  };
  const h1Body = (seed: { telegramUserId: string }, patch: object = {}) =>
    bodyFor(seed, { durationSec: H1_EXPIRY_SEC, ...patch });
  const startRows = (brokerAccountId: string) =>
    tmp.db
      .select()
      .from(signalDecisions)
      .where(eq(signalDecisions.brokerAccountId, brokerAccountId));

  it("H1-R1′ writes v5: the request's cycles, the process's strategy, the saved stake, the R1 signal", async () => {
    const seed = await seedReady();
    await setStake(
      tmp.db,
      BigInt(seed.telegramUserId),
      TradeMode.Demo,
      decimalStringSchema.parse('2.50'),
    );
    const response = await start(h1App(), h1Body(seed));
    expect(response.statusCode).toBe(201);
    const session = sessionOf(response);
    const baseStake = decimalStringSchema.parse('2.5');
    expect(session.settings).toEqual({
      version: 5,
      assetId: ASSET,
      durationSec: H1_EXPIRY_SEC,
      cycles: 5,
      stake: {
        strategy: 'martingale',
        baseStake,
        stakeScale: 2,
        limits: martingaleLimitsFor(baseStake),
      },
      signal: { kind: 'h1', params: H1_R1_PARAMS, entryDelaySec: 1, expirySec: H1_EXPIRY_SEC },
    });
    const [row] = await tmp.db
      .select()
      .from(tradingSessions)
      .where(eq(tradingSessions.id, session.id));
    expect(row?.settings).toEqual(session.settings);
    expect(row?.startSignalAction).toBe('up');
    const rows = await startRows(seed.brokerAccountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      context: 'session_start',
      version: 'h1',
      outcome: 'started',
      tradingSessionId: session.id,
    });
  });

  it('H1-R15 a 15 s request is 409 h1_duration_unsupported (#828)', async () => {
    const seed = await seedReady();
    const before = await sessionCount();
    const response = await start(h1App(), h1Body(seed, { durationSec: 15 }));
    await expectRefusal(response, 409, 'h1_duration_unsupported', before);
    expect(driverCalls.currentCalls).toEqual([]);
  });

  // #568: the reading's direction is the session's first picture in the bot
  it.each([
    [TradeAction.Up, RAMP],
    [TradeAction.Down, FALL],
  ])(
    'R34′ a start on a %s H1 signal writes it to the row and answers it in the view',
    async (action, closes) => {
      const seed = await seedReady();
      const response = await start(
        h1App({}, [h1Pair], { kind: 'decision', facts: factsOf(closes) }),
        h1Body(seed),
      );
      expect(response.statusCode).toBe(201);
      const session = sessionOf(response);
      expect(session.signalAction).toBe(action);
      const [row] = await tmp.db
        .select({ startSignalAction: tradingSessions.startSignalAction })
        .from(tradingSessions)
        .where(eq(tradingSessions.id, session.id));
      expect(row!.startSignalAction).toBe(action);
    },
  );

  it('H1-R3′ no payout floor: a pair paying under 94 % starts (#775, В2)', async () => {
    const seed = await seedReady();
    const response = await start(
      h1App({}, [{ ...h1Pair, payout: H1_MIN_PAYOUT_PCT - 4 }]),
      h1Body(seed),
    );
    expect(response.statusCode).toBe(201);
    expect(sessionOf(response).settings?.version).toBe(5);
  });

  it("H1-R4 a duration other than H1's is 409 h1_duration_unsupported before the signal", async () => {
    const seed = await seedReady();
    const before = await sessionCount();
    // the file's pair accepts 60 s, so step 4 passes; it pays 95
    const response = await start(
      h1App({}, [{ ...pair, payout: 95 }]),
      bodyFor(seed, { durationSec: 60 }),
    );
    await expectRefusal(response, 409, 'h1_duration_unsupported', before);
    expect(driverCalls.currentCalls).toEqual([]);
    expect(await startRows(seed.brokerAccountId)).toEqual([]);
  });

  it('H1-R5′ the order: the pair, then the duration; no signal starts waiting (#796)', async () => {
    const seed = await seedReady();
    const before = await sessionCount();
    const from60: BinaryPair = { ...pair, minTimeframe: 60, payout: 93 };
    // the pair refuses the 5 s expiry: pair_unavailable
    await expectRefusal(
      await start(h1App({}, [from60], quietReading), h1Body(seed)),
      409,
      'pair_unavailable',
      before,
    );
    // the pair takes 60 s, the request asks 60 s: the duration answers before the reading
    await expectRefusal(
      await start(h1App({}, [from60], quietReading), bodyFor(seed, { durationSec: 60 })),
      409,
      'h1_duration_unsupported',
      before,
    );
    expect(driverCalls.currentCalls).toEqual([]);
    // 5 s on a pair paying 93, no H1 signal: the session starts and waits
    const response = await start(
      h1App({}, [{ ...h1Pair, payout: 93 }], quietReading),
      h1Body(seed),
    );
    expect(response.statusCode).toBe(201);
    expect(sessionOf(response).signalAction).toBeNull();
  });

  // the trading switch closed between the start's check and the insert: the balance refresh the
  // start awaits (no snapshot yet) closes it, then writes the snapshot
  const closedDuringStart = async (reading: H1Reading) => {
    const seed = await seedUserWithAccount(tmp.db);
    const before = await sessionCount();
    const closeFirst = async () => {
      await stopTrading(tmp.db, { source: 'operator', reason: 'test' });
      await snapshotFor(seed.brokerAccountId);
    };
    try {
      const response = await start(h1App({ refresh: closeFirst }, [h1Pair], reading), h1Body(seed));
      await expectRefusal(response, 409, 'trading_paused', before);
    } finally {
      await openTrading(tmp.db);
    }
    return { seed, rows: await startRows(seed.brokerAccountId) };
  };

  it('H1-R6′ a refusal at the insert after a signal reading is recorded refused with its code', async () => {
    const { rows } = await closedDuringStart(signalReading);
    expect(rows.map((row) => [row.version, row.outcome, row.detail])).toEqual([
      ['h1', 'refused', 'trading_paused'],
    ]);
    expect(driverCalls.adoptCalls).toEqual([]);
  });

  it("H1-R7′ the request's cycles apply; too many for the hour is session_too_long", async () => {
    const seed = await seedReady();
    const response = await start(
      h1App({ stakeStrategy: SessionStakeStrategy.Fixed }),
      h1Body(seed, { cycles: 20 }),
    );
    expect(response.statusCode).toBe(201);
    expect(sessionOf(response).settings).toMatchObject({
      version: 5,
      cycles: 20,
      stake: { strategy: 'fixed' },
    });
    const other = await seedReady();
    const before = await sessionCount();
    await expectRefusal(
      await start(h1App(), h1Body(other, { cycles: 8 })),
      409,
      'session_too_long',
      before,
    );
  });

  it('H1-R8 DEMO_ONLY: a real H1 start is 409 demo_only, past the fence', async () => {
    const seed = await seedReady();
    await setTradingMode(tmp.db, BigInt(seed.telegramUserId), TradeMode.Real);
    const before = await sessionCount();
    const response = await start(h1App({ demoOnly: true }), h1Body(seed, { mode: TradeMode.Real }));
    await expectRefusal(response, 409, 'demo_only', before);
  });

  it('H1-R9 an H1 signal at the start: 201 with its direction, the h1 row, the session handed to the driver (#796)', async () => {
    const seed = await seedReady();
    const response = await start(h1App(), h1Body(seed));
    expect(response.statusCode).toBe(201);
    const session = sessionOf(response);
    expect(session.signalAction).toBe('up');
    const [row] = await tmp.db
      .select()
      .from(tradingSessions)
      .where(eq(tradingSessions.id, session.id));
    expect(row?.startSignalAction).toBe('up');
    const facts = factsOf(RAMP);
    expect(driverCalls.currentCalls).toEqual([[ASSET, session.settings]]);
    expect(driverCalls.adoptCalls).toEqual([
      [
        {
          id: session.id,
          brokerAccountId: seed.brokerAccountId,
          mode: 'demo',
          telegramUserId: seed.telegramUserId,
          settings: session.settings,
          startedAt: row!.startedAt,
        },
        { facts, pair: h1Pair },
      ],
    ]);
    const rows = await startRows(seed.brokerAccountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      context: 'session_start',
      tradingSessionId: session.id,
      step: null,
      interval: null,
      version: 'h1',
      outcome: 'started',
      detail: null,
      kind: 'signal',
      action: 'up',
      decidedAtMs: F,
      takenAtMs: facts.takenAtMs,
      payout: h1Pair.payout,
      digits: 5,
      params: { set: 'session', ...H1_R1_PARAMS, entryDelaySec: 1, expirySec: H1_EXPIRY_SEC },
      source: { kind: 'ticks', symbol: h1Pair.symbol, closedBy: 'tick', closedAtMs: F + 300 },
      series: RAMP,
      ticksUntilMs: null,
    });
  });

  it('H1-R9b no H1 signal at the start: 201 waiting, start_signal_action NULL, a no_signal row with the session (#796)', async () => {
    const seed = await seedReady();
    expect(quietReading.kind === 'decision' && quietReading.facts.decision).toMatchObject({
      kind: 'no_signal',
      reason: 'below_threshold',
    });
    const response = await start(h1App({}, [h1Pair], quietReading), h1Body(seed));
    expect(response.statusCode).toBe(201);
    const session = sessionOf(response);
    expect(session.signalAction).toBeNull();
    const [row] = await tmp.db
      .select()
      .from(tradingSessions)
      .where(eq(tradingSessions.id, session.id));
    expect(row?.startSignalAction).toBeNull();
    expect(driverCalls.adoptCalls).toHaveLength(1);
    expect(driverCalls.adoptCalls[0]![1]).toEqual({ facts: factsOf(QUIET), pair: h1Pair });
    const rows = await startRows(seed.brokerAccountId);
    expect(rows.map((one) => [one.version, one.outcome, one.kind, one.tradingSessionId])).toEqual([
      ['h1', 'no_signal', 'no_signal', session.id],
    ]);
  });

  it("H1-R10 the real driver trades the start's signal at once: Шаг 1 on the start's reading (#796)", async () => {
    const seed = await seedReady();
    const BUDGET_MS = 5_000;
    const T = F - 300_000;
    const series = createSecondSeries({ capacitySec: 320, closeMarginMs: 500 });
    RAMP.forEach((price, i) => {
      const second = T + i * 1_000;
      series.push(ASSET, 5, { price, timestamp: second - 500 }, second - 460);
    });
    series.advance(F + 500);
    const wakes = { n: 0 };
    const driver = createH1Driver({
      series,
      catalog: { read: () => freshCatalog([h1Pair]) },
      streaming: () => true,
      sessions: {
        list: () => listActiveH1Sessions(tmp.db),
        history: (id, options) => readSessionHistory(tmp.db, id, options),
        balance: (id, options) => readSessionBalance(tmp.db, id, options),
        createIntent: (input) => createSessionIntent(tmp.db, input, { demoOnly: false }),
        stop: (id, reason) => stopTradingSession(tmp.db, { id, reason }),
        record: (input) => recordSignalDecision(tmp.db, input),
      },
      wake: () => void (wakes.n += 1),
      logger: pino(logOptions('silent')),
      now: () => F + 600,
      config: {
        scanMs: 60_000,
        tickMs: 60_000,
        logMs: 60_000,
        submitBudgetMs: BUDGET_MS,
        startMaxAgeMs: 1_600,
      },
    });
    try {
      const response = await start(
        appWith({ catalog: freshCatalog([h1Pair]), h1Driver: driver }),
        h1Body(seed),
      );
      expect(response.statusCode).toBe(201);
      const session = sessionOf(response);
      expect(session.signalAction).toBe('up');
      await until('the driver to wake the publisher', () => Promise.resolve(wakes.n === 1));
      const intents = await tmp.db
        .select()
        .from(tradeIntents)
        .where(eq(tradeIntents.tradingSessionId, session.id));
      expect(intents).toHaveLength(1);
      const rows = await tmp.db
        .select()
        .from(signalDecisions)
        .where(eq(signalDecisions.tradingSessionId, session.id));
      const startRow = rows.find((one) => one.context === 'session_start')!;
      const intentRow = rows.find((one) => one.context === 'session')!;
      expect(startRow).toMatchObject({ outcome: 'started', decidedAtMs: F, takenAtMs: F + 600 });
      expect(intentRow).toMatchObject({ outcome: 'intent', step: 1, decidedAtMs: F, action: 'up' });
      expect(intents[0]).toMatchObject({
        action: 'up',
        signalDecisionId: intentRow.id,
        submitDeadlineAt: new Date(startRow.takenAtMs + BUDGET_MS),
      });
    } finally {
      await driver.stop();
    }
  });

  it.each([
    ['no driver (no data socket)', undefined, 'source_down'],
    ['the source down', 'source_down', 'source_down'],
    ['no series', 'no_series', 'no_series'],
    ['a stale second', 'stale', 'stale'],
    ['unknown digits', 'no_digits', 'no_digits'],
    ['a window still warming', 'warming', 'warming'],
  ] as const)(
    'H1-R11 %s: 201 waiting, no row, no hand-over of a reading, one info line (#796)',
    async (_name, reason, logged) => {
      const seed = await seedReady();
      const app =
        reason === undefined
          ? appWith({ catalog: freshCatalog([h1Pair]) })
          : h1App({}, [h1Pair], { kind: 'unavailable', reason });
      const response = await start(app, h1Body(seed));
      expect(response.statusCode).toBe(201);
      const session = sessionOf(response);
      expect(session.signalAction).toBeNull();
      expect(await startRows(seed.brokerAccountId)).toEqual([]);
      if (reason !== undefined) {
        expect(driverCalls.adoptCalls).toHaveLength(1);
        expect(driverCalls.adoptCalls[0]![1]).toBeUndefined();
      }
      const infos = lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((entry) => entry.msg === 'h1 start without a reading');
      expect(infos).toEqual([
        expect.objectContaining({
          accountId: seed.brokerAccountId,
          assetId: ASSET,
          reason: logged,
        }),
      ]);
    },
  );

  it('H1-R12 a refusal at the insert after a no-signal reading: no_signal without a session, no hand-over (#796)', async () => {
    const { rows } = await closedDuringStart(quietReading);
    expect(rows.map((row) => [row.version, row.outcome, row.detail, row.tradingSessionId])).toEqual(
      [['h1', 'no_signal', null, null]],
    );
    expect(driverCalls.adoptCalls).toEqual([]);
  });

  it('H1-R13 a stake refusal of an H1 start writes no row and reads no H1 signal (#796)', async () => {
    const seed = await seedReady();
    await setStake(
      tmp.db,
      BigInt(seed.telegramUserId),
      TradeMode.Demo,
      decimalStringSchema.parse('0.5'),
    );
    const before = await sessionCount();
    await expectRefusal(await start(h1App(), h1Body(seed)), 409, 'stake_below_minimum', before);
    expect(await startRows(seed.brokerAccountId)).toEqual([]);
    expect(driverCalls.currentCalls).toEqual([]);
    expect(driverCalls.adoptCalls).toEqual([]);
  });

  // #829: the direction the bot showed, older than any reading; the fake reading says up
  const shownSignal = {
    action: 'down',
    second: F - 20_000,
    decidedAt: F - 19_600,
    shownAtMs: F - 15_000,
    source: 'analysis',
  } as const;
  const shownBody = (seed: { telegramUserId: string }, patch: object = {}) =>
    h1Body(seed, { shownSignal: { ...shownSignal, ...patch } });

  it('H1-R17 a start with a shown signal: 201 in its direction, no reading, the shown hand-over, the h1-start row, one info line (#829)', async () => {
    const seed = await seedReady();
    const response = await start(h1App(), shownBody(seed));
    expect(response.statusCode).toBe(201);
    const session = sessionOf(response);
    expect(session.signalAction).toBe('down');
    const [row] = await tmp.db
      .select()
      .from(tradingSessions)
      .where(eq(tradingSessions.id, session.id));
    expect(row?.startSignalAction).toBe('down');
    expect(driverCalls.currentCalls).toEqual([]);
    expect(driverCalls.adoptCalls).toHaveLength(1);
    expect(driverCalls.adoptCalls[0]![1]).toEqual({ shown: shownSignal, pair: h1Pair });
    const rows = await startRows(seed.brokerAccountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      context: 'session_start',
      tradingSessionId: session.id,
      step: null,
      interval: null,
      version: 'h1-start',
      outcome: 'started',
      detail: null,
      kind: 'signal',
      action: 'down',
      decidedAtMs: shownSignal.second,
      takenAtMs: NOW,
      payout: h1Pair.payout,
      digits: null,
      params: { rule: 'shown_signal', ...H1_R1_PARAMS },
      decision: {
        kind: 'signal',
        version: 'h1-start',
        action: 'down',
        shown: {
          second: shownSignal.second,
          decidedAt: shownSignal.decidedAt,
          source: 'analysis',
        },
      },
      source: { kind: 'shown', source: 'analysis', shownAtMs: shownSignal.shownAtMs },
      series: [],
      lastTick: null,
      ticksUntilMs: null,
    });
    const infos = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.msg === 'h1 start on a shown signal');
    expect(infos).toEqual([
      expect.objectContaining({
        accountId: seed.brokerAccountId,
        assetId: ASSET,
        source: 'analysis',
        ageMs: NOW - shownSignal.second,
      }),
    ]);
  });

  it('H1-R18 a shown signal without the driver (no data socket): 201 in its direction, no reading line, no h1 row (#829)', async () => {
    const seed = await seedReady();
    const response = await start(appWith({ catalog: freshCatalog([h1Pair]) }), shownBody(seed));
    expect(response.statusCode).toBe(201);
    expect(sessionOf(response).signalAction).toBe('down');
    expect(lines.some((line) => line.includes('h1 start without a reading'))).toBe(false);
    const rows = await startRows(seed.brokerAccountId);
    expect(rows.map((one) => [one.version, one.outcome])).toEqual([['h1-start', 'started']]);
  });

  it('H1-R19 a refusal at the insert after a shown signal: the h1-start row refused with its code, no session, no hand-over (#829)', async () => {
    const seed = await seedUserWithAccount(tmp.db);
    const before = await sessionCount();
    const closeFirst = async () => {
      await stopTrading(tmp.db, { source: 'operator', reason: 'test' });
      await snapshotFor(seed.brokerAccountId);
    };
    try {
      const response = await start(h1App({ refresh: closeFirst }), shownBody(seed));
      await expectRefusal(response, 409, 'trading_paused', before);
    } finally {
      await openTrading(tmp.db);
    }
    const rows = await startRows(seed.brokerAccountId);
    expect(
      rows.map((row) => [row.version, row.context, row.outcome, row.detail, row.tradingSessionId]),
    ).toEqual([['h1-start', 'session_start', 'refused', 'trading_paused', null]]);
    expect(driverCalls.adoptCalls).toEqual([]);
    expect(driverCalls.currentCalls).toEqual([]);
  });

  it('H1-R20 a stake refusal with a shown signal writes no row, reads nothing, hands nothing over (#829)', async () => {
    const seed = await seedReady();
    await setStake(
      tmp.db,
      BigInt(seed.telegramUserId),
      TradeMode.Demo,
      decimalStringSchema.parse('0.5'),
    );
    const before = await sessionCount();
    await expectRefusal(await start(h1App(), shownBody(seed)), 409, 'stake_below_minimum', before);
    expect(await startRows(seed.brokerAccountId)).toEqual([]);
    expect(driverCalls.currentCalls).toEqual([]);
    expect(driverCalls.adoptCalls).toEqual([]);
  });

  it.each([
    ['an unknown source', { source: 'card' }],
    ['a zero second', { second: 0 }],
    ['an extra key', { extra: 1 }],
    ['no shownAtMs', { shownAtMs: undefined }],
  ])(
    'H1-R21 a malformed shown signal (%s) is 400 validation, nothing created (#829)',
    async (_name, patch) => {
      const seed = await seedReady();
      const before = await sessionCount();
      const response = await start(h1App(), shownBody(seed, patch));
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: 'validation' });
      expect(await sessionCount()).toBe(before);
      expect(await startRows(seed.brokerAccountId)).toEqual([]);
      expect(driverCalls.adoptCalls).toEqual([]);
    },
  );

  it('H1-R22 the real driver on a quiet series trades the shown direction at once: Шаг 1 without a deadline, both h1-start rows (#829)', async () => {
    const seed = await seedReady();
    const T = F - 300_000;
    const series = createSecondSeries({ capacitySec: 320, closeMarginMs: 500 });
    QUIET.forEach((price, i) => {
      const second = T + i * 1_000;
      series.push(ASSET, 5, { price, timestamp: second - 500 }, second - 460);
    });
    series.advance(F + 500);
    const wakes = { n: 0 };
    const driver = createH1Driver({
      series,
      catalog: { read: () => freshCatalog([h1Pair]) },
      streaming: () => true,
      sessions: {
        list: () => listActiveH1Sessions(tmp.db),
        history: (id, options) => readSessionHistory(tmp.db, id, options),
        balance: (id, options) => readSessionBalance(tmp.db, id, options),
        createIntent: (input) => createSessionIntent(tmp.db, input, { demoOnly: false }),
        stop: (id, reason) => stopTradingSession(tmp.db, { id, reason }),
        record: (input) => recordSignalDecision(tmp.db, input),
      },
      wake: () => void (wakes.n += 1),
      logger: pino(logOptions('silent')),
      now: () => F + 600,
      config: {
        scanMs: 60_000,
        tickMs: 60_000,
        logMs: 60_000,
        submitBudgetMs: 5_000,
        startMaxAgeMs: 1_600,
      },
    });
    try {
      const response = await start(
        appWith({ catalog: freshCatalog([h1Pair]), h1Driver: driver }),
        shownBody(seed, { action: 'up' }),
      );
      expect(response.statusCode).toBe(201);
      const session = sessionOf(response);
      expect(session.signalAction).toBe('up');
      await until('the driver to wake the publisher', () => Promise.resolve(wakes.n === 1));
      const intents = await tmp.db
        .select()
        .from(tradeIntents)
        .where(eq(tradeIntents.tradingSessionId, session.id));
      expect(intents).toHaveLength(1);
      const rows = await tmp.db
        .select()
        .from(signalDecisions)
        .where(eq(signalDecisions.tradingSessionId, session.id));
      const startRow = rows.find((one) => one.context === 'session_start')!;
      const intentRow = rows.find((one) => one.context === 'session')!;
      expect(startRow).toMatchObject({ version: 'h1-start', outcome: 'started' });
      expect(intentRow).toMatchObject({
        version: 'h1-start',
        outcome: 'intent',
        step: 1,
        decidedAtMs: shownSignal.second,
        takenAtMs: F + 600,
        action: 'up',
      });
      expect(intents[0]).toMatchObject({
        clientRequestId: `session:${session.id}:1`,
        action: 'up',
        signalDecisionId: intentRow.id,
        submitDeadlineAt: null,
      });
    } finally {
      await driver.stop();
    }
  });
});
