import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  breakEvenPct,
  H1_MIN_PAYOUT_PCT,
  H1ShadowEntryOutcome,
  H1ShadowSet,
  h1ShadowEntrySchema,
  markdownTable,
  SignalDecisionContext,
  tradeLogLineSchema,
  verdictOf,
  wilson,
  type H1ShadowParams,
} from '@binarius/shared';
import { recordSignalDecision, signalDecisions, type SignalDecisionInput } from '@binarius/db';
import {
  createTempDatabase,
  decisionFixture,
  SHADOW_FIXTURE_DECIDED_AT_MS,
  seedTradingSession,
  seedUserWithAccount,
  shadowDecisionFixture,
  type TempDatabase,
} from '@binarius/db/testing';
import { H1_SHADOW_SETS } from '@binarius/signal';
import { h1ShadowParams } from '../h1/shadow';
import { ALL_PAIRS, NO_PAYOUT, NO_SET, NO_TRADES, parseH1Args, runH1Cli } from './h1';
import { runTradeLogCli } from './trade-log';

// The H1 shadow report (#681, docs/h1.md → The report) through runH1Cli on a temporary migrated
// database. Every case reads its own window of recorded_at, far from the rows recorded now().
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

const paramsOf = (set: H1ShadowSet): H1ShadowParams => {
  const spec = H1_SHADOW_SETS.find((candidate) => candidate.name === set);
  if (spec === undefined) throw new Error(`no shadow set ${set}`);
  return h1ShadowParams(spec);
};
const R1 = paramsOf(H1ShadowSet.R1);
const H1 = paramsOf(H1ShadowSet.H1);
const { Win, Loss, Tie, Unpriced } = H1ShadowEntryOutcome;

const entriesOf = (g1: string, g2: string) => ({
  entries: [
    { entryDelaySec: 1, entryPrice: 1.1, exitPrice: 1.1, outcome: g1 },
    { entryDelaySec: 2, entryPrice: 1.1, exitPrice: 1.1, outcome: g2 },
  ],
});

const shadowRow = ({
  params = R1,
  assetId = 1,
  symbol = 'EUR/USD',
  payout = 92,
  lagMs = 500,
  result = entriesOf(Win, Loss),
}: {
  params?: Readonly<Record<string, unknown>>;
  assetId?: number;
  symbol?: string | null;
  payout?: number | null;
  lagMs?: number;
  result?: Record<string, unknown> | null;
}): SignalDecisionInput => {
  const base = shadowDecisionFixture();
  const source: Record<string, unknown> = { ...base.source, symbol };
  if (symbol === null) delete source.symbol;
  return {
    ...base,
    assetId,
    source,
    payout,
    takenAtMs: SHADOW_FIXTURE_DECIDED_AT_MS + lagMs,
    result,
    params,
  };
};

async function seedAt(at: string, rows: readonly SignalDecisionInput[]): Promise<void> {
  for (const input of rows) {
    const { id } = await recordSignalDecision(tmp.db, input);
    await tmp.db
      .update(signalDecisions)
      .set({ recordedAt: new Date(at) })
      .where(eq(signalDecisions.id, id));
  }
}

const times = <T>(n: number, row: () => T): T[] => Array.from({ length: n }, row);

async function run(argv: string[], env: NodeJS.ProcessEnv = { DATABASE_URL: tmp.url }) {
  let out = '';
  const err: string[] = [];
  const code = await runH1Cli(
    argv,
    env,
    (text) => (out += text),
    (line) => err.push(line),
  );
  return { code, out, err };
}

// the report of [since, since + 1 day) through the entry point; its cells come from the same
// rendering, read back from the markdown by the column head
async function report(since: string, until = new Date(Date.parse(since) + 86_400_000)) {
  const result = await run(['shadow', 'report', '--since', since, '--until', until.toISOString()]);
  return { ...result, rows: rowsOf(result.out) };
}

interface Row {
  section: string;
  pair: string;
  decisions: string;
  g: string;
  W: string;
  L: string;
  T: string;
  unpriced: string;
  winPct: string;
  ci: string;
  ev: string;
  payout: string;
  breakEven: string;
  verdict: string;
}

const HEAD =
  '| пара | решений | g | W | L | T | unpriced | win % | 95 % CI | EV/trade % | выплата, средн. (min-max) | безубыточность % | вердикт |';

function rowsOf(markdown: string): Row[] {
  const rows: Row[] = [];
  let section = '';
  for (const line of markdown.split('\n')) {
    if (line.startsWith('## ')) section = line.slice(3);
    if (!line.startsWith('| ') || line === HEAD || line.startsWith('| ---')) continue;
    const [pair, decisions, g, W, L, T, unpriced, winPct, ci, ev, payout, breakEven, verdict] = line
      .slice(2, -2)
      .split(' | ');
    rows.push({
      section,
      pair: pair!,
      decisions: decisions!,
      g: g!,
      W: W!,
      L: L!,
      T: T!,
      unpriced: unpriced!,
      winPct: winPct!,
      ci: ci!,
      ev: ev!,
      payout: payout!,
      breakEven: breakEven!,
      verdict: verdict!,
    });
  }
  return rows;
}

const cellOf = (rows: readonly Row[], section: string, pair: string, g: string) => {
  const row = rows.find((r) => r.section === section && r.pair === pair && r.g.startsWith(g));
  if (row === undefined) throw new Error(`no row ${section} / ${pair} / ${g}`);
  return row;
};

const ciText = (wins: number, n: number) => {
  const ci = wilson(wins, n);
  return `${ci.low.toFixed(2)}-${ci.high.toFixed(2)}`;
};

describe('h1 shadow report (#681)', () => {
  it('HR1 a command it does not understand is a usage error: exit 2, nothing on stdout', async () => {
    const cases = [
      [],
      ['shadow'],
      ['report'],
      ['shadow', 'replay', '--since', '24h'],
      ['shadow', 'report', 'extra', '--since', '24h'],
      ['shadow', 'report'],
      ...['24', '0h', '1.5h', '24H', '10000h', '2026-10-20T00:00:00', 'yesterday'].map((since) => [
        'shadow',
        'report',
        '--since',
        since,
      ]),
      ['shadow', 'report', '--since', '24h', '--until', '24h'],
      ['shadow', 'report', '--since', '2026-10-20T00:00:00.0001Z'],
      ['shadow', 'report', '--since', '2026-10-20T00:00:00Z', '--until', '2026-10-20T00:00:00Z'],
      ['shadow', 'report', '--since', '2026-10-21T00:00:00Z', '--until', '2026-10-20T00:00:00Z'],
      ['shadow', 'report', '--since', '24h', '--set', 'r1'],
    ];
    for (const argv of cases) {
      const { code, out, err } = await run(argv, {});
      expect({ argv, code, out }).toEqual({ argv, code: 2, out: '' });
      expect(err.at(-1)).toContain('h1 shadow report --since');
    }
  });

  it('HR2 the arguments: a relative since in hours or days, an instant as given', () => {
    expect(parseH1Args(['shadow', 'report', '--since', '24h'])).toEqual({
      since: { hours: 24 },
      until: undefined,
    });
    expect(parseH1Args(['shadow', 'report', '--since', '7d'])).toEqual({
      since: { days: 7 },
      until: undefined,
    });
    expect(
      parseH1Args([
        'shadow',
        'report',
        '--since',
        '2026-10-20T01:02:03.456+03:00',
        '--until',
        '2026-10-21T00:00:00Z',
      ]),
    ).toEqual({
      since: { at: new Date('2026-10-19T22:02:03.456Z') },
      until: new Date('2026-10-21T00:00:00Z'),
    });
    expect(parseH1Args(['shadow', 'report', '--since', '9999h']).since).toEqual({ hours: 9999 });
  });

  it('HR3 without DATABASE_URL: exit 1, the variable named', async () => {
    const { code, out, err } = await run(['shadow', 'report', '--since', '24h'], {});
    expect(code).toBe(1);
    expect(out).toBe('');
    expect(err.join('\n')).toContain('DATABASE_URL');
  });

  it('HR4 an empty window is not a pass: no decisions, exit 1, nothing on stdout', async () => {
    const { code, out, err } = await run([
      'shadow',
      'report',
      '--since',
      '1999-01-01T00:00:00Z',
      '--until',
      '1999-01-02T00:00:00Z',
    ]);
    expect({ code, out, err }).toEqual({ code: 1, out: '', err: ['нет решений за период'] });
  });

  it('HR5 every cell: W/L/T/unpriced, win % without ties, Wilson CI, EV, payout, break-even, verdict', async () => {
    const at = '2002-05-01T00:00:00.000Z';
    await seedAt(at, [
      shadowRow({ payout: 90, result: entriesOf(Win, Loss) }),
      shadowRow({ payout: 92, result: entriesOf(Win, Tie) }),
      shadowRow({ payout: 94, result: entriesOf(Loss, Unpriced) }),
      shadowRow({ payout: 90, result: entriesOf(Tie, Win) }),
      ...times(12, () =>
        shadowRow({ assetId: 2, symbol: 'GBP/USD', payout: 96, result: entriesOf(Win, Loss) }),
      ),
      ...times(2, () => shadowRow({ params: H1, payout: 92, result: entriesOf(Win, Win) })),
    ]);
    const { code, rows, err } = await report(at);
    expect(code).toBe(0);
    expect(err).toEqual(['решений: 18']);
    const eurBreakEven = breakEvenPct(91.5);
    expect(cellOf(rows, 'Набор r1', 'EUR/USD (1)', '1')).toEqual({
      section: 'Набор r1',
      pair: 'EUR/USD (1)',
      decisions: '4',
      g: '1*',
      W: '2',
      L: '1',
      T: '1',
      unpriced: '0',
      winPct: '66.67',
      ci: ciText(2, 3),
      ev: '+20.50',
      payout: '91.50 (90-94)',
      breakEven: eurBreakEven.toFixed(2),
      verdict: verdictOf(wilson(2, 3), eurBreakEven),
    });
    expect(cellOf(rows, 'Набор r1', 'EUR/USD (1)', '2')).toMatchObject({
      g: '2',
      W: '1',
      L: '1',
      T: '1',
      unpriced: '1',
      winPct: '50.00',
      ci: ciText(1, 2),
      ev: '-3.33',
      verdict: 'inconclusive',
    });
    const gbpBreakEven = breakEvenPct(96).toFixed(2);
    expect(cellOf(rows, 'Набор r1', 'GBP/USD (2)', '1')).toMatchObject({
      decisions: '12',
      W: '12',
      winPct: '100.00',
      ci: ciText(12, 12),
      ev: '+96.00',
      payout: '96.00 (96-96)',
      breakEven: gbpBreakEven,
      verdict: 'beats break-even',
    });
    expect(cellOf(rows, 'Набор r1', 'GBP/USD (2)', '2')).toMatchObject({
      L: '12',
      winPct: '0.00',
      ci: ciText(0, 12),
      ev: '-100.00',
      verdict: 'below',
    });
    expect(cellOf(rows, 'Набор h1', 'EUR/USD (1)', '2')).toMatchObject({
      g: '2*',
      decisions: '2',
      W: '2',
      ev: '+92.00',
      payout: '92.00 (92-92)',
    });
  });

  it('HR6 a cell without evidence never beats break-even: no trades, no payout', async () => {
    const at = '2002-06-01T00:00:00.000Z';
    await seedAt(at, [
      shadowRow({ assetId: 20, symbol: 'TIE/USD', payout: 96, result: entriesOf(Tie, Unpriced) }),
      shadowRow({ assetId: 20, symbol: 'TIE/USD', payout: 96, result: entriesOf(Unpriced, Tie) }),
      ...times(12, () =>
        shadowRow({ assetId: 21, symbol: 'NUL/USD', payout: null, result: entriesOf(Win, Loss) }),
      ),
      shadowRow({ assetId: 22, symbol: 'MIX/USD', payout: null, result: entriesOf(Win, Tie) }),
      shadowRow({ assetId: 22, symbol: 'MIX/USD', payout: 90, result: entriesOf(Loss, Tie) }),
    ]);
    const { code, rows } = await report(at);
    expect(code).toBe(0);
    for (const g of ['1', '2']) {
      expect(cellOf(rows, 'Набор r1', 'TIE/USD (20)', g)).toMatchObject({
        winPct: '-',
        ci: '-',
        ev: '-',
        breakEven: breakEvenPct(96).toFixed(2),
        verdict: NO_TRADES,
      });
    }
    expect(cellOf(rows, 'Набор r1', 'NUL/USD (21)', '1')).toMatchObject({
      W: '12',
      ci: ciText(12, 12),
      ev: '-',
      payout: '-',
      breakEven: '-',
      verdict: NO_PAYOUT,
    });
    expect(cellOf(rows, 'Набор r1', 'MIX/USD (22)', '1')).toMatchObject({
      W: '1',
      L: '1',
      ci: ciText(1, 2),
      ev: '-',
      payout: '90.00 (90-90)',
    });
  });

  it('HR7 a relative since counts back from until, not from now; since is in', async () => {
    await seedAt('2002-07-01T11:00:00.000Z', [shadowRow({})]);
    await seedAt('2002-07-01T11:30:00.000Z', [shadowRow({})]);
    await seedAt('2002-07-01T10:59:59.999Z', [shadowRow({})]);
    const { code, err } = await run([
      'shadow',
      'report',
      '--since',
      '1h',
      '--until',
      '2002-07-01T12:00:00Z',
    ]);
    expect(code).toBe(0);
    expect(err.at(-1)).toBe('решений: 2');
  });

  it('HR8 the rows of sessions are not counted', async () => {
    const at = '2002-08-01T00:00:00.000Z';
    const seed = await seedUserWithAccount(tmp.db, { balance: 50n });
    const session = await seedTradingSession(tmp.db, seed.brokerAccountId);
    const ids = { sessionId: session.id, brokerAccountId: seed.brokerAccountId };
    await seedAt(at, [
      shadowRow({}),
      decisionFixture(ids),
      decisionFixture(ids, { context: SignalDecisionContext.SessionStart, step: null }),
    ]);
    const { code, rows, err } = await report(at);
    expect(code).toBe(0);
    expect(err.at(-1)).toBe('решений: 1');
    expect(rows.map((row) => row.decisions)).toEqual(['1', '1', '1', '1']);
  });

  it('HR9 the numbers equal a count over trade-log export of the same window', async () => {
    const at = '2002-09-01T00:00:00.000Z';
    const outcomes = [Win, Loss, Tie, Unpriced];
    await seedAt(at, [
      ...outcomes.flatMap((g1, i) =>
        outcomes.map((g2, j) =>
          shadowRow({
            params: (i + j) % 3 === 0 ? H1 : R1,
            assetId: 1 + ((i * 4 + j) % 3),
            symbol: `P${1 + ((i * 4 + j) % 3)}`,
            result: entriesOf(g1, g2),
          }),
        ),
      ),
    ]);
    const window = ['2002-09-01T00:00:00Z', '2002-09-02T00:00:00Z'] as const;
    const { code, rows } = await report(window[0], new Date(window[1]));
    expect(code).toBe(0);

    let exported = '';
    expect(
      await runTradeLogCli(
        ['export', '--from', window[0], '--to', window[1]],
        { DATABASE_URL: tmp.url },
        (text) => (exported += text),
        () => undefined,
      ),
    ).toBe(0);
    const expected = new Map<string, Record<string, number>>();
    const decisions = new Map<string, number>();
    for (const raw of exported.split('\n').filter((line) => line !== '')) {
      const line = tradeLogLineSchema.parse(JSON.parse(raw));
      if (line.decision.context !== SignalDecisionContext.Shadow) continue;
      const { set } = h1ShadowEntrySchema.parse(line.signal).params;
      const pair = `${set}/P${line.decision.assetId} (${line.decision.assetId})`;
      decisions.set(pair, (decisions.get(pair) ?? 0) + 1);
      const { entries } = line.decision.result as {
        entries: { entryDelaySec: number; outcome: string }[];
      };
      for (const entry of entries) {
        const key = `${pair}/${entry.entryDelaySec}`;
        const counts = expected.get(key) ?? { win: 0, loss: 0, tie: 0, unpriced: 0 };
        counts[entry.outcome] = (counts[entry.outcome] ?? 0) + 1;
        expected.set(key, counts);
      }
    }
    const actual = new Map(
      rows
        .filter((row) => row.pair !== ALL_PAIRS)
        .map((row) => [
          `${row.section.replace('Набор ', '')}/${row.pair}/${row.g.replace('*', '')}`,
          {
            win: Number(row.W),
            loss: Number(row.L),
            tie: Number(row.T),
            unpriced: Number(row.unpriced),
          },
        ]),
    );
    expect(actual.size).toBe(expected.size);
    expect(Object.fromEntries(actual)).toEqual(Object.fromEntries(expected));
    for (const row of rows.filter((r) => r.pair !== ALL_PAIRS)) {
      expect(Number(row.decisions)).toBe(
        decisions.get(`${row.section.replace('Набор ', '')}/${row.pair}`),
      );
    }
  });

  it('HR10 a row without entries and a row without a set: counted, the set-less section last, a warning', async () => {
    const at = '2002-10-01T00:00:00.000Z';
    const withoutSet: Record<string, unknown> = { ...R1 };
    delete withoutSet.set;
    await seedAt(at, [
      shadowRow({}),
      shadowRow({ result: null }),
      shadowRow({ params: withoutSet }),
    ]);
    const { code, out, err } = await report(at);
    expect(code).toBe(0);
    expect(out.indexOf('## Набор r1')).toBeGreaterThan(-1);
    expect(out.indexOf(`## ${NO_SET}`)).toBeGreaterThan(out.indexOf('## Набор r1'));
    expect(err).toContain('строк без записей исходов: 1');
    expect(err.at(-1)).toBe('решений: 3');
    expect(out).toContain('решений: 3 (r1 2, (без набора) 1)');
  });

  it("HR11 the markdown: title, window, r1 before h1, the table, all pairs last, the sets' own entries marked", async () => {
    const at = '2002-11-01T00:00:00.000Z';
    await seedAt(at, [
      shadowRow({ params: H1 }),
      shadowRow({}),
      shadowRow({ assetId: 2, symbol: 'GBP/USD' }),
    ]);
    const { code, out, rows } = await report(at);
    expect(code).toBe(0);
    const lines = out.split('\n');
    expect(lines[0]).toBe('# h1 shadow report');
    expect(lines[2]).toBe(
      'Период: 2002-11-01T00:00:00.000Z .. 2002-11-02T00:00:00.000Z (по recorded_at, часы базы); решений: 3 (r1 2, h1 1)',
    );
    expect(out.indexOf('## Набор r1')).toBeLessThan(out.indexOf('## Набор h1'));
    expect(HEAD).toBe(markdownTable(HEAD.slice(2, -2).split(' | '), []).split('\n')[0]);
    expect(lines.filter((line) => line === HEAD)).toHaveLength(2);
    for (const section of ['Набор r1', 'Набор h1']) {
      const own = rows.filter((row) => row.section === section);
      expect(own.at(-1)?.pair).toBe(ALL_PAIRS);
      expect(own.at(-2)?.pair).toBe(ALL_PAIRS);
    }
    const marked = rows.map((row) => `${row.section}/${row.pair}/${row.g}`);
    expect(marked.filter((key) => key.endsWith('*')).sort()).toEqual(
      [
        'Набор h1/EUR/USD (1)/2*',
        `Набор h1/${ALL_PAIRS}/2*`,
        'Набор r1/EUR/USD (1)/1*',
        'Набор r1/GBP/USD (2)/1*',
        `Набор r1/${ALL_PAIRS}/1*`,
      ].sort(),
    );
    expect(out).toContain('* — вход набора (params.entryDelaySec)');
    expect(lines.filter((line) => line.startsWith('Задержка taken_at_ms'))).toHaveLength(2);
  });

  it('HR12 pairs by decisions, most first; a tie by symbol, the pairs without one last by asset id', async () => {
    const at = '2002-12-01T00:00:00.000Z';
    await seedAt(at, [
      ...times(3, () => shadowRow({ assetId: 40, symbol: 'BBB' })),
      ...times(2, () => shadowRow({ assetId: 30, symbol: 'CCC' })),
      ...times(2, () => shadowRow({ assetId: 31, symbol: 'AAA' })),
      ...times(2, () => shadowRow({ assetId: 6, symbol: null })),
      ...times(2, () => shadowRow({ assetId: 5, symbol: null })),
    ]);
    const { code, rows } = await report(at);
    expect(code).toBe(0);
    const pairs = [...new Set(rows.map((row) => row.pair))];
    expect(pairs).toEqual(['BBB (40)', 'AAA (31)', 'CCC (30)', '5', '6', ALL_PAIRS]);
  });

  it('HR13 all pairs: the sums over the pairs, break-even at the plan payout floor', async () => {
    const at = '2003-01-01T00:00:00.000Z';
    await seedAt(at, [
      shadowRow({ payout: 96, result: entriesOf(Win, Loss) }),
      shadowRow({ payout: 96, result: entriesOf(Tie, Unpriced) }),
      shadowRow({ assetId: 2, symbol: 'GBP/USD', payout: 96, result: entriesOf(Loss, Win) }),
    ]);
    const { code, rows } = await report(at);
    expect(code).toBe(0);
    expect(cellOf(rows, 'Набор r1', ALL_PAIRS, '1')).toMatchObject({
      decisions: '3',
      W: '1',
      L: '1',
      T: '1',
      unpriced: '0',
      payout: `>= ${H1_MIN_PAYOUT_PCT} (по плану)`,
      breakEven: breakEvenPct(H1_MIN_PAYOUT_PCT).toFixed(2),
    });
    expect(cellOf(rows, 'Набор r1', ALL_PAIRS, '2')).toMatchObject({
      W: '1',
      L: '1',
      T: '0',
      unpriced: '1',
    });
  });

  it('HR14 the lag: median and p95 of taken_at_ms - decided_at_ms per set', async () => {
    const at = '2003-02-01T00:00:00.000Z';
    await seedAt(
      at,
      [100, 200, 300, 400].map((lagMs) => shadowRow({ lagMs })),
    );
    const { code, out } = await report(at);
    expect(code).toBe(0);
    expect(out).toContain('Задержка taken_at_ms − decided_at_ms (f), мс: медиана 250, p95 385');
  });
});
