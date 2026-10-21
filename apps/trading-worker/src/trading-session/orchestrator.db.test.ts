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
  buildSessionSettings,
  decimalStringSchema,
  isClosedTrade,
  SessionStakeStrategy,
  SESSION_MAX_DURATION_MS,
  SESSION_NO_SIGNAL_CANDLES,
  sessionNoSignalTimeoutMs,
  SIGNAL_CHART_INTERVAL_MS,
  TradeAction,
  TradeIntentFailureReason,
  TradeIntentStatus,
  TradeMode,
  TradingSessionStatus,
  TradingSessionStopReason,
  type BrokerUser,
  type DecimalString,
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
  openTrading,
  readSessionHistory,
  readTradingSessionView,
  setTradingMode,
  settleClosedTrades,
  signalDecisions,
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
import {
  BackendUnavailable,
  type PairsOutcome,
  type PairsSource,
  type SignalOutcome,
  type SignalSource,
} from './backend';
import { TRADING_SESSION_CANDLE_SLACK_MS, type SessionOrchestratorConfig } from './config';
import { createSessionOrchestrator, pausedDirection } from './orchestrator';
import { eurUsd, fetchFailedAnswer, noSignalAnswer, RECORD_NOW_MS, signalAnswer } from './testing';

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

const CONFIG: SessionOrchestratorConfig = {
  tickMs: 5_000,
  batchSize: 50,
  attemptTimeoutMs: 2_000,
  retryMs: 60_000,
  candleSlackMs: 5_000,
  h1CheckMs: 5_000,
  maxDurationMs: SESSION_MAX_DURATION_MS,
  noSignalCandles: SESSION_NO_SIGNAL_CANDLES,
};

// the orchestrator's clock: the hold-backs and the sizer read it, the sweeps read the database's
let clock = Date.now();
const now = () => clock;
const advance = (ms: number) => (clock += ms);

const fresh = (pairs = [eurUsd()]): PairsOutcome => ({
  ok: true,
  catalog: { pairs, fetchedAt: clock, ageMs: 0, fresh: true },
});

type SignalAnswer =
  SignalOutcome | ((signal?: AbortSignal) => SignalOutcome | Promise<SignalOutcome>);

function signalsOf(answer: SignalAnswer = { ok: true, response: signalAnswer(TradeAction.Up) }) {
  const source: SignalSource & { calls: { assetId: number; interval: string }[] } = {
    calls: [],
    evaluate: async (request, options) => {
      source.calls.push(request);
      return typeof answer === 'function' ? answer(options?.signal) : answer;
    },
  };
  return source;
}

const pairsOf = (outcome: PairsOutcome = fresh()): PairsSource => ({
  read: () => Promise.resolve(outcome),
});

function orchestratorOf({
  signals = signalsOf(),
  pairs = pairsOf(),
  db = tmp.db,
  config = {},
  demoOnly = false,
  clockOf = now,
  log = logger,
}: {
  signals?: SignalSource;
  pairs?: PairsSource;
  db?: Db;
  config?: Partial<SessionOrchestratorConfig>;
  demoOnly?: boolean;
  clockOf?: () => number;
  log?: pino.Logger;
} = {}) {
  return createSessionOrchestrator({
    db,
    signals,
    pairs,
    logger: log,
    config: { ...CONFIG, ...config },
    demoOnly,
    now: clockOf,
  });
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
  settings = sessionSettings(),
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

// #327: a real session runs the same way as a demo one; the user is in the session's mode
const MODES = [TradeMode.Demo, TradeMode.Real] as const;

const intentsOf = (sessionId: string) =>
  tmp.db
    .select()
    .from(tradeIntents)
    .where(eq(tradeIntents.tradingSessionId, sessionId))
    .orderBy(asc(tradeIntents.createdAt), asc(tradeIntents.id));

// the session's trade log rows (#666), in recording order
const decisionsOf = (sessionId: string) =>
  tmp.db
    .select()
    .from(signalDecisions)
    .where(eq(signalDecisions.tradingSessionId, sessionId))
    .orderBy(asc(signalDecisions.recordedAt), asc(signalDecisions.id));

const sessionRow = async (id: string) =>
  (await tmp.db.select().from(tradingSessions).where(eq(tradingSessions.id, id)))[0]!;

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
        submitAckTimeoutMs: 2_000,
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

// one trade of the session from the tick to its settlement
async function tradeOnce(
  orchestrator: ReturnType<typeof orchestratorOf>,
  seed: { brokerAccountId: string; accessToken: string; session: { id: string } },
  outcome: MockTradeOutcome = MockTradeOutcome.Win,
) {
  await orchestrator.tick();
  const intents = await intentsOf(seed.session.id);
  const intent = intents.at(-1)!;
  expect(intent.status).toBe(TradeIntentStatus.Queued);
  expect(await processIntent(intent.id)).toBe('accepted');
  await settle(seed, intent.id, outcome);
  return intent;
}

describe('the attempt and the sequence (#287)', () => {
  it.each(MODES)('E1 trades five times one after another, then completes (%s)', async (mode) => {
    const seed = await seedSession({ mode, real: '50.00' });
    const startBalances = broker.users.get(seed.brokerUserId);
    const signals = signalsOf();
    const orchestrator = orchestratorOf({ signals });

    await orchestrator.tick();
    let intents = await intentsOf(seed.session.id);
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      status: TradeIntentStatus.Queued,
      amount: '1.00000000',
      action: TradeAction.Up,
      mode,
      clientRequestId: `session:${seed.session.id}:1`,
    });
    // a live intent holds the session: no second one, accepted or not
    await orchestrator.tick();
    expect(await processIntent(intents[0]!.id)).toBe('accepted');
    await orchestrator.tick();
    expect(await intentsOf(seed.session.id)).toHaveLength(1);
    await settle(seed, intents[0]!.id);

    for (let step = 2; step <= 5; step += 1) {
      const intent = await tradeOnce(orchestrator, seed);
      expect(intent.clientRequestId).toBe(`session:${seed.session.id}:${step}`);
    }
    intents = await intentsOf(seed.session.id);
    expect(intents.map((i) => i.status)).toEqual(Array(5).fill(TradeIntentStatus.Settled));
    expect((await sessionRow(seed.session.id)).status).toBe(TradingSessionStatus.Active);

    await orchestrator.tick();
    const row = await sessionRow(seed.session.id);
    expect(row).toMatchObject({
      status: TradingSessionStatus.Stopped,
      stopReason: TradingSessionStopReason.Completed,
    });
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
    expect(signals.calls).toEqual(Array(5).fill({ assetId: 101, interval: '1m' }));
    expect(lines.filter((line) => line.code === 'active_intent_exists')).toEqual([]);
    await orchestrator.stop();
  });

  // #313: the demo's short trades on 202 (the mock pair with min_timeframe 5), analysed on their
  // own sub-minute candle
  const aapl = eurUsd({ id: 202, symbol: 'AAPL', type: 'stock', minTimeframe: 5 });
  it.each([
    [5, '5s'],
    [15, '15s'],
  ])(
    'E1b a %i s session asks %s candles and trades step after step',
    async (durationSec, interval) => {
      const seed = await seedSession({
        settings: sessionSettings({ assetId: 202, durationSec, trades: 2 }),
      });
      const signals = signalsOf();
      const orchestrator = orchestratorOf({ signals, pairs: pairsOf(fresh([aapl])) });
      const first = await tradeOnce(orchestrator, seed);
      expect(first).toMatchObject({ assetId: 202, durationSec });
      const second = await tradeOnce(orchestrator, seed);
      expect(second.clientRequestId).toBe(`session:${seed.session.id}:2`);
      await orchestrator.tick();
      expect((await sessionRow(seed.session.id)).stopReason).toBe(
        TradingSessionStopReason.Completed,
      );
      expect(signals.calls).toEqual(Array(2).fill({ assetId: 202, interval }));
      await orchestrator.stop();
    },
  );

  it('E4b no_signal on a 5 s session waits for the next 5 s boundary plus the slack', async () => {
    const seed = await seedSession({ settings: sessionSettings({ assetId: 202, durationSec: 5 }) });
    const signals = signalsOf({ ok: true, response: noSignalAnswer() });
    const orchestrator = orchestratorOf({
      signals,
      pairs: pairsOf(fresh([aapl])),
      config: { candleSlackMs: TRADING_SESSION_CANDLE_SLACK_MS },
    });
    const step = 5_000;
    clock = Math.floor(Date.now() / step) * step + 1_000;
    await orchestrator.tick();
    expect(signals.calls).toEqual([{ assetId: 202, interval: '5s' }]);
    // the next boundary is 4 s away, plus the 2 s slack
    advance(5_900);
    await orchestrator.tick();
    expect(signals.calls).toHaveLength(1);
    advance(200);
    await orchestrator.tick();
    expect(signals.calls).toHaveLength(2);
    expect(await intentsOf(seed.session.id)).toEqual([]);
    await orchestrator.stop();
  });

  it('E2 a rejected trade is retried once; a second rejection in a row stops the session', async () => {
    // two trades planned: a rejected intent is neither a settled trade nor the end of the session
    const once = await seedSession({ settings: sessionSettings({ trades: 2 }) });
    const orchestrator = orchestratorOf();
    await orchestrator.tick();
    broker.rest.failNext('openTrade', { status: 400 });
    expect(await processIntent((await intentsOf(once.session.id))[0]!.id)).toBe('rejected');
    const second = await tradeOnce(orchestrator, once);
    expect(second.clientRequestId).toBe(`session:${once.session.id}:2`);
    await orchestrator.tick();
    expect((await sessionRow(once.session.id)).status).toBe(TradingSessionStatus.Active);
    expect((await intentsOf(once.session.id)).map((i) => i.clientRequestId)).toEqual([
      `session:${once.session.id}:1`,
      `session:${once.session.id}:2`,
      `session:${once.session.id}:3`,
    ]);

    const twice = await seedSession();
    await orchestrator.tick();
    for (let step = 1; step <= 2; step += 1) {
      const intents = await intentsOf(twice.session.id);
      broker.rest.failNext('openTrade', { status: 400 });
      expect(await processIntent(intents.at(-1)!.id)).toBe('rejected');
      await orchestrator.tick();
    }
    expect(await sessionRow(twice.session.id)).toMatchObject({
      status: TradingSessionStatus.Stopped,
      stopReason: TradingSessionStopReason.RejectedTwice,
    });
    expect(await intentsOf(twice.session.id)).toHaveLength(2);
    await orchestrator.stop();
  });

  it("E3 the sizer's stop ends the session with its code and no intent", async () => {
    const seed = await seedSession({
      settings: sessionSettings({ stake: { baseStake: '0.5' as DecimalString, stakeScale: 1 } }),
    });
    const orchestrator = orchestratorOf();
    await orchestrator.tick();
    expect(await sessionRow(seed.session.id)).toMatchObject({
      status: TradingSessionStatus.Stopped,
      stopReason: TradingSessionStopReason.StakeStop,
    });
    expect(await intentsOf(seed.session.id)).toEqual([]);
    expect(linesOf(seed.session.id)).toContainEqual(
      expect.objectContaining({ level: 40, stopReason: 'below_min_trade_amount' }),
    );
    expect(await reservedOf(seed.userId)).toBe(0n);
    await orchestrator.stop();
  });

  it('E4 no_signal waits for the next candle and moves last_decision_at', async () => {
    const seed = await seedSession();
    const signals = signalsOf({ ok: true, response: noSignalAnswer() });
    const orchestrator = orchestratorOf({ signals });
    const minute = 60_000;
    clock = Math.floor(Date.now() / minute) * minute + 10_000;
    await orchestrator.tick();
    expect(signals.calls).toHaveLength(1);
    expect((await sessionRow(seed.session.id)).lastDecisionAt).not.toBeNull();
    advance(30_000);
    await orchestrator.tick();
    expect(signals.calls).toHaveLength(1);
    // the next boundary is 50 s away, plus the 5 s slack
    advance(26_000);
    await orchestrator.tick();
    expect(signals.calls).toHaveLength(2);
    expect(await intentsOf(seed.session.id)).toEqual([]);
    await orchestrator.stop();
  });

  it('E5 fetch_failed holds for retryAfterSec, clamped to one tick; the backend down for retryMs', async () => {
    const seed = await seedSession();
    let signals = signalsOf({ ok: true, response: fetchFailedAnswer(7) });
    let orchestrator = orchestratorOf({ signals });
    await orchestrator.tick();
    advance(6_000);
    await orchestrator.tick();
    expect(signals.calls).toHaveLength(1);
    advance(2_000);
    await orchestrator.tick();
    expect(signals.calls).toHaveLength(2);
    await orchestrator.stop();

    signals = signalsOf({ ok: true, response: fetchFailedAnswer(0) });
    orchestrator = orchestratorOf({ signals });
    await orchestrator.tick();
    advance(1_000);
    await orchestrator.tick();
    expect(signals.calls).toHaveLength(1);
    advance(5_000);
    await orchestrator.tick();
    expect(signals.calls).toHaveLength(2);
    await orchestrator.stop();

    signals = signalsOf({ ok: false, reason: 'backend_unreachable' });
    orchestrator = orchestratorOf({ signals });
    const before = (await sessionRow(seed.session.id)).lastDecisionAt!;
    await orchestrator.tick();
    advance(59_000);
    await orchestrator.tick();
    expect(signals.calls).toHaveLength(1);
    advance(2_000);
    await orchestrator.tick();
    expect(signals.calls).toHaveLength(2);
    expect((await sessionRow(seed.session.id)).lastDecisionAt!.getTime()).toBeGreaterThan(
      before.getTime(),
    );
    expect(msgsOf(seed.session.id)).toContain('trading session signal unavailable');
    await orchestrator.stop();
  });

  it.each(MODES)(
    'E6 a halted account stops the session before any backend call (%s)',
    async (mode) => {
      const seed = await seedSession({ mode, real: '50.00' });
      await tmp.db
        .update(brokerAccounts)
        .set({ tradingHalted: true, haltedReason: 'trade_mismatch' })
        .where(eq(brokerAccounts.id, seed.brokerAccountId));
      const signals = signalsOf();
      const orchestrator = orchestratorOf({ signals });
      await orchestrator.tick();
      expect(await sessionRow(seed.session.id)).toMatchObject({
        status: TradingSessionStatus.Stopped,
        stopReason: TradingSessionStopReason.ManualReview,
      });
      expect(signals.calls).toHaveLength(0);
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
      await createSessionIntent(tmp.db, {
        sessionId: seed.session.id,
        step: 1,
        telegramUserId: seed.telegramUserId,
        brokerAccountId: seed.brokerAccountId,
        mode,
        assetId: 101,
        amount: '1' as DecimalString,
        action: TradeAction.Up,
        durationSec: 60,
        decision: null,
      });
      const orchestrator = orchestratorOf();
      await orchestrator.tick();
      expect(await sessionRow(seed.session.id)).toMatchObject({
        status: TradingSessionStatus.Stopped,
        stopReason: TradingSessionStopReason.Timeout,
      });
      expect(linesOf(seed.session.id)).toContainEqual(
        expect.objectContaining({ level: 40, msg: 'trading session stopped', reason: 'timeout' }),
      );
      await orchestrator.stop();
    },
  );

  it('E7b sessions past the deadline beyond the sweep cap get no trade (review M1)', async () => {
    const startedAt = new Date(Date.now() - 61 * 60_000);
    const first = await seedSession({ startedAt });
    const second = await seedSession({ startedAt });
    const signals = signalsOf();
    const orchestrator = orchestratorOf({ signals, config: { batchSize: 1 } });
    await orchestrator.tick();
    expect(await intentsOf(first.session.id)).toEqual([]);
    expect(await intentsOf(second.session.id)).toEqual([]);
    expect(signals.calls).toHaveLength(0);
    // the capped sweep stopped one; the scan never listed the other, the next sweep stops it
    const statuses = [
      (await sessionRow(first.session.id)).status,
      (await sessionRow(second.session.id)).status,
    ].sort();
    expect(statuses).toEqual([TradingSessionStatus.Active, TradingSessionStatus.Stopped]);
    await orchestrator.tick();
    for (const seed of [first, second]) {
      expect(await sessionRow(seed.session.id)).toMatchObject({
        status: TradingSessionStatus.Stopped,
        stopReason: TradingSessionStopReason.Timeout,
      });
    }
    await orchestrator.stop();
  });

  it('E7c a deadline that passes after the scan stops the session before any backend call', async () => {
    const earlier = await seedSession();
    const later = await seedSession();
    // on the database clock: the deadline 1.5 s ahead, passing while the first session's attempt
    // waits on the signal, well inside its attempt timeout
    await tmp.db
      .update(tradingSessions)
      .set({
        startedAt: sql`now() - make_interval(secs => ${(SESSION_MAX_DURATION_MS - 1_500) / 1000})`,
      })
      .where(eq(tradingSessions.id, later.session.id));
    const signals = signalsOf(async () => {
      await until(
        'the later deadline on the database clock',
        async () =>
          (await readSessionHistory(tmp.db, later.session.id, {
            noSignalTimeoutMs: sessionNoSignalTimeoutMs(60),
            maxDurationMs: SESSION_MAX_DURATION_MS,
          }))!.expired,
      );
      return { ok: true, response: signalAnswer(TradeAction.Up) };
    });
    const orchestrator = orchestratorOf({ signals, config: { attemptTimeoutMs: 5_000 } });
    await orchestrator.tick();
    // both were listed by the scan, so the stop below is the attempt's, not the sweep's
    expect(lines.filter((line) => line.msg === 'trading session tick').at(-1)).toMatchObject({
      runnable: 2,
      attempted: 2,
      created: 1,
      stopped: 1,
    });
    expect(signals.calls).toHaveLength(1);
    expect(await intentsOf(earlier.session.id)).toHaveLength(1);
    expect(await sessionRow(later.session.id)).toMatchObject({
      status: TradingSessionStatus.Stopped,
      stopReason: TradingSessionStopReason.Timeout,
    });
    expect(linesOf(later.session.id)).toContainEqual(
      expect.objectContaining({ msg: 'trading session stopped', reason: 'timeout' }),
    );
    expect(await intentsOf(later.session.id)).toEqual([]);
    await orchestrator.stop();
  });

  it('E8 a new orchestrator continues from the database: step 3 after two settled', async () => {
    const seed = await seedSession();
    const first = orchestratorOf();
    await tradeOnce(first, seed);
    await tradeOnce(first, seed);
    await first.stop();
    const second = orchestratorOf();
    await second.tick();
    const intents = await intentsOf(seed.session.id);
    expect(intents).toHaveLength(3);
    expect(intents[2]!.clientRequestId).toBe(`session:${seed.session.id}:3`);
    expect(
      lines.filter(
        (l) => l.sessionId === seed.session.id && l.msg === 'trading session step replayed',
      ),
    ).toEqual([]);
    await second.stop();
  });

  it('E10 stop() during an attempt ends it before the backend answers and writes nothing', async () => {
    const seed = await seedSession();
    let answered = false;
    const signals = signalsOf(
      (signal) =>
        new Promise<SignalOutcome>((resolve) => {
          const timer = setTimeout(() => {
            answered = true;
            resolve({ ok: true, response: signalAnswer(TradeAction.Up) });
          }, 2_000);
          signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve({ ok: false, reason: 'backend_unreachable' });
          });
        }),
    );
    const orchestrator = orchestratorOf({ signals, config: { attemptTimeoutMs: 5_000 } });
    orchestrator.start();
    await until('the signal call', () => signals.calls.length === 1);
    await orchestrator.stop();
    expect(answered).toBe(false);
    expect(await sessionRow(seed.session.id)).toMatchObject({
      status: TradingSessionStatus.Active,
      lastDecisionAt: null,
    });
    expect(await intentsOf(seed.session.id)).toEqual([]);
    expect(linesOf(seed.session.id).filter((line) => (line.level as number) >= 50)).toEqual([]);
  });

  it('E11 a worker clock behind started_at still sizes the first stake', async () => {
    const seed = await seedSession();
    clock = seed.session.startedAt.getTime() - 5_000;
    const orchestrator = orchestratorOf();
    await orchestrator.tick();
    expect(await intentsOf(seed.session.id)).toHaveLength(1);
    expect(linesOf(seed.session.id).filter((line) => (line.level as number) >= 50)).toEqual([]);
    await orchestrator.stop();
  });
});

describe('the endings of an attempt (#287)', () => {
  const stopsWith = async (sessionId: string, reason: TradingSessionStopReason) =>
    expect(await sessionRow(sessionId)).toMatchObject({
      status: TradingSessionStatus.Stopped,
      stopReason: reason,
    });

  it('E9a a real session is sized against the real balance', async () => {
    const seed = await seedSession({ mode: TradeMode.Real, real: '50.00', demo: '0.00' });
    const orchestrator = orchestratorOf();
    await orchestrator.tick();
    const intents = await intentsOf(seed.session.id);
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({ mode: TradeMode.Real, amount: '1.00000000' });
    await orchestrator.stop();
  });

  it('F1 DEMO_ONLY stops a real session as account_unavailable and creates nothing (#396)', async () => {
    const seed = await seedSession({ mode: TradeMode.Real, real: '50.00', demo: '0.00' });
    const orchestrator = orchestratorOf({ demoOnly: true });
    await orchestrator.tick();
    expect(await sessionRow(seed.session.id)).toMatchObject({
      status: TradingSessionStatus.Stopped,
      stopReason: TradingSessionStopReason.AccountUnavailable,
    });
    expect(await intentsOf(seed.session.id)).toEqual([]);
    expect(await reservedOf(seed.userId)).toBe(0n);
    expect(linesOf(seed.session.id)).toContainEqual(
      expect.objectContaining({
        msg: 'trading session stopped',
        reason: 'account_unavailable',
        code: 'demo_only',
      }),
    );
    await orchestrator.stop();
  });

  it('E9i a real session of a user in demo mode stops as account_unavailable (#121)', async () => {
    const seed = await seedSession({
      mode: TradeMode.Real,
      real: '50.00',
      demo: '0.00',
      tradingMode: TradeMode.Demo,
    });
    const orchestrator = orchestratorOf();
    await orchestrator.tick();
    expect(await sessionRow(seed.session.id)).toMatchObject({
      status: TradingSessionStatus.Stopped,
      stopReason: TradingSessionStopReason.AccountUnavailable,
    });
    expect(await intentsOf(seed.session.id)).toEqual([]);
    expect(await reservedOf(seed.userId)).toBe(0n);
    expect(linesOf(seed.session.id)).toContainEqual(
      expect.objectContaining({
        msg: 'trading session stopped',
        reason: 'account_unavailable',
        code: 'real_mode_off',
      }),
    );
    await orchestrator.stop();
  });

  // #327: the switch stops the session itself; the attempt's reserve then meets real_mode_off,
  // whose stop finds the row stopped already and logs nothing
  it('E9j a switch to demo during the attempt of a real session stops it as user_stopped', async () => {
    const seed = await seedSession({ mode: TradeMode.Real, real: '50.00', demo: '0.00' });
    const signals = signalsOf(async () => {
      await setTradingMode(tmp.db, BigInt(seed.telegramUserId), TradeMode.Demo);
      return { ok: true, response: signalAnswer(TradeAction.Up) };
    });
    const orchestrator = orchestratorOf({ signals });
    await orchestrator.tick();
    expect(signals.calls).toHaveLength(1);
    expect(await sessionRow(seed.session.id)).toMatchObject({
      status: TradingSessionStatus.Stopped,
      stopReason: TradingSessionStopReason.UserStopped,
    });
    expect(await intentsOf(seed.session.id)).toEqual([]);
    expect(await reservedOf(seed.userId)).toBe(0n);
    expect(msgsOf(seed.session.id)).not.toContain('trading session stopped');
    await orchestrator.stop();
  });

  it('F2 DEMO_ONLY leaves a demo session trading (#396)', async () => {
    const seed = await seedSession();
    const orchestrator = orchestratorOf({ demoOnly: true });
    await orchestrator.tick();
    const intents = await intentsOf(seed.session.id);
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({ mode: TradeMode.Demo, status: TradeIntentStatus.Queued });
    expect((await sessionRow(seed.session.id)).status).toBe(TradingSessionStatus.Active);
    await orchestrator.stop();
  });

  it('E9b a halt committed during the attempt stops it as manual_review', async () => {
    const seed = await seedSession();
    const signals = signalsOf(async () => {
      await tmp.db
        .update(brokerAccounts)
        .set({ tradingHalted: true, haltedReason: 'trade_mismatch' })
        .where(eq(brokerAccounts.id, seed.brokerAccountId));
      return { ok: true, response: signalAnswer(TradeAction.Up) };
    });
    const orchestrator = orchestratorOf({ signals });
    await orchestrator.tick();
    await stopsWith(seed.session.id, TradingSessionStopReason.ManualReview);
    expect(linesOf(seed.session.id)).toContainEqual(
      expect.objectContaining({ level: 50, code: 'account_halted' }),
    );
    expect(await intentsOf(seed.session.id)).toEqual([]);
    await orchestrator.stop();
  });

  it.each<[string, SeedOptions, TradingSessionStopReason]>([
    ['settings that fail v1', { settings: {} }, TradingSessionStopReason.InvalidSettings],
    ['no balance snapshot', { snapshot: false }, TradingSessionStopReason.BalanceUnavailable],
    ['a user without tokens', { tokens: 0n }, TradingSessionStopReason.AccountUnavailable],
    [
      'a pair missing from the catalog',
      { settings: sessionSettings({ assetId: 999 }) },
      TradingSessionStopReason.PairUnavailable,
    ],
  ])('E9c %s stops the session', async (_label, options, reason) => {
    const seed = await seedSession(options);
    const orchestrator = orchestratorOf();
    await orchestrator.tick();
    await stopsWith(seed.session.id, reason);
    expect(await intentsOf(seed.session.id)).toEqual([]);
    await orchestrator.stop();
  });

  it('E9d a pair that refuses the duration stops the session as pair_unavailable', async () => {
    const seed = await seedSession();
    const orchestrator = orchestratorOf({ pairs: pairsOf(fresh([eurUsd({ minTimeframe: 120 })])) });
    await orchestrator.tick();
    await stopsWith(seed.session.id, TradingSessionStopReason.PairUnavailable);
    expect(await intentsOf(seed.session.id)).toEqual([]);
    await orchestrator.stop();
  });

  it('E9e a closed pair holds the session until it opens', async () => {
    const seed = await seedSession();
    const signals = signalsOf();
    const pairs = pairsOf(fresh([eurUsd({ scheduledUntil: clock + 30_000 })]));
    const orchestrator = orchestratorOf({ signals, pairs });
    await orchestrator.tick();
    advance(25_000);
    await orchestrator.tick();
    expect(signals.calls).toHaveLength(0);
    advance(5_000);
    await orchestrator.tick();
    expect(signals.calls).toHaveLength(1);
    expect((await sessionRow(seed.session.id)).status).toBe(TradingSessionStatus.Active);
    await orchestrator.stop();
  });

  it('E9f a stale or unavailable catalog holds the session, it does not stop it', async () => {
    const seed = await seedSession();
    const signals = signalsOf();
    const stale: PairsOutcome = {
      ok: true,
      catalog: { pairs: [eurUsd()], fetchedAt: clock, ageMs: 600_000, fresh: false },
    };
    let orchestrator = orchestratorOf({ signals, pairs: pairsOf(stale) });
    await orchestrator.tick();
    await orchestrator.stop();
    orchestrator = orchestratorOf({
      signals,
      pairs: pairsOf({ ok: false, reason: 'catalog_unavailable' }),
    });
    await orchestrator.tick();
    await orchestrator.stop();
    expect(signals.calls).toHaveLength(0);
    expect((await sessionRow(seed.session.id)).status).toBe(TradingSessionStatus.Active);
    expect(
      msgsOf(seed.session.id).filter((m) => m === 'trading session pairs unavailable'),
    ).toHaveLength(2);
  });

  // the same step created by someone else while the backend calls were in flight
  it.each<[string, TradeAction, string]>([
    ['with the same terms is a replay', TradeAction.Up, 'trading session step replayed'],
    ['with other terms is a conflict', TradeAction.Down, 'trading session intent refused'],
  ])('E9g the step %s and reschedules', async (_label, action, msg) => {
    const seed = await seedSession();
    const signals = signalsOf(async () => {
      await createSessionIntent(tmp.db, {
        sessionId: seed.session.id,
        step: 1,
        telegramUserId: seed.telegramUserId,
        brokerAccountId: seed.brokerAccountId,
        mode: TradeMode.Demo,
        assetId: 101,
        amount: '1' as DecimalString,
        action,
        durationSec: 60,
        decision: null,
      });
      return { ok: true, response: signalAnswer(TradeAction.Up) };
    });
    const orchestrator = orchestratorOf({ signals });
    await orchestrator.tick();
    const row = await sessionRow(seed.session.id);
    expect(row.status).toBe(TradingSessionStatus.Active);
    expect(row.lastDecisionAt).not.toBeNull();
    expect(await intentsOf(seed.session.id)).toHaveLength(1);
    expect(msgsOf(seed.session.id)).toContain(msg);
    await orchestrator.stop();
  });
});

// docs/trading-session.md -> The pause after two losses (#379); a candle wait is under 66 s for
// the 1m sessions here (the next boundary plus the 5 s slack)
describe('the pause after two losses (#379)', () => {
  const CANDLE_WAIT = 66_000;
  const signalTo = (action: TradeAction): SignalOutcome => ({
    ok: true,
    response: signalAnswer(action),
  });
  const pauseLines = (sessionId: string) =>
    linesOf(sessionId).filter(
      (line) => line.msg === 'trading session waits for the signal to change',
    );

  it('P1 (716ed06d) two losses in one direction hold it until the signal changes', async () => {
    const seed = await seedSession({ settings: sessionSettings({ trades: 10 }) });
    let answer = signalTo(TradeAction.Down);
    const signals = signalsOf(() => answer);
    const orchestrator = orchestratorOf({ signals });
    await tradeOnce(orchestrator, seed, MockTradeOutcome.Win);
    await tradeOnce(orchestrator, seed, MockTradeOutcome.Loss);
    await tradeOnce(orchestrator, seed, MockTradeOutcome.Loss);
    const before = await sessionRow(seed.session.id);
    expect(before.lastSignalAction).toBe(TradeAction.Down);

    await orchestrator.tick();
    expect(await intentsOf(seed.session.id)).toHaveLength(3);
    const paused = await sessionRow(seed.session.id);
    expect(paused.lastSignalAction).toBe(TradeAction.Down);
    expect(paused.lastDecisionAt!.getTime()).toBeGreaterThan(before.lastDecisionAt!.getTime());
    expect(pauseLines(seed.session.id)).toEqual([
      expect.objectContaining({ level: 30, action: TradeAction.Down }),
    ]);
    // held for the candle wait, not retried at the next tick
    const asked = signals.calls.length;
    advance(CONFIG.tickMs);
    await orchestrator.tick();
    expect(signals.calls).toHaveLength(asked);

    answer = { ok: true, response: noSignalAnswer() };
    advance(CANDLE_WAIT);
    await orchestrator.tick();
    expect(signals.calls).toHaveLength(asked + 1);
    expect((await sessionRow(seed.session.id)).lastSignalAction).toBeNull();

    answer = signalTo(TradeAction.Down);
    advance(CANDLE_WAIT);
    await orchestrator.tick();
    const intents = await intentsOf(seed.session.id);
    expect(intents).toHaveLength(4);
    expect(intents[3]!.action).toBe(TradeAction.Down);
    expect((await sessionRow(seed.session.id)).lastSignalAction).toBe(TradeAction.Down);
    await orchestrator.stop();
  });

  it('P2 two losses down, then a signal up trades at once', async () => {
    const seed = await seedSession();
    let answer = signalTo(TradeAction.Down);
    const orchestrator = orchestratorOf({ signals: signalsOf(() => answer) });
    await tradeOnce(orchestrator, seed, MockTradeOutcome.Loss);
    await tradeOnce(orchestrator, seed, MockTradeOutcome.Loss);
    answer = signalTo(TradeAction.Up);
    await orchestrator.tick();
    const intents = await intentsOf(seed.session.id);
    expect(intents.map((i) => i.action)).toEqual([
      TradeAction.Down,
      TradeAction.Down,
      TradeAction.Up,
    ]);
    expect(pauseLines(seed.session.id)).toEqual([]);
    await orchestrator.stop();
  });

  it('P3 loss, win, loss in one direction is not two losses in a row: it trades', async () => {
    const seed = await seedSession();
    const orchestrator = orchestratorOf({ signals: signalsOf(signalTo(TradeAction.Down)) });
    await tradeOnce(orchestrator, seed, MockTradeOutcome.Loss);
    await tradeOnce(orchestrator, seed, MockTradeOutcome.Win);
    await tradeOnce(orchestrator, seed, MockTradeOutcome.Loss);
    await orchestrator.tick();
    expect(await intentsOf(seed.session.id)).toHaveLength(4);
    expect(pauseLines(seed.session.id)).toEqual([]);
    await orchestrator.stop();
  });

  it('P4 a new orchestrator (a worker restart) pauses from the row alone', async () => {
    const seed = await seedSession();
    const signals = signalsOf(signalTo(TradeAction.Down));
    const first = orchestratorOf({ signals });
    await tradeOnce(first, seed, MockTradeOutcome.Loss);
    await tradeOnce(first, seed, MockTradeOutcome.Loss);
    await first.stop();
    const second = orchestratorOf({ signals });
    await second.tick();
    expect(await intentsOf(seed.session.id)).toHaveLength(2);
    expect(pauseLines(seed.session.id)).toHaveLength(1);
    await second.stop();
  });

  it('P5 a rejected intent between the two losses is skipped: still paused', async () => {
    const seed = await seedSession();
    const orchestrator = orchestratorOf({ signals: signalsOf(signalTo(TradeAction.Down)) });
    await tradeOnce(orchestrator, seed, MockTradeOutcome.Loss);
    await orchestrator.tick();
    broker.rest.failNext('openTrade', { status: 400 });
    expect(await processIntent((await intentsOf(seed.session.id)).at(-1)!.id)).toBe('rejected');
    await tradeOnce(orchestrator, seed, MockTradeOutcome.Loss);
    await orchestrator.tick();
    expect((await intentsOf(seed.session.id)).map((i) => i.status)).toEqual([
      TradeIntentStatus.Settled,
      TradeIntentStatus.Rejected,
      TradeIntentStatus.Settled,
    ]);
    expect(pauseLines(seed.session.id)).toHaveLength(1);
    await orchestrator.stop();
  });

  // #379 review m1: the deadline or a restart between the INSERT and the ending loses the
  // ending; the direct createSessionIntent is that state (no seam inside the attempt fires the
  // deadline between the two)
  it('P8 an intent whose ending was lost still counts: the next signal in its direction waits', async () => {
    const seed = await seedSession();
    let answer = signalTo(TradeAction.Down);
    const orchestrator = orchestratorOf({ signals: signalsOf(() => answer) });
    await tradeOnce(orchestrator, seed, MockTradeOutcome.Loss);
    answer = { ok: true, response: noSignalAnswer() };
    advance(CANDLE_WAIT);
    await orchestrator.tick();
    expect((await sessionRow(seed.session.id)).lastSignalAction).toBeNull();

    const { intent } = await createSessionIntent(tmp.db, {
      sessionId: seed.session.id,
      step: 2,
      telegramUserId: seed.telegramUserId,
      brokerAccountId: seed.brokerAccountId,
      mode: TradeMode.Demo,
      assetId: 101,
      amount: '1' as DecimalString,
      action: TradeAction.Down,
      durationSec: 60,
      decision: null,
    });
    expect(await processIntent(intent.id)).toBe('accepted');
    await settle(seed, intent.id, MockTradeOutcome.Loss);

    answer = signalTo(TradeAction.Down);
    advance(CANDLE_WAIT);
    await orchestrator.tick();
    expect(await intentsOf(seed.session.id)).toHaveLength(2);
    expect(pauseLines(seed.session.id)).toHaveLength(1);
    expect((await sessionRow(seed.session.id)).lastSignalAction).toBe(TradeAction.Down);
    await orchestrator.stop();
  });

  // #379 review m2: the intent after the second loss exists only because the pause had lifted
  it('P9 a rejected intent after the lifted pause does not re-arm it', async () => {
    const seed = await seedSession({ settings: sessionSettings({ trades: 10 }) });
    let answer = signalTo(TradeAction.Down);
    const orchestrator = orchestratorOf({ signals: signalsOf(() => answer) });
    await tradeOnce(orchestrator, seed, MockTradeOutcome.Loss);
    await tradeOnce(orchestrator, seed, MockTradeOutcome.Loss);
    answer = { ok: true, response: noSignalAnswer() };
    await orchestrator.tick();
    expect((await sessionRow(seed.session.id)).lastSignalAction).toBeNull();

    answer = signalTo(TradeAction.Down);
    advance(CANDLE_WAIT);
    await orchestrator.tick();
    broker.rest.failNext('openTrade', { status: 400 });
    expect(await processIntent((await intentsOf(seed.session.id)).at(-1)!.id)).toBe('rejected');

    advance(CANDLE_WAIT);
    await orchestrator.tick();
    const intents = await intentsOf(seed.session.id);
    expect(intents.map((i) => [i.action, i.status])).toEqual([
      [TradeAction.Down, TradeIntentStatus.Settled],
      [TradeAction.Down, TradeIntentStatus.Settled],
      [TradeAction.Down, TradeIntentStatus.Rejected],
      [TradeAction.Down, TradeIntentStatus.Queued],
    ]);
    expect(pauseLines(seed.session.id)).toEqual([]);
    await orchestrator.stop();
  });

  // #509 (owner), #631: no payout floor holds a session; a payout that fell keeps trading
  it('P6 a pair whose payout fell below the floor after the start trades on its signal', async () => {
    const seed = await seedSession();
    const signals = signalsOf();
    const orchestrator = orchestratorOf({
      signals,
      pairs: pairsOf(fresh([eurUsd({ payout: 79 })])),
    });
    await orchestrator.tick();
    expect(signals.calls).toHaveLength(1);
    expect(await intentsOf(seed.session.id)).toHaveLength(1);
    expect((await sessionRow(seed.session.id)).status).toBe(TradingSessionStatus.Active);
    await orchestrator.stop();
  });

  // the streak rule on the history alone
  const intent = (
    action: TradeAction,
    status: TradeIntentStatus,
    profit: string | null,
  ): Parameters<typeof pausedDirection>[0][number] => ({
    id: `${action}-${status}-${profit}`,
    action,
    status,
    amount: '1.00000000' as DecimalString,
    profit: profit as DecimalString | null,
    lastError: null,
  });
  const loss = (action: TradeAction) => intent(action, TradeIntentStatus.Settled, '-1.00000000');

  it.each([
    ['two losses down', [loss(TradeAction.Down), loss(TradeAction.Down)], TradeAction.Down],
    ['two losses in two directions', [loss(TradeAction.Up), loss(TradeAction.Down)], undefined],
    ['one loss', [loss(TradeAction.Up)], undefined],
    [
      'a tie after a loss',
      [loss(TradeAction.Up), intent(TradeAction.Up, TradeIntentStatus.Settled, '0.00000000')],
      undefined,
    ],
    [
      'a settled trade without its profit',
      [loss(TradeAction.Up), intent(TradeAction.Up, TradeIntentStatus.Settled, null)],
      undefined,
    ],
    [
      'a manual_review intent',
      [loss(TradeAction.Up), intent(TradeAction.Up, TradeIntentStatus.ManualReview, null)],
      undefined,
    ],
    [
      'a rejected intent between two losses',
      [
        loss(TradeAction.Up),
        intent(TradeAction.Down, TradeIntentStatus.Rejected, null),
        loss(TradeAction.Up),
      ],
      TradeAction.Up,
    ],
    [
      'a rejected intent after two losses',
      [
        loss(TradeAction.Up),
        loss(TradeAction.Up),
        intent(TradeAction.Up, TradeIntentStatus.Rejected, null),
      ],
      undefined,
    ],
  ])('P7 %s', (_, intents, expected) => {
    expect(pausedDirection(intents)).toBe(expected);
  });
});

// #509 (owner): 20 candles of the session's signal interval waiting for a signal stop it (#637), on
// the database clock, from the later of started_at and the session's last intent change; the
// tests compute the limit from sessionNoSignalTimeoutMs and move those rows relative to it (the
// default seed's 60 s session waits on 1m candles)
describe('the no-signal limit (#509)', () => {
  const LIMIT = sessionNoSignalTimeoutMs(60);
  const ago = (ms: number) => sql`now() - (${ms}::int * interval '1 millisecond')`;
  const startedAgo = (id: string, ms: number) =>
    tmp.db
      .update(tradingSessions)
      .set({ startedAt: ago(ms) })
      .where(eq(tradingSessions.id, id));
  const changedAgo = (sessionId: string, ms: number) =>
    tmp.db.execute(
      sql`update trade_intents set updated_at = ${ago(ms)} where trading_session_id = ${sessionId}`,
    );
  const noSignal: SignalOutcome = { ok: true, response: noSignalAnswer() };
  const stopLines = (sessionId: string) =>
    linesOf(sessionId).filter((line) => line.msg === 'trading session stopped');
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
  const expectStopped = async (sessionId: string, waited: string, limitMs: number = LIMIT) => {
    expect(await sessionRow(sessionId)).toMatchObject({
      status: TradingSessionStatus.Stopped,
      stopReason: TradingSessionStopReason.NoSignalTimeout,
    });
    expect(stopLines(sessionId)).toEqual([
      expect.objectContaining({ level: 40, reason: 'no_signal_timeout', waited, limitMs }),
    ]);
  };
  const expectActive = async (sessionId: string) =>
    expect((await sessionRow(sessionId)).status).toBe(TradingSessionStatus.Active);

  it('W1 no_signal past the limit since the start stops it: no intent, one no_signal row', async () => {
    const seed = await seedSession();
    await startedAgo(seed.session.id, LIMIT + 5_000);
    const before = await tokensOf(seed.userId);
    const signals = signalsOf(noSignal);
    const orchestrator = orchestratorOf({ signals });
    await orchestrator.tick();
    expect(signals.calls).toHaveLength(1);
    await expectStopped(seed.session.id, 'no_signal');
    expect(await intentsOf(seed.session.id)).toEqual([]);
    expect(await tokensOf(seed.userId)).toEqual(before);
    // O9 (#666): the decision the stop came after, recorded with the wait's outcome
    expect(await decisionsOf(seed.session.id)).toEqual([
      expect.objectContaining({
        outcome: 'no_signal',
        kind: 'no_signal',
        detail: null,
        step: 1,
        decidedAtMs: RECORD_NOW_MS,
      }),
    ]);
    await orchestrator.stop();
  });

  it('W2 no_signal 10 s inside the limit holds it', async () => {
    const seed = await seedSession();
    await startedAgo(seed.session.id, LIMIT - 10_000);
    const orchestrator = orchestratorOf({ signals: signalsOf(noSignal) });
    await orchestrator.tick();
    await expectActive(seed.session.id);
    expect(stopLines(seed.session.id)).toEqual([]);
    await orchestrator.stop();
  });

  it("W3 counts from the session's last intent change, not the start", async () => {
    const seed = await seedSession();
    let answer: SignalOutcome = { ok: true, response: signalAnswer(TradeAction.Up) };
    const orchestrator = orchestratorOf({ signals: signalsOf(() => answer) });
    await tradeOnce(orchestrator, seed);
    await startedAgo(seed.session.id, LIMIT + 300_000);
    await changedAgo(seed.session.id, 30_000);
    answer = noSignal;
    await orchestrator.tick();
    await expectActive(seed.session.id);

    await changedAgo(seed.session.id, LIMIT + 5_000);
    // past the no_signal hold: up to a 1m candle plus the slack
    advance(SIGNAL_CHART_INTERVAL_MS['1m'] + CONFIG.candleSlackMs + 1_000);
    await orchestrator.tick();
    await expectStopped(seed.session.id, 'no_signal');
    await orchestrator.stop();
  });

  it('W4 the pause after two losses past the limit stops it', async () => {
    const seed = await seedSession();
    const answer: SignalOutcome = { ok: true, response: signalAnswer(TradeAction.Down) };
    const signals = signalsOf(answer);
    const orchestrator = orchestratorOf({ signals });
    await tradeOnce(orchestrator, seed, MockTradeOutcome.Loss);
    await tradeOnce(orchestrator, seed, MockTradeOutcome.Loss);
    await startedAgo(seed.session.id, LIMIT + 300_000);
    await changedAgo(seed.session.id, LIMIT + 5_000);
    await orchestrator.tick();
    expect(await intentsOf(seed.session.id)).toHaveLength(2);
    await expectStopped(seed.session.id, 'paused');
    // O10 (#666): the paused decision, with its direction, after the two intents' rows
    const rows = await decisionsOf(seed.session.id);
    expect(rows.map((row) => row.outcome)).toEqual(['intent', 'intent', 'paused']);
    expect(rows[2]).toMatchObject({ kind: 'signal', action: 'down', detail: null, step: 3 });
    await orchestrator.stop();
  });

  it('W5 a pair closed by its schedule past the limit stops it, no signal asked', async () => {
    const seed = await seedSession();
    await startedAgo(seed.session.id, LIMIT + 5_000);
    const signals = signalsOf();
    const orchestrator = orchestratorOf({
      signals,
      pairs: pairsOf(fresh([eurUsd({ scheduledUntil: clock + 30_000 })])),
    });
    await orchestrator.tick();
    expect(signals.calls).toHaveLength(0);
    await expectStopped(seed.session.id, 'pair_closed');
    // O11 (#666): no decision was asked, none recorded
    expect(await decisionsOf(seed.session.id)).toEqual([]);
    await orchestrator.stop();
  });

  it('O12 a session stopped by the user while the signal is read past the limit keeps its reason; the decision is recorded', async () => {
    const seed = await seedSession();
    await startedAgo(seed.session.id, LIMIT + 5_000);
    const signals = signalsOf(async () => {
      await stopTradingSession(tmp.db, {
        id: seed.session.id,
        reason: TradingSessionStopReason.UserStopped,
      });
      return noSignal;
    });
    const orchestrator = orchestratorOf({ signals });
    await orchestrator.tick();
    expect(await sessionRow(seed.session.id)).toMatchObject({
      status: TradingSessionStatus.Stopped,
      stopReason: TradingSessionStopReason.UserStopped,
    });
    expect(stopLines(seed.session.id)).toEqual([]);
    expect(await decisionsOf(seed.session.id)).toEqual([
      expect.objectContaining({ outcome: 'no_signal', step: 1 }),
    ]);
    await orchestrator.stop();
  });

  it.each<[string, SignalOutcome]>([
    ['unavailable', { ok: false, reason: BackendUnavailable.BackendUnreachable }],
    ['fetch_failed', { ok: true, response: fetchFailedAnswer() }],
  ])('W6 a signal %s past the limit holds it; the next no_signal stops it', async (_, failed) => {
    const seed = await seedSession();
    await startedAgo(seed.session.id, LIMIT + 5_000);
    let answer = failed;
    const orchestrator = orchestratorOf({ signals: signalsOf(() => answer) });
    await orchestrator.tick();
    await expectActive(seed.session.id);
    answer = noSignal;
    advance(CONFIG.retryMs);
    await orchestrator.tick();
    await expectStopped(seed.session.id, 'no_signal');
    await orchestrator.stop();
  });

  it('W7 a signal past the limit trades', async () => {
    const seed = await seedSession();
    await startedAgo(seed.session.id, LIMIT + 30_000);
    const orchestrator = orchestratorOf();
    await orchestrator.tick();
    expect(await intentsOf(seed.session.id)).toHaveLength(1);
    await expectActive(seed.session.id);
    await orchestrator.stop();
  });

  it('W8 a new orchestrator (a worker restart) stops from the rows alone', async () => {
    const seed = await seedSession();
    await startedAgo(seed.session.id, LIMIT - 10_000);
    const first = orchestratorOf({ signals: signalsOf(noSignal) });
    await first.tick();
    await first.stop();
    await expectActive(seed.session.id);
    await startedAgo(seed.session.id, LIMIT + 5_000);
    const second = orchestratorOf({ signals: signalsOf(noSignal) });
    await second.tick();
    await expectStopped(seed.session.id, 'no_signal');
    await second.stop();
  });

  // #637: the limit is the session's, 20 candles of intervalForDuration(durationSec); sessions of
  // one age that differ only in durationSec
  const shortPair = eurUsd({ id: 202, symbol: 'AAPL', type: 'stock', minTimeframe: 5 });
  const seedOn = (durationSec: number) =>
    seedSession({ settings: sessionSettings({ assetId: 202, durationSec }) });

  it('W9 at 150 s without a signal a 5 s session stops, 15 s and 60 s ones wait on', async () => {
    const five = await seedOn(5);
    const fifteen = await seedOn(15);
    const sixty = await seedOn(60);
    for (const seed of [five, fifteen, sixty]) await startedAgo(seed.session.id, 150_000);
    const orchestrator = orchestratorOf({
      signals: signalsOf(noSignal),
      pairs: pairsOf(fresh([shortPair])),
    });
    await orchestrator.tick();
    await expectStopped(five.session.id, 'no_signal', 100_000);
    await expectActive(fifteen.session.id);
    await expectActive(sixty.session.id);
    await orchestrator.stop();
  });

  it('W10 at 305 s without a signal a 15 s session stops, a 60 s one waits on', async () => {
    const fifteen = await seedOn(15);
    const sixty = await seedOn(60);
    for (const seed of [fifteen, sixty]) await startedAgo(seed.session.id, 305_000);
    const orchestrator = orchestratorOf({
      signals: signalsOf(noSignal),
      pairs: pairsOf(fresh([shortPair])),
    });
    await orchestrator.tick();
    await expectStopped(fifteen.session.id, 'no_signal', 300_000);
    await expectActive(sixty.session.id);
    await orchestrator.stop();
  });
});

// The database refuses this session's decision rows while `run` runs, whatever their values: the
// writers' guards cannot be bypassed from a test that goes through the orchestrator.
async function refusingDecisionsOf<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
  if (!/^[0-9a-f-]{36}$/.test(sessionId)) throw new Error('not a session id');
  await tmp.db.execute(
    sql.raw(`create function refuse_decisions() returns trigger language plpgsql as $$
      begin
        if new.trading_session_id = '${sessionId}' then
          raise exception 'refused by the test' using errcode = 'check_violation';
        end if;
        return new;
      end $$`),
  );
  await tmp.db.execute(
    sql.raw(
      'create trigger refuse_decisions before insert on signal_decisions for each row execute function refuse_decisions()',
    ),
  );
  try {
    return await run();
  } finally {
    await tmp.db.execute(sql.raw('drop trigger refuse_decisions on signal_decisions'));
    await tmp.db.execute(sql.raw('drop function refuse_decisions()'));
  }
}

// #666: every ending reached after a decision writes its trade log row (docs/trade-log.md → The
// writers and their outcomes, E1–E14); O9–O12 sit with the no-signal limit
describe('the decision rows of an attempt (#666)', () => {
  it('O1 a created intent names its decision row, written in its transaction with the record', async () => {
    const seed = await seedSession();
    clock = Date.now();
    const orchestrator = orchestratorOf();
    await orchestrator.tick();
    const [intent] = await intentsOf(seed.session.id);
    const rows = await decisionsOf(seed.session.id);
    expect(rows).toHaveLength(1);
    expect(intent!.signalDecisionId).toBe(rows[0]!.id);
    const answer = signalAnswer(TradeAction.Up);
    const record = answer.outcome === 'decided' ? answer.record : undefined;
    expect(rows[0]).toMatchObject({
      context: 'session',
      brokerAccountId: seed.brokerAccountId,
      step: 1,
      assetId: 101,
      interval: '1m',
      version: 'v2',
      decidedAtMs: RECORD_NOW_MS,
      takenAtMs: clock,
      kind: 'signal',
      action: 'up',
      payout: 85,
      digits: 5,
      outcome: 'intent',
      detail: null,
      series: record?.entry.series,
      source: record?.entry.source,
      lastTick: record?.lastTick,
    });
    await orchestrator.stop();
  });

  it('O2 a no_signal hold records no_signal', async () => {
    const seed = await seedSession();
    const orchestrator = orchestratorOf({
      signals: signalsOf({ ok: true, response: noSignalAnswer() }),
    });
    await orchestrator.tick();
    expect(await decisionsOf(seed.session.id)).toEqual([
      expect.objectContaining({ outcome: 'no_signal', kind: 'no_signal', action: null, step: 1 }),
    ]);
    await orchestrator.stop();
  });

  it('O3 the pause after two losses records paused with the paused direction', async () => {
    const seed = await seedSession();
    const orchestrator = orchestratorOf({
      signals: signalsOf({ ok: true, response: signalAnswer(TradeAction.Down) }),
    });
    await tradeOnce(orchestrator, seed, MockTradeOutcome.Loss);
    await tradeOnce(orchestrator, seed, MockTradeOutcome.Loss);
    await orchestrator.tick();
    expect(await intentsOf(seed.session.id)).toHaveLength(2);
    const rows = await decisionsOf(seed.session.id);
    expect(rows.map((row) => row.outcome)).toEqual(['intent', 'intent', 'paused']);
    expect(rows[2]).toMatchObject({ kind: 'signal', action: 'down', detail: null, step: 3 });
    expect(msgsOf(seed.session.id)).not.toContain('trading session decision not recorded');
    await orchestrator.stop();
  });

  it("O4 the sizer's stop records stake_stop with its code: the minimum, and a martingale limit", async () => {
    const below = await seedSession({
      settings: sessionSettings({ stake: { baseStake: '0.5' as DecimalString, stakeScale: 1 } }),
    });
    const first = orchestratorOf();
    await first.tick();
    await first.stop();
    expect(await decisionsOf(below.session.id)).toEqual([
      expect.objectContaining({ outcome: 'stake_stop', detail: 'below_min_trade_amount' }),
    ]);

    const built = buildSessionSettings({
      assetId: 101,
      durationSec: 60,
      cycles: 5,
      stake: { baseStake: '1' as DecimalString, stakeScale: 2 },
      strategy: SessionStakeStrategy.Martingale,
    });
    if (!built.success) throw new Error('the test settings fail the schema');
    const late = await seedSession({ settings: built.data });
    const lateClock = late.session.startedAt.getTime() + SESSION_MAX_DURATION_MS + 1_000;
    const second = orchestratorOf({ clockOf: () => lateClock });
    await second.tick();
    expect((await sessionRow(late.session.id)).stopReason).toBe(
      TradingSessionStopReason.SessionDurationExceeded,
    );
    expect(await decisionsOf(late.session.id)).toEqual([
      expect.objectContaining({
        outcome: 'stake_stop',
        detail: 'session_duration_exceeded',
        takenAtMs: lateClock,
      }),
    ]);
    await second.stop();
  });

  it('O5 a refusal records refused with its code, exactly one row; a session gone meanwhile none', async () => {
    const paused = await seedSession();
    const closing = orchestratorOf({
      signals: signalsOf(async () => {
        await closeTradingSwitch(tmp.db);
        return { ok: true, response: signalAnswer(TradeAction.Up) };
      }),
    });
    await closing.tick();
    await closing.stop();
    await openTrading(tmp.db);
    expect((await sessionRow(paused.session.id)).stopReason).toBe(
      TradingSessionStopReason.KillSwitch,
    );
    expect(await decisionsOf(paused.session.id)).toEqual([
      expect.objectContaining({ outcome: 'refused', detail: 'trading_paused', step: 1 }),
    ]);

    const busy = await seedSession();
    const occupying = orchestratorOf({
      signals: signalsOf(async () => {
        await createTradeIntent(tmp.db, {
          telegramUserId: busy.telegramUserId,
          mode: TradeMode.Demo,
          assetId: 101,
          amount: '1.00' as DecimalString,
          action: TradeAction.Up,
          durationSec: 60,
          clientRequestId: `bot-${busy.session.id}`,
        });
        return { ok: true, response: signalAnswer(TradeAction.Up) };
      }),
    });
    await occupying.tick();
    await occupying.stop();
    expect((await sessionRow(busy.session.id)).status).toBe(TradingSessionStatus.Active);
    expect(await decisionsOf(busy.session.id)).toEqual([
      expect.objectContaining({ outcome: 'refused', detail: 'active_intent_exists', step: 1 }),
    ]);

    const gone = await seedSession();
    const stopping = orchestratorOf({
      signals: signalsOf(async () => {
        await stopTradingSession(tmp.db, {
          id: gone.session.id,
          reason: TradingSessionStopReason.UserStopped,
        });
        return { ok: true, response: signalAnswer(TradeAction.Up) };
      }),
    });
    await stopping.tick();
    await stopping.stop();
    expect(await decisionsOf(gone.session.id)).toEqual([]);
  });

  it("O6 a replayed step records replayed beside the first process's intent", async () => {
    const seed = await seedSession();
    const orchestrator = orchestratorOf({
      signals: signalsOf(async () => {
        await createSessionIntent(tmp.db, {
          sessionId: seed.session.id,
          step: 1,
          telegramUserId: seed.telegramUserId,
          brokerAccountId: seed.brokerAccountId,
          mode: TradeMode.Demo,
          assetId: 101,
          amount: '1.00' as DecimalString,
          action: TradeAction.Up,
          durationSec: 60,
          decision: null,
        });
        return { ok: true, response: signalAnswer(TradeAction.Up) };
      }),
    });
    await orchestrator.tick();
    expect(await intentsOf(seed.session.id)).toHaveLength(1);
    expect(await decisionsOf(seed.session.id)).toEqual([
      expect.objectContaining({ outcome: 'replayed', detail: null, step: 1 }),
    ]);
    await orchestrator.stop();
  });

  const recordLess = signalAnswer(TradeAction.Up, { record: false });
  it.each<[string, SignalOutcome, string | undefined]>([
    ['an old backend without the record', { ok: true, response: recordLess }, 'record_missing'],
    [
      'a record the source found invalid',
      { ok: true, response: recordLess, recordProblem: 'invalid' },
      'record_invalid',
    ],
    [
      "a record that is not the answer's",
      { ok: true, response: recordLess, recordProblem: 'mismatch' },
      'record_mismatch',
    ],
    [
      'the backend unavailable',
      { ok: false, reason: BackendUnavailable.BackendUnreachable },
      undefined,
    ],
    ['a fetch failure', { ok: true, response: fetchFailedAnswer() }, undefined],
  ])('O7 %s: no row', async (_label, answer, reason) => {
    const seed = await seedSession();
    const orchestrator = orchestratorOf({ signals: signalsOf(answer) });
    await orchestrator.tick();
    expect(await decisionsOf(seed.session.id)).toEqual([]);
    const warns = linesOf(seed.session.id).filter(
      (line) => line.msg === 'trading session decision not recorded',
    );
    expect(warns).toEqual(
      reason === undefined ? [] : [expect.objectContaining({ level: 40, reason })],
    );
    if (reason !== undefined) {
      const [intent] = await intentsOf(seed.session.id);
      expect(intent!.signalDecisionId).toBeNull();
    }
    await orchestrator.stop();
  });

  it('O8 a record the database refuses is a warn by name and code; the ending stands', async () => {
    const seed = await seedSession();
    const orchestrator = orchestratorOf({
      signals: signalsOf({ ok: true, response: noSignalAnswer() }),
    });
    await refusingDecisionsOf(seed.session.id, () => orchestrator.tick());
    expect((await sessionRow(seed.session.id)).lastDecisionAt).not.toBeNull();
    expect(await decisionsOf(seed.session.id)).toEqual([]);
    expect(
      linesOf(seed.session.id).filter(
        (line) => line.msg === 'trading session decision not recorded',
      ),
    ).toEqual([
      expect.objectContaining({
        level: 40,
        step: 1,
        cause: { name: 'error', code: '23514' },
      }),
    ]);
    await orchestrator.stop();
  });

  it("O13 a decision the database refuses in the intent's transaction leaves the intent created, unlinked", async () => {
    const seed = await seedSession();
    const orchestrator = orchestratorOf();
    await refusingDecisionsOf(seed.session.id, () => orchestrator.tick());
    const [intent] = await intentsOf(seed.session.id);
    expect(intent).toMatchObject({ signalDecisionId: null, status: 'queued' });
    expect(await decisionsOf(seed.session.id)).toEqual([]);
    expect(
      linesOf(seed.session.id).filter(
        (line) => line.msg === 'trading session decision not recorded',
      ),
    ).toEqual([
      expect.objectContaining({
        level: 40,
        step: 1,
        reason: 'insert_refused',
        cause: { name: 'error', code: '23514' },
      }),
    ]);
    expect(msgsOf(seed.session.id)).toContain('trading session intent created');
    await orchestrator.stop();
  });

  it('O14 a catalog payout the column cannot hold is recorded as NULL; the intent is linked', async () => {
    const seed = await seedSession();
    clock = Date.now();
    const orchestrator = orchestratorOf({ pairs: pairsOf(fresh([eurUsd({ payout: -1 })])) });
    await orchestrator.tick();
    const [intent] = await intentsOf(seed.session.id);
    const rows = await decisionsOf(seed.session.id);
    expect(rows).toHaveLength(1);
    expect(intent!.signalDecisionId).toBe(rows[0]!.id);
    expect(rows[0]).toMatchObject({
      context: 'session',
      step: 1,
      kind: 'signal',
      action: 'up',
      payout: null,
      digits: 5,
      outcome: 'intent',
      takenAtMs: clock,
    });
    expect(msgsOf(seed.session.id)).not.toContain('trading session decision not recorded');
    await orchestrator.stop();
  });
});

describe('a stop that races the attempt (#287)', () => {
  it('E9h a session stopped while the backend calls were in flight gets no intent', async () => {
    const seed = await seedSession();
    const signals = signalsOf(async () => {
      await stopTradingSession(tmp.db, {
        id: seed.session.id,
        reason: TradingSessionStopReason.UserStopped,
      });
      return { ok: true, response: signalAnswer(TradeAction.Up) };
    });
    const orchestrator = orchestratorOf({ signals });
    await orchestrator.tick();
    expect(await sessionRow(seed.session.id)).toMatchObject({
      status: TradingSessionStatus.Stopped,
      stopReason: TradingSessionStopReason.UserStopped,
    });
    expect(await intentsOf(seed.session.id)).toEqual([]);
    expect(await reservedOf(seed.userId)).toBe(0n);
    expect(msgsOf(seed.session.id)).toContain('trading session stopped meanwhile');
    await orchestrator.stop();
  });
});

describe('the kill switch (#144, #287)', () => {
  it.each(MODES)(
    'K1 a closed switch stops the session before any backend call (%s)',
    async (mode) => {
      const seed = await seedSession({ mode, real: '50.00' });
      await closeTradingSwitch(tmp.db);
      const signals = signalsOf();
      const orchestrator = orchestratorOf({ signals });
      await orchestrator.tick();
      expect(await sessionRow(seed.session.id)).toMatchObject({
        status: TradingSessionStatus.Stopped,
        stopReason: TradingSessionStopReason.KillSwitch,
      });
      expect(signals.calls).toHaveLength(0);
      expect(await intentsOf(seed.session.id)).toEqual([]);
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

  it('K2 a switch closed during the attempt stops the session as kill_switch, nothing reserved', async () => {
    const signals = signalsOf(async () => {
      await closeTradingSwitch(tmp.db);
      return { ok: true, response: signalAnswer(TradeAction.Up) };
    });
    const seed = await seedSession();
    const orchestrator = orchestratorOf({ signals });
    await orchestrator.tick();
    expect(await sessionRow(seed.session.id)).toMatchObject({
      status: TradingSessionStatus.Stopped,
      stopReason: TradingSessionStopReason.KillSwitch,
    });
    expect(await intentsOf(seed.session.id)).toEqual([]);
    expect(await reservedOf(seed.userId)).toBe(0n);
    expect(linesOf(seed.session.id)).toContainEqual(
      expect.objectContaining({ level: 40, reason: 'kill_switch', code: 'trading_paused' }),
    );
    await orchestrator.stop();
  });
});

describe('failures that write no ending (#287)', () => {
  it('a throw in an attempt holds the session back for retryMs without moving last_decision_at', async () => {
    const seed = await seedSession();
    const signals = signalsOf(() => {
      throw new Error('stub failure');
    });
    const orchestrator = orchestratorOf({ signals });
    await orchestrator.tick();
    advance(59_000);
    await orchestrator.tick();
    expect(signals.calls).toHaveLength(1);
    expect((await sessionRow(seed.session.id)).lastDecisionAt).toBeNull();
    expect(linesOf(seed.session.id)).toContainEqual(
      expect.objectContaining({
        level: 50,
        msg: 'trading session attempt failed',
        brokerAccountId: seed.brokerAccountId,
      }),
    );
    advance(2_000);
    await orchestrator.tick();
    expect(signals.calls).toHaveLength(2);
    await orchestrator.stop();
  });

  it('an attempt past its deadline is cut and held back', async () => {
    const seed = await seedSession();
    // ignores its signal: only the race ends the wait
    const signals = signalsOf(() => new Promise<SignalOutcome>(() => {}));
    const orchestrator = orchestratorOf({ signals, config: { attemptTimeoutMs: 100 } });
    await orchestrator.tick();
    expect((await sessionRow(seed.session.id)).lastDecisionAt).toBeNull();
    expect(msgsOf(seed.session.id)).toContain('trading session attempt timed out');
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

// The msg table in docs/trading-session.md -> Logs is the contract: every row was produced by the
// cases above (a row marked "race" cannot be produced on demand), and no warn or error line
// carries a msg outside it.
// A worker restart, built in process (#131): "the dead worker" is orchestrator A plus the database
// writes it made before dying; "the new worker" is a new orchestrator, pass and catch-up over the
// same database. The crash state is written step by step, not produced by killing a running job.
// The check after an outcome (#92) never changes it; its own suite is balance-check.db.test.ts.
const balanceCheck: BalanceCheck = { check: () => Promise.resolve('not_compared') };
const passOf = () =>
  createReconciliationPass({
    db: tmp.db,
    reconciler: createRestReconciler({
      rest: rest(),
      tokens,
      linkedTradeIds: (brokerAccountId, brokerTradeIds) =>
        listLinkedBrokerTradeIds(tmp.db, { brokerAccountId, brokerTradeIds }),
      logger,
      config: { windowBeforeMs: 60_000, windowAfterMs: 90_000, pageSize: 50, maxPages: 2 },
    }),
    balanceCheck,
    logger,
    config: {
      tickMs: 60_000,
      retryMs: 60_000,
      attemptTimeoutMs: 5_000,
      batchSize: 20,
      balanceCheckTimeoutMs: 1_000,
    },
  });
const catchupOf = () =>
  createSettlementCatchup({
    db: tmp.db,
    rest: rest(),
    tokens,
    logger,
    config: {
      tickMs: 60_000,
      graceMs: 5_000,
      batchSize: 20,
      pageSize: 50,
      maxPages: 2,
      attemptTimeoutMs: 5_000,
      stalledRetryMs: 60_000,
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
        submitAckTimeoutMs: 2_000,
        staleSubmittingMs: 0,
        demoOnly: false,
      },
    },
    { intentId },
  );

// asked of the broker, not of our rows: "no second trade" is what the broker holds
async function brokerTradeCount(accessToken: string) {
  let count = 0;
  for (const status of [TradeListStatus.Open, TradeListStatus.Closed]) {
    const trades = await rest().listTrades(
      { accessToken },
      { status, isDemo: true, limit: 50, offset: 0 },
    );
    count += trades.length;
  }
  return count;
}

const secondsAgo = (seconds: number) => sql`now() - make_interval(secs => ${seconds})`;
const ageSubmitted = (id: string, seconds: number) =>
  tmp.db
    .update(tradeIntents)
    .set({ submittedAt: secondsAgo(seconds) })
    .where(eq(tradeIntents.id, id));
const ageCreated = (id: string, seconds: number) =>
  tmp.db
    .update(tradeIntents)
    .set({ createdAt: secondsAgo(seconds) })
    .where(eq(tradeIntents.id, id));
const ageClaim = (id: string, seconds: number) =>
  tmp.db
    .update(tradeIntents)
    .set({ reconcileClaimedAt: secondsAgo(seconds) })
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
      assetId: 101,
      amount: '1.00' as DecimalString,
      action: TradeAction.Up,
      durationSec: 60,
      isDemo: true,
    },
  );
}

describe('restart recovery (#131)', () => {
  it.each(['submitting', 'unknown', 'reconciling', 'claimed'] as const)(
    'R1 crash at %s with the order at the broker: it settles, one trade, the session goes on',
    async (point) => {
      const seed = await seedSession();
      const a = orchestratorOf();
      await a.tick();
      const [step1] = await intentsOf(seed.session.id);
      const trade = await crashAfterOpen(seed.accessToken, step1!.id);
      if (point !== 'submitting') {
        await tmp.db.transaction((tx) =>
          markIntentUnknown(tx, {
            id: step1!.id,
            reason: TradeIntentFailureReason.StaleSubmitting,
            olderThanMs: 0,
          }),
        );
      }
      if (point === 'reconciling' || point === 'claimed') {
        const row = await intentRow(step1!.id);
        expect(
          await startReconciling(tmp.db, { id: step1!.id, expectedVersion: row.version }),
        ).toBeDefined();
      }
      if (point === 'claimed') {
        expect(await claimReconciling(tmp.db, { id: step1!.id, retryMs: 60_000 })).toBeDefined();
      }
      await a.stop();
      broker.trades.settle(Number(trade.id), { outcome: MockTradeOutcome.Win });

      const b = orchestratorOf();
      await b.tick();
      expect(await intentsOf(seed.session.id)).toHaveLength(1);
      if (point === 'submitting') expect(await processNow(step1!.id)).toBe('stale_unknown');
      if (point === 'submitting' || point === 'unknown') {
        expect(
          await processReconciliationJob({ db: tmp.db, logger }, { intentId: step1!.id }),
        ).toBe('reconciling');
      }
      await runOnce(passOf());
      if (point === 'claimed') {
        // the dead worker's claim is a lease: the new pass waits it out
        expect((await intentRow(step1!.id)).status).toBe(TradeIntentStatus.Reconciling);
        await ageClaim(step1!.id, 120);
        await runOnce(passOf());
      }
      expect((await intentRow(step1!.id)).status).toBe(TradeIntentStatus.Settled);
      await b.tick();
      const intents = await intentsOf(seed.session.id);
      expect(intents.map((i) => i.status)).toEqual([
        TradeIntentStatus.Settled,
        TradeIntentStatus.Queued,
      ]);
      expect(intents[1]!.clientRequestId).toBe(`session:${seed.session.id}:2`);
      expect(await brokerTradeCount(seed.accessToken)).toBe(1);
      await b.stop();
    },
  );

  it('R1b the job redelivered to the new worker never resends the order', async () => {
    const seed = await seedSession();
    const a = orchestratorOf();
    await a.tick();
    const [step1] = await intentsOf(seed.session.id);
    await crashAfterOpen(seed.accessToken, step1!.id);
    await a.stop();
    expect(await processNow(step1!.id)).toBe('stale_unknown');
    expect(await brokerTradeCount(seed.accessToken)).toBe(1);
  });

  // pinned as today (owner's Q3); #274 replaces the halt with a release on a proven absence
  it('R2 crash in submitting with nothing at the broker: manual_review, halt, the session stops', async () => {
    const seed = await seedSession();
    const a = orchestratorOf();
    await a.tick();
    const [step1] = await intentsOf(seed.session.id);
    const row = await intentRow(step1!.id);
    expect(
      await takeIntent(tmp.db, { id: step1!.id, expectedVersion: row.version, maxAgeMs: 60_000 }),
    ).toBeDefined();
    await a.stop();
    await ageSubmitted(step1!.id, 200);
    expect(
      await sweepStaleSubmitting(tmp.db, { olderThanMs: 60_000, limit: 50 }),
    ).toBeGreaterThanOrEqual(1);
    expect(await processReconciliationJob({ db: tmp.db, logger }, { intentId: step1!.id })).toBe(
      'reconciling',
    );
    await runOnce(passOf());
    const after = await intentRow(step1!.id);
    expect(after.status).toBe(TradeIntentStatus.ManualReview);
    expect(after.lastError).toBe(TradeIntentFailureReason.ReconciliationNotFound);
    const [account] = await tmp.db
      .select()
      .from(brokerAccounts)
      .where(eq(brokerAccounts.id, seed.brokerAccountId));
    expect(account!.tradingHalted).toBe(true);
    expect(account!.haltedReason).toBe(AccountHaltReason.ReconciliationNotFound);

    const b = orchestratorOf();
    await b.tick();
    const session = await sessionRow(seed.session.id);
    expect(session.status).toBe(TradingSessionStatus.Stopped);
    expect(session.stopReason).toBe(TradingSessionStopReason.ManualReview);
    expect(await intentsOf(seed.session.id)).toHaveLength(1);
    expect(await reservedOf(seed.userId)).toBe(1n);
    expect(await brokerTradeCount(seed.accessToken)).toBe(0);
    await b.stop();
  });

  it('R3 a lost job delivered late expires; two in a row stop the session rejected_twice', async () => {
    const seed = await seedSession();
    const b = orchestratorOf();
    for (let step = 1; step <= 2; step += 1) {
      await b.tick();
      const intents = await intentsOf(seed.session.id);
      expect(intents).toHaveLength(step);
      await ageCreated(intents[step - 1]!.id, 120);
      expect(await processIntent(intents[step - 1]!.id)).toBe('expired');
      expect(await reservedOf(seed.userId)).toBe(0n);
    }
    await b.tick();
    const session = await sessionRow(seed.session.id);
    expect(session.status).toBe(TradingSessionStatus.Stopped);
    expect(session.stopReason).toBe(TradingSessionStopReason.RejectedTwice);
    expect(await brokerTradeCount(seed.accessToken)).toBe(0);
    await b.stop();
  });

  it('R4 crash with an accepted intent: the catch-up settles it, the session goes on', async () => {
    const seed = await seedSession();
    const a = orchestratorOf();
    await a.tick();
    const [step1] = await intentsOf(seed.session.id);
    expect(await processIntent(step1!.id)).toBe('accepted');
    await a.stop();

    const b = orchestratorOf();
    await b.tick();
    expect(await intentsOf(seed.session.id)).toHaveLength(1);
    const [trade] = await tmp.db
      .select()
      .from(brokerTrades)
      .where(eq(brokerTrades.intentId, step1!.id));
    broker.trades.settle(Number(trade!.brokerTradeId), { outcome: MockTradeOutcome.Loss });
    await overdueTrade(step1!.id);
    await runOnce(catchupOf());
    expect((await intentRow(step1!.id)).status).toBe(TradeIntentStatus.Settled);
    await b.tick();
    expect((await intentsOf(seed.session.id)).map((i) => i.status)).toEqual([
      TradeIntentStatus.Settled,
      TradeIntentStatus.Queued,
    ]);
    expect(await brokerTradeCount(seed.accessToken)).toBe(1);
    await b.stop();
  });

  it('R5 a hold-back is lost with the worker: the new one asks again, one intent', async () => {
    const seed = await seedSession();
    const a = orchestratorOf({
      signals: signalsOf({ ok: false, reason: BackendUnavailable.BackendUnreachable }),
    });
    await a.tick();
    expect(await intentsOf(seed.session.id)).toHaveLength(0);
    await a.stop();

    const signals = signalsOf();
    const b = orchestratorOf({ signals });
    await b.tick();
    await b.tick();
    expect(await intentsOf(seed.session.id)).toHaveLength(1);
    expect(signals.calls.filter((call) => call.assetId === 101)).toHaveLength(1);
    await b.stop();
  });

  // one intent per step for concurrent orchestrators only; the other components are
  // docs/worker-deploy.md → "Why two workers at once are safe"
  it('R6 two orchestrators in one tick: one intent for the step', async () => {
    const seed = await seedSession();
    const a = orchestratorOf();
    const b = orchestratorOf();
    await Promise.all([a.tick(), b.tick()]);
    const intents = await intentsOf(seed.session.id);
    expect(intents).toHaveLength(1);
    expect(intents[0]!.clientRequestId).toBe(`session:${seed.session.id}:1`);
    await Promise.all([a.stop(), b.stop()]);
  });

  it('R7 a restart adds no limit: a session started 40 min ago with nothing done trades step 1', async () => {
    const seed = await seedSession({ startedAt: new Date(Date.now() - 40 * 60_000) });
    const b = orchestratorOf();
    await b.tick();
    expect(await intentsOf(seed.session.id)).toHaveLength(1);
    await b.stop();
  });
});

// #450: the strategy and the limits come from the session's row (settings v3 since #552), the default
// limits of a base stake of 1 at stakeScale 2 (docs/stake.md -> Defaults). The signal alternates,
// so a series of losses is never the pause of #379.
describe('martingale (#450)', () => {
  const settingsOf = (strategy: SessionStakeStrategy, cycles = 5) => {
    const built = buildSessionSettings({
      assetId: 101,
      durationSec: 60,
      cycles,
      stake: { baseStake: '1' as DecimalString, stakeScale: 2 },
      strategy,
    });
    if (!built.success) throw new Error('the test settings fail the schema');
    return built.data;
  };
  const martingale = (cycles = 5) => settingsOf(SessionStakeStrategy.Martingale, cycles);
  // a row written before #552: the same stake, its length in trades
  const settingsV2Of = (strategy: SessionStakeStrategy, trades: number) => {
    const { assetId, durationSec, stake } = settingsOf(strategy);
    return { version: 2, assetId, durationSec, trades, stake };
  };
  // the mock broker has no tie: a won trade's stored profit is set to the live broker's tie, 0
  const tieOnce = async (
    orchestrator: ReturnType<typeof orchestratorOf>,
    seed: Awaited<ReturnType<typeof seedSession>>,
  ) => {
    const intent = await tradeOnce(orchestrator, seed, MockTradeOutcome.Win);
    await tmp.db
      .update(brokerTrades)
      .set({ profit: '0.00000000' as DecimalString })
      .where(eq(brokerTrades.intentId, intent.id));
  };
  const statusOf = async (seed: Awaited<ReturnType<typeof seedSession>>) =>
    (await sessionRow(seed.session.id))?.status;
  const alternating = () => {
    let calls = 0;
    return signalsOf(() => ({
      ok: true,
      response: signalAnswer(
        (calls++ % 2 === 0 ? TradeAction.Up : TradeAction.Down) as TradeAction,
      ),
    }));
  };
  const at = (payout: number) =>
    orchestratorOf({ signals: alternating(), pairs: pairsOf(fresh([eurUsd({ payout })])) });
  const amountsOf = async (sessionId: string) =>
    (await intentsOf(sessionId)).map((intent) => intent.amount);
  const losses = async (
    orchestrator: ReturnType<typeof orchestratorOf>,
    seed: Awaited<ReturnType<typeof seedSession>>,
    count: number,
  ) => {
    for (let i = 0; i < count; i += 1) await tradeOnce(orchestrator, seed, MockTradeOutcome.Loss);
  };
  const expectStopped = async (
    seed: Awaited<ReturnType<typeof seedSession>>,
    stopReason: TradingSessionStopReason,
    sizerCode: string,
  ) => {
    expect(await sessionRow(seed.session.id)).toMatchObject({
      status: TradingSessionStatus.Stopped,
      stopReason,
    });
    expect(linesOf(seed.session.id)).toContainEqual(
      expect.objectContaining({ msg: 'trading session stopped', stopReason: sizerCode }),
    );
    expect(await reservedOf(seed.userId)).toBe(0n);
  };

  it('G1 a loss raises the next stake by the formula, a win brings back the base stake', async () => {
    const seed = await seedSession({ settings: martingale() });
    const orchestrator = at(80);
    await tradeOnce(orchestrator, seed, MockTradeOutcome.Loss);
    await tradeOnce(orchestrator, seed, MockTradeOutcome.Win);
    await orchestrator.tick();
    expect(await amountsOf(seed.session.id)).toEqual(['1.00000000', '2.25000000', '1.00000000']);
    await orchestrator.stop();
  });

  it('G2 a tie leaves the series as it is: the next stake is the same step', async () => {
    const seed = await seedSession({ settings: martingale() });
    const orchestrator = at(80);
    await tradeOnce(orchestrator, seed, MockTradeOutcome.Loss);
    const second = await tradeOnce(orchestrator, seed, MockTradeOutcome.Win);
    // the mock broker has no tie: its stored profit is set to the live broker's tie, 0 (#450 probe)
    await tmp.db
      .update(brokerTrades)
      .set({ profit: '0.00000000' as DecimalString })
      .where(eq(brokerTrades.intentId, second.id));
    await orchestrator.tick();
    expect(await amountsOf(seed.session.id)).toEqual(['1.00000000', '2.25000000', '2.25000000']);
    await orchestrator.stop();
  });

  it('G3 four losses in a row at 80 % stop it as max_steps_exceeded before a fifth stake', async () => {
    const seed = await seedSession({ settings: martingale() });
    const orchestrator = at(80);
    await losses(orchestrator, seed, 4);
    await orchestrator.tick();
    expect(await amountsOf(seed.session.id)).toEqual([
      '1.00000000',
      '2.25000000',
      '5.07000000',
      '11.40000000',
    ]);
    await expectStopped(seed, TradingSessionStopReason.MaxStepsExceeded, 'max_steps_exceeded');
    await orchestrator.stop();
  });

  it('G4 at 79 % the fourth stake would pass 20×B: max_session_loss_exceeded after three losses', async () => {
    const seed = await seedSession({ settings: martingale() });
    const orchestrator = at(79);
    await losses(orchestrator, seed, 3);
    await orchestrator.tick();
    expect(await amountsOf(seed.session.id)).toEqual(['1.00000000', '2.27000000', '5.14000000']);
    await expectStopped(
      seed,
      TradingSessionStopReason.MaxSessionLossExceeded,
      'max_session_loss_exceeded',
    );
    await orchestrator.stop();
  });

  it('G5 at 77 % the fourth stake would pass 12×B: max_stake_exceeded after three losses', async () => {
    const seed = await seedSession({ settings: martingale() });
    const orchestrator = at(77);
    await losses(orchestrator, seed, 3);
    await orchestrator.tick();
    expect(await amountsOf(seed.session.id)).toEqual(['1.00000000', '2.30000000', '5.29000000']);
    await expectStopped(seed, TradingSessionStopReason.MaxStakeExceeded, 'max_stake_exceeded');
    await orchestrator.stop();
  });

  it("G6 the worker's clock past the session's hour stops it as session_duration_exceeded", async () => {
    const seed = await seedSession({ settings: martingale() });
    // the database's deadline has not passed, so the scan still lists the session
    const late = seed.session.startedAt.getTime() + SESSION_MAX_DURATION_MS + 1_000;
    const orchestrator = orchestratorOf({ clockOf: () => late });
    await orchestrator.tick();
    expect(await intentsOf(seed.session.id)).toEqual([]);
    await expectStopped(
      seed,
      TradingSessionStopReason.SessionDurationExceeded,
      'session_duration_exceeded',
    );
    await orchestrator.stop();
  });

  it.each<[string, () => unknown]>([
    ['settings v3 fixed', () => settingsOf(SessionStakeStrategy.Fixed)],
    [
      'settings v1',
      () => sessionSettings({ stake: { baseStake: '1' as DecimalString, stakeScale: 2 } }),
    ],
  ])('G7 %s keep the base stake after a loss', async (_, settings) => {
    const seed = await seedSession({ settings: settings() });
    const orchestrator = at(80);
    await tradeOnce(orchestrator, seed, MockTradeOutcome.Loss);
    await orchestrator.tick();
    expect(await amountsOf(seed.session.id)).toEqual(['1.00000000', '1.00000000']);
    await orchestrator.stop();
  });

  it('G8 a real session raises its stake against the real balance', async () => {
    const seed = await seedSession({
      mode: TradeMode.Real,
      real: '4.00',
      demo: '10000.00',
      settings: martingale(),
    });
    const orchestrator = at(80);
    await tradeOnce(orchestrator, seed, MockTradeOutcome.Loss);
    await tradeOnce(orchestrator, seed, MockTradeOutcome.Loss);
    // the seed's snapshot is older than both settlements: without a real balance written after
    // them the attempt would wait for one (#696) instead of stopping
    await applyBalanceEvent(tmp.db, {
      brokerAccountId: seed.brokerAccountId,
      mode: TradeMode.Real,
      balance: balance('4.00'),
    });
    await orchestrator.tick();
    // the third stake, 5.07, is above the real snapshot's 4.00 though the demo one holds 10000
    expect(await amountsOf(seed.session.id)).toEqual(['1.00000000', '2.25000000']);
    expect((await intentsOf(seed.session.id)).map((intent) => intent.mode)).toEqual([
      TradeMode.Real,
      TradeMode.Real,
    ]);
    await expectStopped(seed, TradingSessionStopReason.StakeStop, 'insufficient_balance');
    await orchestrator.stop();
  });

  // #552: a session of N cycles ends on its N-th win, never in the middle of a series
  it('G9′ losses never complete a martingale session: two cycles end on the second win', async () => {
    const seed = await seedSession({ settings: martingale(2) });
    const orchestrator = at(80);
    await losses(orchestrator, seed, 2);
    await orchestrator.tick();
    expect(await statusOf(seed)).toBe(TradingSessionStatus.Active);
    expect(await amountsOf(seed.session.id)).toEqual(['1.00000000', '2.25000000', '5.07000000']);
    // the third intent is live: this tick holds it, the win settles it and closes one cycle
    await tradeOnce(orchestrator, seed, MockTradeOutcome.Win);
    await orchestrator.tick();
    expect(await statusOf(seed)).toBe(TradingSessionStatus.Active);
    await tradeOnce(orchestrator, seed, MockTradeOutcome.Win);
    await orchestrator.tick();
    expect(await sessionRow(seed.session.id)).toMatchObject({
      status: TradingSessionStatus.Stopped,
      stopReason: TradingSessionStopReason.Completed,
    });
    expect(await amountsOf(seed.session.id)).toEqual([
      '1.00000000',
      '2.25000000',
      '5.07000000',
      '1.00000000',
    ]);
    expect(linesOf(seed.session.id)).toContainEqual(
      expect.objectContaining({ msg: 'trading session completed', settled: 4, cycles: 2 }),
    );
    await orchestrator.stop();
  });

  it('G10 a settings v2 martingale row still completes on its N-th trade', async () => {
    const seed = await seedSession({ settings: settingsV2Of(SessionStakeStrategy.Martingale, 2) });
    const orchestrator = at(80);
    await losses(orchestrator, seed, 2);
    await orchestrator.tick();
    expect(await sessionRow(seed.session.id)).toMatchObject({
      status: TradingSessionStatus.Stopped,
      stopReason: TradingSessionStopReason.Completed,
    });
    expect(await amountsOf(seed.session.id)).toEqual(['1.00000000', '2.25000000']);
    await orchestrator.stop();
  });

  it('G11 under fixed every trade is a cycle: two losses complete two cycles', async () => {
    const seed = await seedSession({ settings: settingsOf(SessionStakeStrategy.Fixed, 2) });
    const orchestrator = at(80);
    await losses(orchestrator, seed, 2);
    await orchestrator.tick();
    expect(await sessionRow(seed.session.id)).toMatchObject({
      status: TradingSessionStatus.Stopped,
      stopReason: TradingSessionStopReason.Completed,
    });
    expect(await amountsOf(seed.session.id)).toEqual(['1.00000000', '1.00000000']);
    await orchestrator.stop();
  });

  it('G12 a tie does not close the cycle: one cycle ends on the win after it', async () => {
    const seed = await seedSession({ settings: martingale(1) });
    const orchestrator = at(80);
    await losses(orchestrator, seed, 1);
    await tieOnce(orchestrator, seed);
    await orchestrator.tick();
    expect(await statusOf(seed)).toBe(TradingSessionStatus.Active);
    expect(await amountsOf(seed.session.id)).toEqual(['1.00000000', '2.25000000', '2.25000000']);
    await tradeOnce(orchestrator, seed, MockTradeOutcome.Win);
    await orchestrator.tick();
    expect(await sessionRow(seed.session.id)).toMatchObject({
      status: TradingSessionStatus.Stopped,
      stopReason: TradingSessionStopReason.Completed,
    });
    expect(await amountsOf(seed.session.id)).toHaveLength(3);
    await orchestrator.stop();
  });
});

// #670: an H1 session (settings v4) is held between checks; its trades come from the driver (#707),
// here from createSessionIntent directly
describe('an H1 session (#670)', () => {
  // the mock's AAPL takes 5 s trades
  const h1Pair = (patch: Parameters<typeof eurUsd>[0] = {}) =>
    eurUsd({ id: 202, symbol: 'AAPL', minTimeframe: 5, payout: 94, ...patch });
  const h1Settings = (trades = 10, k = 20) => {
    const built = buildH1SessionSettings({
      assetId: 202,
      trades,
      stake: { baseStake: decimalStringSchema.parse('1.00'), stakeScale: 2 },
      maxLossMultiplier: k,
    });
    if (!built.success) throw new Error('H1 fixture settings do not parse');
    return built.data;
  };
  // a signal source that must not be asked
  const noSignals = () => {
    const source = signalsOf(() => {
      throw new Error('the H1 branch asked the signal');
    });
    return source;
  };
  const h1Orchestrator = (pairs: PairsSource = pairsOf(fresh([h1Pair()]))) => {
    const signals = noSignals();
    return { signals, orchestrator: orchestratorOf({ signals, pairs }) };
  };
  const driverTrade = async (
    seed: Awaited<ReturnType<typeof seedSession>>,
    step: number,
    outcome: MockTradeOutcome,
  ) => {
    const { intent } = await createSessionIntent(tmp.db, {
      sessionId: seed.session.id,
      step,
      telegramUserId: seed.telegramUserId,
      brokerAccountId: seed.brokerAccountId,
      mode: TradeMode.Demo,
      assetId: 202,
      amount: decimalStringSchema.parse('1.00'),
      action: TradeAction.Up,
      durationSec: 5,
      decision: null,
    });
    expect(await processIntent(intent.id)).toBe('accepted');
    await settle(seed, intent.id, outcome);
    return intent;
  };
  const stopOf = async (id: string) => {
    const row = await sessionRow(id);
    return { status: row.status, stopReason: row.stopReason };
  };
  const ACTIVE = { status: TradingSessionStatus.Active, stopReason: null };

  it('H1-O1 holds without asking the signal and moves last_decision_at', async () => {
    const seed = await seedSession({ settings: h1Settings() });
    const { signals, orchestrator } = h1Orchestrator();
    await orchestrator.tick();
    expect(signals.calls).toEqual([]);
    expect(await stopOf(seed.session.id)).toEqual(ACTIVE);
    expect(await intentsOf(seed.session.id)).toEqual([]);
    expect((await sessionRow(seed.session.id)).lastDecisionAt).not.toBeNull();
    expect(linesOf(seed.session.id)).toContainEqual(
      expect.objectContaining({ level: 20, msg: 'trading session waits for the H1 driver' }),
    );
    await orchestrator.stop();
  });

  it('H1-O2 completes after N settled trades, a loss counted', async () => {
    const seed = await seedSession({ settings: h1Settings(2) });
    await driverTrade(seed, 1, MockTradeOutcome.Win);
    const { orchestrator } = h1Orchestrator();
    await orchestrator.tick();
    expect(await stopOf(seed.session.id)).toEqual(ACTIVE);
    await driverTrade(seed, 2, MockTradeOutcome.Loss);
    advance(CONFIG.h1CheckMs);
    await orchestrator.tick();
    expect(await stopOf(seed.session.id)).toEqual({
      status: TradingSessionStatus.Stopped,
      stopReason: TradingSessionStopReason.Completed,
    });
    await orchestrator.stop();
  });

  it('H1-O3 stops with max_session_loss_exceeded when the next stake would pass maxLoss', async () => {
    // k = 2: after one loss of 1, -1 - 1 = -2 is not below -2, the session goes on
    const within = await seedSession({ settings: h1Settings(10, 2) });
    await driverTrade(within, 1, MockTradeOutcome.Loss);
    // k = 1: -1 - 1 = -2 is below -1
    const past = await seedSession({ settings: h1Settings(10, 1) });
    await driverTrade(past, 1, MockTradeOutcome.Loss);
    const { orchestrator } = h1Orchestrator();
    await orchestrator.tick();
    expect(await stopOf(within.session.id)).toEqual(ACTIVE);
    expect(await stopOf(past.session.id)).toEqual({
      status: TradingSessionStatus.Stopped,
      stopReason: TradingSessionStopReason.MaxSessionLossExceeded,
    });
    expect(linesOf(past.session.id)).toContainEqual(
      expect.objectContaining({ reason: 'max_session_loss_exceeded', maxLoss: '1' }),
    );
    await orchestrator.stop();
  });

  it('H1-O4 the hour ends it with timeout', async () => {
    const seed = await seedSession({
      settings: h1Settings(),
      startedAt: new Date(Date.now() - SESSION_MAX_DURATION_MS - 60_000),
    });
    const { orchestrator } = h1Orchestrator();
    await orchestrator.tick();
    expect(await stopOf(seed.session.id)).toEqual({
      status: TradingSessionStatus.Stopped,
      stopReason: TradingSessionStopReason.Timeout,
    });
    await orchestrator.stop();
  });

  it.each([
    ['a pair outside the catalog', [eurUsd({ minTimeframe: 5 })]],
    ['a pair that refuses 5 s', [h1Pair({ minTimeframe: 15 })]],
  ])('H1-O5 %s stops it with pair_unavailable', async (_label, listed) => {
    const seed = await seedSession({ settings: h1Settings() });
    const { orchestrator } = h1Orchestrator(pairsOf(fresh(listed)));
    await orchestrator.tick();
    expect(await stopOf(seed.session.id)).toEqual({
      status: TradingSessionStatus.Stopped,
      stopReason: TradingSessionStopReason.PairUnavailable,
    });
    await orchestrator.stop();
  });

  it('H1-O6 a pair closed past the no-signal limit holds it: no no_signal_timeout', async () => {
    const seed = await seedSession({
      settings: h1Settings(),
      startedAt: new Date(Date.now() - sessionNoSignalTimeoutMs(5) * 3),
    });
    const { signals, orchestrator } = h1Orchestrator(
      pairsOf(fresh([h1Pair({ scheduledUntil: clock + 30_000 })])),
    );
    await orchestrator.tick();
    expect(signals.calls).toEqual([]);
    expect(await stopOf(seed.session.id)).toEqual(ACTIVE);
    expect(msgsOf(seed.session.id)).toContain('trading session waits for the pair to open');
    await orchestrator.stop();
  });

  it('H1-O7 an open pair past the no-signal limit with a payout below 94 still holds', async () => {
    const seed = await seedSession({
      settings: h1Settings(),
      startedAt: new Date(Date.now() - sessionNoSignalTimeoutMs(5) * 3),
    });
    const { orchestrator } = h1Orchestrator(pairsOf(fresh([h1Pair({ payout: 50 })])));
    await orchestrator.tick();
    expect(await stopOf(seed.session.id)).toEqual(ACTIVE);
    await orchestrator.stop();
  });

  it('H1-O8 the sizer and the snapshot still stop it: below the minimum, no snapshot', async () => {
    const poor = await seedSession({ settings: h1Settings(), demo: '0.50' });
    const blind = await seedSession({ settings: h1Settings(), snapshot: false });
    const { orchestrator } = h1Orchestrator();
    await orchestrator.tick();
    expect(await stopOf(poor.session.id)).toEqual({
      status: TradingSessionStatus.Stopped,
      stopReason: TradingSessionStopReason.StakeStop,
    });
    expect(await stopOf(blind.session.id)).toEqual({
      status: TradingSessionStatus.Stopped,
      stopReason: TradingSessionStopReason.BalanceUnavailable,
    });
    await orchestrator.stop();
  });

  it('H1-O9 two intents rejected past their entry window stop it with rejected_twice', async () => {
    const seed = await seedSession({ settings: h1Settings() });
    for (const step of [1, 2]) {
      const { intent } = await createSessionIntent(tmp.db, {
        sessionId: seed.session.id,
        step,
        telegramUserId: seed.telegramUserId,
        brokerAccountId: seed.brokerAccountId,
        mode: TradeMode.Demo,
        assetId: 202,
        amount: decimalStringSchema.parse('1.00'),
        action: TradeAction.Up,
        durationSec: 5,
        decision: null,
        submitDeadlineAt: new Date(Date.now() - 1_000),
      });
      expect(await processIntent(intent.id)).toBe('rejected');
    }
    const { orchestrator } = h1Orchestrator();
    await orchestrator.tick();
    expect(await stopOf(seed.session.id)).toEqual({
      status: TradingSessionStatus.Stopped,
      stopReason: TradingSessionStopReason.RejectedTwice,
    });
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

  // a signal held until release(); an abort answers at once, as the backend client does
  function gatedSignals() {
    let release = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    const signals = signalsOf(
      (signal) =>
        new Promise<SignalOutcome>((resolve) => {
          void released.then(() => resolve({ ok: true, response: signalAnswer(TradeAction.Up) }));
          signal?.addEventListener('abort', () =>
            resolve({ ok: false, reason: 'backend_unreachable' }),
          );
        }),
    );
    return { signals, release };
  }

  it('WK1 a wake after the settlement makes the next step within a second, with no tick called', async () => {
    const seed = await seedSession();
    const signals = signalsOf();
    const orchestrator = wakeful({ signals, log: tagged('WK1') });
    await tradeOnce(orchestrator, seed);
    const before = ticksOf('WK1').length;
    const wokenAt = Date.now();
    orchestrator.wake();
    await until('step 2', async () => (await intentsOf(seed.session.id)).length === 2);
    expect(Date.now() - wokenAt).toBeLessThan(1_000);
    await until('the tick line', () => ticksOf('WK1').length === before + 1);
    expect((await intentsOf(seed.session.id))[1]!.clientRequestId).toBe(
      `session:${seed.session.id}:2`,
    );
    expect(signals.calls).toHaveLength(2);
    expect(ticksOf('WK1').slice(before)).toEqual([
      expect.objectContaining({ runnable: 1, created: 1, woken: 1 }),
    ]);
    await orchestrator.stop();
  });

  it('WK2 wakes during a tick merge into one more tick: one intent, one decision row', async () => {
    const seed = await seedSession();
    const { signals, release } = gatedSignals();
    const orchestrator = wakeful({ signals, log: tagged('WK2') });
    const first = orchestrator.tick();
    await until('the signal call', () => signals.calls.length === 1);
    orchestrator.wake();
    orchestrator.wake();
    orchestrator.wake();
    release();
    await first;
    await until('the follow-up tick', () => ticksOf('WK2').length >= 2);
    await orchestrator.stop();
    expect(ticksOf('WK2')).toEqual([
      expect.objectContaining({ runnable: 1, created: 1, woken: 0 }),
      // the live intent keeps the session out of the scan
      expect.objectContaining({ runnable: 0, attempted: 0, woken: 3 }),
    ]);
    expect(await intentsOf(seed.session.id)).toHaveLength(1);
    expect(await decisionsOf(seed.session.id)).toHaveLength(1);
    expect(signals.calls).toHaveLength(1);
  });

  it('WK3 a lost wake loses nothing: the next tick makes the step', async () => {
    const seed = await seedSession();
    const orchestrator = wakeful({ log: tagged('WK3') });
    await tradeOnce(orchestrator, seed);
    await orchestrator.tick();
    expect((await intentsOf(seed.session.id)).map((i) => i.clientRequestId)).toEqual([
      `session:${seed.session.id}:1`,
      `session:${seed.session.id}:2`,
    ]);
    expect(ticksOf('WK3').at(-1)).toMatchObject({ created: 1, woken: 0 });
    await orchestrator.stop();
  });

  it('WK4a a wake after stop() is a no-op and does not throw', async () => {
    const seed = await seedSession();
    const orchestrator = wakeful({ log: tagged('WK4a') });
    await orchestrator.stop();
    expect(() => orchestrator.wake()).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(ticksOf('WK4a')).toEqual([]);
    expect(await intentsOf(seed.session.id)).toEqual([]);
  });

  it('WK4b a wake during a tick that stop() ends runs no deferred tick', async () => {
    const seed = await seedSession();
    const { signals } = gatedSignals();
    const orchestrator = wakeful({
      signals,
      config: { attemptTimeoutMs: 5_000 },
      log: tagged('WK4b'),
    });
    const first = orchestrator.tick();
    await until('the signal call', () => signals.calls.length === 1);
    orchestrator.wake();
    await orchestrator.stop();
    await first;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(ticksOf('WK4b')).toEqual([expect.objectContaining({ attempted: 1, woken: 0 })]);
    expect(signals.calls).toHaveLength(1);
    expect(await intentsOf(seed.session.id)).toEqual([]);
    expect(await sessionRow(seed.session.id)).toMatchObject({
      status: TradingSessionStatus.Active,
      lastDecisionAt: null,
    });
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
  const LIMIT = sessionNoSignalTimeoutMs(60);
  const WAITS = 'trading session waits for the balance';
  const demoBalance = (brokerAccountId: string, available: string) =>
    applyBalanceEvent(tmp.db, {
      brokerAccountId,
      mode: TradeMode.Demo,
      balance: balance(available),
    });
  // step 1 opened (the stake held: 1.50 - 1.00 on the snapshot), then won: the settlement is newer
  // than the snapshot, which still lacks the payout - the live order of close_trade.success and
  // update_balance
  const wonBeforePayout = async (orchestrator: ReturnType<typeof orchestratorOf>) => {
    const seed = await seedSession({ demo: '1.50' });
    await orchestrator.tick();
    const [intent] = await intentsOf(seed.session.id);
    expect(await processIntent(intent!.id)).toBe('accepted');
    await demoBalance(seed.brokerAccountId, '0.50');
    await settle(seed, intent!.id, MockTradeOutcome.Win);
    return seed;
  };
  const stepTwoRows = async (sessionId: string) =>
    (await decisionsOf(sessionId)).filter((row) => row.step === 2);

  it('BW1 a woken attempt on the balance before the payout waits; the payout makes step 2', async () => {
    const orchestrator = orchestratorOf();
    const seed = await wonBeforePayout(orchestrator);
    orchestrator.wake();
    await until('the wait', () => msgsOf(seed.session.id).includes(WAITS));
    expect(await sessionRow(seed.session.id)).toMatchObject({
      status: TradingSessionStatus.Active,
      stopReason: null,
    });
    expect(await intentsOf(seed.session.id)).toHaveLength(1);
    expect(await stepTwoRows(seed.session.id)).toEqual([]);
    expect(linesOf(seed.session.id).find((line) => line.msg === WAITS)).toMatchObject({
      level: 30,
      step: 2,
    });
    await demoBalance(seed.brokerAccountId, '2.40');
    await orchestrator.tick();
    expect((await intentsOf(seed.session.id)).map((intent) => intent.amount)).toEqual([
      '1.00000000',
      '1.00000000',
    ]);
    await orchestrator.stop();
  });

  it('BW2 a balance written after the settlement that is short stops the session', async () => {
    const orchestrator = orchestratorOf();
    const seed = await wonBeforePayout(orchestrator);
    await demoBalance(seed.brokerAccountId, '0.50');
    await orchestrator.tick();
    expect(await sessionRow(seed.session.id)).toMatchObject({
      status: TradingSessionStatus.Stopped,
      stopReason: TradingSessionStopReason.StakeStop,
    });
    expect(linesOf(seed.session.id)).toContainEqual(
      expect.objectContaining({
        msg: 'trading session stopped',
        stopReason: 'insufficient_balance',
      }),
    );
    expect(msgsOf(seed.session.id)).not.toContain(WAITS);
    await orchestrator.stop();
  });

  it('BW3 past the no-signal limit the balance behind the settlement stops the session', async () => {
    const orchestrator = orchestratorOf();
    const seed = await wonBeforePayout(orchestrator);
    // the settle row keeps its time, so the snapshot stays behind; an UPDATE without status
    // runs no transition trigger
    await tmp.db
      .update(tradingSessions)
      .set({ startedAt: sql`now() - (${LIMIT + 5_000}::int * interval '1 millisecond')` })
      .where(eq(tradingSessions.id, seed.session.id));
    await tmp.db.execute(
      sql`update trade_intents set updated_at = now() - (${LIMIT + 5_000}::int * interval '1 millisecond') where trading_session_id = ${seed.session.id}`,
    );
    await orchestrator.tick();
    expect(await sessionRow(seed.session.id)).toMatchObject({
      status: TradingSessionStatus.Stopped,
      stopReason: TradingSessionStopReason.StakeStop,
    });
    expect(linesOf(seed.session.id)).toContainEqual(
      expect.objectContaining({
        msg: 'trading session stopped',
        stopReason: 'insufficient_balance',
      }),
    );
    expect(msgsOf(seed.session.id)).not.toContain(WAITS);
    await orchestrator.stop();
  });
});

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
    const tickLines = new Set(['trading session tick', 'trading session tick failed']);
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
