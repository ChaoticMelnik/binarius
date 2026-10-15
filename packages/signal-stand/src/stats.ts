import type { SimTrade } from './simulate';

const Z95 = 1.959964;

export interface Interval95 {
  low: number;
  high: number;
}

// Wilson score interval, in percent; 0 trials -> the whole range
export function wilson(wins: number, n: number): Interval95 {
  if (n === 0) return { low: 0, high: 100 };
  const p = wins / n;
  const z2 = Z95 * Z95;
  const centre = p + z2 / (2 * n);
  const margin = Z95 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  const denominator = 1 + z2 / n;
  return {
    low: (100 * (centre - margin)) / denominator,
    high: (100 * (centre + margin)) / denominator,
  };
}

export interface Tally {
  trades: number;
  wins: number;
  losses: number;
  ties: number;
  unpriced: number;
  // at stake 1: +payout/100 per win, -1 per loss
  pnl: number;
}

export const emptyTally = (): Tally => ({
  trades: 0,
  wins: 0,
  losses: 0,
  ties: 0,
  unpriced: 0,
  pnl: 0,
});

export function addTrade(tally: Tally, trade: Pick<SimTrade, 'outcome'>, payout: number): void {
  if (trade.outcome === 'unpriced') {
    tally.unpriced++;
    return;
  }
  tally.trades++;
  if (trade.outcome === 'win') {
    tally.wins++;
    tally.pnl += payout / 100;
  } else if (trade.outcome === 'loss') {
    tally.losses++;
    tally.pnl -= 1;
  } else {
    tally.ties++;
  }
}

export function mergeTally(into: Tally, from: Tally): void {
  into.trades += from.trades;
  into.wins += from.wins;
  into.losses += from.losses;
  into.ties += from.ties;
  into.unpriced += from.unpriced;
  into.pnl += from.pnl;
}

// ties excluded: the rate is wins over decided trades
export const decided = (tally: Tally): number => tally.wins + tally.losses;
export const winRatePct = (tally: Tally): number | undefined =>
  decided(tally) === 0 ? undefined : (100 * tally.wins) / decided(tally);
export const intervalOf = (tally: Tally): Interval95 => wilson(tally.wins, decided(tally));

export type Verdict = 'beats break-even' | 'inconclusive' | 'below';

// beating break-even needs the whole interval above it; touching it is not enough
export function verdictOf(ci: Interval95, breakEven: number): Verdict {
  if (ci.low > breakEven) return 'beats break-even';
  if (ci.high < breakEven) return 'below';
  return 'inconclusive';
}

export const splitAt = (since: number, until: number, share: number): number =>
  since + Math.floor(share * (until - since));

// the highest in-sample rate among the points with enough trades; the first point wins a tie
export function selectPoint<T>(
  candidates: readonly { point: T; tally: Tally }[],
  minTrades: number,
): T | undefined {
  let best: { point: T; rate: number } | undefined;
  for (const { point, tally } of candidates) {
    const rate = winRatePct(tally);
    if (tally.trades < minTrades || rate === undefined) continue;
    if (best === undefined || rate > best.rate) best = { point, rate };
  }
  return best?.point;
}
