import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  breakEvenPct,
  decimalStringSchema,
  TradeAction,
  TradeIntentFailureReason,
  TradeIntentStatus,
  TradeMode,
  tradeLogLineSchema,
  verdictOf,
  wilson,
  type DecimalString,
  type SignalRecord,
} from '@binarius/shared';
import {
  brokerTrades,
  createSessionIntent,
  rejectIntent,
  signalDecisions,
  tradeIntents,
  type SignalDecisionInput,
} from '@binarius/db';
import {
  createTempDatabase,
  decisionFixture,
  seedBrokerTradeFor,
  seedQueuedIntent,
  seedTradingSession,
  seedUserWithAccount,
  signalRecordFixture,
  type TempDatabase,
} from '@binarius/db/testing';
import { ALL_PAIRS, NO_PAYOUT, NO_TRADES } from './report';
import { runTradeLogCli } from './trade-log';
import { MANUAL_LABEL, UNLINKED_LABEL } from './trade-report';

// The trade report (#502, docs/trade-log.md → The report) through runTradeLogCli on a temporary
// database built from the migration files. Every case moves its intents into a day of its own.
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

const DAY_MS = 86_400_000;
let days = 0;
// a day of its own per case, a day apart, so no case's rows (RP9 places one at its window's end)
// reach another case's window
const ownDay = () => {
  const since = new Date(Date.UTC(2003, 0, 1) + ++days * 2 * DAY_MS);
  return { since, until: new Date(since.getTime() + DAY_MS) };
};
const placeAt = (ids: readonly string[], at: Date) =>
  tmp.db
    .update(tradeIntents)
    .set({ createdAt: at })
    .where(inArray(tradeIntents.id, [...ids]));

const withParams = (patch: Record<string, unknown>): SignalRecord => {
  const record = signalRecordFixture();
  return { ...record, entry: { ...record.entry, params: { ...record.entry.params, ...patch } } };
};

type Outcome = { profit: string; payout?: number } | 'rejected' | 'open';
interface StepSpec {
  outcome: Outcome;
  assetId?: number;
  // null: an intent without a decision row; h1: the H1 driver's row shape (interval NULL, symbol)
  record?: SignalRecord | null | 'h1';
}

// the H1 driver's decision row (docs/h1.md → The driver): version h1, no interval, ticks source
const h1Decision = (input: SignalDecisionInput, assetId: number): SignalDecisionInput => ({
  ...input,
  assetId,
  interval: null,
  version: 'h1',
  params: { set: 'session', sdWindowSec: 60 },
  source: { kind: 'ticks', symbol: 'EUR/USD' },
});

// a session's steps in order, each intent created with its decision row in its transaction, then
// settled, rejected or left open at the broker; the intent ids by step
async function sessionSteps(
  steps: readonly StepSpec[],
  { mode = TradeMode.Demo, durationSec = 60 }: { mode?: TradeMode; durationSec?: number } = {},
) {
  const seed = await seedUserWithAccount(tmp.db, { balance: 50n, tradingMode: mode });
  const row = await seedTradingSession(tmp.db, seed.brokerAccountId, { mode });
  const session = { ...seed, sessionId: row.id };
  const ids: string[] = [];
  for (const [index, spec] of steps.entries()) {
    const step = index + 1;
    const assetId = spec.assetId ?? 101;
    let decision: SignalDecisionInput | null;
    if (spec.record === null) decision = null;
    else if (spec.record === 'h1') {
      decision = h1Decision(decisionFixture(session, { step }), assetId);
    } else decision = decisionFixture(session, { step }, spec.record ?? signalRecordFixture());
    const { intent } = await createSessionIntent(tmp.db, {
      sessionId: session.sessionId,
      step,
      telegramUserId: session.telegramUserId,
      brokerAccountId: session.brokerAccountId,
      mode,
      assetId,
      amount: decimalStringSchema.parse('1'),
      action: TradeAction.Up,
      durationSec,
      decision,
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
    } else {
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

async function run(argv: string[], env: NodeJS.ProcessEnv = { DATABASE_URL: tmp.url }) {
  let out = '';
  const err: string[] = [];
  const code = await runTradeLogCli(
    argv,
    env,
    (text) => (out += text),
    (line) => err.push(line),
  );
  return { code, out, err };
}

const HEAD =
  '| версия | параметры | пара | интервал | длит., с | сделок | не закрыто | W | L | T | win % | 95 % CI | выплата, средн. (min-max) | безубыточность % | вердикт | ставок | P&L | ROI % |';
const VERSIONS_HEAD = '| версия | отпечаток | сделок | первая сделка | последняя сделка | params |';

interface Row {
  section: string;
  version: string;
  params: string;
  pair: string;
  interval: string;
  duration: string;
  trades: string;
  notClosed: string;
  W: string;
  L: string;
  T: string;
  winPct: string;
  ci: string;
  payout: string;
  breakEven: string;
  verdict: string;
  staked: string;
  pnl: string;
  roi: string;
}

interface VersionRow {
  version: string;
  hash: string;
  trades: string;
  first: string;
  last: string;
  params: string;
}

// the mode tables' rows and the «Параметры» rows, read back from the markdown by their heads
function parse(markdown: string): { rows: Row[]; versions: VersionRow[] } {
  const rows: Row[] = [];
  const versions: VersionRow[] = [];
  let section = '';
  let head = '';
  for (const line of markdown.split('\n')) {
    if (line.startsWith('#')) section = line.replace(/^#+ /, '');
    if (line === HEAD || line === VERSIONS_HEAD) head = line;
    if (!line.startsWith('| ') || line === head || line.startsWith('| ---')) continue;
    const cells = line.slice(2, -2).split(' | ');
    if (head === VERSIONS_HEAD) {
      const [version, hash, trades, first, last, params] = cells;
      versions.push({
        version: version!,
        hash: hash!,
        trades: trades!,
        first: first!,
        last: last!,
        params: params!,
      });
      continue;
    }
    const [
      version,
      params,
      pair,
      interval,
      duration,
      trades,
      notClosed,
      W,
      L,
      T,
      winPct,
      ci,
      payout,
      breakEven,
      verdict,
      staked,
      pnl,
      roi,
    ] = cells;
    rows.push({
      section,
      version: version!,
      params: params!,
      pair: pair!,
      interval: interval!,
      duration: duration!,
      trades: trades!,
      notClosed: notClosed!,
      W: W!,
      L: L!,
      T: T!,
      winPct: winPct!,
      ci: ci!,
      payout: payout!,
      breakEven: breakEven!,
      verdict: verdict!,
      staked: staked!,
      pnl: pnl!,
      roi: roi!,
    });
  }
  return { rows, versions };
}

// the report of one window through the entry point
async function report(window: { since: Date; until: Date }) {
  const result = await run([
    'report',
    '--since',
    window.since.toISOString(),
    '--until',
    window.until.toISOString(),
  ]);
  return { ...result, ...parse(result.out) };
}

const ciText = (wins: number, n: number) => {
  const ci = wilson(wins, n);
  return `${ci.low.toFixed(2)}-${ci.high.toFixed(2)}`;
};

const hashesOf = async (ids: readonly string[]) =>
  (
    await tmp.db
      .select({ hash: signalDecisions.paramsHash })
      .from(signalDecisions)
      .innerJoin(tradeIntents, eq(tradeIntents.signalDecisionId, signalDecisions.id))
      .where(inArray(tradeIntents.id, [...ids]))
  ).map((row) => row.hash);

describe('trade-log report (#502)', () => {
  it('RP1 a command it does not understand is a usage error: exit 2, nothing on stdout', async () => {
    const cases = [
      ['report'],
      ['report', 'extra', '--since', '24h'],
      ['report', '--since', '0h'],
      ['report', '--since', '10000d'],
      ['report', '--since', '2026-10-20T00:00:00'],
      ['report', '--since', '2026-10-20T00:00:00.0001Z'],
      ['report', '--since', '24h', '--until', '24h'],
      ['report', '--since', '2026-10-20T00:00:00Z', '--until', '2026-10-20T00:00:00Z'],
      ['report', '--since', '2026-10-21T00:00:00Z', '--until', '2026-10-20T00:00:00Z'],
      ['report', '--since', '24h', '--session', '00000000-0000-0000-0000-000000000000'],
      ['nothing'],
    ];
    for (const argv of cases) {
      const { code, out, err } = await run(argv, {});
      expect({ argv, code, out }).toEqual({ argv, code: 2, out: '' });
      expect(err.at(-1)).toContain('trade-log report --since');
    }
    // a --since after the database's now, with no --until: the window is reversed
    const future = await run(['report', '--since', '2999-01-01T00:00:00Z']);
    expect(future.code).toBe(2);
    expect(future.out).toBe('');
    expect(future.err[0]).toBe('--since должен быть раньше конца периода');
    expect(future.err.at(-1)).toContain('trade-log report --since');
  });

  it('RP2 without DATABASE_URL: exit 1, the variable named', async () => {
    const { code, out, err } = await run(['report', '--since', '24h'], {});
    expect(code).toBe(1);
    expect(out).toBe('');
    expect(err.join('\n')).toContain('DATABASE_URL');
  });

  it('RP3 a window without a closed trade is not a pass: exit 1, nothing on stdout', async () => {
    const empty = ownDay();
    expect(
      await run([
        'report',
        '--since',
        empty.since.toISOString(),
        '--until',
        empty.until.toISOString(),
      ]),
    ).toEqual({
      code: 1,
      out: '',
      err: ['нет закрытых сделок за период'],
    });
    const window = ownDay();
    const { ids } = await sessionSteps([{ outcome: 'rejected' }]);
    await placeAt(ids, window.since);
    const { code, out, err } = await report(window);
    expect({ code, out, err }).toEqual({
      code: 1,
      out: '',
      err: ["intent'ов без закрытой сделки: 1 (rejected: 1)", 'нет закрытых сделок за период'],
    });
  });

  it('RP4 every column of a cell, and an H1 session row with its symbol and no interval', async () => {
    const window = ownDay();
    const v2 = await sessionSteps([
      { outcome: win },
      { outcome: win },
      { outcome: loss },
      { outcome: tie },
      { outcome: 'rejected' },
      { outcome: 'open' },
    ]);
    const h1 = await sessionSteps(
      [
        { outcome: { profit: '0.94', payout: 94 }, record: 'h1', assetId: 7 },
        { outcome: { profit: '-1', payout: 94 }, record: 'h1', assetId: 7 },
      ],
      { durationSec: 5 },
    );
    await placeAt([...v2.ids, ...h1.ids], window.since);
    const { code, rows } = await report(window);
    expect(code).toBe(0);
    const [hash] = await hashesOf(v2.ids.slice(0, 1));
    const breakEven = breakEvenPct(85);
    const pair = rows.find((row) => row.version === 'v2' && row.pair === '101');
    expect(pair).toEqual({
      section: 'demo',
      version: 'v2',
      params: hash!.slice(0, 8),
      pair: '101',
      interval: '15s',
      duration: '60',
      trades: '4',
      notClosed: '2',
      W: '2',
      L: '1',
      T: '1',
      winPct: '66.67',
      ci: ciText(2, 3),
      payout: '85.00 (85-85)',
      breakEven: breakEven.toFixed(2),
      verdict: verdictOf(wilson(2, 3), breakEven),
      staked: '$4.00',
      pnl: '+$0.70',
      roi: '+17.50',
    });
    expect(rows.find((row) => row.version === 'h1' && row.pair === 'EUR/USD (7)')).toMatchObject({
      interval: '—',
      duration: '5',
      trades: '2',
      W: '1',
      L: '1',
      payout: '94.00 (94-94)',
      pnl: '-$0.06',
      roi: '-3.00',
    });
  });

  it('RP5 no decided trade -> нет сделок, no payout -> нет выплаты; neither beats break-even', async () => {
    const window = ownDay();
    const ties = await sessionSteps([{ outcome: tie }, { outcome: tie }], { durationSec: 30 });
    const unpriced = await sessionSteps(
      Array.from({ length: 12 }, () => ({ outcome: win })),
      {
        durationSec: 120,
      },
    );
    await tmp.db
      .update(brokerTrades)
      .set({ payout: null })
      .where(inArray(brokerTrades.intentId, unpriced.ids));
    await placeAt([...ties.ids, ...unpriced.ids], window.since);
    const { code, rows } = await report(window);
    expect(code).toBe(0);
    const tied = rows.filter((row) => row.duration === '30');
    const unpricedRows = rows.filter((row) => row.duration === '120');
    expect(tied.map((row) => [row.pair, row.verdict, row.winPct, row.ci])).toEqual([
      ['101', NO_TRADES, '-', '-'],
      [ALL_PAIRS, NO_TRADES, '-', '-'],
    ]);
    expect(
      unpricedRows.map((row) => [row.pair, row.W, row.payout, row.breakEven, row.verdict]),
    ).toEqual([
      ['101', '12', '-', '-', NO_PAYOUT],
      [ALL_PAIRS, '12', '-', '-', NO_PAYOUT],
    ]);
    expect(rows.some((row) => row.verdict === 'beats break-even')).toBe(false);
  });

  it('RP6 two parameter sets under one version: two rows and two «Параметры» rows; another key order adds none', async () => {
    const window = ownDay();
    const base = signalRecordFixture();
    const reordered = Object.fromEntries(
      Object.entries(base.entry.params).reverse(),
    ) as typeof base.entry.params;
    const { ids } = await sessionSteps([
      { outcome: win },
      { outcome: loss, record: withParams({ rsiExtremeBand: 20 }) },
      { outcome: win, record: { ...base, entry: { ...base.entry, params: reordered } } },
    ]);
    await placeAt(ids, window.since);
    const { code, rows, versions } = await report(window);
    expect(code).toBe(0);
    const [first, changed, again] = await hashesOf([ids[0]!]).then(async (one) => [
      one[0]!,
      (await hashesOf([ids[1]!]))[0]!,
      (await hashesOf([ids[2]!]))[0]!,
    ]);
    expect(again).toBe(first);
    expect(changed).not.toBe(first);
    expect(rows.filter((row) => row.pair === '101').map((row) => [row.params, row.trades])).toEqual(
      [
        [first, '2'],
        [changed, '1'],
      ]
        .sort((a, b) => (a[0]! < b[0]! ? -1 : 1))
        .map(([hash, trades]) => [hash!.slice(0, 8), trades]),
    );
    expect(versions.map((row) => [row.version, row.hash, row.trades])).toEqual(
      [
        ['v2', first, '2'],
        ['v2', changed, '1'],
      ].sort((a, b) => (a[1]! < b[1]! ? -1 : 1)),
    );
    const paramsOf = (hash: string) =>
      JSON.parse(versions.find((row) => row.hash === hash)!.params);
    expect(paramsOf(first)).toEqual(base.entry.params);
    expect(paramsOf(changed)).toEqual({ ...base.entry.params, rsiExtremeBand: 20 });
    expect(versions[0]).toMatchObject({
      first: window.since.toISOString(),
      last: window.since.toISOString(),
    });
  });

  it('RP7 a one-off trade and a session trade without a decision row: their own rows, last', async () => {
    const window = ownDay();
    const linked = await sessionSteps([{ outcome: win }, { outcome: loss, record: null }]);
    const oneOff = await seedQueuedIntent(tmp.db);
    await seedBrokerTradeFor(tmp.db, oneOff.intent, { profit: '8.5' as DecimalString });
    await placeAt([...linked.ids, oneOff.intent.id], window.since);
    const { code, rows } = await report(window);
    expect(code).toBe(0);
    expect(
      rows.map((row) => [row.version, row.params, row.pair, row.interval, row.W, row.L]),
    ).toEqual([
      ['v2', expect.stringMatching(/^[0-9a-f]{8}$/), '101', '15s', '1', '0'],
      ['v2', expect.stringMatching(/^[0-9a-f]{8}$/), ALL_PAIRS, '15s', '1', '0'],
      [MANUAL_LABEL, '—', '91', '—', '1', '0'],
      [UNLINKED_LABEL, '—', '101', '—', '0', '1'],
    ]);
  });

  it('RP8 demo and real: a section each, demo first', async () => {
    const window = ownDay();
    const real = await sessionSteps([{ outcome: loss }], { mode: TradeMode.Real });
    const demo = await sessionSteps([{ outcome: win }]);
    await placeAt([...real.ids, ...demo.ids], window.since);
    const { code, out, rows } = await report(window);
    expect(code).toBe(0);
    expect(out.indexOf('\n## demo\n')).toBeGreaterThan(0);
    expect(out.indexOf('\n## real\n')).toBeGreaterThan(out.indexOf('\n## demo\n'));
    expect(rows.map((row) => [row.section, row.pair, row.W, row.L])).toEqual([
      ['demo', '101', '1', '0'],
      ['demo', ALL_PAIRS, '1', '0'],
      ['real', '101', '0', '1'],
      ['real', ALL_PAIRS, '0', '1'],
    ]);
  });

  it('RP9 --since 24h counts back from --until; since in, until out', async () => {
    const window = ownDay();
    const { ids } = await sessionSteps([
      { outcome: win },
      { outcome: win },
      { outcome: win },
      { outcome: win },
    ]);
    const at = (delta: number, base: Date) => new Date(base.getTime() + delta);
    await placeAt([ids[0]!], at(-1, window.since));
    await placeAt([ids[1]!], window.since);
    await placeAt([ids[2]!], at(-1, window.until));
    await placeAt([ids[3]!], window.until);
    const { code, out, err, rows } = await run([
      'report',
      '--since',
      '24h',
      '--until',
      window.until.toISOString(),
    ]).then((result) => ({ ...result, ...parse(result.out) }));
    expect(code).toBe(0);
    expect(out).toContain(`Период: ${window.since.toISOString()} .. ${window.until.toISOString()}`);
    expect(rows.find((row) => row.pair === ALL_PAIRS)).toMatchObject({ trades: '2', W: '2' });
    expect(err).toEqual(['сделок: 2']);
  });

  it('RP10 the numbers equal a count over trade-log export of the same session', async () => {
    const window = ownDay();
    const outcomes = [win, loss, tie, win, { profit: '0.9', payout: 90 }, loss, win];
    const { session, ids } = await sessionSteps([
      ...outcomes.map((outcome) => ({ outcome })),
      { outcome: 'open' as const },
    ]);
    await placeAt(ids, window.since);
    const { code, rows } = await report(window);
    expect(code).toBe(0);
    const exported = await run([
      'export',
      '--from',
      '2000-01-01T00:00:00Z',
      '--session',
      session.sessionId,
    ]);
    expect(exported.code).toBe(0);
    const lines = exported.out
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => tradeLogLineSchema.parse(JSON.parse(line)));
    const closed = lines.flatMap((line) =>
      line.trade?.broker?.status === 'closed' && line.trade.broker.profit !== null
        ? [line.trade.broker.profit]
        : [],
    );
    const count = (pick: (profit: string) => boolean) => String(closed.filter(pick).length);
    expect(rows.find((row) => row.pair === '101')).toMatchObject({
      trades: String(closed.length),
      W: count((profit) => !profit.startsWith('-') && !/^0(\.0*)?$/.test(profit)),
      L: count((profit) => profit.startsWith('-')),
      T: count((profit) => /^0(\.0*)?$/.test(profit)),
      notClosed: '1',
    });
  });

  it('RP11 the markdown: title, window, sections, heads, pooled after its pairs, «Параметры» last', async () => {
    const window = ownDay();
    const { ids } = await sessionSteps([
      { outcome: win, assetId: 101 },
      { outcome: loss, assetId: 102 },
      { outcome: win, assetId: 102 },
    ]);
    const single = await sessionSteps([{ outcome: win }], { durationSec: 15 });
    await placeAt([...ids, ...single.ids], window.since);
    const { code, out, rows } = await report(window);
    expect(code).toBe(0);
    const lines = out.split('\n');
    expect(lines.slice(0, 3)).toEqual([
      '# trade-log report',
      '',
      `Период: ${window.since.toISOString()} .. ${window.until.toISOString()} (по trade_intents.created_at, часы базы); intent'ов: 4, закрытых сделок: 4`,
    ]);
    expect(lines.filter((line) => line.startsWith('#'))).toEqual([
      '# trade-log report',
      '## demo',
      '### Параметры',
    ]);
    expect(lines.indexOf(HEAD)).toBe(lines.indexOf('## demo') + 2);
    expect(lines.indexOf(VERSIONS_HEAD)).toBe(lines.indexOf('### Параметры') + 2);
    expect(out.endsWith('|\n')).toBe(true);
    expect(rows.map((row) => [row.duration, row.pair, row.trades])).toEqual([
      ['15', '101', '1'],
      ['15', ALL_PAIRS, '1'],
      ['60', '102', '2'],
      ['60', '101', '1'],
      ['60', ALL_PAIRS, '3'],
    ]);
  });

  it('RP12 stderr: the intents without a closed trade by status, then the count of trades', async () => {
    const window = ownDay();
    const { ids } = await sessionSteps([
      { outcome: win },
      { outcome: win },
      { outcome: loss },
      { outcome: tie },
      { outcome: 'rejected' },
      { outcome: 'open' },
    ]);
    await placeAt(ids, window.since);
    const { code, err } = await report(window);
    expect(code).toBe(0);
    expect(err).toEqual([
      "intent'ов без закрытой сделки: 2 (accepted: 1, rejected: 1)",
      'сделок: 4',
    ]);
  });
});
