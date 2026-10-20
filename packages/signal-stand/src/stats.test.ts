import { breakEvenPct } from '@binarius/shared';
import { describe, expect, it } from 'vitest';
import {
  addTrade,
  againstV2,
  betterOnAllIntervals,
  emptyTally,
  selectPoint,
  tradesPerPairHour,
  winRatePct,
  type Tally,
} from './stats';

const tally = (wins: number, losses: number, ties = 0): Tally => ({
  ...emptyTally(),
  trades: wins + losses + ties,
  wins,
  losses,
  ties,
});

describe('stats', () => {
  it('T2 the rate excludes ties, which pay nothing', () => {
    const t = emptyTally();
    addTrade(t, { outcome: 'win' }, 90);
    addTrade(t, { outcome: 'tie' }, 90);
    addTrade(t, { outcome: 'loss' }, 90);
    addTrade(t, { outcome: 'unpriced' }, 90);
    expect(t).toMatchObject({ trades: 3, wins: 1, losses: 1, ties: 1, unpriced: 1 });
    expect(winRatePct(t)).toBe(50);
    expect(t.pnl).toBeCloseTo(-0.1, 10);
  });

  it('T3 break-even at a payout', () => {
    expect(breakEvenPct(80).toFixed(2)).toBe('55.56');
    expect(breakEvenPct(96).toFixed(2)).toBe('51.02');
    expect(breakEvenPct(54).toFixed(2)).toBe('64.94');
  });

  it('T4 selection takes the best in-sample rate among points with enough trades', () => {
    const candidates = [
      { point: 'a', tally: tally(60, 40) },
      { point: 'b', tally: tally(80, 19) },
      { point: 'c', tally: tally(70, 30) },
    ];
    expect(selectPoint(candidates, 100)).toBe('c');
    expect(selectPoint(candidates, 99)).toBe('b');
    expect(selectPoint(candidates, 101)).toBeUndefined();
  });

  // v2 at 55 % out of sample on 1 000 trades, 55 % in sample
  const v2 = { inSample: tally(55, 45), outOfSample: tally(550, 450) };

  it('T6 against v2: better above its rate, worse below, inconclusive when the interval straddles it', () => {
    const better = againstV2({
      variant: { inSample: tally(60, 40), outOfSample: tally(700, 300) },
      v2,
    });
    expect(better.verdict).toBe('better');
    expect(better.keptPct).toBe(100);
    expect(better.deltaPct).toBeCloseTo(15, 10);
    expect(better.inSampleDeltaPct).toBeCloseTo(5, 10);
    expect(
      againstV2({ variant: { inSample: tally(60, 40), outOfSample: tally(400, 600) }, v2 }).verdict,
    ).toBe('worse');
    expect(
      againstV2({ variant: { inSample: tally(60, 40), outOfSample: tally(56, 44) }, v2 }).verdict,
    ).toBe('inconclusive');
  });

  it('T7 a variant keeping under 10 % of the trades is not better, at any rate; kept % counts ties', () => {
    const many = { inSample: tally(55, 45), outOfSample: tally(5_500, 4_500) };
    const few = againstV2({
      variant: { inSample: tally(60, 40), outOfSample: tally(350, 150) },
      v2: many,
    });
    expect(few.keptPct).toBe(5);
    expect(few.verdict).toBe('inconclusive');
    const atFloor = againstV2({
      variant: { inSample: tally(60, 40), outOfSample: tally(650, 250, 100) },
      v2: many,
    });
    expect(atFloor.keptPct).toBe(10);
    expect(atFloor.verdict).toBe('better');
  });

  it('T8 a variant not above v2 in sample is not better', () => {
    for (const inSample of [tally(55, 45), tally(50, 50)]) {
      expect(againstV2({ variant: { inSample, outOfSample: tally(700, 300) }, v2 }).verdict).toBe(
        'inconclusive',
      );
    }
  });

  it('T9 no decided trade in any of the four samples is no evidence, never better', () => {
    const strong = { inSample: tally(60, 40), outOfSample: tally(700, 300) };
    const empty = tally(0, 0, 3);
    const cases = [
      { variant: { ...strong, outOfSample: empty }, v2 },
      { variant: { ...strong, inSample: empty }, v2 },
      { variant: strong, v2: { ...v2, outOfSample: empty } },
      { variant: strong, v2: { ...v2, inSample: empty } },
      { variant: strong, v2: { ...v2, outOfSample: tally(0, 0) } },
    ];
    for (const samples of cases) expect(againstV2(samples).verdict).toBe('no evidence');
    expect(againstV2(cases[4]).keptPct).toBeUndefined();
  });

  it('T10 trades per pair-hour and the points better on every interval', () => {
    expect(tradesPerPairHour(tally(6, 3, 1), 2, 2.5)).toBe(2);
    expect(tradesPerPairHour(tally(6, 3, 1), 0, 2.5)).toBeUndefined();
    const rows = [
      { interval: '5s', variant: 'v2+ma', params: 'ma=200', verdict: 'better' },
      { interval: '15s', variant: 'v2+ma', params: 'ma=200', verdict: 'better' },
      { interval: '5s', variant: 'v2+ma', params: 'ma=50', verdict: 'better' },
      { interval: '15s', variant: 'v2+ma', params: 'ma=50', verdict: 'inconclusive' },
      { interval: '5s', variant: 'v2+macd', params: 'macd=cross', verdict: 'worse' },
    ];
    expect(betterOnAllIntervals(rows)).toEqual({
      intervals: ['5s', '15s'],
      points: ['v2+ma ma=200'],
    });
    expect(betterOnAllIntervals(rows.filter((r) => r.interval === '5s'))).toEqual({
      intervals: ['5s'],
      points: ['v2+ma ma=200', 'v2+ma ma=50'],
    });
    expect(betterOnAllIntervals([])).toEqual({ intervals: [], points: [] });
  });
});
