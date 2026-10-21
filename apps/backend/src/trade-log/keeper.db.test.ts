import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  SignalDecisionContext,
  SignalDecisionOutcome,
  SignalKind,
  TradeAction,
  TradeMode,
  decimalStringSchema,
  type DecimalString,
} from '@binarius/shared';
import {
  brokerTrades,
  createSessionIntent,
  decisionTicks,
  recordSignalDecision,
  signalDecisions,
} from '@binarius/db';
import {
  createTempDatabase,
  decisionFixture,
  seedBrokerTradeFor,
  seedTradingSession,
  seedUserWithAccount,
  shadowDecisionFixture,
  signalRecordFixture,
  type TempDatabase,
} from '@binarius/db/testing';
import { createTickStore, type TickStore } from '../market-data/ticks';
import {
  MARKET_DATA_SKEW_MARGIN_MS,
  TRADE_TICKS_AFTER_CLOSE_MS,
  TRADE_TICKS_BEFORE_MS,
} from '../timing';
import { createTradeLogKeeper } from './keeper';

// The keeper against the real operations (#668, docs/trade-log.md → The ticks around a decision,
// → Retention) on a temporary migrated database. Before each case the rows already there are moved
// an hour back: out of the capture horizon, far from the retention cutoffs.
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
beforeEach(async () => {
  await tmp.db.execute(
    sql`update signal_decisions set recorded_at = recorded_at - interval '1 hour'`,
  );
});

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const keeperOn = (store: TickStore | undefined, nowMs: number) =>
  createTradeLogKeeper({ db: tmp.db, ticks: store, logger: silent, now: () => nowMs });

// a tick each second over [from, until], received 100 ms after its broker time
function fill(store: TickStore, assetId: number, from: number, until: number): void {
  for (let at = from; at <= until; at += 1_000) {
    store.push(assetId, { price: 1.1 + (at % 7) / 1e4, timestamp: at }, at + 100);
  }
}

async function seedSession() {
  const seed = await seedUserWithAccount(tmp.db, { balance: 50n });
  const session = await seedTradingSession(tmp.db, seed.brokerAccountId);
  return { ...seed, sessionId: session.id };
}

const DECIDED = signalRecordFixture().entry.nowMs;

async function sessionTrade(profit?: DecimalString) {
  const session = await seedSession();
  const { intent } = await createSessionIntent(tmp.db, {
    sessionId: session.sessionId,
    step: 1,
    telegramUserId: session.telegramUserId,
    brokerAccountId: session.brokerAccountId,
    mode: TradeMode.Demo,
    assetId: 101,
    amount: decimalStringSchema.parse('1'),
    action: TradeAction.Up,
    durationSec: 60,
    decision: decisionFixture(session, { step: 1 }),
  });
  await seedBrokerTradeFor(tmp.db, intent, {
    openTimestamp: DECIDED + 500,
    ...(profit === undefined ? {} : { profit }),
  });
  return intent;
}

async function shadowRow(head: string) {
  const { id } = await recordSignalDecision(tmp.db, shadowDecisionFixture());
  const pinned = `${head}${randomUUID().slice(4)}`;
  await tmp.db.update(signalDecisions).set({ id: pinned }).where(eq(signalDecisions.id, id));
  return pinned;
}

const ticksOf = async (ids: string[]) =>
  tmp.db.select().from(decisionTicks).where(inArray(decisionTicks.decisionId, ids));

const age = (id: string, interval: string) =>
  tmp.db.execute(
    sql`update signal_decisions set recorded_at = now() - ${interval}::interval where id = ${id}`,
  );

describe('the trade log keeper on the database (#668)', () => {
  it('D1 a session trade gets its ticks from decided - 60 s to close + 5 s, the open inside them', async () => {
    const intent = await sessionTrade('0.85' as DecimalString);
    const [trade] = await tmp.db
      .select({ open: brokerTrades.openTimestampMs, close: brokerTrades.closeTimestampMs })
      .from(brokerTrades)
      .where(eq(brokerTrades.intentId, intent.id));
    const until = trade!.close! + TRADE_TICKS_AFTER_CLOSE_MS;
    const store = createTickStore();
    fill(store, 101, DECIDED - 70_000, until + 3_000);
    await keeperOn(store, until + 3_100).capture();
    const [row] = await ticksOf([intent.signalDecisionId!]);
    expect(row).toMatchObject({
      fromMs: DECIDED - TRADE_TICKS_BEFORE_MS,
      untilMs: until,
      status: 'complete',
      detail: null,
    });
    expect(row!.count).toBe(row!.ticks.length);
    expect(row!.ticks[0]![0]).toBe(DECIDED - TRADE_TICKS_BEFORE_MS);
    // a tick each second from a whole second: the last one is the newest at or before the end
    expect(until - row!.ticks.at(-1)![0]).toBeGreaterThanOrEqual(0);
    expect(until - row!.ticks.at(-1)![0]).toBeLessThan(1_000);
    expect(row!.ticks[0]![0]).toBeLessThanOrEqual(trade!.open);
    expect(row!.ticks.at(-1)![0]).toBeGreaterThanOrEqual(trade!.open);
  });

  it('D2 a sampled shadow row gets its row, an unsampled one none', async () => {
    const sampled = await shadowRow('0000');
    const unsampled = await shadowRow('0015');
    const { decidedAtMs, ticksUntilMs, assetId } = shadowDecisionFixture();
    const store = createTickStore();
    fill(store, assetId, decidedAtMs - 61_000, ticksUntilMs! + 1_000);
    await keeperOn(store, ticksUntilMs! + 1_100).capture();
    const rows = await ticksOf([sampled, unsampled]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      decisionId: sampled,
      fromMs: decidedAtMs - TRADE_TICKS_BEFORE_MS,
      untilMs: ticksUntilMs,
      status: 'complete',
      count: 68,
    });
  });

  it('D3 a store started after the decision writes unavailable/uncovered', async () => {
    const intent = await sessionTrade('-1' as DecimalString);
    const [trade] = await tmp.db
      .select({ close: brokerTrades.closeTimestampMs })
      .from(brokerTrades)
      .where(eq(brokerTrades.intentId, intent.id));
    const until = trade!.close! + TRADE_TICKS_AFTER_CLOSE_MS;
    const store = createTickStore();
    fill(store, 202, until + 1_000, until + 1_000);
    await keeperOn(store, until + MARKET_DATA_SKEW_MARGIN_MS).capture();
    expect(await ticksOf([intent.signalDecisionId!])).toMatchObject([
      { status: 'unavailable', detail: 'uncovered', count: 0, ticks: [] },
    ]);
  });

  it('D4 the sweep keeps 7 days of shadow rows, 30 of the rest and every decision with a trade, by the database clock', async () => {
    const oldShadow = await shadowRow('0000');
    const youngShadow = await shadowRow('0015');
    await tmp.db.insert(decisionTicks).values({
      decisionId: oldShadow,
      fromMs: 1,
      untilMs: 2,
      status: 'complete',
      detail: null,
      count: 1,
      ticks: [[1, 2, 1.1]],
    });
    const session = await seedSession();
    const base = decisionFixture(session, { outcome: SignalDecisionOutcome.NoSignal });
    const { id: oldNoSignal } = await recordSignalDecision(tmp.db, {
      ...base,
      context: SignalDecisionContext.Session,
      kind: SignalKind.NoSignal,
      action: null,
    });
    const traded = (await sessionTrade('0.85' as DecimalString)).signalDecisionId!;
    await age(oldShadow, '8 days');
    await age(youngShadow, '6 days');
    await age(oldNoSignal, '31 days');
    await age(traded, '400 days');
    await keeperOn(undefined, Date.now()).sweep();
    const left = await tmp.db
      .select({ id: signalDecisions.id })
      .from(signalDecisions)
      .where(inArray(signalDecisions.id, [oldShadow, youngShadow, oldNoSignal, traded]));
    expect(left.map((row) => row.id).sort()).toEqual([youngShadow, traded].sort());
    expect(await ticksOf([oldShadow])).toEqual([]);
  });
});
