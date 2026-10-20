import { eq, sql } from 'drizzle-orm';
import * as z from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SignalDecisionOutcome,
  SignalKind,
  TradeAction,
  TradeMode,
  decimalStringSchema,
  tradeLogLineSchema,
  tradeLogTradeJsonSchema,
  type Candle,
  type DecimalString,
  type SignalRecord,
  type TradeLogLine,
} from '@binarius/shared';
import {
  brokerAccounts,
  brokerTrades,
  createSessionIntent,
  recordSignalDecision,
  signalDecisions,
  users,
} from '@binarius/db';
import {
  createTempDatabase,
  decisionFixture,
  seedBrokerTradeFor,
  seedTradingSession,
  seedUserWithAccount,
  type TempDatabase,
} from '@binarius/db/testing';
import {
  DEFAULT_SIGNAL_PARAMS,
  createSignalDecider,
  replaySignalJournalEntry,
  toJournalCandle,
  type SignalJournalEntry,
} from '@binarius/signal';
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

async function seedSession() {
  const seed = await seedUserWithAccount(tmp.db, { balance: 50n });
  const session = await seedTradingSession(tmp.db, seed.brokerAccountId);
  return { ...seed, sessionId: session.id };
}
type Session = Awaited<ReturnType<typeof seedSession>>;

const sessionIntent = (session: Session, step: number, record?: SignalRecord) =>
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
    decision: decisionFixture(session, { step }, record),
  });

// a real decision of the current decider on 15 s candles, as the feed would record it
function decidedRecord(): SignalRecord {
  const intervalMs = 15_000;
  const start = 1_760_000_000_000;
  const candles: Candle[] = Array.from({ length: 60 }, (_, index) => {
    const close = 1.1 + index * 0.0002 + (index % 3 === 0 ? -0.00015 : 0.0001);
    return {
      timestamp: start + index * intervalMs,
      open: close - 0.0001,
      high: close + 0.0003,
      low: close - 0.0003,
      close,
    };
  });
  const nowMs = start + 60 * intervalMs + 2_000;
  const decider = createSignalDecider();
  const decision = decider.decide({ candles, intervalMs, nowMs, digits: 5 });
  const entry: SignalJournalEntry = {
    assetId: 101,
    interval: '15s',
    digits: 5,
    intervalMs,
    nowMs,
    source: { kind: 'socket', startTime: start, closedUntil: nowMs - 2_000, gaps: 0 },
    version: decider.version,
    params: DEFAULT_SIGNAL_PARAMS,
    series: candles.map(toJournalCandle),
    decision,
  };
  return { entry, lastTick: null };
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

  it("X3 a session's line carries the decision, its replayable entry, the timing chain, the cycle and the stake", async () => {
    const session = await seedSession();
    const record = decidedRecord();
    const signal = record.entry.decision.kind === SignalKind.Signal;
    let intentId: string | undefined;
    if (signal) {
      const { intent } = await sessionIntent(session, 1, record);
      intentId = intent.id;
      await seedBrokerTradeFor(tmp.db, intent, { profit: '-1.00' as DecimalString });
    } else {
      await recordSignalDecision(
        tmp.db,
        decisionFixture(session, { outcome: SignalDecisionOutcome.NoSignal }, record),
      );
    }
    const { code, out, err } = await run('export', '--from', FROM, '--session', session.sessionId);
    expect(code).toBe(0);
    expect(err).toEqual(['строк: 1']);
    const [line] = linesOf(out);
    expect(line!.signal).toEqual(record.entry);
    const entry = line!.signal as SignalJournalEntry;
    expect(replaySignalJournalEntry(entry)).toEqual(record.entry.decision);
    expect(line!.decision).toMatchObject({
      decidedAtMs: record.entry.nowMs,
      takenAtMs: record.entry.nowMs + 50,
      recordedAtMs: expect.any(Number),
      step: 1,
    });
    expect(line!.session).toMatchObject({
      id: session.sessionId,
      userId: session.userId,
      brokerAccountId: session.brokerAccountId,
      strategy: 'fixed',
      baseStake: '1',
      durationSec: 60,
      stopReason: null,
    });
    expect(line!.ticks).toBeNull();
    if (intentId !== undefined) {
      expect(line!.trade).toMatchObject({
        intentId,
        status: 'settled',
        createdAtMs: expect.any(Number),
        submittedAtMs: expect.any(Number),
        cycle: 1,
        cycleStep: 1,
        broker: { status: 'closed', openTimestampMs: expect.any(Number), profit: '-1.00000000' },
      });
    }
  });

  it('X4 trades-json holds only closed trades, in the shape the stand reads', async () => {
    const session = await seedSession();
    const { intent: closed } = await sessionIntent(session, 1);
    await seedBrokerTradeFor(tmp.db, closed, { profit: '0.85' as DecimalString });
    await recordSignalDecision(
      tmp.db,
      decisionFixture(session, { outcome: SignalDecisionOutcome.Paused, step: 2 }),
    );
    const { intent: open } = await sessionIntent(session, 2);
    await seedBrokerTradeFor(tmp.db, open);
    const jsonl = await run('export', '--from', FROM, '--session', session.sessionId);
    expect(linesOf(jsonl.out)).toHaveLength(3);
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
    expect(err).toEqual(['строк: 1']);
    const trades = z.array(tradeLogTradeJsonSchema).parse(JSON.parse(out));
    expect(trades).toEqual([
      expect.objectContaining({
        trading_session_id: session.sessionId,
        intent_id: closed.id,
        asset_id: 101,
        action: 'up',
        duration_sec: 60,
        created_at_ms: closed.createdAt.getTime(),
        profit: '0.85000000',
        mode: 'demo',
        amount: '1.00000000',
      }),
    ]);
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

  it('X8 pages past one page keep every row once, in order; --session keeps one session', async () => {
    const session = await seedSession();
    const other = await seedSession();
    const total = TRADE_LOG_PAGE_ROWS + 5;
    for (let step = 1; step <= total; step += 1) {
      await recordSignalDecision(
        tmp.db,
        decisionFixture(session, { step, outcome: SignalDecisionOutcome.Paused }),
      );
    }
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
    const steps = linesOf(out).map((line) => line.decision.step);
    expect(steps).toEqual(Array.from({ length: total }, (_, index) => index + 1));
    expect(err).toEqual([`строк: ${total}`]);
    const both = await run(
      'export',
      '--from',
      '2003-01-01T00:00:00Z',
      '--to',
      '2003-01-02T00:00:00Z',
    );
    expect(linesOf(both.out)).toHaveLength(total + 1);
  });
});
