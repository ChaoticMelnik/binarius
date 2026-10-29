import { eq, sql } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildH1SessionSettings,
  decimalStringSchema,
  h1ShadowEntrySchema,
  logOptions,
  toBinaryPair,
  TradeIntentStatus,
  TradeMode,
  TradingSessionStopReason,
  type PairsCatalogView,
  SessionStakeStrategy,
} from '@binarius/shared';
import { closedTradeFor, openTradeFor, until } from '@binarius/shared/testing';
import {
  createSessionIntent,
  createTradingSession,
  journalEntryOf,
  listActiveH1Sessions,
  listPendingSessionNotices,
  markIntentAccepted,
  outboxEvents,
  readSessionBalance,
  readSessionHistory,
  readTradeLogPage,
  recordSignalDecision,
  SESSION_NOTICE_CHANNEL,
  settleIntent,
  signalDecisions,
  stopTradingSession,
  takeIntent,
  tradeIntents,
  tradingSessions,
  type TradeIntentRow,
} from '@binarius/db';
import {
  createTempDatabase,
  seedBalanceSnapshot,
  seedBrokerTradeFor,
  seedUserWithAccount,
  type TempDatabase,
} from '@binarius/db/testing';
import { createSessionNoticeListener } from '../trading/session-notice-listener';
import { replayH1Entry } from '@binarius/signal';
import type { ClosedSecond } from '../market-data/seconds';
import {
  createH1Driver,
  h1ShownDecisionInput,
  h1ShownStartDecisionInput,
  type H1Driver,
  type H1DriverDeps,
} from './driver';

// The driver against the real operations (#707, docs/h1.md -> The driver) on a temporary migrated
// database: an account's v5 session (#828), a scripted series whose ramp from F signals up.
const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for apps/backend integration tests (see README → Test database)',
  );
}

let tmp: TempDatabase;
beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
});
afterAll(() => tmp.drop());

const ASSET = 202;
// a budget the case's own steps fit in: the take below runs on the database's clock
const BUDGET_MS = 5_000;

function scriptedSeries() {
  const prices = new Map<number, number>();
  let first = Infinity;
  let last = -Infinity;
  const listeners = new Set<(closed: ClosedSecond) => void>();
  const close = (second: number) =>
    second >= first && second <= last ? (prices.get(second) ?? NaN) : NaN;
  const api: H1DriverDeps['series'] = {
    onClosed(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    advance: () => {},
    window(_assetId, f, lengthSec) {
      const closes = new Float64Array(lengthSec);
      let complete = true;
      for (let i = 0; i < lengthSec; i++) {
        const second = f - (lengthSec - 1 - i) * 1_000;
        closes[i] = close(second);
        if (second < first || second > last) complete = false;
      }
      return { closes, complete };
    },
    lastTickOf: (_assetId, f) => {
      const price = close(f);
      return Number.isNaN(price) ? undefined : { price, timestamp: f - 100, receivedAtMs: f - 60 };
    },
    digitsOf: () => 5,
    lastClosed: (assetId) =>
      last === -Infinity
        ? undefined
        : { assetId, second: last, closedBy: 'tick', closedAtMs: last + 300 },
  };
  return {
    api,
    feed(from: number, values: readonly number[]) {
      values.forEach((price, i) => {
        const second = from + i * 1_000;
        if (first === Infinity) first = second;
        prices.set(second, price);
        last = second;
        for (const listener of listeners) {
          listener({ assetId: ASSET, second, closedBy: 'tick', closedAtMs: second + 300 });
        }
      });
    },
  };
}

const catalog: PairsCatalogView = {
  pairs: [
    toBinaryPair({
      id: ASSET,
      symbol: 'EUR/USD',
      is_otc: false,
      type: 'currency',
      digits: 5,
      payout: 96,
      max_payout: 96,
      min_timeframe: 5,
      max_timeframe: 3600,
      scheduled_until: 0,
    }),
  ],
  fetchedAt: 0,
  ageMs: 0,
  fresh: true,
};

// an account's v5 session: the bot's start since #828
async function botSession() {
  const seed = await seedUserWithAccount(tmp.db, { balance: 50n });
  // the sizer's balance (#775)
  await seedBalanceSnapshot(tmp.db, seed.brokerAccountId);
  const built = buildH1SessionSettings({
    assetId: ASSET,
    cycles: 5,
    stake: { baseStake: decimalStringSchema.parse('1'), stakeScale: 2 },
    strategy: SessionStakeStrategy.Martingale,
  });
  if (!built.success) throw new Error('H1 fixture settings');
  const session = await createTradingSession(
    tmp.db,
    {
      telegramUserId: seed.telegramUserId,
      brokerAccountId: seed.brokerAccountId,
      mode: TradeMode.Demo,
      settings: built.data,
    },
    { demoOnly: false },
  );
  return { seed, session };
}

function driverOn(series: ReturnType<typeof scriptedSeries>) {
  const wakes = { n: 0 };
  const driver: H1Driver = createH1Driver({
    series: series.api,
    catalog: { read: () => catalog },
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
    config: {
      scanMs: 60_000,
      tickMs: 60_000,
      logMs: 60_000,
      submitBudgetMs: BUDGET_MS,
      startMaxAgeMs: 1_600,
    },
  });
  return { driver, wakes };
}

// 300 flat seconds, then one ramp second at F
const RAMP = [...Array<number>(300).fill(1.1), 1.1001];

async function tradeOnce() {
  const { seed, session } = await botSession();
  const series = scriptedSeries();
  const { driver, wakes } = driverOn(series);
  driver.start();
  await driver.scan();
  const t = Math.floor(Date.now() / 1000) * 1000 - 300_000;
  const f = t + 300_000;
  series.feed(t, RAMP);
  await until('the driver to wake the publisher', () => Promise.resolve(wakes.n === 1));
  await driver.stop();
  return { seed, session, f, wakes };
}

describe('the H1 driver on the database (#707)', () => {
  it('H1-DB1: the intent carries the entry hold, the deadline and its decision row; the outbox event is there', async () => {
    const { session, f } = await tradeOnce();
    const [intent] = await tmp.db
      .select()
      .from(tradeIntents)
      .where(eq(tradeIntents.tradingSessionId, session.id));
    expect(intent).toMatchObject({
      status: 'queued',
      assetId: ASSET,
      action: 'up',
      amount: '1.00000000',
      durationSec: 5,
      clientRequestId: `session:${session.id}:1`,
    });
    const [row] = await tmp.db
      .select()
      .from(signalDecisions)
      .where(eq(signalDecisions.id, intent!.signalDecisionId!));
    expect(row).toMatchObject({
      context: 'session',
      tradingSessionId: session.id,
      step: 1,
      version: 'h1',
      interval: null,
      decidedAtMs: f,
      outcome: 'intent',
      ticksUntilMs: null,
      params: expect.objectContaining({ set: 'session', entryDelaySec: 1, expirySec: 5 }),
    });
    // #836: the second closed at f + 300, held 1 s; the budget runs from the later of the hold
    // and the creation (the real clock here)
    expect(intent!.submitNotBeforeAt!.getTime()).toBe(f + 1_300);
    const budgetFrom = intent!.submitDeadlineAt!.getTime() - BUDGET_MS;
    expect(budgetFrom).toBeGreaterThanOrEqual(f + 1_300);
    expect(budgetFrom).toBeLessThanOrEqual(Math.max(f + 1_300, Date.now()));
    const events = await tmp.db
      .select({ id: outboxEvents.id })
      .from(outboxEvents)
      .where(eq(outboxEvents.intentId, intent!.id));
    expect(events).toHaveLength(1);
  });

  it("H1-DB2′: the export replays the driver's row to its own decision", async () => {
    const { session, f } = await tradeOnce();
    const [intent] = await tmp.db
      .select()
      .from(tradeIntents)
      .where(eq(tradeIntents.tradingSessionId, session.id));
    await seedBrokerTradeFor(tmp.db, intent!, {
      openPrice: 1.1001,
      openTimestamp: f + 800,
      profit: decimalStringSchema.parse('0.92'),
      closePrice: 1.1006,
    });
    const page = await readTradeLogPage(tmp.db, {
      from: new Date(0),
      to: new Date(Date.now() + 60_000),
      limit: 10,
      sessionId: session.id,
    });
    const own = page.rows.filter((row) => row.decision.context === 'session');
    expect(own).toHaveLength(1);
    const entry = h1ShadowEntrySchema.parse(journalEntryOf(own[0]!.decision));
    expect(replayH1Entry(entry)).toEqual(own[0]!.decision.decision);
  });
});

describe('the shown start on the database (#829)', () => {
  // the builders' rows against every CHECK of signal_decisions: here and not in packages/db, so a
  // change of the builders is what the case runs
  it('SD20: the three h1-start rows pass the CHECKs and come back as written', async () => {
    const { seed, session } = await botSession();
    const second = Date.now() - 6_000;
    const facts = {
      assetId: ASSET,
      shown: {
        action: 'up' as const,
        second,
        decidedAt: second + 400,
        shownAtMs: second + 2_000,
        source: 'list' as const,
      },
      takenAtMs: second + 5_000,
      payout: 96,
      brokerAccountId: seed.brokerAccountId,
    };
    const inputs = [
      h1ShownStartDecisionInput(facts, { sessionId: session.id }),
      h1ShownStartDecisionInput(facts, { refusal: 'trading_paused' }),
      h1ShownDecisionInput({ ...facts, sessionId: session.id }, 1, 'intent', null),
    ];
    for (const input of inputs) {
      const { id } = await recordSignalDecision(tmp.db, input);
      const [row] = await tmp.db.select().from(signalDecisions).where(eq(signalDecisions.id, id));
      expect(row).toMatchObject({ ...input, series: [] });
    }
    expect(inputs.map((one) => [one.context, one.outcome, one.tradingSessionId, one.step])).toEqual(
      [
        ['session_start', 'started', session.id, null],
        ['session_start', 'refused', null, null],
        ['session', 'intent', session.id, 1],
      ],
    );
  });

  it('H1-DB8: the shown Шаг 1: the intent without a deadline, its h1-start row by signal_decision_id, the outbox event', async () => {
    const { seed, session } = await botSession();
    const { driver, wakes } = driverOn(scriptedSeries());
    const second = Date.now() - 4_000;
    driver.adopt(
      {
        id: session.id,
        brokerAccountId: session.brokerAccountId,
        mode: session.mode,
        telegramUserId: seed.telegramUserId,
        settings: session.settings,
        startedAt: session.startedAt,
      },
      {
        shown: {
          action: 'down',
          second,
          decidedAt: second + 400,
          shownAtMs: second + 1_000,
          source: 'analysis',
        },
        pair: { payout: 96, symbol: 'EUR/USD' },
      },
    );
    await until('the driver to wake the publisher', () => Promise.resolve(wakes.n === 1));
    await driver.stop();
    const [intent] = await tmp.db
      .select()
      .from(tradeIntents)
      .where(eq(tradeIntents.tradingSessionId, session.id));
    expect(intent).toMatchObject({
      status: 'queued',
      action: 'down',
      amount: '1.00000000',
      submitDeadlineAt: null,
      submitNotBeforeAt: new Date(second + 1_400),
      clientRequestId: `session:${session.id}:1`,
    });
    const [row] = await tmp.db
      .select()
      .from(signalDecisions)
      .where(eq(signalDecisions.id, intent!.signalDecisionId!));
    expect(row).toMatchObject({
      context: 'session',
      tradingSessionId: session.id,
      step: 1,
      version: 'h1-start',
      kind: 'signal',
      action: 'down',
      decidedAtMs: second,
      outcome: 'intent',
      digits: null,
      series: [],
      source: { kind: 'shown', source: 'analysis', shownAtMs: second + 1_000 },
    });
    const events = await tmp.db
      .select({ id: outboxEvents.id })
      .from(outboxEvents)
      .where(eq(outboxEvents.intentId, intent!.id));
    expect(events).toHaveLength(1);
  });
});

// #745, #775, #828: the start route writes the same v5 for every account; the driver lists it
describe("the driver's list and a session of the bot's settings (#745, #828)", () => {
  it('H1-DB3′: listed with its owner', async () => {
    const seed = await seedUserWithAccount(tmp.db, { balance: 50n });
    const built = buildH1SessionSettings({
      assetId: ASSET,
      cycles: 5,
      stake: { baseStake: decimalStringSchema.parse('1'), stakeScale: 2 },
      strategy: SessionStakeStrategy.Martingale,
    });
    if (!built.success) throw new Error('H1 fixture settings');
    const session = await createTradingSession(
      tmp.db,
      {
        telegramUserId: seed.telegramUserId,
        brokerAccountId: seed.brokerAccountId,
        mode: TradeMode.Demo,
        settings: built.data,
        startSignalAction: 'up',
      },
      { demoOnly: false },
    );
    const listed = (await listActiveH1Sessions(tmp.db)).find((row) => row.id === session.id);
    expect(listed).toMatchObject({ telegramUserId: seed.telegramUserId, settings: built.data });
  });
});

// #775: the repeat step on the settlement's real notification, and the waiting row the sender reads
describe('the H1 driver as a regular session on the database (#775)', () => {
  async function settleLost(intent: TradeIntentRow) {
    const taken = (await takeIntent(tmp.db, {
      id: intent.id,
      expectedVersion: intent.version,
      maxAgeMs: 60_000,
    }))!;
    const open = openTradeFor(intent, { openPrice: 1.1001 });
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
        trade: closedTradeFor(open, {
          profit: decimalStringSchema.parse('-1.00'),
          closePrice: 1.1,
        }),
      }),
    );
  }
  // the earlier cases' sessions stay active on the same pair: each case trades its own alone
  beforeEach(async () => {
    for (const listed of await listActiveH1Sessions(tmp.db)) {
      await stopTradingSession(tmp.db, {
        id: listed.id,
        reason: TradingSessionStopReason.UserStopped,
      });
    }
  });
  const intentsOf = (sessionId: string) =>
    tmp.db
      .select()
      .from(tradeIntents)
      .where(eq(tradeIntents.tradingSessionId, sessionId))
      .orderBy(tradeIntents.createdAt);

  it('H1-DB4: a lost Шаг 1 settled -> the LISTEN round trip -> Шаг 2 in its direction, no deadline', async () => {
    const { session } = await botSession();
    const series = scriptedSeries();
    const { driver, wakes } = driverOn(series);
    const lines: string[] = [];
    const listener = createSessionNoticeListener({
      pool: tmp.pool,
      channel: SESSION_NOTICE_CHANNEL,
      onNotification: (payload) => driver.notice(payload),
      logger: pino(logOptions('info'), { write: (line: string) => void lines.push(line) }),
    });
    try {
      driver.start();
      await driver.scan();
      listener.start();
      await until('the listener', () =>
        Promise.resolve(lines.some((line) => line.includes('listening'))),
      );
      const t = Math.floor(Date.now() / 1000) * 1000 - 300_000;
      series.feed(t, RAMP);
      await until('Шаг 1', () => Promise.resolve(wakes.n === 1));
      const [first] = await intentsOf(session.id);
      await settleLost(first!);
      await until('Шаг 2', async () => (await intentsOf(session.id)).length === 2);
      const [, second] = await intentsOf(session.id);
      expect(second).toMatchObject({
        status: 'queued',
        action: 'up',
        durationSec: 5,
        submitDeadlineAt: null,
        submitNotBeforeAt: null,
        clientRequestId: `session:${session.id}:2`,
      });
      expect(Number(second!.amount)).toBeGreaterThan(1);
      const [row] = await tmp.db
        .select()
        .from(signalDecisions)
        .where(eq(signalDecisions.id, second!.signalDecisionId!));
      expect(row).toMatchObject({
        context: 'session',
        step: 2,
        version: 'h1-repeat',
        kind: 'signal',
        action: 'up',
        outcome: 'intent',
        source: { kind: 'settlement', trigger: 'notice' },
        series: [],
      });
      const events = await tmp.db
        .select({ id: outboxEvents.id })
        .from(outboxEvents)
        .where(eq(outboxEvents.intentId, second!.id));
      expect(events).toHaveLength(1);
      expect(wakes.n).toBe(2);
    } finally {
      await listener.stop();
      await driver.stop();
    }
  });

  it("H1-DB5: the driver's no_signal row makes the session wait: the sender lists it waitingDue", async () => {
    const { session } = await botSession();
    await tmp.db
      .update(tradingSessions)
      .set({ statusMessageId: 7 })
      .where(eq(tradingSessions.id, session.id));
    const series = scriptedSeries();
    const { driver } = driverOn(series);
    try {
      driver.start();
      await driver.scan();
      const t = Math.floor(Date.now() / 1000) * 1000 - 300_000;
      series.feed(t, Array<number>(301).fill(1.1));
      const waiting = async () =>
        (await listPendingSessionNotices(tmp.db, { limit: 100, exclude: [] })).find(
          (row) => row.sessionId === session.id,
        );
      await until('the waiting row', async () => (await waiting())?.waitingDue === true);
      const rows = await tmp.db
        .select()
        .from(signalDecisions)
        .where(eq(signalDecisions.tradingSessionId, session.id));
      expect(rows.filter((row) => row.context === 'session')).toEqual([
        expect.objectContaining({
          kind: 'no_signal',
          outcome: 'no_signal',
          version: 'h1',
          step: 1,
        }),
      ]);
    } finally {
      await driver.stop();
    }
  });

  it('H1-DB6: the 100th decided second of a session past the limit stops it no_signal_timeout, after its waiting row', async () => {
    const { session } = await botSession();
    await tmp.db.execute(
      sql`update trading_sessions set started_at = now() - interval '10 minutes' where id = ${session.id}`,
    );
    const series = scriptedSeries();
    const { driver } = driverOn(series);
    const rowsOf = async () =>
      (
        await tmp.db
          .select()
          .from(signalDecisions)
          .where(eq(signalDecisions.tradingSessionId, session.id))
          .orderBy(signalDecisions.decidedAtMs)
      ).filter((row) => row.context === 'session');
    const stateOf = async () =>
      (
        await tmp.db
          .select({
            status: tradingSessions.status,
            stopReason: tradingSessions.stopReason,
            endedAt: tradingSessions.endedAt,
          })
          .from(tradingSessions)
          .where(eq(tradingSessions.id, session.id))
      )[0]!;
    try {
      driver.start();
      await driver.scan();
      const t = Math.floor(Date.now() / 1000) * 1000 - 300_000;
      const f = t + 300_000;
      series.feed(t, Array<number>(301).fill(1.1));
      await until('the waiting row', async () => (await rowsOf()).length === 1);
      series.feed(f + 1_000, Array<number>(98).fill(1.1));
      expect(await stateOf()).toMatchObject({ status: 'active', stopReason: null });
      series.feed(f + 99_000, [1.1]);
      await until('the stopping row', async () => (await rowsOf()).length === 2);
      const stopped = await stateOf();
      expect(stopped).toMatchObject({ status: 'stopped', stopReason: 'no_signal_timeout' });
      expect(stopped.endedAt).not.toBeNull();
      // the waiting row's own shape is H1-DB5's
      const rows = await rowsOf();
      expect(rows.map((row) => [row.decidedAtMs, row.step])).toEqual([
        [f, 1],
        [f + 99_000, 1],
      ]);
      expect(rows[1]).toMatchObject({ kind: 'no_signal', outcome: 'no_signal' });
    } finally {
      await driver.stop();
    }
  });
});
