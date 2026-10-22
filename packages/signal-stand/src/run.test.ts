import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { TradeAction } from '@binarius/shared';
import { describe, expect, it, vi } from 'vitest';
import type { TradeInterval } from './config';
import { calibrationPath, rangeWarning, runBacktest, splitTrades, type RunOptions } from './run';
import { appendRows, seriesPath } from './cache';
import { againstV2, emptyTally, type Tally } from './stats';
import { cacheWith, PAIR, quiet, secondsPath, T0 } from './testing';
import { comparesWithV2, pointLabel, VARIANTS } from './variants';

function run(dir: string, headlineDelayMs?: number, over: Partial<RunOptions> = {}) {
  const out = path.join(dir, 'out', 'r');
  const io = { out: vi.fn(), err: vi.fn() };
  const code = runBacktest({ dir, assets: [PAIR.id], out, headlineDelayMs, io, ...over });
  return { code, out, io };
}

interface JsonRow {
  variant: string;
  interval: TradeInterval;
  params: string;
  scope: string;
  trades: number;
  wins: number;
  losses: number;
  ties: number;
  tradesPerPairHour?: number;
}
interface AgainstRow extends JsonRow {
  keptPct?: number;
  verdict: string;
  selected: boolean;
}
interface Report {
  since: number;
  split: number;
  until: number;
  headline: JsonRow[];
  grid: JsonRow[];
  perPair: JsonRow[];
  perType: JsonRow[];
  againstV2: AgainstRow[];
  betterOnAllIntervals: { intervals: string[]; points: string[] };
  selections: { variant: string; interval: string }[];
}
const readJson = (out: string) =>
  JSON.parse(readFileSync(path.join(out, 'report.json'), 'utf8')) as Report;
const tallyOf = ({ trades, wins, losses, ties }: JsonRow): Tally => ({
  ...emptyTally(),
  trades,
  wins,
  losses,
  ties,
});

describe('run', () => {
  const dir = cacheWith(secondsPath(T0, 2 * 3_600));

  it('R1 report.md holds the nine tables and a headline row for every variant and interval', () => {
    const { code, out, io } = run(dir);
    expect(code).toBe(0);
    const markdown = readFileSync(path.join(out, 'report.md'), 'utf8');
    for (const section of ['(a)', '(b)', '(c)', '(d)', '(e)', '(f)', '(g)', '(h)', '(i)']) {
      expect(markdown).toContain(`## ${section}`);
    }
    const json = JSON.parse(readFileSync(path.join(out, 'report.json'), 'utf8')) as {
      selections: { variant: string; interval: string }[];
    };
    const expected = VARIANTS.flatMap((v) =>
      v.intervals.map((interval) => `${v.name} ${interval}`),
    );
    expect(json.selections.map((s) => `${s.variant} ${s.interval}`).sort()).toEqual(
      expected.sort(),
    );
    expect(io.out).toHaveBeenCalledWith(expect.stringContaining('| interval | variant |'));
  });

  it('R2 report.json carries the numbers the tables print', () => {
    const { out } = run(dir, 1_000);
    const json = JSON.parse(readFileSync(path.join(out, 'report.json'), 'utf8')) as {
      headlineDelayMs: number;
      grid: {
        variant: string;
        interval: string;
        params: string;
        trades: number;
        winRate?: number;
      }[];
    };
    const markdown = readFileSync(path.join(out, 'report.md'), 'utf8');
    expect(json.headlineDelayMs).toBe(1_000);
    expect(json.grid.length).toBe(3 * 1 + 3 * 9 + 2 * 3 + 2 * 1 + 2 * 2 + 2 * 3 + 2 * 6);
    for (const row of json.grid) {
      expect(markdown).toContain(`| ${row.interval} | ${row.variant} | ${row.params} |`);
      expect(markdown).toContain(`| ${row.trades} |`);
    }
  });

  it('S9 without --headline-delay or calibration.json the headline delay is the fallback 0, and the report says so', () => {
    const { out } = run(dir);
    const markdown = readFileSync(path.join(out, 'report.md'), 'utf8');
    expect(markdown).toContain('Headline openDelay 0 ms (fallback: calibrate has not run)');
    const json = JSON.parse(readFileSync(path.join(out, 'report.json'), 'utf8')) as {
      headlineDelayMs: number;
      headlineDelaySource: string;
      headline: { openDelayMs: number }[];
    };
    expect(json.headlineDelayMs).toBe(0);
    expect(json.headlineDelaySource).toBe('fallback: calibrate has not run');
    expect(json.headline.length).toBeGreaterThan(0);
    for (const row of json.headline) expect(row.openDelayMs).toBe(0);
  });

  it('R4 a variant short of 100 in-sample trades keeps its table (a) line: a single-point variant with its numbers, the rest named', () => {
    const { out } = run(cacheWith(secondsPath(T0, 15 * 60)));
    const json = JSON.parse(readFileSync(path.join(out, 'report.json'), 'utf8')) as {
      selections: {
        variant: string;
        interval: string;
        selected: string;
        bestInSampleTrades: number;
      }[];
      headline: { variant: string; interval: string; scope: string; trades: number }[];
      grid: { variant: string; interval: string; trades: number }[];
      headlineDelayMs: number;
    };
    const delay = json.headlineDelayMs;
    expect(json.selections.every((s) => s.selected === 'none')).toBe(true);
    expect(json.selections.some((s) => s.bestInSampleTrades > 0)).toBe(true);
    for (const { variant, interval, bestInSampleTrades } of json.selections) {
      const trades = json.grid
        .filter((r) => r.variant === variant && r.interval === interval)
        .map((r) => r.trades);
      expect(bestInSampleTrades).toBe(Math.max(...trades));
    }
    const markdown = readFileSync(path.join(out, 'report.md'), 'utf8');
    const tableA = markdown.slice(markdown.indexOf('## (a)'), markdown.indexOf('## (b)'));
    for (const { variant, interval, bestInSampleTrades } of json.selections) {
      const none = `no point with >= 100 in-sample trades (best: ${bestInSampleTrades})`;
      const spec = VARIANTS.find((v) => v.name === variant);
      if (spec?.grid.length === 1) {
        const row = json.headline.find((r) => r.variant === variant && r.interval === interval);
        const pause = spec.headlinePause ? 'on' : 'off';
        expect(row?.scope).toBe(`only point, ${none}, out-of-sample, pooled`);
        expect(tableA).toContain(
          `| ${interval} | ${variant} | - | ${pause} | ${delay} | ${row?.scope} | ${row?.trades} |`,
        );
      } else {
        expect(tableA).toContain(`| ${interval} | ${variant} | - | off | ${delay} | ${none} | - |`);
      }
    }
  });

  it('R5 pooled pairs whose ranges differ by more than a day are named', () => {
    const day = 86_400_000;
    const range = (label: string, days: number) => ({ label, first: T0, last: T0 + days * day });
    expect(rangeWarning([range('A', 14), range('B', 13.5)])).toBeUndefined();
    expect(rangeWarning([range('A', 14), range('B', 1), range('C', 14)])).toBe(
      'run: pooled 1s ranges differ by more than a day: B 1.0 d, against 14.0 d',
    );
    expect(rangeWarning([])).toBeUndefined();
  });

  // three pairs over 1.1 days of decisions: about 2 s alone, more under the full suite
  it(
    'R5b run warns on stderr about the short pooled pair, not about an unpooled one',
    { timeout: 30_000 },
    () => {
      const day = 86_400_000;
      const dir = cacheWith(secondsPath(T0, 600));
      cacheWith(secondsPath(T0, 600), { ...PAIR, id: 7, symbol: 'SHORT' }, dir);
      cacheWith(secondsPath(T0, 600), { ...PAIR, id: 8, symbol: 'LOWPAY', payout: 55 }, dir);
      appendRows(seriesPath(dir, PAIR.id, '1s'), secondsPath(T0 + 1.1 * day, 1), quiet);
      const io = { out: vi.fn(), err: vi.fn() };
      runBacktest({ dir, assets: [PAIR.id, 7, 8], out: path.join(dir, 'o'), io });
      const warnings = io.err.mock.calls
        .map(([line]) => String(line))
        .filter((l) => l.includes('ranges'));
      expect(warnings).toEqual([
        'run: pooled 1s ranges differ by more than a day: SHORT (7) 0.0 d, against 1.1 d',
      ]);
    },
  );

  it('R3 nothing is written outside --out; calibrate choice is read from calibration.json', () => {
    const before = readdirSync(dir, { recursive: true })
      .filter((f) => !String(f).startsWith('out'))
      .sort();
    writeFileSync(
      calibrationPath(dir),
      JSON.stringify({ headlineDelayMs: 1_000, calibratedAt: T0 }),
    );
    const { out } = run(dir);
    const after = readdirSync(dir, { recursive: true })
      .filter((f) => !String(f).startsWith('out') && f !== 'calibration.json')
      .sort();
    expect(after).toEqual(before.filter((f) => f !== 'calibration.json'));
    expect(readFileSync(path.join(out, 'report.md'), 'utf8')).toContain(
      `Headline openDelay 1000 ms (calibrate, ${new Date(T0).toISOString()})`,
    );
  });

  it("R6 a truncated calibration.json is the stand's refusal, not a parse crash", () => {
    const own = cacheWith(secondsPath(T0, 600));
    writeFileSync(calibrationPath(own), '{"headlineDelayMs": 10');
    expect(() => run(own)).toThrow(`${calibrationPath(own)}: not a calibration result`);
  });

  it('S7 a trade is in-sample iff its decision is before the split', () => {
    const trade = (decidedAt: number) => ({
      decidedAt,
      action: TradeAction.Up,
      entryAt: decidedAt,
      exitAt: decidedAt + 5_000,
      outcome: 'win' as const,
    });
    const { inSample, outOfSample } = splitTrades(
      [trade(999), trade(1_000), trade(1_001)],
      1_000,
      90,
    );
    expect([inSample.trades, outOfSample.trades]).toEqual([1, 2]);
  });

  it('R7 table (h): every point of every variant against v2, kept % of v2 production, the verdict of againstV2', () => {
    const { out } = run(dir);
    const json = readJson(out);
    const markdown = readFileSync(path.join(out, 'report.md'), 'utf8');
    const compared = VARIANTS.filter((v) => comparesWithV2(v.name));
    expect(json.againstV2.map((r) => `${r.interval} ${r.variant} ${r.params}`).sort()).toEqual(
      compared
        .flatMap((v) =>
          v.intervals.flatMap((i) => v.grid.map((p) => `${i} ${v.name} ${pointLabel(p)}`)),
        )
        .sort(),
    );
    const v2Out = (interval: string) =>
      json.headline.find(
        (r) =>
          r.variant === 'v2' &&
          r.interval === interval &&
          r.params === 'rsiExtremeBand=15 minAtrTicks=5',
      )!;
    const inSample = (variant: string, interval: string, params: string) =>
      json.grid.find(
        (r) => r.variant === variant && r.interval === interval && r.params === params,
      )!;
    let decidedRows = 0;
    for (const row of json.againstV2) {
      const reference = v2Out(row.interval);
      expect(row.keptPct).toBeCloseTo((100 * row.trades) / reference.trades, 10);
      const expected = againstV2({
        variant: {
          inSample: tallyOf(inSample(row.variant, row.interval, row.params)),
          outOfSample: tallyOf(row),
        },
        v2: {
          inSample: tallyOf(inSample('v2', row.interval, 'rsiExtremeBand=15 minAtrTicks=5')),
          outOfSample: tallyOf(reference),
        },
      });
      expect(row.verdict).toBe(expected.verdict);
      if (row.verdict !== 'no evidence') decidedRows++;
    }
    expect(decidedRows).toBeGreaterThan(0);
    expect(markdown).toContain('Points better on every interval of this run (5s, 15s): ');
    const v2Only = run(dir, undefined, { variants: ['v2'] });
    const onlyMarkdown = readFileSync(path.join(v2Only.out, 'report.md'), 'utf8');
    expect(onlyMarkdown).toContain('no variant against v2 in this run');
    expect(readJson(v2Only.out).againstV2).toEqual([]);
  });

  it('R7b a fixture flat after the split: every (h) row is no evidence, never better', () => {
    const flatFrom = Math.floor((2 * 3_600 * 5) / 7) - 1_800;
    const own = cacheWith(
      secondsPath(T0, 2 * 3_600, (i) =>
        i < flatFrom ? 1 + 0.002 * Math.sin(i / 97) + 0.0004 * Math.sin(i / 7) : 1.001,
      ),
    );
    const { code, out } = run(own, undefined, {
      variants: ['v2', 'v2+macd', 'v2+ma'],
      intervals: ['5s', '15s'],
    });
    expect(code).toBe(0);
    const json = readJson(out);
    expect(json.againstV2).toHaveLength(2 * (2 + 3));
    for (const row of json.againstV2) expect(row.verdict).toBe('no evidence');
    expect(json.betterOnAllIntervals.points).toEqual([]);
  });

  // three pairs, one filtered variant: about a second
  describe('R8/R9 pooled by type', () => {
    const own = cacheWith(secondsPath(T0, 2 * 3_600));
    cacheWith(secondsPath(T0, 2 * 3_600), { ...PAIR, id: 7, symbol: 'LOWPAY', payout: 79 }, own);
    cacheWith(
      secondsPath(T0, 2 * 3_600),
      { ...PAIR, id: 8, symbol: 'BTC', type: 'cryptocurrency', payout: 85 },
      own,
    );
    const io = { out: vi.fn(), err: vi.fn() };
    const out = path.join(own, 'o');
    runBacktest({
      dir: own,
      assets: [PAIR.id, 7, 8],
      out,
      variants: ['v2'],
      intervals: ['5s'],
      io,
    });
    const json = readJson(out);

    it('R8 table (i) pools only the paying pairs of each type, in PAIR_TYPE_GROUPS order', () => {
      const own = (id: number) =>
        json.perPair.find((r) => r.scope.includes(`(${id})`) && r.scope.includes('production'))!;
      expect(json.perType.map((r) => r.scope)).toEqual([
        'currency, production, out-of-sample, pooled within the type',
        'cryptocurrency, production, out-of-sample, pooled within the type',
      ]);
      expect(json.perType[0].trades).toBe(own(PAIR.id).trades);
      expect(json.perType[0].trades).toBeGreaterThan(0);
      expect(json.perType[1].trades).toBe(own(8).trades);
    });

    it('R9 trades/pair-h divides by the pooled pairs and the hours of the row sample', () => {
      const outHours = (json.until - json.split) / 3_600_000;
      const inHours = (json.split - json.since) / 3_600_000;
      const production = json.headline.find((r) => r.scope.startsWith('production'))!;
      expect(production.trades).toBeGreaterThan(0);
      expect(production.tradesPerPairHour).toBeCloseTo(production.trades / (2 * outHours), 10);
      const grid = json.grid.find((r) => r.params === production.params)!;
      expect(grid.tradesPerPairHour).toBeCloseTo(grid.trades / (2 * inHours), 10);
      const pair = json.perPair.find((r) => r.scope.includes(`(${PAIR.id})`))!;
      expect(pair.tradesPerPairHour).toBeCloseTo(pair.trades / outHours, 10);
      expect(json.perType[0].tradesPerPairHour).toBeCloseTo(json.perType[0].trades / outHours, 10);
    });
  });
});
