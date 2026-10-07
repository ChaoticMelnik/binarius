import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { asc, eq, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import pino from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createBrokerRestClient, TradeListStatus } from '@binarius/broker-rest';
import { MockTradeOutcome, startMockBroker, type MockBroker } from '@binarius/mock-broker';
import {
  isClosedTrade,
  SESSION_MAX_DURATION_MS,
  TradeAction,
  TradeIntentStatus,
  TradeMode,
  TradingSessionStatus,
  TradingSessionStopReason,
  type BrokerUser,
  type DecimalString,
} from '@binarius/shared';
import { until } from '@binarius/shared/testing';
import {
  brokerAccounts,
  brokerTrades,
  createDb,
  createSessionIntent,
  openTrading,
  readSessionHistory,
  settleClosedTrades,
  stopTradingSession,
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
import { noTradeSessions } from '../broker/trade-session';
import { processIntentJob } from '../intents/processor';
import { createTradeCommandExecutor } from '../intents/trade-command-executor';
import type { PairsOutcome, PairsSource, SignalOutcome, SignalSource } from './backend';
import { TRADING_SESSION_CANDLE_SLACK_MS, type SessionOrchestratorConfig } from './config';
import { createSessionOrchestrator } from './orchestrator';
import { eurUsd, fetchFailedAnswer, noSignalAnswer, signalAnswer } from './testing';

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
  maxDurationMs: SESSION_MAX_DURATION_MS,
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
}: {
  signals?: SignalSource;
  pairs?: PairsSource;
  db?: Db;
  config?: Partial<SessionOrchestratorConfig>;
} = {}) {
  return createSessionOrchestrator({
    db,
    signals,
    pairs,
    logger,
    config: { ...CONFIG, ...config },
    now,
  });
}

// the access token per account for the REST open; the executor is the production composition
const accessTokens = new Map<string, string>();
const rest = () => createBrokerRestClient({ baseUrl: broker.url });
const executor = () =>
  createTradeCommandExecutor({
    sessions: noTradeSessions,
    rest: rest(),
    tokens: {
      accessToken: (accountId) => {
        const accessToken = accessTokens.get(accountId);
        return Promise.resolve(
          accessToken === undefined
            ? { ok: false, reason: 'account_not_found' }
            : { ok: true, accessToken },
        );
      },
    },
    logger,
  });

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
  const user = await seedUser(tmp.db, { balance: tokens });
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
  return { ...user, brokerAccountId, accessToken, session };
}

const intentsOf = (sessionId: string) =>
  tmp.db
    .select()
    .from(tradeIntents)
    .where(eq(tradeIntents.tradingSessionId, sessionId))
    .orderBy(asc(tradeIntents.createdAt), asc(tradeIntents.id));

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
      config: { intentMaxAgeMs: 60_000, submitAckTimeoutMs: 2_000, staleSubmittingMs: 60_000 },
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
) {
  await orchestrator.tick();
  const intents = await intentsOf(seed.session.id);
  const intent = intents.at(-1)!;
  expect(intent.status).toBe(TradeIntentStatus.Queued);
  expect(await processIntent(intent.id)).toBe('accepted');
  await settle(seed, intent.id);
  return intent;
}

describe('the attempt and the sequence (#287)', () => {
  it('E1 trades five times one after another, then completes', async () => {
    const seed = await seedSession();
    const signals = signalsOf();
    const orchestrator = orchestratorOf({ signals });

    await orchestrator.tick();
    let intents = await intentsOf(seed.session.id);
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      status: TradeIntentStatus.Queued,
      amount: '1.00000000',
      action: TradeAction.Up,
      mode: TradeMode.Demo,
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
    expect(await intentsOf(seed.session.id)).toHaveLength(5);
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

  it('E6 a halted account stops the session before any backend call', async () => {
    const seed = await seedSession();
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
  });

  it('E7 the deadline stops a session even while its intent is live', async () => {
    const seed = await seedSession({ startedAt: new Date(Date.now() - 61 * 60_000) });
    await createSessionIntent(tmp.db, {
      sessionId: seed.session.id,
      step: 1,
      telegramUserId: seed.telegramUserId,
      brokerAccountId: seed.brokerAccountId,
      mode: TradeMode.Demo,
      assetId: 101,
      amount: '1' as DecimalString,
      action: TradeAction.Up,
      durationSec: 60,
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
  });

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
  it('K1 a closed switch stops the session before any backend call', async () => {
    const seed = await seedSession();
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
      expect.objectContaining({ level: 40, msg: 'trading session stopped', reason: 'kill_switch' }),
    );
    await orchestrator.stop();
  });

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
