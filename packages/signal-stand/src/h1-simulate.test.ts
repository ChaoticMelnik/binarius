import { createH1Detector, DEFAULT_H1_PARAMS, type H1Detector } from '@binarius/signal';
import { describe, expect, it } from 'vitest';
import { StandError } from './cache';
import { H1_ENTRY_DELAY_GRID_SEC, H1_EXPIRY_GRID_SEC, H1_THRESHOLD_GRID } from './config';
import { closesBySecond, simulateH1, type SecondCloses } from './h1-simulate';
import { secondsPath, T0 } from './testing';

const detector = createH1Detector();

// the detector, with the index of every decision it was asked for
function recording(inner: H1Detector = detector) {
  const ats: number[] = [];
  const reasons: string[] = [];
  const wrapped: H1Detector = {
    ...inner,
    decide: (input) => {
      ats.push(input.at);
      const decision = inner.decide(input);
      reasons.push(decision.kind === 'signal' ? 'signal' : decision.reason);
      return decision;
    },
  };
  return { wrapped, ats, reasons };
}

const series = (closes: readonly number[]): SecondCloses => ({
  first: T0,
  closes: Float64Array.from(closes),
});

// flat at 1000, a jump to 1001 at f (the only non-zero move of its window, z = sqrt(60)), 1003 from
// f + 1 to f + g and 1002 after: the trade enters at 1003 and leaves at 1002, a loss for its up
function spike(f: number, g: number, length: number): number[] {
  return Array.from({ length }, (_, i) => {
    if (i < f) return 1000;
    if (i === f) return 1001;
    if (i <= f + g) return 1003;
    return 1002;
  });
}

describe('the H1 stand cadence (#667)', () => {
  it('H-T1: closesBySecond indexes rows by second and keeps gaps as NaN', () => {
    const rows = secondsPath(T0, 20);
    const kept = rows.filter((_, i) => i !== 4 && i !== 11);
    const result = closesBySecond(kept);
    expect(result?.first).toBe(T0);
    expect(result?.closes).toHaveLength(20);
    for (let i = 0; i < 20; i++) {
      if (i === 4 || i === 11) expect(result?.closes[i]).toBeNaN();
      else expect(result?.closes[i]).toBe(rows[i].close);
    }
    expect(closesBySecond([])).toBeUndefined();
    expect(() => closesBySecond([rows[0], { ...rows[1], timestamp: T0 + 1_500 }])).toThrow(
      StandError,
    );
  });

  it('H-T2: the first decision is at index sdWindowSec, none before', () => {
    const { wrapped, ats } = recording();
    const result = simulateH1(series(Array<number>(400).fill(1000)), wrapped, {
      entryDelaySec: 1,
      expirySec: 5,
    });
    expect(ats[0]).toBe(DEFAULT_H1_PARAMS.sdWindowSec);
    expect(Math.min(...ats)).toBe(DEFAULT_H1_PARAMS.sdWindowSec);
    expect(result.decisions).toBe(ats.length);
  });

  it.each([
    [1, 5],
    [2, 15],
  ])(
    'H-T3: a signal at f enters at f + %i, exits %i s later, and the next decision is the second after',
    (g, H) => {
      const f = 400;
      const { wrapped, ats } = recording();
      const result = simulateH1(series(spike(f, g, 500)), wrapped, {
        entryDelaySec: g,
        expirySec: H,
      });
      expect(result.trades).toEqual([
        {
          decidedAt: T0 + f * 1_000,
          action: 'up',
          entryAt: T0 + (f + g) * 1_000,
          exitAt: T0 + (f + g + H) * 1_000,
          outcome: 'loss',
        },
      ]);
      expect(ats[ats.indexOf(f) + 1]).toBe(f + g + H + 1);
    },
  );

  it('H-T4: a no_signal advances one second', () => {
    const { wrapped, ats } = recording();
    simulateH1(series(Array<number>(340).fill(1000)), wrapped, { entryDelaySec: 2, expirySec: 5 });
    expect(ats.length).toBeGreaterThan(30);
    expect(ats.slice(1).map((at, i) => at - ats[i])).toEqual(Array(ats.length - 1).fill(1));
  });

  it.each([
    ['entry', 1],
    ['exit', 6],
  ])('H-T5: no close at the %s is unpriced, and the cadence still jumps', (_, offset) => {
    const f = 400;
    const closes = spike(f, 1, 500);
    closes[f + offset] = NaN;
    const { wrapped, ats } = recording();
    const result = simulateH1(series(closes), wrapped, { entryDelaySec: 1, expirySec: 5 });
    expect(result.trades.map((trade) => trade.outcome)).toEqual(['unpriced']);
    expect(ats[ats.indexOf(f) + 1]).toBe(f + 7);
  });

  it('H-T6: refusals are counted by reason', () => {
    // flat for 400 s (no_volatility), a NaN close (no_price), then noise (below_threshold)
    const closes = Array.from({ length: 900 }, (_, i) =>
      i < 400 ? 1000 : 1000 + ((i * 7919) % 13) - 6,
    );
    closes.fill(NaN, 600, 611);
    const { wrapped, reasons } = recording();
    const result = simulateH1(series(closes), wrapped, { entryDelaySec: 1, expirySec: 5 });
    const counted: Record<string, number> = {};
    for (const reason of reasons.filter((reason) => reason !== 'signal')) {
      counted[reason] = (counted[reason] ?? 0) + 1;
    }
    expect(result.refusals).toEqual(counted);
    expect(Object.keys(result.refusals).sort()).toEqual([
      'below_threshold',
      'no_price',
      'no_volatility',
    ]);
    expect(result.decisions).toBe(reasons.length);
  });

  it('H-T7: the loop stops at the last second whose exit is in the series', () => {
    const length = 400;
    const g = 2;
    const H = 5;
    // a jump at the first second past the range: deciding it would trade beyond the last row
    const closes = Array.from({ length }, (_, i) => (i < length - g - H ? 1000 : 1005));
    const { wrapped, ats } = recording();
    const result = simulateH1(series(closes), wrapped, { entryDelaySec: g, expirySec: H });
    expect(ats.at(-1)).toBe(length - 1 - g - H);
    expect(result.trades).toEqual([]);
  });

  it('H-T8: the same trades as the backtest script loop, at every grid point', () => {
    const closes = randomWalk(6_000, 42);
    for (const threshold of H1_THRESHOLD_GRID) {
      const custom = createH1Detector({ ...DEFAULT_H1_PARAMS, threshold });
      for (const g of H1_ENTRY_DELAY_GRID_SEC) {
        for (const H of H1_EXPIRY_GRID_SEC) {
          const expected = scriptLoop(closes, threshold, g, H);
          const actual = simulateH1(series(closes), custom, { entryDelaySec: g, expirySec: H });
          expect(expected.length).toBeGreaterThan(10);
          expect(
            actual.trades.map((trade) => [
              (trade.decidedAt - T0) / 1_000,
              trade.action === 'up' ? 1 : -1,
              trade.outcome,
            ]),
            `threshold ${threshold}, +${g} s, ${H} s`,
          ).toEqual(expected);
        }
      }
    }
  });
});

// A seeded walk in integer steps with 1 % of the seconds missing, a flat first 400 s, so the
// flat-window path runs on both sides, and a flat last 30 s, so no signal waits at the very end.
function randomWalk(length: number, seed: number): number[] {
  let state = seed;
  const next = () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
  const closes: number[] = [];
  let price = 100_000;
  for (let i = 0; i < length; i++) {
    const walking = i >= 400 && i < length - 30;
    if (walking) price += Math.round((next() - 0.5) * 8) + (next() < 0.01 ? 40 : 0);
    closes.push(walking && next() < 0.01 ? NaN : price);
  }
  return closes;
}

// strat.mjs's loop (#667's analysis session), verbatim but for the per-trade record
function scriptLoop(c: readonly number[], t: number, g: number, H: number) {
  const N = c.length;
  const trades: [number, number, string][] = [];
  let f = 300;
  while (f + g + H < N) {
    let ss = 0;
    let m = 0;
    for (let j = f - 295; j <= f; j += 5) {
      const x = c[j] - c[j - 5];
      if (!Number.isNaN(x)) {
        ss += x * x;
        m++;
      }
    }
    const z = Math.abs(c[f] - c[f - 5]) / Math.sqrt(ss / m);
    const d = z > t ? Math.sign(c[f] - c[f - 5]) : 0;
    if (!d || Number.isNaN(d)) {
      f++;
      continue;
    }
    const e = c[f + g];
    const x = c[f + g + H];
    if (Number.isNaN(e) || Number.isNaN(x)) trades.push([f, d, 'unpriced']);
    else {
      const mv = Math.sign(x - e);
      trades.push([f, d, mv === 0 ? 'tie' : mv === d ? 'win' : 'loss']);
    }
    f = f + g + H + 1;
  }
  return trades;
}
