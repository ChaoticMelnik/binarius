import { h1DecisionSchema, type H1Params } from '@binarius/shared';
import { describe, expect, it } from 'vitest';
import { assertH1Params, createH1Detector, DEFAULT_H1_PARAMS } from './h1';

// A step series: c[0] = 1000, c[5m] = c[5(m-1)] + moves[m-1], the seconds in between held at
// c[5(m-1)] unless `between` says otherwise. Integer prices keep every expected number exact.
function stepSeries(
  moves: readonly number[],
  between: (base: number, r: number) => number = (base) => base,
): number[] {
  const closes = [1000];
  for (const move of moves) {
    const base = closes[closes.length - 1];
    for (let r = 1; r <= 4; r++) closes.push(between(base, r));
    closes.push(base + move);
  }
  return closes;
}

const alternating = (n: number) => Array.from({ length: n }, (_, i) => (i % 2 === 0 ? 1 : -1));
const zeros = (n: number) => Array<number>(n).fill(0);

const H_D1_MOVES = [...alternating(51), ...zeros(8), 3];
const H_D3_MOVES = [...alternating(14), ...zeros(45), 1];
const H_D5_MOVES = [...alternating(4), ...zeros(15), 4];

// 60 moves; only m = 0 or 1 (mod 4) survive the NaN closes below, the others carry 7
function hD7Series(): number[] {
  const kept: Record<number, number> = { 1: 1, 4: -1, 5: 1, 8: -1, 9: 1, 60: 5 };
  const moves = Array.from({ length: 60 }, (_, i) => {
    const m = i + 1;
    return m % 4 === 0 || m % 4 === 1 ? (kept[m] ?? 0) : 7;
  });
  const closes = stepSeries(moves);
  // each NaN at 5(2 + 4k) kills the moves m = 2 + 4k and 3 + 4k
  for (let k = 0; k < 15; k++) closes[10 + 20 * k] = NaN;
  return closes;
}

const detector = createH1Detector();
const decide = (closes: ArrayLike<number>, at = closes.length - 1) =>
  detector.decide({ closes, at });

const fixtures = (): Record<string, number[]> => {
  const hD4a = stepSeries(H_D1_MOVES);
  hD4a[300] = NaN;
  const hD4b = stepSeries(H_D1_MOVES);
  hD4b[295] = NaN;
  return {
    'H-D1': stepSeries(H_D1_MOVES),
    'H-D2': stepSeries(H_D1_MOVES.map((move) => -move)),
    'H-D3': stepSeries(H_D3_MOVES),
    'H-D4a': hD4a,
    'H-D4b': hD4b,
    'H-D5': stepSeries(H_D5_MOVES),
    'H-D6': Array<number>(301).fill(1000),
    'H-D7': hD7Series(),
  };
};

describe('the H1 detector (#667)', () => {
  it('H-D1: a 5-s move above 2 sd is a signal up', () => {
    expect(decide(stepSeries(H_D1_MOVES))).toEqual({
      kind: 'signal',
      version: 'h1',
      action: 'up',
      features: { move: 3, sd: 1, z: 3, moves: 60, lastClose: 1004 },
    });
  });

  it('H-D2: the mirrored series is a signal down', () => {
    expect(decide(stepSeries(H_D1_MOVES.map((move) => -move)))).toEqual({
      kind: 'signal',
      version: 'h1',
      action: 'down',
      features: { move: -3, sd: 1, z: 3, moves: 60, lastClose: 996 },
    });
  });

  it('H-D3: z exactly at the threshold is below it (strict >)', () => {
    expect(decide(stepSeries(H_D3_MOVES))).toEqual({
      kind: 'no_signal',
      version: 'h1',
      reason: 'below_threshold',
      features: { move: 1, sd: 0.5, z: 2, moves: 60, lastClose: 1001 },
    });
  });

  it('H-D4a: no close at f is no_price last', () => {
    expect(decide(fixtures()['H-D4a'])).toEqual({
      kind: 'no_signal',
      version: 'h1',
      reason: 'no_price',
      detail: { missing: 'last' },
    });
  });

  it('H-D4b: no close at f - 5 is no_price before', () => {
    expect(decide(fixtures()['H-D4b'])).toEqual({
      kind: 'no_signal',
      version: 'h1',
      reason: 'no_price',
      detail: { missing: 'before' },
    });
  });

  it('H-D5: a series shorter than the window decides on the moves it has', () => {
    const closes = stepSeries(H_D5_MOVES);
    expect(closes).toHaveLength(101);
    expect(decide(closes, 100)).toEqual({
      kind: 'signal',
      version: 'h1',
      action: 'up',
      features: { move: 4, sd: 1, z: 4, moves: 20, lastClose: 1004 },
    });
  });

  // the backtest script computes 0 / 0 = NaN on this window and does not trade either
  it('H-D6: a flat window is no_volatility', () => {
    expect(decide(Array<number>(301).fill(1000))).toEqual({
      kind: 'no_signal',
      version: 'h1',
      reason: 'no_volatility',
      detail: { moves: 60 },
    });
  });

  it('H-D7: missing moves inside the window are skipped, not counted as 0', () => {
    const closes = hD7Series();
    expect(closes[300]).toBe(1216);
    expect(decide(closes, 300)).toEqual({
      kind: 'signal',
      version: 'h1',
      action: 'up',
      features: { move: 5, sd: 1, z: 5, moves: 30, lastClose: 1216 },
    });
  });

  it('H-D8: the decision reads nothing past at, and at outside the series throws', () => {
    const closes = stepSeries(H_D1_MOVES);
    const longer = [...closes, ...Array.from({ length: 50 }, (_, i) => (i % 2 ? 1e9 : -1e9))];
    expect(detector.decide({ closes: longer, at: 300 })).toEqual(decide(closes));
    expect(() => detector.decide({ closes, at: -1 })).toThrow(RangeError);
    expect(() => detector.decide({ closes, at: closes.length })).toThrow(RangeError);
    expect(() => detector.decide({ closes, at: 1.5 })).toThrow(RangeError);
  });

  it('H-D9: every decision passes the wire schema', () => {
    for (const [id, closes] of Object.entries(fixtures())) {
      expect(h1DecisionSchema.safeParse(decide(closes)).success, id).toBe(true);
    }
  });

  it('H-D10: assertH1Params refuses each field past its rule and accepts the defaults', () => {
    expect(() => assertH1Params(DEFAULT_H1_PARAMS)).not.toThrow();
    const bad: Partial<H1Params>[] = [
      { sdStepSec: 0 },
      { sdWindowSec: 302 },
      { sdWindowSec: 3 },
      { threshold: 0 },
      { threshold: NaN },
      { threshold: -1 },
      { threshold: Infinity },
      { moveSec: 0 },
      { moveSec: 1.5 },
    ];
    for (const change of bad) {
      expect(
        () => assertH1Params({ ...DEFAULT_H1_PARAMS, ...change }),
        JSON.stringify(change),
      ).toThrow(RangeError);
      expect(() => createH1Detector({ ...DEFAULT_H1_PARAMS, ...change })).toThrow(RangeError);
    }
  });

  it('H-D11: sd is the RMS of the step-5 moves and move is c[f] - c[f - 5] exactly', () => {
    const closes = stepSeries(H_D1_MOVES, (base, r) => base + 100 * r);
    expect(closes[296]).not.toBe(closes[295]);
    expect(decide(closes)).toEqual({
      kind: 'signal',
      version: 'h1',
      action: 'up',
      features: { move: 3, sd: 1, z: 3, moves: 60, lastClose: 1004 },
    });
  });
});
