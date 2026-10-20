import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { H1_R1_PARAMS } from '@binarius/shared';
import { describe, expect, it } from 'vitest';
import { appendRows, seriesPath, writePairs } from './cache';
import { runH1, type H1RunOptions } from './h1-run';
import { cacheWith, PAIR, quiet, secondsPath, T0, tempDir } from './testing';

const HOUR_S = 3_600;

// the out-of-sample rows' points: move, sd step, threshold, delay, expiry
function points(outDir: string): number[][] {
  const json = JSON.parse(readFileSync(path.join(outDir, 'report-h1.json'), 'utf8')) as {
    outOfSample: {
      moveSec: number;
      sdStepSec: number;
      threshold: number;
      entryDelaySec: number;
      expirySec: number;
    }[];
  };
  return json.outOfSample.map((r) => [
    r.moveSec,
    r.sdStepSec,
    r.threshold,
    r.entryDelaySec,
    r.expirySec,
  ]);
}

function run(dir: string, extra: Partial<H1RunOptions> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const outDir = path.join(dir, 'o');
  const code = runH1({
    dir,
    assets: [PAIR.id],
    out: outDir,
    io: { out: (line) => out.push(line), err: (line) => err.push(line) },
    ...extra,
  });
  return { code, out, err, outDir };
}

describe('stand h1 (#667)', () => {
  it('H-U1: a run writes both reports and prints table (a) and the report path', () => {
    const dir = cacheWith(secondsPath(T0, 2 * HOUR_S));
    const { code, out, outDir } = run(dir);
    expect(code).toBe(0);
    expect(existsSync(path.join(outDir, 'report-h1.md'))).toBe(true);
    expect(existsSync(path.join(outDir, 'report-h1.json'))).toBe(true);
    expect(out[0]).toMatch(
      /^\| rule \| move s \| sd step s \| threshold \| delay s \| expiry s \|/,
    );
    expect(out.at(-1)).toBe(`report: ${path.join(outDir, 'report-h1.md')}`);
  });

  it('H-U2: a cache without a 1s series is refused before any file', () => {
    const dir = tempDir();
    writePairs(dir, [PAIR]);
    expect(() => run(dir)).toThrow(`h1: no 1s series in ${dir}`);
    expect(existsSync(path.join(dir, 'o'))).toBe(false);
  });

  it('H-U3: an asset missing from pairs.json is refused', () => {
    const dir = cacheWith(secondsPath(T0, 600));
    expect(() => run(dir, { assets: [7] })).toThrow('h1: asset 7 is not in pairs.json; fetch it');
  });

  it('H-U4: a grid subset runs only its points', () => {
    const dir = cacheWith(secondsPath(T0, 2 * HOUR_S));
    const { outDir } = run(dir, { thresholds: [2], delays: [2], expiries: [5] });
    expect(points(outDir)).toEqual([
      [5, 5, 2, 2, 5],
      [5, 5, 2, 2, 5],
      [3, H1_R1_PARAMS.sdStepSec, 2, 2, 5],
      [3, H1_R1_PARAMS.sdStepSec, 2, 2, 5],
    ]);
  });

  it('H-U5: pooled 1s ranges that differ by more than a day are warned about', () => {
    const dir = cacheWith(secondsPath(T0, 600));
    const other = { ...PAIR, id: 2, symbol: 'GBP/USD' };
    writePairs(dir, [PAIR, other]);
    appendRows(seriesPath(dir, other.id, '1s'), secondsPath(T0 - 2 * 86_400_000, 600), quiet);
    appendRows(seriesPath(dir, other.id, '1s'), secondsPath(T0, 600), quiet);
    const { code, err } = run(dir, {
      assets: [PAIR.id, other.id],
      thresholds: [2],
      delays: [2],
      expiries: [5],
    });
    expect(code).toBe(0);
    expect(err.join('\n')).toContain('ranges differ by more than a day: EUR/USD (1605169136)');
  });

  it('H-U6: --move-sec and --sd-step run the product of their subsets, the missing one the whole grid (#669)', () => {
    const dir = cacheWith(secondsPath(T0, 2 * HOUR_S));
    const grid = { thresholds: [1], delays: [1], expiries: [5] };
    const shapesOf = (outDir: string) =>
      points(outDir)
        .filter((_, i) => i % 2 === 0)
        .map(([moveSec, sdStepSec]) => [moveSec, sdStepSec]);
    expect(shapesOf(run(dir, { ...grid, moveSecs: [3], sdSteps: [3, 5] }).outDir)).toEqual([
      [3, 3],
      [3, 5],
    ]);
    expect(shapesOf(run(dir, { ...grid, moveSecs: [5] }).outDir)).toEqual([
      [5, 3],
      [5, 5],
    ]);
    expect(shapesOf(run(dir, grid).outDir)).toEqual([
      [5, 5],
      [3, H1_R1_PARAMS.sdStepSec],
    ]);
  });
});
