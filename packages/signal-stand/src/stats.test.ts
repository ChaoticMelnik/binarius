import { breakEvenPct } from '@binarius/shared';
import { describe, expect, it } from 'vitest';
import {
  addTrade,
  emptyTally,
  selectPoint,
  verdictOf,
  wilson,
  winRatePct,
  type Tally,
} from './stats';

const round = ({ low, high }: { low: number; high: number }) => [
  Number(low.toFixed(1)),
  Number(high.toFixed(1)),
];

const tally = (wins: number, losses: number, ties = 0): Tally => ({
  ...emptyTally(),
  trades: wins + losses + ties,
  wins,
  losses,
  ties,
});

describe('stats', () => {
  it('T1 the Wilson interval matches the reference values', () => {
    expect(round(wilson(8, 30))).toEqual([14.2, 44.4]);
    expect(round(wilson(0, 10))).toEqual([0, 27.8]);
    expect(round(wilson(180, 300))).toEqual([54.4, 65.4]);
    expect(wilson(0, 0)).toEqual({ low: 0, high: 100 });
  });

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

  it('T5 the verdict at the boundaries', () => {
    expect(verdictOf({ low: 55.6, high: 60 }, 55.6)).toBe('inconclusive');
    expect(verdictOf({ low: 55.7, high: 60 }, 55.6)).toBe('beats break-even');
    expect(verdictOf({ low: 40, high: 55.5 }, 55.6)).toBe('below');
    expect(verdictOf({ low: 40, high: 55.6 }, 55.6)).toBe('inconclusive');
  });
});
