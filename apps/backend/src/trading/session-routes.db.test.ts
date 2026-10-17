import type { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  AccountHaltReason,
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
  setStake,
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
  fakeSignalFeed,
  sessionSignalEvaluation,
  unusedAccessTokenDeps,
  unusedBalanceDeps,
  unusedPairsDeps,
  unusedSignalDeps,
  unusedSignalsDeps,
} from './testing';
import { unusedDepositDeps } from '../deposit/testing';
import type { SignalEvaluation } from '@binarius/signal';

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
let signalCalls: Parameters<TradingSessionRoutesDeps['signals']['evaluate']>[0][] = [];

beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
});
afterEach(async () => {
  await app?.close();
  app = undefined;
  lines = [];
  refreshCalls = [];
  catalogReads = 0;
  signalCalls = [];
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
    // the pair's signal at the start (#509); a signal by default
    signal?: SignalEvaluation | (() => Promise<SignalEvaluation>);
  } = {},
): FastifyInstance {
  const catalog = 'catalog' in options ? options.catalog : freshCatalog();
  const signals = fakeSignalFeed(options.signal ?? sessionSignalEvaluation('signal'));
  signalCalls = signals.calls;
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
      signals: signals.feed,
      internalApiToken: PAIRS_TEST_TOKEN,
      demoOnly: options.demoOnly ?? false,
      stakeStrategy: options.stakeStrategy ?? SessionStakeStrategy.Martingale,
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
      // #450: the process's default strategy, martingale, with the limits of the base stake
      settings: {
        version: 3,
        assetId: ASSET,
        durationSec: 60,
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

  // #552: the worst case of the process's strategy: four trades a martingale cycle, one a fixed one
  it.each([
    [SessionStakeStrategy.Fixed, 201],
    [SessionStakeStrategy.Martingale, 409],
  ])('R5b five cycles of 300 s under %s answer %i', async (stakeStrategy, status) => {
    const seed = await seedReady();
    const before = await sessionCount();
    const response = await start(appWith({ stakeStrategy }), bodyFor(seed, { durationSec: 300 }));
    expect(response.statusCode).toBe(status);
    if (status === 409) await expectRefusal(response, 409, 'session_too_long', before);
    else expect(sessionOf(response).settings).toMatchObject({ version: 3, cycles: 5 });
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

  // #379: no cycle on a pair paying less than MIN_CYCLE_PAYOUT_PCT; refused before the balance
  it('R19 a pair paying 79 % is 409 payout_too_low, before any balance refresh', async () => {
    const seed = await seedUserWithAccount(tmp.db);
    const before = await sessionCount();
    const response = await start(
      appWith({ catalog: freshCatalog([{ ...pair, payout: 79 }]) }),
      bodyFor(seed),
    );
    await expectRefusal(response, 409, 'payout_too_low', before);
    expect(refreshCalls).toEqual([]);
    // R33 (#509): the floor answers before the signal is asked
    expect(signalCalls).toEqual([]);
  });

  // #509: no session on a pair without a signal now, whatever door the request came from
  it('R28 a pair with no signal is 409 no_signal and writes no session', async () => {
    const seed = await seedReady();
    const before = await sessionCount();
    const response = await start(
      appWith({ signal: sessionSignalEvaluation('no_signal') }),
      bodyFor(seed),
    );
    await expectRefusal(response, 409, 'no_signal', before);
  });

  it.each(['rate_limited', 'unavailable'] as const)(
    'R29 a signal fetch_failed %s is 503 signal_unavailable and writes no session',
    async (code) => {
      const seed = await seedReady();
      const before = await sessionCount();
      const response = await start(
        appWith({ signal: { outcome: 'fetch_failed', code } as unknown as SignalEvaluation }),
        bodyFor(seed),
      );
      await expectRefusal(response, 503, 'signal_unavailable', before);
    },
  );

  it('R29 a signal feed that throws is 503 signal_unavailable, not a 500', async () => {
    const seed = await seedReady();
    const before = await sessionCount();
    const response = await start(
      appWith({ signal: () => Promise.reject(new TypeError('boom')) }),
      bodyFor(seed),
    );
    await expectRefusal(response, 503, 'signal_unavailable', before);
  });

  it("R30/R31 a signal starts; the feed is asked for the duration's candle and the pair's digits", async () => {
    const seed = await seedReady();
    // fixed: five martingale cycles of 300 s cannot fit the hour (#552)
    const response = await start(
      appWith({ stakeStrategy: SessionStakeStrategy.Fixed }),
      bodyFor(seed, { durationSec: 300 }),
    );
    expect(response.statusCode).toBe(201);
    expect(signalCalls).toEqual([{ assetId: ASSET, interval: '5m', digits: pair.digits }]);
  });

  // #568: the checked signal's direction is the session's first picture in the bot
  it.each([TradeAction.Down, TradeAction.Up])(
    'R34 a start on a %s signal writes it to the row and answers it in the view',
    async (action) => {
      const seed = await seedReady();
      const response = await start(
        appWith({ signal: sessionSignalEvaluation('signal', action) }),
        bodyFor(seed),
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

  it('R32 a signal without a balance snapshot is 409 balance_unavailable', async () => {
    const seed = await seedUserWithAccount(tmp.db);
    const before = await sessionCount();
    const response = await start(appWith({ refresh: () => Promise.resolve() }), bodyFor(seed));
    await expectRefusal(response, 409, 'balance_unavailable', before);
  });

  it('R32b no signal and no balance snapshot answers no_signal first', async () => {
    const seed = await seedUserWithAccount(tmp.db);
    const before = await sessionCount();
    const response = await start(
      appWith({
        refresh: () => Promise.resolve(),
        signal: sessionSignalEvaluation('no_signal'),
      }),
      bodyFor(seed),
    );
    await expectRefusal(response, 409, 'no_signal', before);
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
      durationSec: 60,
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
      version: 3,
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

  it('R41 writes v3 fixed under SESSION_STAKE_STRATEGY=fixed, and a later process leaves the row as it is', async () => {
    const seed = await seedReady();
    const response = await start(
      appWith({ stakeStrategy: SessionStakeStrategy.Fixed }),
      bodyFor(seed),
    );
    expect(response.statusCode).toBe(201);
    const session = sessionOf(response);
    expect(session.settings?.stake).toEqual({ strategy: 'fixed', baseStake: '1', stakeScale: 0 });

    await app?.close();
    const again = await read(
      appWith({ stakeStrategy: SessionStakeStrategy.Martingale }),
      session.id,
      seed.telegramUserId,
    );
    expect(again.statusCode).toBe(200);
    expect(sessionOf(again).settings).toEqual(session.settings);
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
    const target = appWith({ signal: sessionSignalEvaluation('signal', TradeAction.Up) });
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

// a session whose snapshot was written before its one trade settled
async function finishedSession(
  reason: TradingSessionStopReason = TradingSessionStopReason.Completed,
): Promise<SeededAccount & { sessionId: string }> {
  const seed = await seedUserWithAccount(tmp.db, { balance: 10n });
  const session = await seedTradingSession(tmp.db, seed.brokerAccountId);
  await snapshotFor(seed.brokerAccountId);
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

describe('POST /trading/sessions/:id/summary (#318)', () => {
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
    // the summary message is out: the card waits for it (#464)
    await tmp.db
      .update(tradingSessions)
      .set({ finalNoticeSentAt: sql`now()` })
      .where(eq(tradingSessions.id, session.id));
    return { ...seed, sessionId: session.id };
  };

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

  it('T2 a second id answers 200 and the first stays', async () => {
    const seed = await seedSession();
    const target = appWith();
    const body = { telegramUserId: seed.telegramUserId };
    expect((await record(target, seed.sessionId, { ...body, messageId: 41 })).statusCode).toBe(200);
    const second = await record(target, seed.sessionId, { ...body, messageId: 42 });
    expect(second.statusCode).toBe(200);
    expect(sessionOf(second).id).toBe(seed.sessionId);
    expect(await recordedOf(seed.sessionId)).toBe(41);
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

  it('T8 a row carries the owner, the message, the pair and started_at, oldest first', async () => {
    const target = appWith();
    const seeded = [];
    for (const startedAt of ['1999-01-02T00:00:00.000Z', '1999-01-01T00:00:00.000Z']) {
      const seed = await seedUserWithAccount(tmp.db);
      const session = await seedTradingSession(tmp.db, seed.brokerAccountId, {
        startedAt: new Date(startedAt),
      });
      await record(target, session.id, { telegramUserId: seed.telegramUserId, messageId: 9 });
      seeded.push({ id: session.id, telegramUserId: seed.telegramUserId, startedAt });
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

  it('T10 a record replacing the recorded message writes; the lost route refuses replacesMessageId', async () => {
    const seed = await seedSession();
    const target = appWith();
    const body = { telegramUserId: seed.telegramUserId };
    expect((await record(target, seed.sessionId, { ...body, messageId: 41 })).statusCode).toBe(200);
    const zero = await record(target, seed.sessionId, {
      ...body,
      messageId: 42,
      replacesMessageId: 0,
    });
    expect(zero.statusCode).toBe(400);
    expect(await recordedOf(seed.sessionId)).toBe(41);
    const replaced = await record(target, seed.sessionId, {
      ...body,
      messageId: 42,
      replacesMessageId: 41,
    });
    expect(replaced.statusCode).toBe(200);
    expect(sessionOf(replaced).id).toBe(seed.sessionId);
    expect(await recordedOf(seed.sessionId)).toBe(42);
    const lost = await target.inject({
      method: 'POST',
      url: `${TRADING_SESSIONS_PATH}/${seed.sessionId}${SESSION_STATUS_MESSAGE_LOST_SUFFIX}`,
      headers: auth,
      payload: { ...body, messageId: 42, replacesMessageId: 41 },
    });
    expect([lost.statusCode, (lost.json() as { error?: unknown }).error]).toEqual([
      400,
      'validation',
    ]);
    expect(await recordedOf(seed.sessionId)).toBe(42);
  });
});
