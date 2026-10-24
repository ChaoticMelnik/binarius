import { readFileSync } from 'node:fs';
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
  setH1Mark,
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
  R1_SHADOW_PARAMS_FIXTURE,
  seedBalanceSnapshot,
  seedBrokerTradeFor,
  seedUserWithAccount,
  shadowDecisionFixture,
  type TempDatabase,
} from '@binarius/db/testing';
import { createSessionNoticeListener } from '../trading/session-notice-listener';
import { replayH1Entry } from '@binarius/signal';
import type { ClosedSecond } from '../market-data/seconds';
import { createH1Driver, type H1Driver, type H1DriverDeps } from './driver';

// The driver against the real operations (#707, docs/h1.md -> The driver) on a temporary migrated
// database: a marked account's v5 session, a scripted series whose ramp from F signals up.
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

async function markedSession() {
  const seed = await seedUserWithAccount(tmp.db, { balance: 50n });
  await tmp.db.transaction((tx) => setH1Mark(tx, { accountId: seed.brokerAccountId, h1: true }));
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
  const { seed, session } = await markedSession();
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

// a shadow row on the driver's pair and second
const twinOf = (f: number) => ({
  assetId: ASSET,
  decidedAtMs: f,
  takenAtMs: f + 520,
  ticksUntilMs: f + 7_000,
});

describe('the H1 driver on the database (#707)', () => {
  it('H1-DB1: the intent carries the deadline and its decision row; the outbox event is there', async () => {
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
    expect(intent!.submitDeadlineAt!.getTime()).toBe(row!.takenAtMs + BUDGET_MS);
    const events = await tmp.db
      .select({ id: outboxEvents.id })
      .from(outboxEvents)
      .where(eq(outboxEvents.intentId, intent!.id));
    expect(events).toHaveLength(1);
  });

  it("H1-DB2: docs/h1.md's comparison query pairs the trade with the shadow's r1 twin; the export replays the row", async () => {
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
    const entries = (entryPrice: number, outcome: string) => ({
      entries: [
        { entryDelaySec: 1, entryPrice, exitPrice: 1.1006, outcome },
        { entryDelaySec: 2, entryPrice: 1.1009, exitPrice: 1.1004, outcome: 'loss' },
      ],
    });
    await recordSignalDecision(
      tmp.db,
      shadowDecisionFixture({ ...twinOf(f), result: entries(1.1003, 'win') }),
    );
    await recordSignalDecision(
      tmp.db,
      shadowDecisionFixture(
        { ...twinOf(f), result: entries(1.1007, 'loss') },
        { ...R1_SHADOW_PARAMS_FIXTURE, set: 'h1', entryDelaySec: 2 },
      ),
    );

    const docs = readFileSync(new URL('../../../../docs/h1.md', import.meta.url), 'utf8');
    const section = docs.slice(docs.indexOf('### Comparing with the shadow'));
    const query = /```sql\n([\s\S]*?)```/.exec(section)?.[1];
    if (query === undefined) throw new Error('docs/h1.md has no comparison query');
    expect(query).toContain("'<session id>'");
    const { rows } = await tmp.db.execute<Record<string, unknown>>(
      sql.raw(query.replace("'<session id>'", `'${session.id}'`).replace(/;\s*$/, '')),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      f: String(f),
      open_after_ms: '800',
      open_price: 1.1001,
      close_price: 1.1006,
      profit: '0.92000000',
      last_error: null,
      shadow_entry: 1.1003,
      shadow_exit: 1.1006,
      shadow_outcome: 'win',
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

// #745, #775: the start route writes the same v5; the driver lists such a session while its account
// is marked, whoever created it
describe("the driver's list and a session of the bot's settings (#745)", () => {
  it('H1-DB3: listed with its owner while marked; not listed once the mark is gone', async () => {
    const seed = await seedUserWithAccount(tmp.db, { balance: 50n });
    await tmp.db.transaction((tx) => setH1Mark(tx, { accountId: seed.brokerAccountId, h1: true }));
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
    // the mark cleared by hand under an active session (setH1Mark refuses it), as risk 3 of #707
    await tmp.db.execute(
      sql`update broker_accounts set h1_since = null where id = ${seed.brokerAccountId}`,
    );
    expect((await listActiveH1Sessions(tmp.db)).map((row) => row.id)).not.toContain(session.id);
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
    const { session } = await markedSession();
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
    const { session } = await markedSession();
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
    const { session } = await markedSession();
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
