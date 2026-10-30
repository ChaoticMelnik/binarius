import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { asc, eq, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import pino from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createBrokerRestClient, TradeListStatus } from '@binarius/broker-rest';
import { MockTradeOutcome, startMockBroker, type MockBroker } from '@binarius/mock-broker';
import {
  AccountHaltReason,
  buildH1SessionSettings,
  decimalStringSchema,
  H1_R1_PARAMS,
  isClosedTrade,
  safeParseTradingSessionSettings,
  SessionStakeStrategy,
  SESSION_MAX_DURATION_MS,
  SESSION_NO_SIGNAL_CANDLES,
  sessionNoSignalTimeoutMs,
  TradeAction,
  TradeIntentFailureReason,
  TradeIntentStatus,
  TradeMode,
  TradingSessionStatus,
  TradingSessionStopReason,
  type BrokerUser,
  type DecimalString,
  normalizeDecimal,
} from '@binarius/shared';
import { until } from '@binarius/shared/testing';
import {
  applyBalanceEvent,
  brokerAccounts,
  brokerTrades,
  claimReconciling,
  createDb,
  createSessionIntent,
  createTradeIntent,
  listLinkedBrokerTradeIds,
  markIntentUnknown,
  millisecondsAgo,
  openTrading,
  readSessionHistory,
  readTradingSessionView,
  settleClosedTrades,
  startReconciling,
  stopTradingSession,
  takeIntent,
  tradeIntents,
  tradingSessions,
  upsertBalanceSnapshot,
  users,
  type Db,
} from '@binarius/db';
import {
  buildSessionSettingsV3,
  closeTradingSwitch,
  createTempDatabase,
  seedBrokerAccount,
  seedTradingSession,
  seedUser,
  sessionSettings,
  type TempDatabase,
} from '@binarius/db/testing';
import type { AccessTokenSource } from '../broker/access-token';
import { noTradeSessions } from '../broker/trade-session';
import type { BalanceCheck } from '../intents/balance-check';
import { processIntentJob } from '../intents/processor';
import { createReconciliationPass, processReconciliationJob } from '../intents/reconciliation';
import { createRestReconciler } from '../intents/rest-reconciler';
import { createSettlementCatchup } from '../intents/settlement-catchup';
import { sweepStaleSubmitting } from '../intents/sweeper';
import { createTradeCommandExecutor } from '../intents/trade-command-executor';
import type { PairsOutcome, PairsSource } from './backend';
import { TRADING_SESSION_HOLD_SLACK_MS, type SessionOrchestratorConfig } from './config';
import { createSessionOrchestrator } from './orchestrator';
import { eurUsd } from './testing';

// Since #835 every session the orchestrator runs is an H1 session (settings v5): it stops or holds
// it, the trades come from the backend's H1 driver (#707) - here from createSessionIntent directly.

const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for apps/trading-worker integration tests (see README → Test database)',
  );
}

let tmp: TempDatabase;
let broker: MockBroker;
beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
  broker = await startMockBroker();
});
afterAll(async () => {
  await broker.close();
  await tmp.drop();
});

// every tick scans every active session in this database, so a case's leftovers are stopped
afterEach(async () => {
  await tmp.db
    .update(tradingSessions)
    .set({
      status: TradingSessionStatus.Stopped,
      stopReason: TradingSessionStopReason.UserStopped,
      endedAt: sql`now()`,
    })
    .where(eq(tradingSessions.status, TradingSessionStatus.Active));
  await openTrading(tmp.db);
});

// One sink for the whole file: L1 reads every line the cases produced.
const lines: Record<string, unknown>[] = [];
const logger = pino(
  { level: 'debug' },
  { write: (line: string) => void lines.push(JSON.parse(line) as Record<string, unknown>) },
);
const linesOf = (sessionId: string) => lines.filter((line) => line.sessionId === sessionId);
const msgsOf = (sessionId: string) => linesOf(sessionId).map((line) => line.msg);
const DRIVER = 'trading session waits for the H1 driver';

const CONFIG: SessionOrchestratorConfig = {
  tickMs: 5_000,
  batchSize: 50,
  // a wall-clock deadline while the hold-backs run on the fake clock: kept under the 15 s ceiling of
  // `until` and the 20 s test timeout, far above what an attempt takes on a loaded host
  attemptTimeoutMs: 10_000,
  retryMs: 60_000,
  h1CheckMs: 5_000,
  holdSlackMs: TRADING_SESSION_HOLD_SLACK_MS,
  maxDurationMs: SESSION_MAX_DURATION_MS,
  noSignalCandles: SESSION_NO_SIGNAL_CANDLES,
};

// the orchestrator's clock: the hold-backs and the sizer read it, the sweeps read the database's
let clock = Date.now();
const now = () => clock;
const advance = (ms: number) => (clock += ms);

// the mock's AAPL takes 5 s trades
const h1Pair = (patch: Parameters<typeof eurUsd>[0] = {}) =>
  eurUsd({ id: 202, symbol: 'AAPL', minTimeframe: 5, payout: 94, ...patch });

const h1Settings = (
  cycles = 10,
  strategy: SessionStakeStrategy = SessionStakeStrategy.Martingale,
  assetId = 202,
) => {
  const built = buildH1SessionSettings({
    assetId,
    cycles,
    stake: { baseStake: decimalStringSchema.parse('1.00'), stakeScale: 2 },
    strategy,
  });
  if (!built.success) throw new Error('H1 fixture settings do not parse');
  return built.data;
};

const fresh = (pairs = [h1Pair()]): PairsOutcome => ({
  ok: true,
  catalog: { pairs, fetchedAt: clock, ageMs: 0, fresh: true },
});

type PairsAnswer = PairsOutcome | ((signal?: AbortSignal) => PairsOutcome | Promise<PairsOutcome>);

// a catalog source that counts its reads
function pairsOf(answer: PairsAnswer = fresh()) {
  const source: PairsSource & { calls: number } = {
    calls: 0,
    read: async (options) => {
      source.calls += 1;
      return typeof answer === 'function' ? answer(options?.signal) : answer;
    },
  };
  return source;
}

// a catalog read held until release(); an abort answers at once, as the backend client does
function gatedPairs() {
  let release = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  const pairs = pairsOf(
    (signal) =>
      new Promise<PairsOutcome>((resolve) => {
        void released.then(() => resolve(fresh()));
        signal?.addEventListener('abort', () =>
          resolve({ ok: false, reason: 'backend_unreachable' }),
        );
      }),
  );
  return { pairs, release };
}

function orchestratorOf({
  pairs = pairsOf(),
  db = tmp.db,
  config = {},
  clockOf = now,
  log = logger,
}: {
  pairs?: PairsSource;
  db?: Db;
  config?: Partial<SessionOrchestratorConfig>;
  clockOf?: () => number;
  log?: pino.Logger;
} = {}) {
  return createSessionOrchestrator({
    db,
    pairs,
    logger: log,
    config: { ...CONFIG, ...config },
    now: clockOf,
  });
}

// the statements a Db sends (#871: the tick's shape is a constant number of them)
function countingDb() {
  const statements: string[] = [];
  const db = createDb(tmp.pool, { logger: { logQuery: (query) => void statements.push(query) } });
  return { db, statements };
}

// a pool whose batch read (the one statement with unnest) first waits for `before`: a moment
// between the scan and the read
function hookedDb(before: () => Promise<void>) {
  const pool = new Pool({ connectionString: tmp.url });
  const query = pool.query.bind(pool) as (...args: unknown[]) => Promise<unknown>;
  (pool as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query = async (
    ...args
  ) => {
    const config = args[0];
    const text = typeof config === 'string' ? config : (config as { text?: string }).text;
    if (text?.includes('unnest(') === true) await before();
    return query(...args);
  };
  return { db: createDb(pool), end: () => pool.end() };
}

// the access token per account for the REST open; the executor is the production composition
const accessTokens = new Map<string, string>();
const rest = () => createBrokerRestClient({ baseUrl: broker.url });
const tokens: AccessTokenSource = {
  accessToken: (accountId) => {
    const accessToken = accessTokens.get(accountId);
    return Promise.resolve(
      accessToken === undefined
        ? { ok: false, reason: 'account_not_found' }
        : { ok: true, accessToken },
    );
  },
};
const executor = () =>
  createTradeCommandExecutor({ sessions: noTradeSessions, rest: rest(), tokens, logger });

let brokerUserId = 40_000;

const balance = (available: string) => ({
  available: available as DecimalString,
  held: '0.00' as DecimalString,
  total: available as DecimalString,
});

interface SeedOptions {
  tokens?: bigint;
  minTradeAmount?: string;
  demo?: string;
  real?: string;
  mode?: TradeMode;
  settings?: unknown;
  startedAt?: Date;
  snapshot?: boolean;
  // the user's users.trading_mode; the session's mode by default, so a real session's intents
  // pass the real-mode gate (#121)
  tradingMode?: TradeMode;
}

async function seedSession({
  tokens = 20n,
  minTradeAmount = '1.00',
  demo = '10000.00',
  real = '0.00',
  mode = TradeMode.Demo,
  settings = h1Settings(),
  startedAt,
  snapshot = true,
  tradingMode = mode,
}: SeedOptions = {}) {
  const id = ++brokerUserId;
  const accessToken = `session-token-${id}`;
  broker.users.register({
    id,
    accessToken,
    minTradeAmount,
    demo: { available: demo },
    real: { available: real },
  });
  const user = await seedUser(tmp.db, { balance: tokens, tradingMode });
  const brokerAccountId = await seedBrokerAccount(tmp.db, user.userId);
  accessTokens.set(brokerAccountId, accessToken);
  if (snapshot) {
    const brokerUser: BrokerUser = {
      id: String(id),
      level: { code: 'standard', rank: 1 },
      minTradeAmount: minTradeAmount as DecimalString,
      real: balance(real),
      demo: balance(demo),
    };
    await upsertBalanceSnapshot(tmp.db, { brokerAccountId, user: brokerUser, requested: false });
  }
  const session = await seedTradingSession(tmp.db, brokerAccountId, {
    settings,
    mode,
    ...(startedAt === undefined ? {} : { startedAt }),
  });
  return { ...user, brokerUserId: id, brokerAccountId, accessToken, session };
}
type Seed = Awaited<ReturnType<typeof seedSession>>;

// #327: a real session runs the same way as a demo one; the user is in the session's mode
const MODES = [TradeMode.Demo, TradeMode.Real] as const;

const intentsOf = (sessionId: string) =>
  tmp.db
    .select()
    .from(tradeIntents)
    .where(eq(tradeIntents.tradingSessionId, sessionId))
    .orderBy(asc(tradeIntents.createdAt), asc(tradeIntents.id));

const sessionRow = async (id: string) =>
  (await tmp.db.select().from(tradingSessions).where(eq(tradingSessions.id, id)))[0]!;

const stopOf = async (id: string) => {
  const row = await sessionRow(id);
  return { status: row.status, stopReason: row.stopReason };
};
const ACTIVE = { status: TradingSessionStatus.Active, stopReason: null };
const stoppedWith = (stopReason: TradingSessionStopReason) => ({
  status: TradingSessionStatus.Stopped,
  stopReason,
});

const reservedOf = async (userId: string) =>
  (await tmp.db.select({ v: users.tokenReserved }).from(users).where(eq(users.id, userId)))[0]!.v;

const processIntent = (intentId: string) =>
  processIntentJob(
    {
      db: tmp.db,
      executor: executor(),
      logger,
      config: {
        intentMaxAgeMs: 60_000,
        submitAckTimeoutMs: 10_000,
        staleSubmittingMs: 60_000,
        demoOnly: false,
      },
    },
    { intentId },
  );

// the mock closes the trade, the closed list is read and applied as the catch-up would
async function settle(
  seed: { brokerAccountId: string; accessToken: string },
  intentId: string,
  outcome: MockTradeOutcome = MockTradeOutcome.Win,
) {
  const [trade] = await tmp.db
    .select()
    .from(brokerTrades)
    .where(eq(brokerTrades.intentId, intentId));
  broker.trades.settle(Number(trade!.brokerTradeId), { outcome });
  const listed = await rest().listTrades(
    { accessToken: seed.accessToken },
    {
      status: TradeListStatus.Closed,
      isDemo: trade!.mode === TradeMode.Demo,
      limit: 50,
      offset: 0,
    },
  );
  await settleClosedTrades(tmp.db, {
    brokerAccountId: seed.brokerAccountId,
    trades: listed.filter(isClosedTrade),
  });
}

// the session's intent of `step` as the H1 driver creates it (createSessionIntent, #707)
async function driverIntent(
  seed: Seed,
  step: number,
  { amount = '1.00', submitDeadlineAt }: { amount?: string; submitDeadlineAt?: Date } = {},
) {
  const { intent } = await createSessionIntent(tmp.db, {
    sessionId: seed.session.id,
    step,
    telegramUserId: seed.telegramUserId,
    brokerAccountId: seed.brokerAccountId,
    mode: seed.session.mode,
    assetId: 202,
    amount: decimalStringSchema.parse(amount),
    action: TradeAction.Up,
    durationSec: 5,
    decision: null,
    ...(submitDeadlineAt === undefined ? {} : { submitDeadlineAt }),
  });
  return intent;
}

// one trade of the driver from its intent to its settlement
async function driverTrade(
  seed: Seed,
  step: number,
  outcome: MockTradeOutcome = MockTradeOutcome.Win,
  amount?: string,
) {
  const intent = await driverIntent(seed, step, amount === undefined ? {} : { amount });
  expect(await processIntent(intent.id)).toBe('accepted');
  await settle(seed, intent.id, outcome);
  return intent;
}

const demoBalance = (brokerAccountId: string, available: string) =>
  applyBalanceEvent(tmp.db, {
    brokerAccountId,
    mode: TradeMode.Demo,
    balance: balance(available),
  });

describe('the attempt and the sequence (#287)', () => {
  it.each(MODES)(
    "E1′ holds between the driver's five trades, then completes (%s)",
    async (mode) => {
      const seed = await seedSession({
        mode,
        real: '50.00',
        settings: h1Settings(5, SessionStakeStrategy.Fixed),
      });
      const startBalances = broker.users.get(seed.brokerUserId);
      const pairs = pairsOf();
      const orchestrator = orchestratorOf({ pairs });
      const driverLines = () => msgsOf(seed.session.id).filter((msg) => msg === DRIVER).length;

      for (let step = 1; step <= 5; step += 1) {
        await orchestrator.tick();
        expect(await stopOf(seed.session.id)).toEqual(ACTIVE);
        expect(driverLines()).toBe(step);
        const intent = await driverIntent(seed, step);
        // a live intent keeps the session out of the scan: no attempt until it ends
        advance(CONFIG.h1CheckMs);
        await orchestrator.tick();
        expect(driverLines()).toBe(step);
        expect(await processIntent(intent.id)).toBe('accepted');
        await settle(seed, intent.id);
        advance(CONFIG.h1CheckMs);
      }
      await orchestrator.tick();
      const row = await sessionRow(seed.session.id);
      expect(row).toMatchObject(stoppedWith(TradingSessionStopReason.Completed));
      expect(row.endedAt).not.toBeNull();
      expect((await intentsOf(seed.session.id)).map((intent) => intent.mode)).toEqual(
        Array(5).fill(mode),
      );
      // the broker's side: five trades of the session's mode, its balance moved by five wins
      expect(broker.trades.list(seed.brokerUserId).map((trade) => trade.is_demo)).toEqual(
        Array(5).fill(mode === TradeMode.Demo),
      );
      const endBalances = broker.users.get(seed.brokerUserId);
      const other = mode === TradeMode.Real ? TradeMode.Demo : TradeMode.Real;
      expect(endBalances[mode]).not.toEqual(startBalances[mode]);
      expect(endBalances[other]).toEqual(startBalances[other]);
      expect(
        (await readTradingSessionView(tmp.db, seed.session.id, seed.telegramUserId))?.trades,
      ).toMatchObject({ settled: 5, won: 5 });
      expect(pairs.calls).toBe(5);
      await orchestrator.stop();
    },
  );

  it.each(MODES)(
    'E6 a halted account stops the session before any backend call (%s)',
    async (mode) => {
      const seed = await seedSession({ mode, real: '50.00' });
      await tmp.db
        .update(brokerAccounts)
        .set({ tradingHalted: true, haltedReason: 'trade_mismatch' })
        .where(eq(brokerAccounts.id, seed.brokerAccountId));
      const pairs = pairsOf();
      const orchestrator = orchestratorOf({ pairs });
      await orchestrator.tick();
      expect(await stopOf(seed.session.id)).toEqual(
        stoppedWith(TradingSessionStopReason.ManualReview),
      );
      expect(pairs.calls).toBe(0);
      expect(linesOf(seed.session.id)).toContainEqual(
        expect.objectContaining({ level: 50, msg: 'trading session stopped for manual review' }),
      );
      await orchestrator.stop();
    },
  );

  it.each(MODES)(
    'E7 the deadline stops a session even while its intent is live (%s)',
    async (mode) => {
      const seed = await seedSession({
        mode,
        real: '50.00',
        startedAt: new Date(Date.now() - 61 * 60_000),
      });
      await driverIntent(seed, 1);
      const orchestrator = orchestratorOf();
      await orchestrator.tick();
      expect(await stopOf(seed.session.id)).toEqual(stoppedWith(TradingSessionStopReason.Timeout));
      expect(linesOf(seed.session.id)).toContainEqual(
        expect.objectContaining({ level: 40, msg: 'trading session stopped', reason: 'timeout' }),
      );
      await orchestrator.stop();
    },
  );

  it('E7b sessions past the deadline beyond the sweep cap are never attempted (review M1)', async () => {
    const startedAt = new Date(Date.now() - 61 * 60_000);
    const first = await seedSession({ startedAt });
    const second = await seedSession({ startedAt });
    const pairs = pairsOf();
    const orchestrator = orchestratorOf({ pairs, config: { batchSize: 1 } });
    await orchestrator.tick();
    expect(pairs.calls).toBe(0);
    // the capped sweep stopped one; the scan never listed the other, the next sweep stops it
    const statuses = [
      (await sessionRow(first.session.id)).status,
      (await sessionRow(second.session.id)).status,
    ].sort();
    expect(statuses).toEqual([TradingSessionStatus.Active, TradingSessionStatus.Stopped]);
    await orchestrator.tick();
    for (const seed of [first, second]) {
      expect(await stopOf(seed.session.id)).toEqual(stoppedWith(TradingSessionStopReason.Timeout));
    }
    await orchestrator.stop();
  });

  it('E7c′ a deadline that passes after the scan stops the session before its catalog read', async () => {
    const earlier = await seedSession();
    const later = await seedSession();
    // on the database clock: the deadline 1.5 s ahead, passing between the scan and the batch's
    // read (#871: the read is held until then), well inside the batch timeout
    await tmp.db
      .update(tradingSessions)
      .set({
        startedAt: sql`now() - make_interval(secs => ${(SESSION_MAX_DURATION_MS - 1_500) / 1000})`,
      })
      .where(eq(tradingSessions.id, later.session.id));
    const hooked = hookedDb(() =>
      until(
        'the later deadline on the database clock',
        async () =>
          (await readSessionHistory(tmp.db, later.session.id, {
            noSignalTimeoutMs: sessionNoSignalTimeoutMs(5),
            maxDurationMs: SESSION_MAX_DURATION_MS,
          }))!.expired,
      ),
    );
    const pairs = pairsOf();
    const orchestrator = orchestratorOf({ pairs, db: hooked.db });
    await orchestrator.tick();
    await hooked.end();
    // both were listed by the scan, so the stop below is the attempt's, not the sweep's
    expect(lines.filter((line) => line.msg === 'trading session tick').at(-1)).toMatchObject({
      runnable: 2,
      attempted: 2,
      held: 1,
      stopped: 1,
    });
    expect(pairs.calls).toBe(1);
    expect(await stopOf(earlier.session.id)).toEqual(ACTIVE);
    expect(await stopOf(later.session.id)).toEqual(stoppedWith(TradingSessionStopReason.Timeout));
    expect(linesOf(later.session.id)).toContainEqual(
      expect.objectContaining({ msg: 'trading session stopped', reason: 'timeout' }),
    );
    await orchestrator.stop();
  });

  it('E10′ stop() during an attempt ends it before the catalog answers and writes nothing', async () => {
    const seed = await seedSession();
    let answered = false;
    const pairs = pairsOf(
      (signal) =>
        new Promise<PairsOutcome>((resolve) => {
          const timer = setTimeout(() => {
            answered = true;
            resolve(fresh());
          }, 2_000);
          signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve({ ok: false, reason: 'backend_unreachable' });
          });
        }),
    );
    const orchestrator = orchestratorOf({ pairs });
    orchestrator.start();
    await until('the catalog read', () => pairs.calls === 1);
    await orchestrator.stop();
    expect(answered).toBe(false);
    expect(await sessionRow(seed.session.id)).toMatchObject({
      status: TradingSessionStatus.Active,
      lastDecisionAt: null,
    });
    expect(linesOf(seed.session.id).filter((line) => (line.level as number) >= 50)).toEqual([]);
  });

  it('E11′ a worker clock behind started_at still sizes the first stake: the session is held', async () => {
    const seed = await seedSession();
    clock = seed.session.startedAt.getTime() - 5_000;
    const orchestrator = orchestratorOf();
    await orchestrator.tick();
    expect(await stopOf(seed.session.id)).toEqual(ACTIVE);
    expect(msgsOf(seed.session.id)).toContain(DRIVER);
    expect(linesOf(seed.session.id).filter((line) => (line.level as number) >= 50)).toEqual([]);
    await orchestrator.stop();
  });
});

describe('the endings of an attempt (#287)', () => {
  it('E9a′ a real session is sized against the real balance', async () => {
    const funded = await seedSession({ mode: TradeMode.Real, real: '50.00', demo: '0.00' });
    const short = await seedSession({ mode: TradeMode.Real, real: '0.50', demo: '10000.00' });
    const orchestrator = orchestratorOf();
    await orchestrator.tick();
    expect(await stopOf(funded.session.id)).toEqual(ACTIVE);
    expect(msgsOf(funded.session.id)).toContain(DRIVER);
    expect(await stopOf(short.session.id)).toEqual(stoppedWith(TradingSessionStopReason.StakeStop));
    expect(linesOf(short.session.id)).toContainEqual(
      expect.objectContaining({
        msg: 'trading session stopped',
        stopReason: 'insufficient_balance',
      }),
    );
    await orchestrator.stop();
  });

  it.each<[string, SeedOptions, TradingSessionStopReason]>([
    ['settings that fail the schema', { settings: {} }, TradingSessionStopReason.InvalidSettings],
    ['no balance snapshot', { snapshot: false }, TradingSessionStopReason.BalanceUnavailable],
    [
      'a pair missing from the catalog',
      { settings: h1Settings(10, SessionStakeStrategy.Martingale, 999) },
      TradingSessionStopReason.PairUnavailable,
    ],
  ])('E9c %s stops the session', async (_label, options, reason) => {
    const seed = await seedSession(options);
    const orchestrator = orchestratorOf();
    await orchestrator.tick();
    expect(await stopOf(seed.session.id)).toEqual(stoppedWith(reason));
    expect(await intentsOf(seed.session.id)).toEqual([]);
    await orchestrator.stop();
  });

  // #835: the candle path is gone; an active v1-v3 row has no trader and stops before any read
  const v3 = () => {
    const built = buildSessionSettingsV3({
      assetId: 101,
      durationSec: 60,
      cycles: 2,
      stake: { baseStake: '1' as DecimalString, stakeScale: 2 },
      strategy: SessionStakeStrategy.Martingale,
    });
    if (!built.success) throw new Error('the v3 fixture settings fail the schema');
    return built.data;
  };
  it.each<[number, () => unknown]>([
    [1, () => sessionSettings()],
    [
      2,
      () => {
        const { assetId, durationSec, stake } = v3();
        return { version: 2, assetId, durationSec, trades: 2, stake };
      },
    ],
    [3, v3],
  ])(
    'V1 an active settings v%i row stops invalid_settings before any read',
    async (version, settings) => {
      const old = await seedSession({ settings: settings() });
      const pairs = pairsOf();
      const orchestrator = orchestratorOf({ pairs });
      await orchestrator.tick();
      expect(await stopOf(old.session.id)).toEqual(
        stoppedWith(TradingSessionStopReason.InvalidSettings),
      );
      expect(linesOf(old.session.id)).toContainEqual(
        expect.objectContaining({
          msg: 'trading session stopped',
          reason: 'invalid_settings',
          version,
        }),
      );
      expect(await intentsOf(old.session.id)).toEqual([]);
      expect(pairs.calls).toBe(0);
      // the contrast: an H1 row in the same orchestrator reads the catalog and is held
      const h1 = await seedSession();
      advance(CONFIG.h1CheckMs);
      await orchestrator.tick();
      expect(await stopOf(h1.session.id)).toEqual(ACTIVE);
      expect(msgsOf(h1.session.id)).toContain(DRIVER);
      expect(pairs.calls).toBe(1);
      await orchestrator.stop();
    },
  );

  it('E9e′ a closed pair holds the session until it opens', async () => {
    const seed = await seedSession();
    const pairs = pairsOf(fresh([h1Pair({ scheduledUntil: clock + 30_000 })]));
    const orchestrator = orchestratorOf({ pairs });
    await orchestrator.tick();
    expect(msgsOf(seed.session.id)).toContain('trading session waits for the pair to open');
    advance(25_000);
    await orchestrator.tick();
    expect(pairs.calls).toBe(1);
    advance(5_000);
    await orchestrator.tick();
    expect(pairs.calls).toBe(2);
    expect(msgsOf(seed.session.id)).toContain(DRIVER);
    expect(await stopOf(seed.session.id)).toEqual(ACTIVE);
    await orchestrator.stop();
  });

  it('E9f a stale or unavailable catalog holds the session, it does not stop it', async () => {
    const seed = await seedSession();
    const stale: PairsOutcome = {
      ok: true,
      catalog: { pairs: [h1Pair()], fetchedAt: clock, ageMs: 600_000, fresh: false },
    };
    let orchestrator = orchestratorOf({ pairs: pairsOf(stale) });
    await orchestrator.tick();
    await orchestrator.stop();
    orchestrator = orchestratorOf({ pairs: pairsOf({ ok: false, reason: 'catalog_unavailable' }) });
    await orchestrator.tick();
    await orchestrator.stop();
    expect(await stopOf(seed.session.id)).toEqual(ACTIVE);
    expect(
      msgsOf(seed.session.id).filter((m) => m === 'trading session pairs unavailable'),
    ).toHaveLength(2);
    expect(msgsOf(seed.session.id)).not.toContain(DRIVER);
  });
});

describe('the kill switch (#144, #287)', () => {
  it.each(MODES)(
    'K1 a closed switch stops the session before any backend call (%s)',
    async (mode) => {
      const seed = await seedSession({ mode, real: '50.00' });
      await closeTradingSwitch(tmp.db);
      const pairs = pairsOf();
      const orchestrator = orchestratorOf({ pairs });
      await orchestrator.tick();
      expect(await stopOf(seed.session.id)).toEqual(
        stoppedWith(TradingSessionStopReason.KillSwitch),
      );
      expect(pairs.calls).toBe(0);
      expect(linesOf(seed.session.id)).toContainEqual(
        expect.objectContaining({
          level: 40,
          msg: 'trading session stopped',
          reason: 'kill_switch',
        }),
      );
      await orchestrator.stop();
    },
  );
});

describe('failures that write no ending (#287)', () => {
  const failed = (msg: string) => lines.filter((line) => line.msg === msg).length;

  it('F1′ a throw in the pairs source fails the tick: last_decision_at stays, nothing is held back (#871)', async () => {
    const seed = await seedSession();
    const pairs = pairsOf(() => {
      throw new Error('stub failure');
    });
    const before = failed('trading session tick failed');
    const orchestrator = orchestratorOf({ pairs });
    await orchestrator.tick();
    expect(failed('trading session tick failed')).toBe(before + 1);
    expect((await sessionRow(seed.session.id)).lastDecisionAt).toBeNull();
    await orchestrator.tick();
    expect(pairs.calls).toBe(2);
    await orchestrator.stop();
  });

  it('T1 a batch past its deadline is cut: nothing written, nothing held back (#871)', async () => {
    const seed = await seedSession();
    // ignores its signal: only the race ends the wait
    const pairs = pairsOf(() => new Promise<PairsOutcome>(() => {}));
    const before = failed('trading session batch timed out');
    const orchestrator = orchestratorOf({ pairs, config: { attemptTimeoutMs: 100 } });
    await orchestrator.tick();
    expect(failed('trading session batch timed out')).toBe(before + 1);
    expect(lines.filter((line) => line.msg === 'trading session batch timed out').at(-1)).toEqual(
      expect.objectContaining({ level: 40, runnable: 1, ms: expect.any(Number) }),
    );
    expect((await sessionRow(seed.session.id)).lastDecisionAt).toBeNull();
    await orchestrator.tick();
    expect(pairs.calls).toBe(2);
    await orchestrator.stop();
  });

  it('a database failure fails the tick, not the process', async () => {
    const pool = new Pool({ connectionString: tmp.url });
    await pool.end();
    const orchestrator = orchestratorOf({ db: createDb(pool) });
    await orchestrator.tick();
    expect(lines).toContainEqual(
      expect.objectContaining({ level: 50, msg: 'trading session tick failed' }),
    );
    await orchestrator.stop();
  });
});

// #871: one batch per tick - one batched read, one pairs GET, one write per kind
describe("the tick's batch (#871)", () => {
  const ticks = () => lines.filter((line) => line.msg === 'trading session tick');

  it('P1 one catalog read per tick, none on a tick without a session at the pair step', async () => {
    const seeds = [await seedSession(), await seedSession(), await seedSession()];
    const pairs = pairsOf();
    const orchestrator = orchestratorOf({ pairs });
    await orchestrator.tick();
    expect(pairs.calls).toBe(1);
    for (const seed of seeds) {
      expect(msgsOf(seed.session.id).filter((msg) => msg === DRIVER)).toHaveLength(1);
    }
    // all three held for h1CheckMs: nothing runnable, no GET
    await orchestrator.tick();
    expect(ticks().at(-1)).toMatchObject({ runnable: 0 });
    expect(pairs.calls).toBe(1);
    await orchestrator.stop();
  });

  it('P2 an unavailable catalog holds the sessions at the pair step; a stop by the history lands in the same tick', async () => {
    const done = await seedSession({ settings: h1Settings(1, SessionStakeStrategy.Fixed) });
    await driverTrade(done, 1);
    const waiting = await seedSession();
    const pairs = pairsOf({ ok: false, reason: 'catalog_unavailable' });
    const orchestrator = orchestratorOf({ pairs });
    await orchestrator.tick();
    expect(pairs.calls).toBe(1);
    expect(await stopOf(done.session.id)).toEqual(stoppedWith(TradingSessionStopReason.Completed));
    expect(msgsOf(done.session.id)).not.toContain('trading session pairs unavailable');
    expect(await stopOf(waiting.session.id)).toEqual(ACTIVE);
    expect(msgsOf(waiting.session.id)).toContain('trading session pairs unavailable');
    // held retryMs: the next tick does not try it again
    advance(CONFIG.tickMs);
    await orchestrator.tick();
    expect(pairs.calls).toBe(1);
    await orchestrator.stop();
  });

  it('S1 two sessions that complete in one tick are stopped by one statement', async () => {
    const seeds = [
      await seedSession({ settings: h1Settings(1, SessionStakeStrategy.Fixed) }),
      await seedSession({ settings: h1Settings(1, SessionStakeStrategy.Fixed) }),
    ];
    for (const seed of seeds) await driverTrade(seed, 1);
    const { db, statements } = countingDb();
    const orchestrator = orchestratorOf({ db });
    await orchestrator.tick();
    for (const seed of seeds) {
      expect(await stopOf(seed.session.id)).toEqual(
        stoppedWith(TradingSessionStopReason.Completed),
      );
      expect(msgsOf(seed.session.id)).toContain('trading session completed');
    }
    // three sweeps, the scan, the batch's two reads, one stop; no mark and no touch
    expect(statements).toHaveLength(7);
    await orchestrator.stop();
  });

  it('N1 3 000 sessions are decided in one tick of eight statements and one catalog read', async () => {
    const N = 3_000;
    // one statement per table, the columns of seedUser/seedBrokerAccount and a REST snapshot
    await tmp.db.execute(
      sql`insert into users (telegram_user_id, token_balance, status)
          select 7000000000 + g, 20, 'active' from generate_series(1, ${N}) g`,
    );
    await tmp.db.execute(
      sql`insert into broker_accounts (user_id, broker_user_id, access_token_enc, refresh_token_enc,
            token_key_id, access_token_expires_at, status)
          select id, 'n1-' || telegram_user_id, decode('00', 'hex'), decode('00', 'hex'), 'k1',
            now() + interval '1 hour', 'active'
            from users where telegram_user_id between 7000000001 and ${7_000_000_000 + N}`,
    );
    await tmp.db.execute(
      sql`insert into broker_balance_snapshots (broker_account_id, real_available, real_held,
            real_total, demo_available, demo_held, demo_total, min_trade_amount, level_code,
            level_rank, rest_observed_at)
          select id, 0, 0, 0, 10000, 0, 10000, 1, 'standard', 1, now()
            from broker_accounts where broker_user_id like 'n1-%'`,
    );
    await tmp.db.execute(
      sql`insert into trading_sessions (broker_account_id, mode, settings)
          select id, 'demo', ${JSON.stringify(h1Settings())}::jsonb
            from broker_accounts where broker_user_id like 'n1-%'`,
    );
    const { db, statements } = countingDb();
    const pairs = pairsOf();
    const orchestrator = orchestratorOf({ db, pairs, config: { batchSize: N } });
    await orchestrator.tick();
    // three sweeps, the scan, the batch's two reads, one decision mark, one balance touch
    expect(statements).toHaveLength(8);
    expect(pairs.calls).toBe(1);
    expect(ticks().at(-1)).toMatchObject({ runnable: N, attempted: N, held: N, stopped: 0 });
    const [undecided] = await tmp.db
      .select({ n: sql<number>`count(*)::int` })
      .from(tradingSessions)
      .where(
        sql`${tradingSessions.status} = 'active' and ${tradingSessions.lastDecisionAt} is null`,
      );
    expect(undecided!.n).toBe(0);
    await orchestrator.stop();
  });
});

// A worker restart, built in process (#131): "the dead worker" is orchestrator A plus the database
// writes it made before dying; "the new worker" is a new orchestrator, pass and catch-up over the
// same database. The crash state is written step by step, not produced by killing a running job.
// The check after an outcome (#92) never changes it; its own suite is balance-check.db.test.ts.
const balanceCheck: BalanceCheck = { check: () => Promise.resolve('not_compared') };
// the GET budget (#872) is not what this suite tests
const roomyBudget = () => ({ begin: () => true, end: () => undefined });
const restReconcilerOf = () =>
  createRestReconciler({
    rest: rest(),
    tokens,
    linkedTradeIds: (brokerAccountId, brokerTradeIds) =>
      listLinkedBrokerTradeIds(tmp.db, { brokerAccountId, brokerTradeIds }),
    logger,
    config: { windowBeforeMs: 60_000, windowAfterMs: 90_000, pageSize: 50, maxPages: 2 },
  });
// one reconciler is one worker: its count of proven absences lives in its memory (#274)
const passOf = (reconciler = restReconcilerOf()) =>
  createReconciliationPass({
    db: tmp.db,
    reconciler,
    balanceCheck,
    budget: roomyBudget(),
    logger,
    config: {
      tickMs: 60_000,
      retryMs: 60_000,
      attemptTimeoutMs: 10_000,
      batchSize: 20,
      balanceCheckTimeoutMs: 1_000,
      attemptGets: 4,
      checkGets: 1,
    },
  });
const catchupOf = () =>
  createSettlementCatchup({
    db: tmp.db,
    rest: rest(),
    budget: roomyBudget(),
    tokens,
    logger,
    config: {
      tickMs: 60_000,
      graceMs: 5_000,
      batchSize: 20,
      pageSize: 50,
      maxPages: 2,
      attemptTimeoutMs: 10_000,
      stalledRetryMs: 60_000,
      attemptGets: 2,
    },
  });

async function runOnce(component: { tick(): Promise<void>; stop(): Promise<void> }) {
  await component.tick();
  await component.stop();
}

const processNow = (intentId: string) =>
  processIntentJob(
    {
      db: tmp.db,
      executor: executor(),
      logger,
      config: {
        intentMaxAgeMs: 60_000,
        submitAckTimeoutMs: 10_000,
        staleSubmittingMs: 0,
        demoOnly: false,
      },
    },
    { intentId },
  );

// asked of the broker, not of our rows: "no second trade" is what the broker holds
async function brokerTradeCount(accessToken: string, isDemo = true) {
  let count = 0;
  for (const status of [TradeListStatus.Open, TradeListStatus.Closed]) {
    const trades = await rest().listTrades(
      { accessToken },
      { status, isDemo, limit: 50, offset: 0 },
    );
    count += trades.length;
  }
  return count;
}

const ageSubmitted = (id: string, seconds: number) =>
  tmp.db
    .update(tradeIntents)
    .set({ submittedAt: millisecondsAgo(seconds * 1000) })
    .where(eq(tradeIntents.id, id));
const ageCreated = (id: string, seconds: number) =>
  tmp.db
    .update(tradeIntents)
    .set({ createdAt: millisecondsAgo(seconds * 1000) })
    .where(eq(tradeIntents.id, id));
const ageClaim = (id: string, seconds: number) =>
  tmp.db
    .update(tradeIntents)
    .set({ reconcileClaimedAt: millisecondsAgo(seconds * 1000) })
    .where(eq(tradeIntents.id, id));
// as settlement-catchup.db.test.ts does: the trade's expiry an hour behind the database clock
const overdueTrade = (intentId: string) =>
  tmp.db
    .update(brokerTrades)
    .set({ openTimestampMs: sql`(extract(epoch from now()) * 1000)::bigint - 3600000` })
    .where(eq(brokerTrades.intentId, intentId));
const intentRow = async (id: string) =>
  (await tmp.db.select().from(tradeIntents).where(eq(tradeIntents.id, id)))[0]!;

// the dead worker's take and its order at the broker, with the intent's own terms
async function crashAfterOpen(accessToken: string, intentId: string) {
  const row = await intentRow(intentId);
  expect(
    await takeIntent(tmp.db, { id: intentId, expectedVersion: row.version, maxAgeMs: 60_000 }),
  ).toBeDefined();
  return rest().openTrade(
    { accessToken },
    {
      assetId: row.assetId,
      // the broker takes at most two decimals: the executor's normalization
      amount: decimalStringSchema.parse(normalizeDecimal(row.amount)),
      action: row.action,
      durationSec: row.durationSec,
      isDemo: row.mode === TradeMode.Demo,
    },
  );
}

describe('restart recovery (#131)', () => {
  // after its step's intent is resolved, the new worker's attempt holds the session for the driver
  const goesOn = async (seed: Seed, b: ReturnType<typeof orchestratorOf>) => {
    await b.tick();
    expect(await stopOf(seed.session.id)).toEqual(ACTIVE);
    expect(msgsOf(seed.session.id)).toContain(DRIVER);
  };

  it.each(['submitting', 'unknown', 'reconciling', 'claimed'] as const)(
    'R1′ crash at %s with the order at the broker: it settles, one trade, the session goes on',
    async (point) => {
      const seed = await seedSession();
      const step1 = await driverIntent(seed, 1);
      const trade = await crashAfterOpen(seed.accessToken, step1.id);
      if (point !== 'submitting') {
        await tmp.db.transaction((tx) =>
          markIntentUnknown(tx, {
            id: step1.id,
            reason: TradeIntentFailureReason.StaleSubmitting,
            olderThanMs: 0,
          }),
        );
      }
      if (point === 'reconciling' || point === 'claimed') {
        const row = await intentRow(step1.id);
        expect(
          await startReconciling(tmp.db, { id: step1.id, expectedVersion: row.version }),
        ).toBeDefined();
      }
      if (point === 'claimed') {
        expect(await claimReconciling(tmp.db, { id: step1.id, retryMs: 60_000 })).toBeDefined();
      }
      broker.trades.settle(Number(trade.id), { outcome: MockTradeOutcome.Win });

      const b = orchestratorOf();
      await b.tick();
      // the live intent keeps the session out of the scan
      expect(msgsOf(seed.session.id)).not.toContain(DRIVER);
      if (point === 'submitting') expect(await processNow(step1.id)).toBe('stale_unknown');
      if (point === 'submitting' || point === 'unknown') {
        expect(await processReconciliationJob({ db: tmp.db, logger }, { intentId: step1.id })).toBe(
          'reconciling',
        );
      }
      await runOnce(passOf());
      if (point === 'claimed') {
        // the dead worker's claim is a lease: the new pass waits it out
        expect((await intentRow(step1.id)).status).toBe(TradeIntentStatus.Reconciling);
        await ageClaim(step1.id, 120);
        await runOnce(passOf());
      }
      expect((await intentRow(step1.id)).status).toBe(TradeIntentStatus.Settled);
      await goesOn(seed, b);
      expect(await intentsOf(seed.session.id)).toHaveLength(1);
      expect(await brokerTradeCount(seed.accessToken)).toBe(1);
      await b.stop();
    },
  );

  it('R1b the job redelivered to the new worker never resends the order', async () => {
    const seed = await seedSession();
    const step1 = await driverIntent(seed, 1);
    await crashAfterOpen(seed.accessToken, step1.id);
    expect(await processNow(step1.id)).toBe('stale_unknown');
    expect(await brokerTradeCount(seed.accessToken)).toBe(1);
  });

  async function crashInSubmitting(seed: Seed) {
    const step1 = await driverIntent(seed, 1);
    const row = await intentRow(step1.id);
    expect(
      await takeIntent(tmp.db, { id: step1.id, expectedVersion: row.version, maxAgeMs: 60_000 }),
    ).toBeDefined();
    await ageSubmitted(step1.id, 200);
    expect(
      await sweepStaleSubmitting(tmp.db, { olderThanMs: 60_000, limit: 50 }),
    ).toBeGreaterThanOrEqual(1);
    expect(await processReconciliationJob({ db: tmp.db, logger }, { intentId: step1.id })).toBe(
      'reconciling',
    );
    return step1;
  }

  const accountOf = async (id: string) =>
    (await tmp.db.select().from(brokerAccounts).where(eq(brokerAccounts.id, id)))[0]!;

  // #274: in demo two proven attempts release the reserve; real parks as before (R2r′)
  it('R2′ crash in submitting with nothing at the broker (demo): two passes a lease apart release the reserve, no halt, the session goes on', async () => {
    const seed = await seedSession();
    const step1 = await crashInSubmitting(seed);
    const r = restReconcilerOf();
    await runOnce(passOf(r));
    expect((await intentRow(step1.id)).status).toBe(TradeIntentStatus.Reconciling);
    await ageClaim(step1.id, 61);
    await runOnce(passOf(r));
    const after = await intentRow(step1.id);
    expect(after.status).toBe(TradeIntentStatus.Rejected);
    expect(after.lastError).toBe(TradeIntentFailureReason.ReconciliationNotFound);
    expect(await reservedOf(seed.userId)).toBe(0n);
    const account = await accountOf(seed.brokerAccountId);
    expect(account.tradingHalted).toBe(false);
    expect(account.haltedReason).toBeNull();
    expect(await brokerTradeCount(seed.accessToken)).toBe(0);

    const b = orchestratorOf();
    await goesOn(seed, b);
    expect(await intentsOf(seed.session.id)).toHaveLength(1);
    await b.stop();
  });

  it('R2r′ crash in submitting with nothing at the broker (real): manual_review, halt, the session stops', async () => {
    const seed = await seedSession({ mode: TradeMode.Real, real: '50.00', demo: '0.00' });
    const step1 = await crashInSubmitting(seed);
    await runOnce(passOf());
    const after = await intentRow(step1.id);
    expect(after.status).toBe(TradeIntentStatus.ManualReview);
    expect(after.lastError).toBe(TradeIntentFailureReason.ReconciliationNotFound);
    const account = await accountOf(seed.brokerAccountId);
    expect(account.tradingHalted).toBe(true);
    expect(account.haltedReason).toBe(AccountHaltReason.ReconciliationNotFound);

    const b = orchestratorOf();
    await b.tick();
    expect(await stopOf(seed.session.id)).toEqual(
      stoppedWith(TradingSessionStopReason.ManualReview),
    );
    expect(await intentsOf(seed.session.id)).toHaveLength(1);
    expect(await reservedOf(seed.userId)).toBe(1n);
    expect(await brokerTradeCount(seed.accessToken, false)).toBe(0);
    await b.stop();
  });

  it('R3′ a lost job delivered late expires; two in a row stop the session rejected_twice', async () => {
    const seed = await seedSession();
    for (let step = 1; step <= 2; step += 1) {
      const intent = await driverIntent(seed, step);
      await ageCreated(intent.id, 120);
      expect(await processIntent(intent.id)).toBe('expired');
      expect(await reservedOf(seed.userId)).toBe(0n);
    }
    const b = orchestratorOf();
    await b.tick();
    expect(await stopOf(seed.session.id)).toEqual(
      stoppedWith(TradingSessionStopReason.RejectedTwice),
    );
    expect(await brokerTradeCount(seed.accessToken)).toBe(0);
    await b.stop();
  });

  it('R4′ crash with an accepted intent: the catch-up settles it, the session goes on', async () => {
    const seed = await seedSession();
    const step1 = await driverIntent(seed, 1);
    expect(await processIntent(step1.id)).toBe('accepted');

    const b = orchestratorOf();
    await b.tick();
    expect(msgsOf(seed.session.id)).not.toContain(DRIVER);
    const [trade] = await tmp.db
      .select()
      .from(brokerTrades)
      .where(eq(brokerTrades.intentId, step1.id));
    broker.trades.settle(Number(trade!.brokerTradeId), { outcome: MockTradeOutcome.Loss });
    await overdueTrade(step1.id);
    await runOnce(catchupOf());
    expect((await intentRow(step1.id)).status).toBe(TradeIntentStatus.Settled);
    await goesOn(seed, b);
    expect(await intentsOf(seed.session.id)).toHaveLength(1);
    expect(await brokerTradeCount(seed.accessToken)).toBe(1);
    await b.stop();
  });

  it('R7′ a restart adds no limit: a session started 40 min ago with nothing done is held', async () => {
    const seed = await seedSession({ startedAt: new Date(Date.now() - 40 * 60_000) });
    const b = orchestratorOf();
    await goesOn(seed, b);
    await b.stop();
  });
});

// #450: the strategy and the limits come from the session's row, the default limits of a base
// stake of 1 at stakeScale 2 (docs/stake.md -> Defaults). The driver's stakes are the ones the
// sizer gives at the pair's payout; the attempt sizes the next one only for its stops.
describe('martingale (#450)', () => {
  const at = (payout: number) => orchestratorOf({ pairs: pairsOf(fresh([h1Pair({ payout })])) });
  const losses = async (seed: Seed, amounts: string[]) => {
    for (const [index, amount] of amounts.entries()) {
      await driverTrade(seed, index + 1, MockTradeOutcome.Loss, amount);
    }
  };
  const expectStopped = async (
    seed: Seed,
    stopReason: TradingSessionStopReason,
    sizerCode: string,
  ) => {
    expect(await stopOf(seed.session.id)).toEqual(stoppedWith(stopReason));
    expect(linesOf(seed.session.id)).toContainEqual(
      expect.objectContaining({ msg: 'trading session stopped', stopReason: sizerCode }),
    );
    expect(await reservedOf(seed.userId)).toBe(0n);
  };

  it('G3′ four losses in a row at 80 % stop it as max_steps_exceeded before a fifth stake', async () => {
    const seed = await seedSession({ settings: h1Settings(5) });
    await losses(seed, ['1.00', '2.25', '5.07', '11.40']);
    const orchestrator = at(80);
    await orchestrator.tick();
    await expectStopped(seed, TradingSessionStopReason.MaxStepsExceeded, 'max_steps_exceeded');
    await orchestrator.stop();
  });

  it('G4′ at 79 % the fourth stake would pass 20×B: max_session_loss_exceeded after three losses', async () => {
    const seed = await seedSession({ settings: h1Settings(5) });
    await losses(seed, ['1.00', '2.27', '5.14']);
    const orchestrator = at(79);
    await orchestrator.tick();
    await expectStopped(
      seed,
      TradingSessionStopReason.MaxSessionLossExceeded,
      'max_session_loss_exceeded',
    );
    await orchestrator.stop();
  });

  it('G5′ at 77 % the fourth stake would pass 12×B: max_stake_exceeded after three losses', async () => {
    const seed = await seedSession({ settings: h1Settings(5) });
    await losses(seed, ['1.00', '2.30', '5.29']);
    const orchestrator = at(77);
    await orchestrator.tick();
    await expectStopped(seed, TradingSessionStopReason.MaxStakeExceeded, 'max_stake_exceeded');
    await orchestrator.stop();
  });

  it("G6′ the worker's clock past the session's hour stops it as session_duration_exceeded", async () => {
    const seed = await seedSession({ settings: h1Settings(5) });
    // the database's deadline has not passed, so the scan still lists the session
    const late = seed.session.startedAt.getTime() + SESSION_MAX_DURATION_MS + 1_000;
    const orchestrator = orchestratorOf({ clockOf: () => late });
    await orchestrator.tick();
    await expectStopped(
      seed,
      TradingSessionStopReason.SessionDurationExceeded,
      'session_duration_exceeded',
    );
    await orchestrator.stop();
  });
});

describe('an H1 session (#670, #775)', () => {
  // a v4 row of #670, read-only since #775: a fixed stake, trades and a loss ceiling
  const v4Settings = (maxLoss: string) => {
    const parsed = safeParseTradingSessionSettings({
      version: 4,
      assetId: 202,
      durationSec: 5,
      trades: 10,
      stake: { strategy: 'fixed', baseStake: '1.00', stakeScale: 2 },
      signal: { kind: 'h1', params: { ...H1_R1_PARAMS }, entryDelaySec: 1, expirySec: 5 },
      maxLoss,
    });
    if (!parsed.success) throw new Error('v4 fixture settings do not parse');
    return parsed.data;
  };
  const pastNoSignalLimit = () => new Date(Date.now() - sessionNoSignalTimeoutMs(5) * 3);
  // a case that fails before its own stop() must not leave its ticks running into the next one
  const made: ReturnType<typeof orchestratorOf>[] = [];
  afterEach(async () => {
    await Promise.all(made.splice(0).map((orchestrator) => orchestrator.stop()));
  });
  const h1Orchestrator = (pairs: PairsSource = pairsOf()) => {
    const orchestrator = orchestratorOf({ pairs });
    made.push(orchestrator);
    return orchestrator;
  };
  const tokensOf = async (userId: string) => {
    const [row] = await tmp.db
      .select({ balance: users.tokenBalance, reserved: users.tokenReserved })
      .from(users)
      .where(eq(users.id, userId));
    const { rows } = await tmp.db.execute<{ n: number }>(
      sql`select count(*)::int as n from token_ledger where user_id = ${userId}`,
    );
    return { ...row, ledger: rows[0]!.n };
  };

  it('H1-O1 holds and moves last_decision_at', async () => {
    const seed = await seedSession();
    const orchestrator = h1Orchestrator();
    await orchestrator.tick();
    expect(await stopOf(seed.session.id)).toEqual(ACTIVE);
    expect(await intentsOf(seed.session.id)).toEqual([]);
    expect((await sessionRow(seed.session.id)).lastDecisionAt).not.toBeNull();
    expect(linesOf(seed.session.id)).toContainEqual(
      expect.objectContaining({ level: 20, msg: DRIVER }),
    );
    await orchestrator.stop();
  });

  it('H1-O2 completes by cycles: under martingale only a win closes one', async () => {
    const seed = await seedSession({ settings: h1Settings(2) });
    await driverTrade(seed, 1, MockTradeOutcome.Win);
    const orchestrator = h1Orchestrator();
    await orchestrator.tick();
    expect(await stopOf(seed.session.id)).toEqual(ACTIVE);
    await driverTrade(seed, 2, MockTradeOutcome.Loss);
    advance(CONFIG.h1CheckMs);
    await orchestrator.tick();
    expect(await stopOf(seed.session.id)).toEqual(ACTIVE);
    await driverTrade(seed, 3, MockTradeOutcome.Win);
    advance(CONFIG.h1CheckMs);
    await orchestrator.tick();
    expect(await stopOf(seed.session.id)).toEqual(stoppedWith(TradingSessionStopReason.Completed));
    expect(linesOf(seed.session.id)).toContainEqual(
      expect.objectContaining({ msg: 'trading session completed', settled: 3, cycles: 2 }),
    );
    await orchestrator.stop();
  });

  it('H1-O2b under fixed every trade is a cycle: two losses complete two cycles', async () => {
    const seed = await seedSession({ settings: h1Settings(2, SessionStakeStrategy.Fixed) });
    await driverTrade(seed, 1, MockTradeOutcome.Loss);
    await driverTrade(seed, 2, MockTradeOutcome.Loss);
    const orchestrator = h1Orchestrator();
    await orchestrator.tick();
    expect(await stopOf(seed.session.id)).toEqual(stoppedWith(TradingSessionStopReason.Completed));
    await orchestrator.stop();
  });

  // the mock broker has no tie: a won trade's stored profit is set to the live broker's tie, 0
  it('H1-O2c a tie does not close the cycle: one cycle ends on the win after it', async () => {
    const seed = await seedSession({ settings: h1Settings(1) });
    await driverTrade(seed, 1, MockTradeOutcome.Loss);
    const tie = await driverTrade(seed, 2, MockTradeOutcome.Win);
    await tmp.db
      .update(brokerTrades)
      .set({ profit: '0.00000000' as DecimalString })
      .where(eq(brokerTrades.intentId, tie.id));
    const orchestrator = h1Orchestrator();
    await orchestrator.tick();
    expect(await stopOf(seed.session.id)).toEqual(ACTIVE);
    await driverTrade(seed, 3, MockTradeOutcome.Win);
    advance(CONFIG.h1CheckMs);
    await orchestrator.tick();
    expect(await stopOf(seed.session.id)).toEqual(stoppedWith(TradingSessionStopReason.Completed));
    await orchestrator.stop();
  });

  it("H1-O3′ the sizer's martingale limit stops it: max_session_loss_exceeded", async () => {
    const within = await seedSession();
    await driverTrade(within, 1, MockTradeOutcome.Loss);
    // a ceiling of 2: the raise after a loss of 1 takes the loss past it
    const tight = h1Settings();
    if (tight.version !== 5 || tight.stake.strategy !== SessionStakeStrategy.Martingale) {
      throw new Error('fixture: martingale v5');
    }
    const past = await seedSession({
      settings: {
        ...tight,
        stake: {
          ...tight.stake,
          limits: { ...tight.stake.limits, maxSessionLoss: decimalStringSchema.parse('2.00') },
        },
      },
    });
    await driverTrade(past, 1, MockTradeOutcome.Loss);
    const orchestrator = h1Orchestrator();
    await orchestrator.tick();
    expect(await stopOf(within.session.id)).toEqual(ACTIVE);
    expect(await stopOf(past.session.id)).toEqual(
      stoppedWith(TradingSessionStopReason.MaxSessionLossExceeded),
    );
    expect(linesOf(past.session.id)).toContainEqual(
      expect.objectContaining({ stopReason: 'max_session_loss_exceeded' }),
    );
    await orchestrator.stop();
  });

  it('H1-O4 the hour ends it with timeout', async () => {
    const seed = await seedSession({
      startedAt: new Date(Date.now() - SESSION_MAX_DURATION_MS - 60_000),
    });
    const orchestrator = h1Orchestrator();
    await orchestrator.tick();
    expect(await stopOf(seed.session.id)).toEqual(stoppedWith(TradingSessionStopReason.Timeout));
    await orchestrator.stop();
  });

  it.each([
    ['a pair outside the catalog', [eurUsd({ minTimeframe: 5 })]],
    ['a pair that refuses 5 s', [h1Pair({ minTimeframe: 15 })]],
  ])('H1-O5 %s stops it with pair_unavailable', async (_label, listed) => {
    const seed = await seedSession();
    const orchestrator = h1Orchestrator(pairsOf(fresh(listed)));
    await orchestrator.tick();
    expect(await stopOf(seed.session.id)).toEqual(
      stoppedWith(TradingSessionStopReason.PairUnavailable),
    );
    await orchestrator.stop();
  });

  it("H1-O5″ no intent within the no-signal limit on an open pair holds it: the stop is the driver's", async () => {
    const seed = await seedSession({ startedAt: pastNoSignalLimit() });
    const orchestrator = h1Orchestrator();
    await orchestrator.tick();
    expect(await stopOf(seed.session.id)).toEqual(ACTIVE);
    expect(linesOf(seed.session.id)).not.toContainEqual(
      expect.objectContaining({ reason: 'no_signal_timeout' }),
    );
    expect(msgsOf(seed.session.id)).toContain(DRIVER);
    // the hold of h1CheckMs: a tick inside it does not attempt the session again
    advance(CONFIG.h1CheckMs - CONFIG.holdSlackMs - 1);
    await orchestrator.tick();
    expect(msgsOf(seed.session.id).filter((msg) => msg === DRIVER)).toHaveLength(1);
    // the release's slack: a tick of the interval that reads the clock up to holdSlackMs early
    // still checks the session (#871, review round 1)
    advance(1);
    await orchestrator.tick();
    expect(msgsOf(seed.session.id).filter((msg) => msg === DRIVER)).toHaveLength(2);
    await orchestrator.stop();
  });

  it('H1-O6′ a pair closed past the no-signal limit stops it with no_signal_timeout; no token moves', async () => {
    const seed = await seedSession({ startedAt: pastNoSignalLimit() });
    const tokensBefore = await tokensOf(seed.userId);
    const orchestrator = h1Orchestrator(
      pairsOf(fresh([h1Pair({ scheduledUntil: clock + 30_000 })])),
    );
    await orchestrator.tick();
    expect(await stopOf(seed.session.id)).toEqual(
      stoppedWith(TradingSessionStopReason.NoSignalTimeout),
    );
    expect(linesOf(seed.session.id)).toContainEqual(
      expect.objectContaining({
        reason: 'no_signal_timeout',
        waited: 'pair_closed',
        limitMs: sessionNoSignalTimeoutMs(5),
      }),
    );
    // W5 (#509): a stop without an intent writes nothing to token_ledger or users
    expect(await tokensOf(seed.userId)).toEqual(tokensBefore);
    await orchestrator.stop();
  });

  it('H1-O7 an open pair with a payout below 94 still holds: the payout is not read', async () => {
    const seed = await seedSession();
    const orchestrator = h1Orchestrator(pairsOf(fresh([h1Pair({ payout: 50 })])));
    await orchestrator.tick();
    expect(await stopOf(seed.session.id)).toEqual(ACTIVE);
    await orchestrator.stop();
  });

  it('H1-O10 a v4 row runs with its fixed stake; its maxLoss is no longer a stop (#775)', async () => {
    const seed = await seedSession({ settings: v4Settings('1') });
    await driverTrade(seed, 1, MockTradeOutcome.Loss);
    const orchestrator = h1Orchestrator();
    await orchestrator.tick();
    expect(await stopOf(seed.session.id)).toEqual(ACTIVE);
    expect(msgsOf(seed.session.id)).toContain(DRIVER);
    await orchestrator.stop();
  });

  it('H1-O8 the sizer and the snapshot still stop it: the balance, the minimum, no snapshot', async () => {
    const poor = await seedSession({ demo: '0.50' });
    // E3 until #835: a base stake below the broker's minimum of 1.00
    const halfStake = buildH1SessionSettings({
      assetId: 202,
      cycles: 10,
      stake: { baseStake: decimalStringSchema.parse('0.50'), stakeScale: 2 },
      strategy: SessionStakeStrategy.Fixed,
    });
    if (!halfStake.success) throw new Error('H1 fixture settings do not parse');
    const small = await seedSession({ settings: halfStake.data });
    const blind = await seedSession({ snapshot: false });
    const orchestrator = h1Orchestrator();
    await orchestrator.tick();
    for (const [seed, stopReason] of [
      [poor, 'insufficient_balance'],
      [small, 'below_min_trade_amount'],
    ] as const) {
      expect(await stopOf(seed.session.id)).toEqual(
        stoppedWith(TradingSessionStopReason.StakeStop),
      );
      expect(linesOf(seed.session.id)).toContainEqual(
        expect.objectContaining({ level: 40, stopReason }),
      );
      expect(await reservedOf(seed.userId)).toBe(0n);
    }
    expect(await stopOf(blind.session.id)).toEqual(
      stoppedWith(TradingSessionStopReason.BalanceUnavailable),
    );
    await orchestrator.stop();
  });

  it('H1-O9 two intents rejected past their entry window stop it with rejected_twice', async () => {
    const seed = await seedSession();
    for (const step of [1, 2]) {
      const intent = await driverIntent(seed, step, {
        submitDeadlineAt: new Date(Date.now() - 1_000),
      });
      expect(await processIntent(intent.id)).toBe('rejected');
    }
    const orchestrator = h1Orchestrator();
    await orchestrator.tick();
    expect(await stopOf(seed.session.id)).toEqual(
      stoppedWith(TradingSessionStopReason.RejectedTwice),
    );
    await orchestrator.stop();
  });

  it('H1-BW a settlement newer than the balance holds the stake stop a tick; the payout clears it', async () => {
    const WAITS = 'trading session waits for the balance';
    const seed = await seedSession({ demo: '1.50' });
    const intent = await driverIntent(seed, 1);
    expect(await processIntent(intent.id)).toBe('accepted');
    // the snapshot after the opening holds the stake; the win settles before update_balance
    await demoBalance(seed.brokerAccountId, '0.50');
    await settle(seed, intent.id, MockTradeOutcome.Win);
    const orchestrator = h1Orchestrator();
    await orchestrator.tick();
    expect(await stopOf(seed.session.id)).toEqual(ACTIVE);
    expect(linesOf(seed.session.id).find((line) => line.msg === WAITS)).toMatchObject({
      level: 30,
      step: 2,
    });
    expect(msgsOf(seed.session.id)).not.toContain(DRIVER);
    advance(CONFIG.tickMs);
    await demoBalance(seed.brokerAccountId, '2.40');
    await orchestrator.tick();
    expect(await stopOf(seed.session.id)).toEqual(ACTIVE);
    expect(msgsOf(seed.session.id)).toContain(DRIVER);
    expect(msgsOf(seed.session.id).filter((msg) => msg === WAITS)).toHaveLength(1);
    await orchestrator.stop();
  });
});

describe('the wake after a write that ends an intent or halts its account (#696)', () => {
  // the tick line carries no session id: each case tags its orchestrator's lines
  const tagged = (wake: string) => logger.child({ wake });
  const ticksOf = (wake: string) =>
    lines.filter((line) => line.wake === wake && line.msg === 'trading session tick');
  // a case that fails before its own stop() must not leave its ticks running into the next one
  const made: ReturnType<typeof orchestratorOf>[] = [];
  const wakeful = (options: Parameters<typeof orchestratorOf>[0]) => {
    const orchestrator = orchestratorOf(options);
    made.push(orchestrator);
    return orchestrator;
  };
  afterEach(async () => {
    await Promise.all(made.splice(0).map((orchestrator) => orchestrator.stop()));
  });

  it('WK1′ a wake after the last settlement completes the session within a second, with no tick called', async () => {
    const seed = await seedSession({ settings: h1Settings(1, SessionStakeStrategy.Fixed) });
    const orchestrator = wakeful({ log: tagged('WK1') });
    await driverTrade(seed, 1);
    const wokenAt = Date.now();
    orchestrator.wake();
    await until(
      'the completed stop',
      async () => (await sessionRow(seed.session.id)).status === TradingSessionStatus.Stopped,
    );
    expect(Date.now() - wokenAt).toBeLessThan(1_000);
    expect(await stopOf(seed.session.id)).toEqual(stoppedWith(TradingSessionStopReason.Completed));
    await until('the tick line', () => ticksOf('WK1').length === 1);
    expect(ticksOf('WK1')).toEqual([
      expect.objectContaining({ runnable: 1, stopped: 1, woken: 1 }),
    ]);
    await orchestrator.stop();
  });

  it('WK2′ wakes during a tick merge into one more tick', async () => {
    const seed = await seedSession();
    const { pairs, release } = gatedPairs();
    const orchestrator = wakeful({ pairs, log: tagged('WK2') });
    const first = orchestrator.tick();
    await until('the catalog read', () => pairs.calls === 1);
    orchestrator.wake();
    orchestrator.wake();
    orchestrator.wake();
    release();
    await first;
    await until('the follow-up tick', () => ticksOf('WK2').length >= 2);
    await orchestrator.stop();
    expect(ticksOf('WK2')).toEqual([
      expect.objectContaining({ runnable: 1, attempted: 1, held: 1, woken: 0 }),
      // the hold of h1CheckMs keeps the session out of the scan
      expect.objectContaining({ runnable: 0, attempted: 0, woken: 3 }),
    ]);
    expect(pairs.calls).toBe(1);
    expect(msgsOf(seed.session.id).filter((msg) => msg === DRIVER)).toHaveLength(1);
  });

  it('WK3′ a lost wake loses nothing: the next tick completes the session', async () => {
    const seed = await seedSession({ settings: h1Settings(1, SessionStakeStrategy.Fixed) });
    const orchestrator = wakeful({ log: tagged('WK3') });
    await driverTrade(seed, 1);
    await orchestrator.tick();
    expect(await stopOf(seed.session.id)).toEqual(stoppedWith(TradingSessionStopReason.Completed));
    expect(ticksOf('WK3').at(-1)).toMatchObject({ stopped: 1, woken: 0 });
    await orchestrator.stop();
  });

  it('WK4a a wake after stop() is a no-op and does not throw', async () => {
    const seed = await seedSession();
    const orchestrator = wakeful({ log: tagged('WK4a') });
    await orchestrator.stop();
    expect(() => orchestrator.wake()).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(ticksOf('WK4a')).toEqual([]);
    expect((await sessionRow(seed.session.id)).lastDecisionAt).toBeNull();
  });

  it('WK4b′ a wake during a tick that stop() ends runs no deferred tick', async () => {
    const seed = await seedSession();
    const { pairs } = gatedPairs();
    const orchestrator = wakeful({
      pairs,
      log: tagged('WK4b'),
    });
    const first = orchestrator.tick();
    await until('the catalog read', () => pairs.calls === 1);
    orchestrator.wake();
    await orchestrator.stop();
    await first;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(ticksOf('WK4b')).toEqual([expect.objectContaining({ attempted: 1, woken: 0 })]);
    expect(pairs.calls).toBe(1);
    expect(await sessionRow(seed.session.id)).toMatchObject({
      status: TradingSessionStatus.Active,
      lastDecisionAt: null,
    });
  });

  it("WK6 a wake with an account attempts that account's sessions only (#871)", async () => {
    const orchestrator = wakeful({ log: tagged('WK6') });
    // the first tick is always full; the wake below comes inside a tick of it
    await orchestrator.tick();
    const a = await seedSession();
    const b = await seedSession();
    orchestrator.wake(a.brokerAccountId);
    await until('the woken tick', () => ticksOf('WK6').length === 2);
    expect(ticksOf('WK6')[1]).toEqual(
      expect.objectContaining({ runnable: 1, attempted: 1, woken: 1, accounts: 1 }),
    );
    expect(msgsOf(a.session.id)).toContain(DRIVER);
    expect(msgsOf(b.session.id)).not.toContain(DRIVER);
    expect((await sessionRow(b.session.id)).lastDecisionAt).toBeNull();
  });

  it('WK7 a woken tick runs no sweep; a tick a tick after the last full one is full (#871)', async () => {
    const b = await seedSession();
    const { db, statements } = countingDb();
    const orchestrator = wakeful({ db, log: tagged('WK7') });
    await orchestrator.tick();
    expect(await stopOf(b.session.id)).toEqual(ACTIVE);
    const a = await seedSession();
    await closeTradingSwitch(tmp.db);
    const before = statements.length;
    orchestrator.wake(a.brokerAccountId);
    await until('the woken tick', () => ticksOf('WK7').length === 2);
    // the scan, the batch's two reads, one decision mark, one balance touch
    expect(statements.length - before).toBe(5);
    expect(await stopOf(a.session.id)).toEqual(ACTIVE);
    expect(msgsOf(a.session.id)).toContain(DRIVER);
    advance(CONFIG.tickMs);
    orchestrator.wake(a.brokerAccountId);
    await until('the full tick', () => ticksOf('WK7').length === 3);
    for (const seed of [a, b]) {
      expect(await stopOf(seed.session.id)).toEqual(
        stoppedWith(TradingSessionStopReason.KillSwitch),
      );
    }
  });

  // a batch read held while `gate` is set: a moment inside a tick, after its scan
  const gatedDb = () => {
    const hold = {
      gate: undefined as Promise<void> | undefined,
      entered: false,
      release: () => {},
    };
    const hooked = hookedDb(async () => {
      if (hold.gate === undefined) return;
      hold.entered = true;
      await hold.gate;
    });
    const arm = () => {
      hold.gate = new Promise<void>((resolve) => (hold.release = resolve));
    };
    return { hooked, hold, arm };
  };

  it('WK8 a tick() during a woken tick over an account is a full tick right after it (#871, review round 1)', async () => {
    const { hooked, hold, arm } = gatedDb();
    try {
      const b = await seedSession();
      const orchestrator = wakeful({ db: hooked.db, log: tagged('WK8') });
      await orchestrator.tick();
      expect(msgsOf(b.session.id)).toContain(DRIVER);
      const a = await seedSession();
      await closeTradingSwitch(tmp.db);
      arm();
      // tickAt - lastFullAt = 0: a tick over A's account only
      orchestrator.wake(a.brokerAccountId);
      await until('the woken read', () => hold.entered);
      // what the interval's timer does
      const merged = orchestrator.tick();
      hold.release();
      await merged;
      const ticks = ticksOf('WK8');
      expect(ticks).toHaveLength(3);
      expect(ticks[1]).toEqual(expect.objectContaining({ runnable: 1, accounts: 1 }));
      expect(ticks[2]).toEqual(expect.objectContaining({ accounts: 0, woken: 0 }));
      // A was decided by the tick over its account, then both stopped by the full tick's sweep
      expect(msgsOf(a.session.id)).toContain(DRIVER);
      for (const seed of [a, b]) {
        expect(await stopOf(seed.session.id)).toEqual(
          stoppedWith(TradingSessionStopReason.KillSwitch),
        );
      }
      await orchestrator.stop();
    } finally {
      await hooked.end();
    }
  });

  it('WK9 a tick() during a full tick is served by it, as before #871', async () => {
    const { hooked, hold, arm } = gatedDb();
    try {
      await seedSession();
      const pairs = pairsOf();
      const orchestrator = wakeful({ db: hooked.db, pairs, log: tagged('WK9') });
      arm();
      const first = orchestrator.tick();
      await until('the read', () => hold.entered);
      const merged = orchestrator.tick();
      hold.release();
      await first;
      await merged;
      expect(ticksOf('WK9')).toHaveLength(1);
      expect(pairs.calls).toBe(1);
      await orchestrator.stop();
    } finally {
      await hooked.end();
    }
  });

  it('WK5 a wake with no runnable session, before start(), is one idle tick', async () => {
    const orchestrator = wakeful({ log: tagged('WK5') });
    orchestrator.wake();
    await until('the tick line', () => ticksOf('WK5').length === 1);
    expect(ticksOf('WK5')).toEqual([
      expect.objectContaining({ runnable: 0, attempted: 0, woken: 1 }),
    ]);
    await orchestrator.stop();
  });
});

describe('the balance wait after a settlement (#696)', () => {
  const LIMIT = sessionNoSignalTimeoutMs(5);
  const WAITS = 'trading session waits for the balance';
  // a case that fails before its own stop() must not leave its ticks running into the next one
  const made: ReturnType<typeof orchestratorOf>[] = [];
  const stoppable = (options?: Parameters<typeof orchestratorOf>[0]) => {
    const orchestrator = orchestratorOf(options);
    made.push(orchestrator);
    return orchestrator;
  };
  afterEach(async () => {
    await Promise.all(made.splice(0).map((orchestrator) => orchestrator.stop()));
  });
  // step 1 opened (the stake held: 1.50 - 1.00 on the snapshot), then won: the settlement is newer
  // than the snapshot, which still lacks the payout - the live order of close_trade.success and
  // update_balance
  const wonBeforePayout = async () => {
    const seed = await seedSession({ demo: '1.50' });
    const intent = await driverIntent(seed, 1);
    expect(await processIntent(intent.id)).toBe('accepted');
    await demoBalance(seed.brokerAccountId, '0.50');
    await settle(seed, intent.id, MockTradeOutcome.Win);
    return seed;
  };

  it('BW2′ a balance written after the settlement that is short stops the session', async () => {
    const orchestrator = stoppable();
    const seed = await wonBeforePayout();
    await demoBalance(seed.brokerAccountId, '0.50');
    await orchestrator.tick();
    expect(await stopOf(seed.session.id)).toEqual(stoppedWith(TradingSessionStopReason.StakeStop));
    expect(linesOf(seed.session.id)).toContainEqual(
      expect.objectContaining({
        msg: 'trading session stopped',
        stopReason: 'insufficient_balance',
      }),
    );
    expect(msgsOf(seed.session.id)).not.toContain(WAITS);
    await orchestrator.stop();
  });

  it('BW3′ past the no-signal limit counted from the settlement the short balance stops the session', async () => {
    const orchestrator = stoppable();
    const seed = await wonBeforePayout();
    // the settlement is aged past the limit and the snapshot further back, so the settlement stays
    // newer than the balance; an UPDATE without status runs no transition trigger
    await tmp.db.execute(
      sql`update trade_intents set updated_at = now() - (${LIMIT + 5_000}::int * interval '1 millisecond') where trading_session_id = ${seed.session.id}`,
    );
    await tmp.db.execute(
      sql`update broker_balance_snapshots set rest_observed_at = now() - (${2 * LIMIT}::int * interval '1 millisecond'), demo_event_at = now() - (${2 * LIMIT}::int * interval '1 millisecond') where broker_account_id = ${seed.brokerAccountId}`,
    );
    await orchestrator.tick();
    expect(await stopOf(seed.session.id)).toEqual(stoppedWith(TradingSessionStopReason.StakeStop));
    expect(linesOf(seed.session.id)).toContainEqual(
      expect.objectContaining({
        msg: 'trading session stopped',
        stopReason: 'insufficient_balance',
      }),
    );
    expect(msgsOf(seed.session.id)).not.toContain(WAITS);
    await orchestrator.stop();
  });

  it('BW4′ inside the hold a wake does not attempt again; after it the session is tried once more', async () => {
    const orchestrator = stoppable();
    const seed = await wonBeforePayout();
    orchestrator.wake();
    await until('the wait', () => msgsOf(seed.session.id).includes(WAITS));
    // the line is written before the hold is applied: the tick that wrote it may still run, and the
    // wake below must start a tick of its own (#716)
    await orchestrator.tick();
    const waits = () => msgsOf(seed.session.id).filter((msg) => msg === WAITS).length;
    orchestrator.wake();
    // single-flight: tick() returns the woken tick
    await orchestrator.tick();
    expect(waits()).toBe(1);
    advance(CONFIG.tickMs);
    await orchestrator.tick();
    expect(waits()).toBe(2);
    expect(await intentsOf(seed.session.id)).toHaveLength(1);
    await orchestrator.stop();
  });

  // another intent on the session's account in its mode, opened while the session is held out of
  // the scan by it, then won before the payout
  const oneOff = async () => {
    const seed = await seedSession({ demo: '1.50' });
    const { intent } = await createTradeIntent(tmp.db, {
      telegramUserId: seed.telegramUserId,
      mode: TradeMode.Demo,
      assetId: 101,
      amount: '1.00' as DecimalString,
      action: TradeAction.Up,
      durationSec: 60,
      clientRequestId: `bot-${seed.session.id}`,
    });
    return { seed, session: seed.session, intentId: intent.id };
  };
  const earlierSession = async () => {
    const seed = await seedSession({ demo: '1.50' });
    const intent = await driverIntent(seed, 1);
    await stopTradingSession(tmp.db, {
      id: seed.session.id,
      reason: TradingSessionStopReason.UserStopped,
    });
    const session = await seedTradingSession(tmp.db, seed.brokerAccountId, {
      settings: h1Settings(),
    });
    return { seed, session, intentId: intent.id };
  };

  it.each<[string, () => ReturnType<typeof oneOff>]>([
    ["a bot's one-off trade", oneOff],
    ['the intent an earlier session left live at its stop', earlierSession],
  ])(
    'BW5′ the settlement of %s on the account waits too, bounded from that settlement',
    async (_name, arrange) => {
      const orchestrator = stoppable();
      const { seed, session, intentId } = await arrange();
      // the session's own bound would have passed: it has no intent, and started long ago
      await tmp.db
        .update(tradingSessions)
        .set({ startedAt: sql`now() - (${LIMIT + 5_000}::int * interval '1 millisecond')` })
        .where(eq(tradingSessions.id, session.id));
      expect(await processIntent(intentId)).toBe('accepted');
      await demoBalance(seed.brokerAccountId, '0.50');
      await settle(seed, intentId, MockTradeOutcome.Win);
      orchestrator.wake();
      await until('the wait', () => msgsOf(session.id).includes(WAITS));
      // the line is written before the hold is applied: the tick that wrote it may still run
      // (#716, #871)
      await orchestrator.tick();
      expect(await stopOf(session.id)).toEqual(ACTIVE);
      advance(CONFIG.tickMs);
      await demoBalance(seed.brokerAccountId, '2.40');
      await orchestrator.tick();
      expect(await stopOf(session.id)).toEqual(ACTIVE);
      expect(msgsOf(session.id)).toContain(DRIVER);
      expect(await intentsOf(session.id)).toHaveLength(0);
      await orchestrator.stop();
    },
  );
});

// The msg table in docs/trading-session.md -> Logs is the contract: every row was produced by the
// cases above (a row marked "race" cannot be produced on demand), and no warn or error line
// carries a msg outside it.
describe('L1 the log lines (#287)', () => {
  const doc = readFileSync(
    fileURLToPath(new URL('../../../../docs/trading-session.md', import.meta.url)),
    'utf8',
  );
  const section = doc.slice(
    doc.indexOf('## Logs'),
    doc.indexOf('\n## ', doc.indexOf('## Logs') + 1),
  );
  const rows = [...section.matchAll(/^\| `([^`]+)` \| (\w+) \| ([^|]*)\|/gm)].map((m) => ({
    msg: m[1]!,
    level: m[2]!,
    race: m[3]!.includes('race'),
  }));

  it('matches the table', () => {
    expect(rows.length).toBeGreaterThan(10);
    const seen = new Set(lines.map((line) => line.msg));
    expect(rows.filter((row) => !row.race && !seen.has(row.msg)).map((row) => row.msg)).toEqual([]);
    const levels: Record<string, number> = { debug: 20, info: 30, warn: 40, error: 50 };
    const ours = lines.filter((line) => String(line.msg).startsWith('trading session'));
    const tickLines = new Set([
      'trading session tick',
      'trading session tick failed',
      'trading session batch timed out',
    ]);
    for (const line of ours.filter((l) => !tickLines.has(String(l.msg)))) {
      expect(line, String(line.msg)).toEqual(
        expect.objectContaining({
          sessionId: expect.any(String),
          brokerAccountId: expect.any(String),
        }),
      );
    }
    for (const line of ours) {
      const row = rows.find((r) => r.msg === line.msg);
      expect(row, String(line.msg)).toBeDefined();
      expect(levels[row!.level], String(line.msg)).toBe(line.level);
    }
  });

  it('carries no access token, URL or amount outside the sizer detail', () => {
    for (const line of lines.filter((l) => String(l.msg).startsWith('trading session'))) {
      const text = JSON.stringify({ ...line, detail: undefined });
      expect(text).not.toMatch(/session-token-|http:\/\/|127\.0\.0\.1/);
      expect(text).not.toMatch(/"amount"/);
    }
  });
});
