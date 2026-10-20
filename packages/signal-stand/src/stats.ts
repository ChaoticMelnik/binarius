import { wilson, type Interval95 } from '@binarius/shared';
import { MIN_KEPT_SHARE_PCT } from './config';
import type { SimTrade } from './simulate';

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

export interface Samples {
  inSample: Tally;
  outOfSample: Tally;
}

export type AgainstV2Verdict = 'better' | 'worse' | 'inconclusive' | 'no evidence';

export interface AgainstV2 {
  // the variant's priced trades (W + L + T) out of sample, in % of v2's
  keptPct?: number;
  deltaPct?: number;
  inSampleDeltaPct?: number;
  verdict: AgainstV2Verdict;
}

// #483's rule, fixed before the run: `better` needs the variant's whole out-of-sample interval
// above v2's rate, the kept-share floor and the same sign in sample
export function againstV2({ variant, v2 }: { variant: Samples; v2: Samples }): AgainstV2 {
  const keptPct =
    v2.outOfSample.trades === 0
      ? undefined
      : (100 * variant.outOfSample.trades) / v2.outOfSample.trades;
  const rate = winRatePct(variant.outOfSample);
  const v2Rate = winRatePct(v2.outOfSample);
  const inRate = winRatePct(variant.inSample);
  const v2InRate = winRatePct(v2.inSample);
  const deltaPct = rate === undefined || v2Rate === undefined ? undefined : rate - v2Rate;
  const inSampleDeltaPct =
    inRate === undefined || v2InRate === undefined ? undefined : inRate - v2InRate;
  if (
    keptPct === undefined ||
    v2Rate === undefined ||
    deltaPct === undefined ||
    inSampleDeltaPct === undefined
  ) {
    return { keptPct, deltaPct, inSampleDeltaPct, verdict: 'no evidence' };
  }
  const ci = intervalOf(variant.outOfSample);
  let verdict: AgainstV2Verdict = 'inconclusive';
  if (ci.low > v2Rate && keptPct >= MIN_KEPT_SHARE_PCT && inSampleDeltaPct > 0) verdict = 'better';
  else if (ci.high < v2Rate) verdict = 'worse';
  return { keptPct, deltaPct, inSampleDeltaPct, verdict };
}

// the cadence of a non-stop simulated session per pair, not the scanner's list length
export const tradesPerPairHour = (
  tally: Tally,
  pairs: number,
  hours: number,
): number | undefined => (pairs * hours === 0 ? undefined : tally.trades / (pairs * hours));

// the points `better` on every interval the rows cover; the intervals are returned with them,
// since #483's «added» needs 5s and 15s and a run may cover fewer
export function betterOnAllIntervals(
  rows: readonly { interval: string; variant: string; params: string; verdict: string }[],
): { intervals: string[]; points: string[] } {
  const intervals = [...new Set(rows.map((row) => row.interval))];
  const better = new Map<string, Set<string>>();
  for (const row of rows) {
    const key = `${row.variant} ${row.params}`;
    if (!better.has(key)) better.set(key, new Set());
    if (row.verdict === 'better') better.get(key)?.add(row.interval);
  }
  const points = [...better]
    .filter(([, seen]) => intervals.length > 0 && intervals.every((i) => seen.has(i)))
    .map(([key]) => key);
  return { intervals, points };
}
