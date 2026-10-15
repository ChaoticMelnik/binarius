import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { TradeAction } from '@binarius/shared';
import { describe, expect, it, vi } from 'vitest';
import { runBacktest, splitTrades } from './run';
import { cacheWith, PAIR, secondsPath, T0 } from './testing';
import { VARIANTS } from './variants';

function run(dir: string, headlineDelayMs?: number) {
  const out = path.join(dir, 'out', 'r');
  const io = { out: vi.fn(), err: vi.fn() };
  const code = runBacktest({ dir, assets: [PAIR.id], out, headlineDelayMs, io });
  return { code, out, io };
}

describe('run', () => {
  const dir = cacheWith(secondsPath(T0, 2 * 3_600));

  it('R1 report.md holds the seven tables and a headline row for every variant and interval', () => {
    const { code, out, io } = run(dir);
    expect(code).toBe(0);
    const markdown = readFileSync(path.join(out, 'report.md'), 'utf8');
    for (const section of ['(a)', '(b)', '(c)', '(d)', '(e)', '(f)', '(g)']) {
      expect(markdown).toContain(`## ${section}`);
    }
    expect(markdown).toContain('Headline openDelay 3000 ms (fallback: no --headline-delay)');
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
    expect(json.grid.length).toBe(2 * 1 + 2 * 9 + 2 * 3);
    for (const row of json.grid) {
      expect(markdown).toContain(`| ${row.interval} | ${row.variant} | ${row.params} |`);
      expect(markdown).toContain(`| ${row.trades} |`);
    }
  });

  it('R3 nothing is written outside --out', () => {
    const before = readdirSync(dir, { recursive: true })
      .filter((f) => !String(f).startsWith('out'))
      .sort();
    run(dir);
    const after = readdirSync(dir, { recursive: true })
      .filter((f) => !String(f).startsWith('out'))
      .sort();
    expect(after).toEqual(before);
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
});
