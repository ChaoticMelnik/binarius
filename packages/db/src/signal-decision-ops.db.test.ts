import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SessionStakeStrategy,
  SignalDecisionContext,
  SignalDecisionOutcome,
  TradeAction,
  TradeMode,
  TradingSessionStopReason,
  decimalStringSchema,
  type DecimalString,
  type TradingSessionSettings,
} from '@binarius/shared';
import { brokerAccounts, brokerTrades, signalDecisions } from './schema/index';
import {
  journalEntryOf,
  readSessionTradeSteps,
  readTradeLogPage,
  recordSignalDecision,
  signalDecisionInput,
  type TradeLogRow,
} from './signal-decision-ops';
import {
  createTempDatabase,
  decisionFixture,
  seedBrokerTradeFor,
  seedTradingSession,
  seedUserWithAccount,
  sessionSettings,
  signalRecordFixture,
  type TempDatabase,
} from './testing';
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
    const input = signalDecisionInput(
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
