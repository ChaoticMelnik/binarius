import { eq, inArray, sql } from 'drizzle-orm';
import * as z from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SessionStakeStrategy,
  SignalDecisionContext,
  SignalDecisionOutcome,
  SignalKind,
  TradeAction,
  TradeIntentFailureReason,
  TradeIntentStatus,
  TradeMode,
  TradingSessionStatus,
  TradingSessionStopReason,
  buildH1SessionSettings,
  buildSessionSettings,
  decimalStringSchema,
  H1_R1_PARAMS,
  isH1Settings,
  tradeLogLineSchema,
  tradeLogTradeJsonSchema,
  h1ShadowEntrySchema,
  type Candle,
  type DecimalString,
  type SignalRecord,
  type TradeLogLine,
} from '@binarius/shared';
import {
  brokerAccounts,
  brokerTrades,
  createSessionIntent,
  decisionTicks,
  recordSignalDecision,
  rejectIntent,
  rejectLateIntent,
  signalDecisions,
  tradeIntents,
  tradingSessions,
  users,
} from '@binarius/db';
import {
  createTempDatabase,
  decisionFixture,
  shadowDecisionFixture,
  seedBrokerTradeFor,
  seedTradingSession,
  seedUserWithAccount,
  type TempDatabase,
} from '@binarius/db/testing';
import {
  DEFAULT_SIGNAL_PARAMS,
  createH1Detector,
  createSignalDecider,
  H1_SHADOW_SETS,
  replayH1Entry,
  replaySignalJournalEntry,
  toJournalCandle,
  type SignalJournalEntry,
} from '@binarius/signal';
import { h1DriverDecisionInput, h1RepeatDecisionInput, H1RepeatTrigger } from '../h1/driver';
import { parseTradeLogArgs, runTradeLogCli, TRADE_LOG_PAGE_ROWS } from './trade-log';

// The trade log's export (#666, docs/trade-log.md → The export) through runTradeLogCli on a
// temporary migrated database. Every case exports its own session or its own time window.
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

const FROM = '2000-01-01T00:00:00Z';

async function run(...argv: string[]) {
  let out = '';
  const err: string[] = [];
  const code = await runTradeLogCli(
    argv,
    { DATABASE_URL: tmp.url },
    (text) => (out += text),
    (line) => err.push(line),
  );
  return { code, out, err };
}

const linesOf = (out: string): TradeLogLine[] =>
  out
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => tradeLogLineSchema.parse(JSON.parse(line)));

function martingaleSettings() {
  const built = buildSessionSettings({
    assetId: 101,
    durationSec: 15,
    cycles: 3,
    stake: { baseStake: decimalStringSchema.parse('1'), stakeScale: 0 },
    strategy: SessionStakeStrategy.Martingale,
  });
  expect(built.success).toBe(true);
  return built.data;
}

// a fixed v1 session (60 s trades) or a martingale v3 one (15 s trades)
async function seedSession(options: { martingale?: boolean } = {}) {
  const seed = await seedUserWithAccount(tmp.db, { balance: 50n });
  const session = await seedTradingSession(
    tmp.db,
    seed.brokerAccountId,
    options.martingale === true ? { settings: martingaleSettings() } : {},
  );
  return { ...seed, sessionId: session.id, durationSec: options.martingale === true ? 15 : 60 };
}
type Session = Awaited<ReturnType<typeof seedSession>>;

const sessionIntent = (
  session: Session,
  step: number,
  { amount = '1', record }: { amount?: string; record?: SignalRecord } = {},
) =>
  createSessionIntent(tmp.db, {
    sessionId: session.sessionId,
    step,
    telegramUserId: session.telegramUserId,
    brokerAccountId: session.brokerAccountId,
    mode: TradeMode.Demo,
    assetId: 101,
    amount: decimalStringSchema.parse(amount),
    action: TradeAction.Up,
    durationSec: session.durationSec,
    decision: decisionFixture(session, { step }, record),
  });

const SERIES_START = 1_760_000_000_000;
const SERIES_INTERVAL_MS = 15_000;
const SERIES_NOW_MS = SERIES_START + 60 * SERIES_INTERVAL_MS + 2_000;

// a real decision of the current decider on 15 s candles, as the feed would record it
function decidedRecord(candles: Candle[], lastTick: SignalRecord['lastTick']): SignalRecord {
  const decider = createSignalDecider();
  const decision = decider.decide({
    candles,
    intervalMs: SERIES_INTERVAL_MS,
    nowMs: SERIES_NOW_MS,
    digits: 5,
  });
  const entry: SignalJournalEntry = {
    assetId: 101,
    interval: '15s',
    digits: 5,
    intervalMs: SERIES_INTERVAL_MS,
    nowMs: SERIES_NOW_MS,
    source: {
      kind: 'socket',
      startTime: SERIES_START,
      closedUntil: SERIES_NOW_MS - 2_000,
      gaps: 0,
    },
    version: decider.version,
    params: DEFAULT_SIGNAL_PARAMS,
    series: candles.map(toJournalCandle),
    decision,
  };
  return { entry, lastTick };
}

// a climb in alternating steps: the decider's signal (up)
function signalRecord(): SignalRecord {
  let close = 1.1;
  const candles: Candle[] = Array.from({ length: 60 }, (_, index) => {
    const open = close;
    close = Math.round((close + (index % 2 === 0 ? 0.0003 : -0.0002)) * 1e5) / 1e5;
    return {
      timestamp: SERIES_START + index * SERIES_INTERVAL_MS,
      open,
      high: Math.max(open, close) + 0.0001,
      low: Math.min(open, close) - 0.0001,
      close,
    };
  });
  return decidedRecord(candles, {
    price: 1.10302,
    timestamp: SERIES_NOW_MS - 300,
    receivedAtMs: SERIES_NOW_MS - 260,
  });
}

// a steady climb: no_signal (rsi_overbought)
function noSignalRecord(): SignalRecord {
  const candles: Candle[] = Array.from({ length: 60 }, (_, index) => {
    const close = 1.1 + index * 0.0002 + (index % 3 === 0 ? -0.00015 : 0.0001);
    return {
      timestamp: SERIES_START + index * SERIES_INTERVAL_MS,
      open: close - 0.0001,
      high: close + 0.0003,
      low: close - 0.0003,
      close,
    };
  });
  return decidedRecord(candles, null);
}

const TRADED_FROM = '2004-01-01T00:00:00Z';

// A martingale session's five intents, in creation order: a loss, a win, a rejection, a win and
// an open trade; then stopped by its user. Each decision is recorded at TRADED_FROM + step s,
// and the settled trades were submitted 1234 ms after their creation.
async function seedTradedSession() {
  const session = await seedSession({ martingale: true });
  const record = signalRecord();
  expect(record.entry.decision.kind).toBe(SignalKind.Signal);
  const nowMs = record.entry.nowMs;
  const settled = [
    { step: 1, amount: '1', openPrice: 1.103, closePrice: 1.1027, at: 3_000, profit: '-1.00' },
    { step: 2, amount: '2.5', openPrice: 1.1041, closePrice: 1.1049, at: 80_000, profit: '2.12' },
  ] as const;
  const ids = new Map<number, string>();
  for (const trade of settled) {
    const { intent } = await sessionIntent(session, trade.step, { amount: trade.amount, record });
    ids.set(trade.step, intent.id);
    await seedBrokerTradeFor(tmp.db, intent, {
      openPrice: trade.openPrice,
      closePrice: trade.closePrice,
      openTimestamp: nowMs + trade.at,
      profit: trade.profit as DecimalString,
    });
  }
  const { intent: rejected } = await sessionIntent(session, 3, { record });
  ids.set(3, rejected.id);
  const refused = await tmp.db.transaction((tx) =>
    rejectIntent(tx, {
      id: rejected.id,
      from: TradeIntentStatus.Queued,
      reason: TradeIntentFailureReason.BrokerRejected,
    }),
  );
  expect(refused).toBeDefined();
  const fourth = { openPrice: 1.1052, closePrice: 1.1058, at: 160_000, profit: '0.85' };
  const { intent: won } = await sessionIntent(session, 4, { record });
  ids.set(4, won.id);
  await seedBrokerTradeFor(tmp.db, won, {
    openPrice: fourth.openPrice,
    closePrice: fourth.closePrice,
    openTimestamp: nowMs + fourth.at,
    profit: fourth.profit as DecimalString,
  });
  const fifth = { openPrice: 1.1061, at: 240_000 };
  const { intent: open } = await sessionIntent(session, 5, { record });
  ids.set(5, open.id);
  await seedBrokerTradeFor(tmp.db, open, {
    openPrice: fifth.openPrice,
    openTimestamp: nowMs + fifth.at,
  });

  await tmp.db
    .update(tradeIntents)
    .set({ submittedAt: sql`${tradeIntents.createdAt} + interval '1234 milliseconds'` })
    .where(inArray(tradeIntents.id, [ids.get(1)!, ids.get(2)!, ids.get(4)!]));
  await tmp.db.execute(
    sql`update ${signalDecisions} set recorded_at = ${TRADED_FROM}::timestamptz + step * interval '1 second' where trading_session_id = ${session.sessionId}`,
  );
  await tmp.db
    .update(tradingSessions)
    .set({
      status: TradingSessionStatus.Stopped,
      stopReason: TradingSessionStopReason.UserStopped,
      endedAt: sql`now()`,
    })
    .where(eq(tradingSessions.id, session.sessionId));

  const rows = await tmp.db
    .select({
      id: tradeIntents.id,
      decisionId: tradeIntents.signalDecisionId,
      createdAt: tradeIntents.createdAt,
      submittedAt: tradeIntents.submittedAt,
    })
    .from(tradeIntents)
    .where(eq(tradeIntents.tradingSessionId, session.sessionId));
  const intent = (step: number) => {
    const row = rows.find((candidate) => candidate.id === ids.get(step));
    if (row?.decisionId == null) throw new Error(`no intent for step ${step}`);
    return { ...row, decisionId: row.decisionId };
  };
  const closedBroker = (
    trade: { openPrice: number; closePrice: number; at: number },
    profit: string,
  ) => ({
    status: 'closed',
    payout: 85,
    openPrice: trade.openPrice,
    openTimestampMs: nowMs + trade.at,
    closePrice: trade.closePrice,
    closeTimestampMs: nowMs + trade.at + 60_000,
    profit,
  });
  const trades = [
    {
      step: 1,
      status: 'settled',
      amount: '1.00000000',
      cycle: 1,
      cycleStep: 1,
      broker: closedBroker(settled[0], '-1.00000000'),
    },
    {
      step: 2,
      status: 'settled',
      amount: '2.50000000',
      cycle: 1,
      cycleStep: 2,
      broker: closedBroker(settled[1], '2.12000000'),
    },
    {
      step: 3,
      status: 'rejected',
      amount: '1.00000000',
      cycle: null,
      cycleStep: null,
      broker: null,
    },
    {
      step: 4,
      status: 'settled',
      amount: '1.00000000',
      cycle: 2,
      cycleStep: 1,
      broker: closedBroker(fourth, '0.85000000'),
    },
    {
      step: 5,
      status: 'accepted',
      amount: '1.00000000',
      cycle: null,
      cycleStep: null,
      broker: {
        status: 'open',
        payout: 85,
        openPrice: fifth.openPrice,
        openTimestampMs: nowMs + fifth.at,
        closePrice: null,
        closeTimestampMs: null,
        profit: null,
      },
    },
  ].map((trade) => ({ ...trade, intent: intent(trade.step) }));
  return { session, record, trades };
}

describe('trade-log export (#666)', () => {
  it.each<[string, string[]]>([
    ['no command', []],
    ['an unknown command', ['import', '--from', FROM]],
    ['no --from', ['export']],
    ['a date without a zone', ['export', '--from', '2026-10-20T00:00:00']],
    ['a bare day', ['export', '--from', '2026-10-20']],
    ['--to not after --from', ['export', '--from', FROM, '--to', FROM]],
    ['an unknown format', ['export', '--from', FROM, '--format', 'csv']],
    ['a session that is not a uuid', ['export', '--from', FROM, '--session', 'x']],
    ['an unknown option', ['export', '--from', FROM, '--limit', '5']],
  ])('X1 %s is a usage error, exit 2, nothing on stdout', async (_label, argv) => {
    const { code, out, err } = await run(...argv);
    expect(code).toBe(2);
    expect(out).toBe('');
    expect(err.at(-1)).toContain('trade-log export --from');
  });

  it.each<[string, string, string[]]>([
    ['--from', 'four fraction digits', ['export', '--from', '2026-10-20T00:00:00.0001Z']],
    [
      '--to',
      'six fraction digits',
      ['export', '--from', '2026-10-20T00:00:00Z', '--to', '2026-10-20T00:00:00.000001Z'],
    ],
  ])(
    'X1 %s with %s (finer than Date holds) is a usage error, exit 2, the option named',
    async (option, _label, argv) => {
      const { code, out, err } = await run(...argv);
      expect(code).toBe(2);
      expect(out).toBe('');
      expect(err[0]).toContain(option);
      expect(err[0]).toContain('миллисекундах');
    },
  );

  it.each<[string, string]>([
    ['2026-10-20T00:00:00Z', '2026-10-20T00:00:00.000Z'],
    ['2026-10-20T00:00:00.1Z', '2026-10-20T00:00:00.100Z'],
    ['2026-10-20T00:00:00.12Z', '2026-10-20T00:00:00.120Z'],
    ['2026-10-20T00:00:00.123Z', '2026-10-20T00:00:00.123Z'],
    ['2026-10-20T00:00:00.123+05:30', '2026-10-19T18:30:00.123Z'],
  ])('X10 --from %s (up to milliseconds) is taken exactly', (raw, iso) => {
    const args = parseTradeLogArgs(['export', '--from', raw, '--to', raw.replace('2026', '2027')]);
    expect(args.from.toISOString()).toBe(iso);
    expect(args.to?.toISOString()).toBe(iso.replace('2026', '2027'));
  });

  it('X2 without DATABASE_URL: exit 1, the variable named', async () => {
    const err: string[] = [];
    const code = await runTradeLogCli(
      ['export', '--from', FROM],
      {},
      () => undefined,
      (line) => err.push(line),
    );
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('DATABASE_URL');
  });

  it("X3 a session's lines carry every field: the decision, its replayable entry, the timing chain, the cycle, the stake and the broker trade", async () => {
    const { session, record, trades } = await seedTradedSession();
    const { code, out, err } = await run('export', '--from', FROM, '--session', session.sessionId);
    expect(code).toBe(0);
    expect(err).toEqual(['строк: 5']);
    const lines = linesOf(out);
    expect(lines).toEqual(
      trades.map((trade) => ({
        decision: {
          id: trade.intent.decisionId,
          context: 'session',
          outcome: 'intent',
          detail: null,
          version: record.entry.version,
          assetId: 101,
          interval: '15s',
          step: trade.step,
          kind: 'signal',
          action: 'up',
          decidedAtMs: record.entry.nowMs,
          takenAtMs: record.entry.nowMs + 50,
          recordedAtMs: Date.parse(TRADED_FROM) + trade.step * 1_000,
          ticksUntilMs: null,
          payout: 92,
          lastTick: record.lastTick,
          result: null,
        },
        signal: record.entry,
        session: {
          id: session.sessionId,
          userId: session.userId,
          brokerAccountId: session.brokerAccountId,
          mode: 'demo',
          strategy: 'martingale',
          baseStake: '1',
          durationSec: 15,
          stopReason: 'user_stopped',
        },
        trade: {
          intentId: trade.intent.id,
          status: trade.status,
          mode: 'demo',
          action: 'up',
          amount: trade.amount,
          durationSec: 15,
          createdAtMs: trade.intent.createdAt.getTime(),
          submittedAtMs: trade.intent.submittedAt?.getTime() ?? null,
          lastError: trade.step === 3 ? 'broker_rejected' : null,
          submitDeadlineAtMs: null,
          cycle: trade.cycle,
          cycleStep: trade.cycleStep,
          broker: trade.broker,
        },
        ticks: null,
      })),
    );
    const settled = trades.filter((trade) => trade.status === 'settled');
    expect(settled.map((trade) => trade.intent.submittedAt!.getTime())).toEqual(
      settled.map((trade) => trade.intent.createdAt.getTime() + 1234),
    );
    expect(trades[2]!.intent.submittedAt).toBeNull();
    for (const line of lines) {
      expect(replaySignalJournalEntry(line.signal as SignalJournalEntry)).toEqual(
        record.entry.decision,
      );
    }
  });

  it('X4 trades-json holds only the closed trades, every field in the shape the stand reads', async () => {
    const { session, trades } = await seedTradedSession();
    const { code, out, err } = await run(
      'export',
      '--from',
      FROM,
      '--session',
      session.sessionId,
      '--format',
      'trades-json',
    );
    expect(code).toBe(0);
    expect(err).toEqual(['строк: 3']);
    const parsed: unknown = JSON.parse(out);
    z.array(tradeLogTradeJsonSchema).parse(parsed);
    expect(parsed).toEqual(
      trades.flatMap((trade) =>
        trade.broker?.status !== 'closed'
          ? []
          : [
              {
                trading_session_id: session.sessionId,
                asset_id: 101,
                action: 'up',
                duration_sec: 15,
                created_at_ms: trade.intent.createdAt.getTime(),
                open_timestamp_ms: trade.broker.openTimestampMs,
                open_price: trade.broker.openPrice,
                close_timestamp_ms: trade.broker.closeTimestampMs,
                close_price: trade.broker.closePrice,
                profit: trade.broker.profit,
                submitted_at_ms: trade.intent.createdAt.getTime() + 1234,
                payout: 85,
                intent_id: trade.intent.id,
                decision_id: trade.intent.decisionId,
                mode: 'demo',
                amount: trade.amount,
              },
            ],
      ),
    );
  });

  it('X5 no telegram id, broker user id, token or raw broker payload reaches the output', async () => {
    const session = await seedSession();
    const sentinel = 'SENTINEL-X5';
    await tmp.db
      .update(brokerAccounts)
      .set({ brokerUserId: `${sentinel}-broker`, accessTokenEnc: Buffer.from(sentinel) })
      .where(eq(brokerAccounts.id, session.brokerAccountId));
    const telegramUserId = (
      await tmp.db
        .select({ telegramUserId: users.telegramUserId })
        .from(users)
        .where(eq(users.id, session.userId))
    )[0]!.telegramUserId.toString();
    const { intent } = await sessionIntent(session, 1);
    await seedBrokerTradeFor(tmp.db, intent, { profit: '0.85' as DecimalString });
    await tmp.db
      .update(brokerTrades)
      .set({ raw: { sentinel } })
      .where(eq(brokerTrades.intentId, intent.id));
    for (const format of ['jsonl', 'trades-json']) {
      const { out } = await run(
        'export',
        '--from',
        FROM,
        '--session',
        session.sessionId,
        '--format',
        format,
      );
      expect(out).not.toBe('');
      expect(out).not.toContain(sentinel);
      expect(out).not.toContain(telegramUserId);
    }
  });

  it('X6 an empty period: nothing on stdout, строк: 0, exit 0', async () => {
    const { code, out, err } = await run(
      'export',
      '--from',
      '2001-01-01T00:00:00Z',
      '--to',
      '2001-01-02T00:00:00Z',
    );
    expect({ code, out, err }).toEqual({ code: 0, out: '', err: ['строк: 0'] });
    const empty = await run(
      'export',
      '--from',
      '2001-01-01T00:00:00Z',
      '--to',
      '2001-01-02T00:00:00Z',
      '--format',
      'trades-json',
    );
    expect(empty).toEqual({ code: 0, out: '[]\n', err: ['строк: 0'] });
  });

  it('X7 --from is in, --to is out, by the time a decision was recorded', async () => {
    const session = await seedSession();
    for (const step of [1, 2]) {
      await recordSignalDecision(
        tmp.db,
        decisionFixture(session, { step, outcome: SignalDecisionOutcome.Paused }),
      );
    }
    await tmp.db.execute(
      sql`update ${signalDecisions} set recorded_at = case step when 1 then '2002-01-01T00:00:00Z'::timestamptz else '2002-01-01T01:00:00Z'::timestamptz end where trading_session_id = ${session.sessionId}`,
    );
    const { out } = await run(
      'export',
      '--from',
      '2002-01-01T00:00:00Z',
      '--to',
      '2002-01-01T01:00:00Z',
    );
    expect(linesOf(out).map((line) => line.decision.step)).toEqual([1]);
  });

  it('X8 pages past one page keep every row once, in order, and a trade on page 2 its cycle; --session keeps one session', async () => {
    const session = await seedSession({ martingale: true });
    const other = await seedSession();
    const total = TRADE_LOG_PAGE_ROWS + 5;
    const { intent: first } = await sessionIntent(session, 1);
    await seedBrokerTradeFor(tmp.db, first, { profit: '-1.00' as DecimalString });
    for (let step = 2; step < total; step += 1) {
      await recordSignalDecision(
        tmp.db,
        decisionFixture(session, { step, outcome: SignalDecisionOutcome.Paused }),
      );
    }
    const { intent: last } = await sessionIntent(session, total);
    await seedBrokerTradeFor(tmp.db, last, { profit: '0.85' as DecimalString });
    await recordSignalDecision(
      tmp.db,
      decisionFixture(other, { outcome: SignalDecisionOutcome.Paused }),
    );
    await tmp.db.execute(
      sql`update ${signalDecisions} set recorded_at = '2003-01-01T00:00:00Z'::timestamptz + (step * interval '1 microsecond') where trading_session_id in (${session.sessionId}, ${other.sessionId})`,
    );
    const { out, err } = await run(
      'export',
      '--from',
      '2003-01-01T00:00:00Z',
      '--to',
      '2003-01-02T00:00:00Z',
      '--session',
      session.sessionId,
    );
    const lines = linesOf(out);
    expect(lines.map((line) => line.decision.step)).toEqual(
      Array.from({ length: total }, (_, index) => index + 1),
    );
    expect(err).toEqual([`строк: ${total}`]);
    const cycleOf = (line: TradeLogLine | undefined) => ({
      intentId: line?.trade?.intentId,
      cycle: line?.trade?.cycle,
      cycleStep: line?.trade?.cycleStep,
    });
    expect(cycleOf(lines[0])).toEqual({ intentId: first.id, cycle: 1, cycleStep: 1 });
    expect(cycleOf(lines.at(-1))).toEqual({ intentId: last.id, cycle: 1, cycleStep: 2 });
    const both = await run(
      'export',
      '--from',
      '2003-01-01T00:00:00Z',
      '--to',
      '2003-01-02T00:00:00Z',
    );
    expect(linesOf(both.out)).toHaveLength(total + 1);
  });

  it('X15 an intent rejected past its entry window prints its reason and its deadline (#670)', async () => {
    const session = await seedSession();
    const { intent } = await sessionIntent(session, 1, { record: signalRecord() });
    const deadline = new Date('2003-06-01T00:00:01.250Z');
    await tmp.db
      .update(tradeIntents)
      .set({ submitDeadlineAt: deadline })
      .where(eq(tradeIntents.id, intent.id));
    const late = await tmp.db.transaction((tx) =>
      rejectLateIntent(tx, { id: intent.id, expectedVersion: intent.version }),
    );
    expect(late).toBeDefined();
    const { code, out } = await run('export', '--from', FROM, '--session', session.sessionId);
    expect(code).toBe(0);
    expect(linesOf(out).map((line) => line.trade)).toEqual([
      expect.objectContaining({
        intentId: intent.id,
        status: 'rejected',
        lastError: 'entry_window_missed',
        submitDeadlineAtMs: deadline.getTime(),
        submittedAtMs: null,
      }),
    ]);
  });

  it('X16 a broker payout outside the column: the broker object with payout null, trades-json without the key (#675)', async () => {
    const session = await seedSession();
    const { intent } = await sessionIntent(session, 1);
    await seedBrokerTradeFor(tmp.db, intent, { payout: -5, profit: '0.85' as DecimalString });
    const { code, out } = await run('export', '--from', FROM, '--session', session.sessionId);
    expect(code).toBe(0);
    expect(linesOf(out).map((line) => line.trade?.broker)).toEqual([
      expect.objectContaining({ status: 'closed', payout: null, profit: '0.85000000' }),
    ]);
    const json = await run(
      'export',
      '--from',
      FROM,
      '--session',
      session.sessionId,
      '--format',
      'trades-json',
    );
    expect(json.code).toBe(0);
    const rows: unknown = JSON.parse(json.out);
    z.array(tradeLogTradeJsonSchema).length(1).parse(rows);
    expect(Object.keys((rows as object[])[0]!)).not.toContain('payout');
  });

  it('X9 lines without a trade: a start decision without a session, a refusal with its detail and result', async () => {
    const seed = await seedUserWithAccount(tmp.db, { balance: 50n });
    const quiet = noSignalRecord();
    expect(quiet.entry.decision.kind).toBe(SignalKind.NoSignal);
    const start = await recordSignalDecision(
      tmp.db,
      decisionFixture(
        { sessionId: '', brokerAccountId: seed.brokerAccountId },
        {
          context: SignalDecisionContext.SessionStart,
          tradingSessionId: null,
          step: null,
          outcome: SignalDecisionOutcome.NoSignal,
        },
        quiet,
      ),
    );
    const session = await seedSession();
    const record = signalRecord();
    expect(record.entry.decision.kind).toBe(SignalKind.Signal);
    const refused = await recordSignalDecision(
      tmp.db,
      decisionFixture(
        session,
        { outcome: SignalDecisionOutcome.Refused, detail: 'insufficient_tokens' },
        record,
      ),
    );
    await tmp.db
      .update(signalDecisions)
      .set({ result: { probe: 'x9' } })
      .where(eq(signalDecisions.id, refused.id));
    await tmp.db.execute(
      sql`update ${signalDecisions} set recorded_at = case id when ${start.id}::uuid then '2005-01-01T00:00:01Z'::timestamptz else '2005-01-01T00:00:02Z'::timestamptz end where id in (${start.id}::uuid, ${refused.id}::uuid)`,
    );
    const { code, out, err } = await run(
      'export',
      '--from',
      '2005-01-01T00:00:00Z',
      '--to',
      '2005-01-02T00:00:00Z',
    );
    expect(code).toBe(0);
    expect(err).toEqual(['строк: 2']);
    const lines = linesOf(out);
    const decided = {
      version: record.entry.version,
      assetId: 101,
      interval: '15s',
      decidedAtMs: record.entry.nowMs,
      takenAtMs: record.entry.nowMs + 50,
      payout: 92,
      ticksUntilMs: null,
    };
    expect(lines).toEqual([
      {
        decision: {
          ...decided,
          id: start.id,
          context: 'session_start',
          outcome: 'no_signal',
          detail: null,
          step: null,
          kind: 'no_signal',
          action: null,
          recordedAtMs: Date.parse('2005-01-01T00:00:01Z'),
          lastTick: null,
          result: null,
        },
        signal: quiet.entry,
        session: null,
        trade: null,
        ticks: null,
      },
      {
        decision: {
          ...decided,
          id: refused.id,
          context: 'session',
          outcome: 'refused',
          detail: 'insufficient_tokens',
          step: 1,
          kind: 'signal',
          action: 'up',
          recordedAtMs: Date.parse('2005-01-01T00:00:02Z'),
          lastTick: record.lastTick,
          result: { probe: 'x9' },
        },
        signal: record.entry,
        session: {
          id: session.sessionId,
          userId: session.userId,
          brokerAccountId: session.brokerAccountId,
          mode: 'demo',
          strategy: 'fixed',
          baseStake: '1',
          durationSec: 60,
          stopReason: null,
        },
        trade: null,
        ticks: null,
      },
    ]);
    expect(replaySignalJournalEntry(lines[0]!.signal as SignalJournalEntry)).toEqual(
      quiet.entry.decision,
    );
  });

  it('X11 a shadow row of each set (#669): context shadow, no trade, its result and tick window end, an entry replayH1Entry decides again', async () => {
    const rows = [];
    for (const set of H1_SHADOW_SETS) {
      const params = {
        set: set.name,
        ...set.params,
        entryDelaySec: set.entryDelaySec,
        expirySec: 5,
      };
      rows.push(await recordSignalDecision(tmp.db, shadowDecisionFixture({}, params)));
    }
    await tmp.db.execute(
      sql`update ${signalDecisions} set recorded_at = '2006-01-01T00:00:01Z'::timestamptz where id in (${rows[0]!.id}::uuid, ${rows[1]!.id}::uuid)`,
    );
    const { code, out, err } = await run(
      'export',
      '--from',
      '2006-01-01T00:00:00Z',
      '--to',
      '2006-01-02T00:00:00Z',
    );
    expect(code).toBe(0);
    expect(err).toEqual(['строк: 2']);
    const lines = linesOf(out);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const fixture = shadowDecisionFixture();
      expect(line.decision).toMatchObject({
        context: 'shadow',
        outcome: 'shadow',
        version: 'h1',
        interval: null,
        step: null,
        decidedAtMs: fixture.decidedAtMs,
        ticksUntilMs: fixture.ticksUntilMs,
        result: fixture.result,
        lastTick: fixture.lastTick,
      });
      expect(line.session).toBeNull();
      expect(line.trade).toBeNull();
      const entry = h1ShadowEntrySchema.parse(line.signal);
      expect(replayH1Entry(entry)).toEqual(entry.decision);
    }
    expect(lines.map((line) => h1ShadowEntrySchema.parse(line.signal).params.set).sort()).toEqual([
      'h1',
      'r1',
    ]);
    expect(out).toContain('"context":"shadow"');
  });
  it("X17 an H1 session's repeat row and waiting row (#775): both exported; the waiting row replays", async () => {
    const seed = await seedUserWithAccount(tmp.db);
    const built = buildH1SessionSettings({
      assetId: 101,
      cycles: 5,
      stake: { baseStake: decimalStringSchema.parse('1'), stakeScale: 0 },
      strategy: SessionStakeStrategy.Martingale,
    });
    if (!built.success || !isH1Settings(built.data)) throw new Error('fixture: H1 settings');
    const settings = built.data;
    const session = await seedTradingSession(tmp.db, seed.brokerAccountId, { settings });
    const closes = new Float64Array(H1_R1_PARAMS.sdWindowSec + 1).fill(1.1);
    const f = 1_170_000_000_000;
    const waiting = h1DriverDecisionInput(
      {
        sessionId: session.id,
        brokerAccountId: seed.brokerAccountId,
        settings,
        assetId: 101,
        f,
        takenAtMs: f + 320,
        decision: createH1Detector(H1_R1_PARAMS).decide({
          closes,
          at: H1_R1_PARAMS.sdWindowSec,
        }),
        payout: 92,
        digits: 5,
        symbol: 'EUR/USD',
        closedBy: 'tick',
        closedAtMs: f + 300,
        series: Array.from(closes),
        lastTick: null,
      },
      2,
      SignalDecisionOutcome.NoSignal,
      null,
    );
    const repeat = h1RepeatDecisionInput({
      sessionId: session.id,
      brokerAccountId: seed.brokerAccountId,
      assetId: 101,
      step: 2,
      takenAtMs: f + 9_000,
      payout: 92,
      strategy: SessionStakeStrategy.Martingale,
      after: {
        intentId: '00000000-0000-4000-8000-000000000001',
        action: TradeAction.Down,
        profit: decimalStringSchema.parse('-1'),
      },
      trigger: H1RepeatTrigger.Notice,
      outcome: SignalDecisionOutcome.Refused,
      detail: 'active_intent_exists',
    });
    const rows = [
      await recordSignalDecision(tmp.db, waiting),
      await recordSignalDecision(tmp.db, repeat),
    ];
    await tmp.db.execute(
      sql`update ${signalDecisions} set recorded_at = '2007-01-01T00:00:01Z'::timestamptz where id in (${rows[0]!.id}::uuid, ${rows[1]!.id}::uuid)`,
    );
    const { code, out, err } = await run(
      'export',
      '--from',
      '2007-01-01T00:00:00Z',
      '--to',
      '2007-01-02T00:00:00Z',
    );
    expect(code).toBe(0);
    expect(err).toEqual(['строк: 2']);
    const lines = linesOf(out);
    const byVersion = new Map(lines.map((line) => [line.decision.version, line]));
    expect(byVersion.get('h1')?.decision).toMatchObject({
      context: 'session',
      kind: 'no_signal',
      outcome: 'no_signal',
      step: 2,
    });
    const entry = h1ShadowEntrySchema.parse(byVersion.get('h1')!.signal);
    expect(replayH1Entry(entry)).toEqual(entry.decision);
    expect(byVersion.get('h1-repeat')?.decision).toMatchObject({
      context: 'session',
      kind: 'signal',
      action: 'down',
      outcome: 'refused',
      detail: 'active_intent_exists',
      step: 2,
    });
    expect(byVersion.get('h1-repeat')?.signal).toMatchObject({
      version: 'h1-repeat',
      series: [],
      params: { rule: 'repeat_step_2', strategy: 'martingale' },
      source: { kind: 'settlement', trigger: 'notice' },
    });
  });

  describe('the ticks around a decision (#668)', () => {
    const ticks: [number, number, number][] = [
      [1_760_000_001_000, 1_760_000_001_180, 1.08761],
      [1_760_000_002_000, 1_760_000_002_150, 1.08766],
      [1_760_000_003_000, 1_760_000_003_210, 1.08759],
    ];
    async function sessionWithTicks() {
      const session = await seedSession();
      await recordSignalDecision(
        tmp.db,
        decisionFixture(session, { outcome: SignalDecisionOutcome.Paused, step: 1 }),
      );
      const { intent } = await sessionIntent(session, 2);
      await seedBrokerTradeFor(tmp.db, intent, { profit: '0.85' as DecimalString });
      return { session, decisionId: intent.signalDecisionId! };
    }
    const capture = (decisionId: string) =>
      tmp.db.insert(decisionTicks).values({
        decisionId,
        fromMs: 1_759_999_947_000,
        untilMs: 1_760_000_072_000,
        status: 'truncated',
        detail: 'uncovered',
        count: ticks.length,
        ticks,
      });

    it('X12 a captured decision prints its ticks with every field; X13 one without prints null', async () => {
      const { session, decisionId } = await sessionWithTicks();
      await capture(decisionId);
      const { code, out } = await run('export', '--from', FROM, '--session', session.sessionId);
      expect(code).toBe(0);
      const lines = linesOf(out);
      expect(lines.map((line) => line.decision.outcome)).toEqual(['paused', 'intent']);
      expect(lines[0]!.ticks).toBeNull();
      expect(lines[1]!.ticks).toEqual({
        status: 'truncated',
        detail: 'uncovered',
        fromMs: 1_759_999_947_000,
        untilMs: 1_760_000_072_000,
        count: 3,
        rows: ticks,
      });
    });

    it('X14 trades-json is the same with a ticks row as without', async () => {
      const { session, decisionId } = await sessionWithTicks();
      const tradesJson = () =>
        run('export', '--from', FROM, '--session', session.sessionId, '--format', 'trades-json');
      const before = await tradesJson();
      await capture(decisionId);
      const after = await tradesJson();
      expect(after.code).toBe(0);
      expect(JSON.parse(after.out)).toHaveLength(1);
      expect(after.out).toBe(before.out);
      expect(after.out).not.toContain('1.08761');
    });
  });
});
