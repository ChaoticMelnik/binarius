import {
  H1_ENTRY_WINDOW_SEC,
  H1_PRICE_RANGE,
  H1_R1_PARAMS,
  h1DecisionSchema,
  h1ShadowEntrySchema,
  type H1Decision,
  H1ShadowSet,
  type H1Params,
} from '@binarius/shared';
import { describe, expect, it } from 'vitest';
import {
  assertH1Params,
  assertH1ShadowSet,
  createH1Detector,
  DEFAULT_H1_PARAMS,
  H1_SHADOW_MAX_WINDOW_SEC,
  H1_SHADOW_SETS,
  replayH1Entry,
} from './h1';

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

  it('H-D12: a close outside the price range at f or f - 5 is no_price', () => {
    const rows: [number[], 'last' | 'before'][] = [];
    for (const value of [0, -0, -1, 5e-101, 2e100]) {
      const closes = stepSeries(H_D1_MOVES);
      closes[300] = value;
      rows.push([closes, 'last']);
    }
    for (const value of [0, -1]) {
      const closes = stepSeries(H_D1_MOVES);
      closes[295] = value;
      rows.push([closes, 'before']);
    }
    // review round 1's magnitudes: before the range, no_volatility with a non-zero move and sd = ∞
    for (const scale of [1e-203, 1e154]) {
      rows.push([stepSeries(H_D1_MOVES).map((close) => close * scale), 'last']);
    }
    for (const [closes, missing] of rows) {
      const decision = decide(closes);
      const label = `${missing} ${closes[300]} ${closes[295]}`;
      expect(decision, label).toEqual({
        kind: 'no_signal',
        version: 'h1',
        reason: 'no_price',
        detail: { missing },
      });
      expect(h1DecisionSchema.safeParse(decision).success, label).toBe(true);
    }
  });

  it('H-D13: a close outside the price range inside the window is skipped like a gap', () => {
    // closes[150] ends move 30 (-1) and starts move 31 (+1); both go
    for (const value of [1e154, -1, 0, 1e-200]) {
      const closes = stepSeries(H_D1_MOVES);
      closes[150] = value;
      const decision = decide(closes);
      expect(decision, String(value)).toEqual({
        kind: 'signal',
        version: 'h1',
        action: 'up',
        features: { move: 3, sd: 1, z: 3, moves: 58, lastClose: 1004 },
      });
      expect(h1DecisionSchema.safeParse(decision).success, String(value)).toBe(true);
    }
  });

  it("H-D14: the price range's ends are prices", () => {
    const low = Array<number>(301).fill(2 * H1_PRICE_RANGE.min);
    low[300] = H1_PRICE_RANGE.min;
    const high = Array<number>(301).fill(H1_PRICE_RANGE.max / 2);
    high[300] = H1_PRICE_RANGE.max;
    const down = decide(low);
    const up = decide(high);
    expect(down).toMatchObject({
      kind: 'signal',
      action: 'down',
      features: { lastClose: H1_PRICE_RANGE.min, moves: 60 },
    });
    expect(up).toMatchObject({
      kind: 'signal',
      action: 'up',
      features: { lastClose: H1_PRICE_RANGE.max, moves: 60 },
    });
    expect(h1DecisionSchema.safeParse(down).success).toBe(true);
    expect(h1DecisionSchema.safeParse(up).success).toBe(true);
  });

  it('H-D15: on generated series of any magnitude, sign or gap every decision parses', () => {
    let state = 667;
    const next = () => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      return state / 2_147_483_648;
    };
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)];
    const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
    // the range's exact ends are left out, so they stay H-D14's alone
    const scales = [
      1e-300, 1e-200, 1e-150, 3e-101, 2e-100, 1e-5, 1, 1000, 1e5, 5e99, 3e100, 1e154, 1e300,
    ];
    const odd = [
      NaN,
      Infinity,
      -Infinity,
      0,
      -0,
      -1,
      -1000,
      5e-324,
      Number.MAX_VALUE,
      -Number.MAX_VALUE,
    ];
    const outcome = (d: H1Decision) =>
      d.kind === 'signal'
        ? `signal ${d.action}`
        : d.reason === 'no_price'
          ? `no_price ${d.detail.missing}`
          : d.reason;
    const seen = new Set<string>();
    for (let n = 0; n < 3000; n++) {
      let params: H1Params = DEFAULT_H1_PARAMS;
      if (next() >= 0.5) {
        const step = int(1, 6);
        params = {
          moveSec: int(1, 6),
          sdStepSec: step,
          sdWindowSec: step * int(1, 20),
          threshold: pick([0.5, 1, 2, 3]),
        };
      }
      const length = int(1, params.sdWindowSec + params.moveSec + 20);
      let scale = pick(scales);
      const flat = next() < 0.25;
      const closes: number[] = [];
      let close = scale;
      for (let k = 0; k < length; k++) {
        if (next() < 0.02) {
          scale = pick(scales);
          close = scale;
        }
        if (!flat) close += scale * 1e-3 * (next() * 2 - 1);
        closes.push(next() < 0.04 ? pick(odd) : close);
      }
      const at = next() < 0.7 ? length - 1 : int(0, length - 1);
      if (next() < 0.3 && Number.isFinite(closes[at])) {
        closes[at] += (next() < 0.5 ? 1 : -1) * scale * 0.05;
      }
      const decision = createH1Detector(params).decide({ closes, at });
      const label = `input ${n}`;
      expect(h1DecisionSchema.safeParse(decision).success, label).toBe(true);
      if ('features' in decision) {
        const { z, moves, lastClose } = decision.features;
        expect(z, label).toBeLessThanOrEqual(Math.sqrt(moves) * (1 + 2 ** -40));
        expect(lastClose, label).toBe(closes[at]);
      }
      seen.add(outcome(decision));
    }
    expect([...seen].sort()).toEqual([
      'below_threshold',
      'no_price before',
      'no_price last',
      'no_volatility',
      'signal down',
      'signal up',
    ]);
  });
});

describe('the H1 shadow sets and replay (#669)', () => {
  it('H-D16: a stored entry decides again to its own decision, NaN read from null', () => {
    for (const set of H1_SHADOW_SETS) {
      const n = set.params.sdWindowSec + 1;
      // a walk with a gap inside the window: the stored null must read as the NaN the detector saw
      const closes = Array.from({ length: n }, (_, i) =>
        i === 40
          ? NaN
          : Number((1.1 + 0.0001 * Math.sin(i) + (i === n - 1 ? 0.001 : 0)).toFixed(5)),
      );
      const decision = createH1Detector(set.params).decide({ closes, at: n - 1 });
      expect(decision.kind).toBe('signal');
      const entry = h1ShadowEntrySchema.parse(
        JSON.parse(
          JSON.stringify({
            assetId: 1,
            interval: null,
            digits: 5,
            nowMs: 1_760_000_000_000,
            source: { kind: 'ticks', symbol: 'EUR/USD', closedBy: 'tick', closedAtMs: 1 },
            version: 'h1',
            params: {
              set: set.name,
              ...set.params,
              entryDelaySec: set.entryDelaySec,
              expirySec: 5,
            },
            series: closes.map((close) => (Number.isNaN(close) ? null : close)),
            decision,
          }),
        ),
      );
      expect(replayH1Entry(entry)).toEqual(decision);
    }
  });

  it('H-D17: the sets are R1 and the reference, with unique names, entries inside the window and valid params', () => {
    expect(H1_SHADOW_SETS.map((set) => [set.name, set.params, set.entryDelaySec])).toEqual([
      ['r1', H1_R1_PARAMS, H1_ENTRY_WINDOW_SEC.from],
      ['h1', DEFAULT_H1_PARAMS, H1_ENTRY_WINDOW_SEC.to],
    ]);
    for (const set of H1_SHADOW_SETS) {
      expect(() => assertH1Params(set.params)).not.toThrow();
      expect(set.entryDelaySec).toBeGreaterThanOrEqual(H1_ENTRY_WINDOW_SEC.from);
      expect(set.entryDelaySec).toBeLessThanOrEqual(H1_ENTRY_WINDOW_SEC.to);
    }
    expect(H1_SHADOW_MAX_WINDOW_SEC).toBe(
      Math.max(H1_R1_PARAMS.sdWindowSec, DEFAULT_H1_PARAMS.sdWindowSec),
    );
  });

  it('H-D18: a set has moveSec <= sdStepSec, so its window of sdWindowSec + 1 closes decides as the whole history', () => {
    const wide = { moveSec: 5, sdWindowSec: 300, sdStepSec: 3, threshold: 1 };
    expect(() =>
      assertH1ShadowSet({ name: H1ShadowSet.R1, params: wide, entryDelaySec: 1 }),
    ).toThrow(
      new RangeError(
        'h1 shadow set r1: moveSec (5) must be <= sdStepSec (3): the window of sdWindowSec + 1 closes holds every close a decision reads only then',
      ),
    );
    for (const set of H1_SHADOW_SETS) expect(() => assertH1ShadowSet(set)).not.toThrow();

    let state = 7;
    let price = 100_000;
    const closes = Float64Array.from({ length: 2_000 }, () => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      price += Math.round((state / 2_147_483_648 - 0.5) * 8);
      return price;
    });
    const mismatches = (params: H1Params) => {
      const custom = createH1Detector(params);
      let count = 0;
      for (let f = 400; f < closes.length; f += 7) {
        const full = custom.decide({ closes, at: f });
        const window = custom.decide({
          closes: closes.subarray(f - params.sdWindowSec, f + 1),
          at: params.sdWindowSec,
        });
        if (JSON.stringify(full) !== JSON.stringify(window)) count++;
      }
      return count;
    };
    for (const set of H1_SHADOW_SETS) expect(mismatches(set.params), set.name).toBe(0);
    // the check can see a window that misses a close: the wide shape's earliest read falls out
    expect(mismatches(wide)).toBeGreaterThan(0);
  });
});
