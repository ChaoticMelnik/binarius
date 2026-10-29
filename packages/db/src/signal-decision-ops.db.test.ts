import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SessionStakeStrategy,
  SignalDecisionContext,
  SignalDecisionOutcome,
  TradeAction,
  TradeIntentFailureReason,
  TradeIntentStatus,
  TradeMode,
  TradingSessionStopReason,
  decimalStringSchema,
  h1ShadowEntrySchema,
  type DecimalString,
  type TradingSessionSettings,
} from '@binarius/shared';
import {
  brokerAccounts,
  brokerTrades,
  decisionTicks,
  signalDecisions,
  tradeIntents,
} from './schema/index';
import {
  journalEntryOf,
  readSessionTradeSteps,
  readTradeLogPage,
  readTradeReportStats,
  recordSignalDecision,
  TradeReportOrigin,
  type TradeLogRow,
  type TradeReportStats,
} from './signal-decision-ops';
import {
  createTempDatabase,
  decisionFixture,
  R1_SHADOW_PARAMS_FIXTURE,
  SHADOW_FIXTURE_DECIDED_AT_MS,
  seedBrokerTradeFor,
  seedQueuedIntent,
  seedTradingSession,
  seedUserWithAccount,
  sessionSettings,
  shadowDecisionFixture,
  signalDecisionInputV2,
  signalRecordFixture,
  type SignalRecordV2,
  type TempDatabase,
} from './testing';
import type { SignalDecisionInput } from './signal-decision-ops';
import { rejectIntent } from './trade-intent-ops';
import { createSessionIntent, stopTradingSession } from './trading-session-ops';

// The trade log's writer and the export's reads (#666, docs/trade-log.md), on a temporary
// migrated database. Every read is bounded by its own time window or session.
const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for packages/db integration tests (see README → Test database)',
  );
}

let tmp: TempDatabase;
beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
});
afterAll(() => tmp.drop());

const martingale = (): TradingSessionSettings => ({
  version: 3,
  assetId: 101,
  durationSec: 60,
  cycles: 5,
  stake: {
    strategy: SessionStakeStrategy.Martingale,
    baseStake: decimalStringSchema.parse('1'),
    stakeScale: 0,
    limits: {
      maxSteps: 4,
      maxStake: decimalStringSchema.parse('12'),
      maxSessionLoss: decimalStringSchema.parse('20'),
      maxSessionDurationMs: 3_600_000,
    },
  },
});

async function seedSession(settings: unknown = sessionSettings()) {
  const seed = await seedUserWithAccount(tmp.db, { balance: 50n });
  const session = await seedTradingSession(tmp.db, seed.brokerAccountId, { settings });
  return { ...seed, sessionId: session.id };
}

type Session = Awaited<ReturnType<typeof seedSession>>;

const sessionIntent = (session: Session, step: number, recordNowMs?: number) =>
  createSessionIntent(tmp.db, {
    sessionId: session.sessionId,
    step,
    telegramUserId: session.telegramUserId,
    brokerAccountId: session.brokerAccountId,
    mode: TradeMode.Demo,
    assetId: 101,
    amount: decimalStringSchema.parse('1'),
    action: TradeAction.Up,
    durationSec: 60,
    decision: decisionFixture(session, { step }, signalRecordFixture(recordNowMs)),
  });

async function settledStep(session: Session, step: number, profit: string) {
  const { intent } = await sessionIntent(session, step);
  await seedBrokerTradeFor(tmp.db, intent, { profit: profit as DecimalString });
  return intent;
}

const recordedAtOf = async (id: string) =>
  (
    await tmp.db
      .select({ recordedAt: signalDecisions.recordedAt })
      .from(signalDecisions)
      .where(eq(signalDecisions.id, id))
  )[0]!.recordedAt;

// every row of the session's decisions, by pages of `limit`
async function exportOf(sessionId: string, limit = 200): Promise<TradeLogRow[]> {
  const rows: TradeLogRow[] = [];
  let after;
  for (;;) {
    const page = await readTradeLogPage(tmp.db, {
      from: new Date(0),
      to: new Date(Date.now() + 60_000),
      limit,
      sessionId,
      ...(after === undefined ? {} : { after }),
    });
    rows.push(...page.rows);
    if (page.next === undefined) return rows;
    after = page.next;
  }
}

describe('recordSignalDecision (#666)', () => {
  it('SD1 inserts the row with every column of its input', async () => {
    const session = await seedSession();
    const input = decisionFixture(session, {
      outcome: SignalDecisionOutcome.Refused,
      detail: 'trading_paused',
      step: 3,
    });
    const { id } = await recordSignalDecision(tmp.db, input);
    const [row] = await tmp.db.select().from(signalDecisions).where(eq(signalDecisions.id, id));
    expect(row).toMatchObject({ ...input, series: [...input.series], result: null });
  });

  it.each([
    [SignalDecisionOutcome.Intent, null],
    [SignalDecisionOutcome.Paused, null],
    [SignalDecisionOutcome.Replayed, null],
    [SignalDecisionOutcome.StakeStop, 'max_session_loss'],
    [SignalDecisionOutcome.Refused, 'client_request_id_conflict'],
  ] as const)(
    'SD2 the builder gives a row the CHECKs accept for a signal recorded as %s',
    async (outcome, detail) => {
      const session = await seedSession();
      await expect(
        recordSignalDecision(tmp.db, decisionFixture(session, { outcome, detail })),
      ).resolves.toMatchObject({ id: expect.any(String) });
    },
  );

  it('SD3 a no_signal entry of the start route, without a session, a tick or a payout', async () => {
    const seed = await seedUserWithAccount(tmp.db);
    const record = signalRecordFixture();
    const entry = {
      ...record.entry,
      decision: {
        kind: 'no_signal' as const,
        version: 'v2' as const,
        reason: 'insufficient_candles' as const,
        detail: { closedCandles: 2, required: 50 },
      },
    };
    const input = signalDecisionInputV2(
      { entry, lastTick: null },
      {
        context: SignalDecisionContext.SessionStart,
        tradingSessionId: null,
        brokerAccountId: seed.brokerAccountId,
        step: null,
        payout: null,
        takenAtMs: entry.nowMs + 3,
        outcome: SignalDecisionOutcome.NoSignal,
        detail: null,
      },
    );
    expect(input).toMatchObject({ kind: 'no_signal', action: null, decidedAtMs: entry.nowMs });
    const { id } = await recordSignalDecision(tmp.db, input);
    const [row] = await tmp.db.select().from(signalDecisions).where(eq(signalDecisions.id, id));
    expect(row).toMatchObject({ lastTick: null, payout: null, step: null });
  });

  // the catalog's payout is unbounded (#631): one numeric(8,4) >= 0 cannot hold is stored as NULL
  it.each([
    [-1, null],
    [-0.00001, null],
    [10_000, null],
    [1e21, null],
    [Number.NaN, null],
    [Number.POSITIVE_INFINITY, null],
    [null, null],
    [0, 0],
    [1e-7, 0],
    [9999.9999, 9999.9999],
  ])('SD14 a payout of %s is recorded as %s', async (payout, stored) => {
    const session = await seedSession();
    const { id } = await recordSignalDecision(tmp.db, decisionFixture(session, { payout }));
    const [row] = await tmp.db.select().from(signalDecisions).where(eq(signalDecisions.id, id));
    expect(row!.payout).toBe(stored);
  });

  const constraintOf = (promise: Promise<unknown>) =>
    promise.then(
      () => undefined,
      (error: unknown) => (error as { cause?: { constraint?: string } }).cause?.constraint,
    );

  it('SD15 a shadow row (#669) comes back column for column, and its entry is an h1 shadow entry', async () => {
    const input = shadowDecisionFixture();
    const { id } = await recordSignalDecision(tmp.db, input);
    const [row] = await tmp.db.select().from(signalDecisions).where(eq(signalDecisions.id, id));
    expect(row).toMatchObject({ ...input, series: [...input.series] });
    const page = await readTradeLogPage(tmp.db, {
      from: new Date(0),
      to: new Date(Date.now() + 60_000),
      limit: 1_000,
    });
    const exported = page.rows.find((r) => r.decision.id === id)!;
    expect(exported.decision.ticksUntilMs).toBe(input.ticksUntilMs);
    expect(exported.session).toBeNull();
    expect(exported.intent).toBeNull();
    const entry = h1ShadowEntrySchema.parse(journalEntryOf(exported.decision));
    expect(entry).toMatchObject({ nowMs: input.decidedAtMs, series: input.series });
  });

  it('SD16 a shadow row without its tick window end is refused; a session row without one is not', async () => {
    expect(
      await constraintOf(
        recordSignalDecision(tmp.db, shadowDecisionFixture({ ticksUntilMs: null })),
      ),
    ).toBe('signal_decisions_ticks_until_pair_check');
    const session = await seedSession();
    const { id } = await recordSignalDecision(tmp.db, decisionFixture(session));
    const [row] = await tmp.db.select().from(signalDecisions).where(eq(signalDecisions.id, id));
    expect(row!.ticksUntilMs).toBeNull();
  });

  it('SD17 a tick window end at or before the decision is refused', async () => {
    const input = shadowDecisionFixture();
    for (const ticksUntilMs of [input.decidedAtMs, input.decidedAtMs - 1]) {
      expect(
        await constraintOf(recordSignalDecision(tmp.db, shadowDecisionFixture({ ticksUntilMs }))),
      ).toBe('signal_decisions_ticks_until_check');
    }
  });
  // the H1 driver's two new row shapes (#775, apps/backend/src/h1/driver.ts): the waiting period's
  // no_signal row and the repeat step's row
  it("SD19 an H1 session's no_signal row and repeat row pass the CHECKs and come back as written", async () => {
    const session = await seedSession();
    const facts = {
      context: SignalDecisionContext.Session,
      tradingSessionId: session.sessionId,
      brokerAccountId: session.brokerAccountId,
      step: 2,
      ticksUntilMs: null,
    };
    const waiting = shadowDecisionFixture({
      ...facts,
      kind: 'no_signal',
      action: null,
      outcome: SignalDecisionOutcome.NoSignal,
      decision: {
        kind: 'no_signal',
        version: 'h1',
        reason: 'no_volatility',
        detail: { moves: 300 },
      },
      params: { ...R1_SHADOW_PARAMS_FIXTURE, set: 'session' },
    });
    const repeat: SignalDecisionInput = {
      ...facts,
      assetId: 101,
      interval: null,
      version: 'h1-repeat',
      decidedAtMs: SHADOW_FIXTURE_DECIDED_AT_MS,
      takenAtMs: SHADOW_FIXTURE_DECIDED_AT_MS,
      kind: 'signal',
      action: TradeAction.Down,
      payout: 92,
      digits: null,
      params: { rule: 'repeat_step_2', strategy: SessionStakeStrategy.Martingale },
      decision: {
        kind: 'signal',
        version: 'h1-repeat',
        action: TradeAction.Down,
        after: { intentId: '00000000-0000-4000-8000-000000000001', action: 'down', profit: '-1' },
      },
      source: { kind: 'settlement', trigger: 'notice' },
      series: [],
      lastTick: null,
      outcome: SignalDecisionOutcome.Intent,
      detail: null,
    };
    for (const input of [waiting, repeat]) {
      const { id } = await recordSignalDecision(tmp.db, input);
      const [row] = await tmp.db.select().from(signalDecisions).where(eq(signalDecisions.id, id));
      expect(row).toMatchObject({ ...input, series: [...input.series] });
    }
  });
});

describe('readTradeLogPage (#666)', () => {
  it('SD4 joins the intent, its broker trade and the session; one-off decisions get none', async () => {
    const session = await seedSession();
    const intent = await settledStep(session, 1, '-1.00');
    const [row] = await exportOf(session.sessionId);
    expect(row!.decision).toMatchObject({ context: 'session', outcome: 'intent', step: 1 });
    expect(row!.session).toEqual({
      id: session.sessionId,
      userId: session.userId,
      brokerAccountId: session.brokerAccountId,
      mode: 'demo',
      settings: sessionSettings(),
      stopReason: null,
    });
    expect(row!.intent).toMatchObject({
      id: intent.id,
      status: 'settled',
      amount: '1.00000000',
      createdAt: intent.createdAt,
    });
    expect(row!.intent!.broker).toMatchObject({
      status: 'closed',
      profit: '-1.00000000',
      closePrice: expect.any(Number),
    });
  });

  it('SD5 a decision without an intent has no intent; an open trade has no close', async () => {
    const session = await seedSession();
    await recordSignalDecision(
      tmp.db,
      decisionFixture(session, { outcome: SignalDecisionOutcome.Paused, step: 1 }),
    );
    const { intent } = await sessionIntent(session, 1);
    await seedBrokerTradeFor(tmp.db, intent);
    const rows = await exportOf(session.sessionId);
    expect(rows.map((row) => row.decision.outcome)).toEqual(['paused', 'intent']);
    expect(rows[0]!.intent).toBeNull();
    expect(rows[1]!.intent!.broker).toMatchObject({
      status: 'open',
      closePrice: null,
      profit: null,
    });
  });

  it('SD6 the window is half-open on recorded_at: from in, to out', async () => {
    const session = await seedSession();
    const { id } = await recordSignalDecision(tmp.db, decisionFixture(session));
    const at = await recordedAtOf(id);
    const page = (from: Date, to: Date) =>
      readTradeLogPage(tmp.db, { from, to, limit: 10, sessionId: session.sessionId });
    expect((await page(at, new Date(at.getTime() + 1))).rows).toHaveLength(1);
    expect((await page(new Date(at.getTime() - 1), at)).rows).toHaveLength(0);
  });

  it('SD7 the cursor keeps rows of one millisecond apart by their microseconds', async () => {
    const session = await seedSession();
    for (let step = 1; step <= 5; step += 1) {
      await recordSignalDecision(
        tmp.db,
        decisionFixture(session, { step, outcome: SignalDecisionOutcome.Paused }),
      );
    }
    // the same millisecond, different microseconds: a Date cursor would skip or repeat them
    await tmp.db.execute(
      sql`update ${signalDecisions} set recorded_at = '2026-10-19 12:00:00.123'::timestamptz + (step * interval '1 microsecond') where trading_session_id = ${session.sessionId}`,
    );
    const rows = await exportOf(session.sessionId, 2);
    expect(rows.map((row) => row.decision.step)).toEqual([1, 2, 3, 4, 5]);
  });

  it('SD8 the session block carries the stop reason', async () => {
    const session = await seedSession();
    await recordSignalDecision(
      tmp.db,
      decisionFixture(session, { outcome: SignalDecisionOutcome.Paused }),
    );
    await stopTradingSession(tmp.db, {
      id: session.sessionId,
      reason: TradingSessionStopReason.NoSignalTimeout,
    });
    const [row] = await exportOf(session.sessionId);
    expect(row!.session!.stopReason).toBe('no_signal_timeout');
  });

  it('SD9 journalEntryOf rebuilds the recorded entry', async () => {
    const session = await seedSession();
    const record = signalRecordFixture();
    await recordSignalDecision(tmp.db, decisionFixture(session, {}, record));
    const [row] = await exportOf(session.sessionId);
    expect(journalEntryOf(row!.decision)).toEqual(record.entry);
  });

  it('SD10 an unknown version comes out as stored, without an interval length', () => {
    const entry = journalEntryOf({
      id: 'x',
      context: 'shadow',
      outcome: 'shadow',
      detail: null,
      version: 'h1',
      assetId: 101,
      interval: null,
      step: null,
      kind: 'signal',
      action: 'up',
      decidedAtMs: 5,
      takenAtMs: 6,
      recordedAt: new Date(),
      payout: null,
      digits: 5,
      params: { window: 1 },
      decision: { z: 2 },
      source: { kind: 'ticks' },
      series: [1, 2],
      lastTick: null,
      result: null,
      ticksUntilMs: 7,
    });
    expect(entry).not.toHaveProperty('intervalMs');
    expect(entry).toMatchObject({ version: 'h1', interval: null, nowMs: 5, series: [1, 2] });
  });

  it('SD11 the page carries no telegram id, broker user id, token or raw trade', async () => {
    const session = await seedSession();
    const sentinel = 'SENTINEL-SD11';
    await tmp.db
      .update(brokerAccounts)
      .set({ brokerUserId: `${sentinel}-broker` })
      .where(eq(brokerAccounts.id, session.brokerAccountId));
    const intent = await settledStep(session, 1, '0.85');
    await tmp.db
      .update(brokerTrades)
      .set({ raw: { sentinel } })
      .where(eq(brokerTrades.intentId, intent.id));
    const text = JSON.stringify(await exportOf(session.sessionId));
    expect(text).not.toContain(sentinel);
    expect(text).not.toContain(session.telegramUserId);
    expect(text).not.toContain('accessToken');
    expect(text).not.toContain('raw');
  });
  it('SD18 a decision carries its decision_ticks row (#668), null without one', async () => {
    const session = await seedSession();
    const bare = await recordSignalDecision(
      tmp.db,
      decisionFixture(session, { outcome: SignalDecisionOutcome.Paused, step: 1 }),
    );
    const { intent } = await sessionIntent(session, 2);
    const ticks: [number, number, number][] = [
      [1_760_000_001_000, 1_760_000_001_200, 1.1001],
      [1_760_000_002_000, 1_760_000_002_150, 1.1002],
    ];
    await tmp.db.insert(decisionTicks).values({
      decisionId: intent.signalDecisionId!,
      fromMs: 1_759_999_947_000,
      untilMs: 1_760_000_072_000,
      status: 'truncated',
      detail: 'hole',
      count: 2,
      ticks,
    });
    const rows = await exportOf(session.sessionId);
    expect(rows.map((row) => row.decision.id)).toEqual([bare.id, intent.signalDecisionId]);
    expect(rows[0]!.ticks).toBeNull();
    expect(rows[1]!.ticks).toEqual({
      status: 'truncated',
      detail: 'hole',
      fromMs: 1_759_999_947_000,
      untilMs: 1_760_000_072_000,
      count: 2,
      ticks,
    });
  });
});

describe('readSessionTradeSteps (#666)', () => {
  it('SD12 martingale numbers the steps of a cycle; fixed makes every trade a cycle', async () => {
    const mart = await seedSession(martingale());
    const lost = await settledStep(mart, 1, '-1.00');
    const won = await settledStep(mart, 2, '1.70');
    const next = await settledStep(mart, 3, '0.85');
    const fixed = await seedSession();
    const first = await settledStep(fixed, 1, '-1.00');
    const second = await settledStep(fixed, 2, '-1.00');
    const steps = await readSessionTradeSteps(tmp.db, [mart.sessionId, fixed.sessionId]);
    expect(steps.get(lost.id)).toEqual({ cycle: 1, step: 1 });
    expect(steps.get(won.id)).toEqual({ cycle: 1, step: 2 });
    expect(steps.get(next.id)).toEqual({ cycle: 2, step: 1 });
    expect(steps.get(first.id)).toEqual({ cycle: 1, step: 1 });
    expect(steps.get(second.id)).toEqual({ cycle: 2, step: 1 });
  });

  it('SD13 a session whose settings do not parse gets no steps; an unsettled intent none', async () => {
    const broken = await seedSession({});
    const intent = await settledStep(broken, 1, '1.00');
    const open = await seedSession();
    const { intent: pending } = await sessionIntent(open, 1);
    const steps = await readSessionTradeSteps(tmp.db, [broken.sessionId, open.sessionId]);
    expect(steps.has(intent.id)).toBe(false);
    expect(steps.has(pending.id)).toBe(false);
  });
});

describe('readTradeReportStats (#502)', () => {
  // every case moves its intents into an hour of its own, a day apart: TR4 places a row at its
  // window's end, which must stay out of every other case's window
  let days = 0;
  const ownWindow = () => {
    const from = new Date(Date.UTC(2001, 0, 1) + ++days * 86_400_000);
    return { from, to: new Date(from.getTime() + 3_600_000) };
  };
  const placeAt = (ids: readonly string[], at: Date) =>
    tmp.db
      .update(tradeIntents)
      .set({ createdAt: at })
      .where(inArray(tradeIntents.id, [...ids]));

  const withParams = (patch: Record<string, unknown>): SignalRecordV2 => {
    const record = signalRecordFixture();
    return { ...record, entry: { ...record.entry, params: { ...record.entry.params, ...patch } } };
  };

  type Outcome = { profit: string; payout?: number } | 'rejected' | 'open' | 'queued';
  interface StepSpec {
    outcome: Outcome;
    assetId?: number;
    record?: SignalRecordV2 | null;
  }

  // a session's steps in order: each intent created from its decision row (record null: none),
  // then settled, rejected, left open at the broker or queued; the intent ids by step
  async function sessionSteps(
    steps: readonly StepSpec[],
    { mode = TradeMode.Demo }: { mode?: TradeMode } = {},
  ): Promise<{ session: Session; ids: string[] }> {
    const seed = await seedUserWithAccount(tmp.db, { balance: 50n, tradingMode: mode });
    const row = await seedTradingSession(tmp.db, seed.brokerAccountId, { mode });
    const session = { ...seed, sessionId: row.id };
    const ids: string[] = [];
    for (const [index, spec] of steps.entries()) {
      const step = index + 1;
      const record = spec.record === undefined ? signalRecordFixture() : spec.record;
      const { intent } = await createSessionIntent(tmp.db, {
        sessionId: session.sessionId,
        step,
        telegramUserId: session.telegramUserId,
        brokerAccountId: session.brokerAccountId,
        mode,
        assetId: spec.assetId ?? 101,
        amount: decimalStringSchema.parse('1'),
        action: TradeAction.Up,
        durationSec: 60,
        decision: record === null ? null : decisionFixture(session, { step }, record),
      });
      ids.push(intent.id);
      const { outcome } = spec;
      if (outcome === 'rejected') {
        await tmp.db.transaction((tx) =>
          rejectIntent(tx, {
            id: intent.id,
            from: TradeIntentStatus.Queued,
            expectedVersion: intent.version,
            reason: TradeIntentFailureReason.BrokerRejected,
          }),
        );
      } else if (outcome === 'open') {
        await seedBrokerTradeFor(tmp.db, intent);
      } else if (outcome !== 'queued') {
        await seedBrokerTradeFor(tmp.db, intent, {
          profit: outcome.profit as DecimalString,
          ...(outcome.payout === undefined ? {} : { payout: outcome.payout }),
        });
      }
    }
    return { session, ids };
  }

  const win = { profit: '0.85' };
  const loss = { profit: '-1' };
  const tie = { profit: '0' };

  const pairCells = (stats: TradeReportStats) => stats.cells.filter((cell) => !cell.pooled);
  const pooledCells = (stats: TradeReportStats) => stats.cells.filter((cell) => cell.pooled);

  it('TR1 counts a session: W/L/T of closed trades, money as SQL text, the pooled row', async () => {
    const window = ownWindow();
    const { ids } = await sessionSteps([
      { outcome: win },
      { outcome: win },
      { outcome: loss },
      { outcome: tie },
      { outcome: 'rejected' },
      { outcome: 'open' },
    ]);
    await placeAt(ids.slice(0, 1), window.from);
    await placeAt(ids.slice(1), new Date(window.from.getTime() + 60_000));
    const stats = await readTradeReportStats(tmp.db, window);
    expect(stats).toMatchObject({ intents: 6, trades: 4 });
    const [cell] = pairCells(stats);
    expect(pairCells(stats)).toHaveLength(1);
    const expected = {
      mode: TradeMode.Demo,
      origin: TradeReportOrigin.Signal,
      version: 'v2',
      interval: '15s',
      durationSec: 60,
      symbol: null,
      intents: 6,
      trades: 4,
      notClosed: 2,
      wins: 2,
      losses: 1,
      ties: 1,
      priced: 4,
      payoutMean: 85,
      payoutMin: 85,
      payoutMax: 85,
      staked: '4.00000000',
      pnl: '0.70000000',
      roiPct: '17.50',
      firstAt: window.from.toISOString(),
      lastAt: new Date(window.from.getTime() + 60_000).toISOString(),
    };
    expect(cell).toMatchObject({ ...expected, assetId: 101, pooled: false });
    expect(cell!.paramsHash).toMatch(/^[0-9a-f]{32}$/);
    expect(pooledCells(stats)).toEqual([{ ...cell, assetId: null, pooled: true }]);
  });

  it('TR2 groups by the params fingerprint: a changed value splits, another key order joins', async () => {
    const window = ownWindow();
    const base = signalRecordFixture();
    const reordered = Object.fromEntries(
      Object.entries(base.entry.params).reverse(),
    ) as typeof base.entry.params;
    const { ids } = await sessionSteps([
      { outcome: win },
      { outcome: loss, record: withParams({ rsiExtremeBand: 20 }) },
      { outcome: win, record: { ...base, entry: { ...base.entry, params: reordered } } },
    ]);
    await placeAt(ids, window.from);
    const stats = await readTradeReportStats(tmp.db, window);
    const cells = pairCells(stats);
    expect(cells).toHaveLength(2);
    expect(cells.map((cell) => [cell.wins, cell.losses]).sort()).toEqual([
      [0, 1],
      [2, 0],
    ]);
    expect(new Set(cells.map((cell) => cell.paramsHash)).size).toBe(2);
    expect(stats.versions).toHaveLength(2);
    const joined = stats.versions.find((row) => row.trades === 2)!;
    expect(joined).toMatchObject({ version: 'v2', firstAt: window.from.toISOString() });
    expect(JSON.parse(joined.params)).toEqual(base.entry.params);
    const changed = stats.versions.find((row) => row.trades === 1)!;
    expect(JSON.parse(changed.params)).toMatchObject({ rsiExtremeBand: 20 });
    expect(changed.paramsHash).not.toBe(joined.paramsHash);
  });

  it('TR3 tells a one-off intent (manual) and a session intent without a decision (unlinked)', async () => {
    const window = ownWindow();
    const linked = await sessionSteps([{ outcome: win }, { outcome: loss, record: null }]);
    const oneOff = await seedQueuedIntent(tmp.db);
    await seedBrokerTradeFor(tmp.db, oneOff.intent, { profit: '0.85' as DecimalString });
    await placeAt([...linked.ids, oneOff.intent.id], window.from);
    const stats = await readTradeReportStats(tmp.db, window);
    const byOrigin = Object.fromEntries(pairCells(stats).map((cell) => [cell.origin, cell]));
    expect(Object.keys(byOrigin).sort()).toEqual(['manual', 'signal', 'unlinked']);
    expect(byOrigin.signal).toMatchObject({ version: 'v2', wins: 1, losses: 0 });
    expect(byOrigin.unlinked).toMatchObject({
      version: null,
      paramsHash: null,
      interval: null,
      wins: 0,
      losses: 1,
    });
    expect(byOrigin.manual).toMatchObject({
      version: null,
      paramsHash: null,
      assetId: 91,
      wins: 1,
      losses: 0,
    });
    expect(stats.versions).toHaveLength(1);
  });

  it('TR4 the window is [from, to) on trade_intents.created_at', async () => {
    const window = ownWindow();
    const { ids } = await sessionSteps([
      { outcome: win },
      { outcome: win },
      { outcome: win },
      { outcome: win },
    ]);
    const ms = (base: Date, delta: number) => new Date(base.getTime() + delta);
    await placeAt([ids[0]!], ms(window.from, -1));
    await placeAt([ids[1]!], window.from);
    await placeAt([ids[2]!], ms(window.to, -1));
    await placeAt([ids[3]!], window.to);
    const stats = await readTradeReportStats(tmp.db, window);
    expect(stats).toMatchObject({ intents: 2, trades: 2 });
    expect(pairCells(stats)[0]).toMatchObject({
      firstAt: window.from.toISOString(),
      lastAt: ms(window.to, -1).toISOString(),
    });
  });

  it('TR5 demo and real intents are cells of their own mode', async () => {
    const window = ownWindow();
    const demo = await sessionSteps([{ outcome: win }]);
    const real = await sessionSteps([{ outcome: loss }], { mode: TradeMode.Real });
    await placeAt([...demo.ids, ...real.ids], window.from);
    const stats = await readTradeReportStats(tmp.db, window);
    const byMode = Object.fromEntries(pairCells(stats).map((cell) => [cell.mode, cell]));
    expect(byMode.demo).toMatchObject({ wins: 1, losses: 0 });
    expect(byMode.real).toMatchObject({ wins: 0, losses: 1 });
    expect(
      pooledCells(stats)
        .map((cell) => cell.mode)
        .sort(),
    ).toEqual(['demo', 'real']);
  });

  it('TR6 the pooled row sums two pairs of one group, money as SQL text', async () => {
    const window = ownWindow();
    const { ids } = await sessionSteps([
      { outcome: win, assetId: 101 },
      { outcome: { profit: '-1', payout: 90 }, assetId: 102 },
      { outcome: { profit: '0.9', payout: 90 }, assetId: 102 },
    ]);
    await placeAt(ids, window.from);
    const stats = await readTradeReportStats(tmp.db, window);
    expect(
      pairCells(stats)
        .map((cell) => [cell.assetId, cell.trades])
        .sort(),
    ).toEqual([
      [101, 1],
      [102, 2],
    ]);
    expect(pooledCells(stats)).toEqual([
      expect.objectContaining({
        assetId: null,
        pooled: true,
        trades: 3,
        wins: 2,
        losses: 1,
        priced: 3,
        payoutMin: 85,
        payoutMax: 90,
        staked: '3.00000000',
        pnl: '0.75000000',
        roiPct: '25.00',
      }),
    ]);
    expect(pooledCells(stats)[0]!.payoutMean).toBeCloseTo(88.333, 3);
  });

  it('TR7 the intents without a closed trade, by status', async () => {
    const window = ownWindow();
    const first = await sessionSteps([{ outcome: 'rejected' }, { outcome: 'open' }]);
    const second = await sessionSteps([{ outcome: 'queued' }]);
    await placeAt([...first.ids, ...second.ids], window.from);
    const stats = await readTradeReportStats(tmp.db, window);
    expect(stats).toMatchObject({ intents: 3, trades: 0 });
    expect([...stats.notClosed].sort((a, b) => a.status.localeCompare(b.status))).toEqual([
      { status: TradeIntentStatus.Accepted, count: 1 },
      { status: TradeIntentStatus.Queued, count: 1 },
      { status: TradeIntentStatus.Rejected, count: 1 },
    ]);
    expect(pairCells(stats)[0]).toMatchObject({
      trades: 0,
      notClosed: 3,
      staked: null,
      pnl: null,
      roiPct: null,
      payoutMean: null,
      firstAt: null,
    });
    expect(stats.versions).toEqual([]);
  });

  it('TR8 the stats carry no telegram id, broker user id, token or raw trade', async () => {
    const window = ownWindow();
    const sentinel = 'SENTINEL-TR8';
    const { session, ids } = await sessionSteps([{ outcome: win }]);
    await tmp.db
      .update(brokerAccounts)
      .set({ brokerUserId: `${sentinel}-broker` })
      .where(eq(brokerAccounts.id, session.brokerAccountId));
    await tmp.db
      .update(brokerTrades)
      .set({ raw: { sentinel } })
      .where(eq(brokerTrades.intentId, ids[0]!));
    await placeAt(ids, window.from);
    const text = JSON.stringify(await readTradeReportStats(tmp.db, window));
    expect(text).toContain('"trades":1');
    expect(text).not.toContain(sentinel);
    expect(text).not.toContain(session.telegramUserId);
    expect(text).not.toContain(session.sessionId);
    expect(text).not.toContain(ids[0]!);
    expect(text).not.toContain('accessToken');
  });
});
