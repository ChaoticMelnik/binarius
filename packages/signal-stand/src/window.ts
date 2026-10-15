import type { Candle } from '@binarius/shared';
import { chartWindow, SIGNAL_CHART_LIMIT } from '@binarius/signal';

// the first index whose timestamp is >= ms
export function lowerBound(series: readonly Candle[], ms: number): number {
  let lo = 0;
  let hi = series.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (series[mid].timestamp < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// The rows the broker would answer the feed's request at nowMs: from chartWindow's start_time up
// to the current boundary, the forming candle included (the decider drops it). `limit` is a
// parameter so a variant needing a longer history (#483's MA200) plugs in unchanged.
export function seriesAt(
  series: readonly Candle[],
  intervalMs: number,
  nowMs: number,
  limit: number = SIGNAL_CHART_LIMIT,
): Candle[] {
  const { startTime } = chartWindow(nowMs, intervalMs, limit);
  const boundary = Math.floor(nowMs / intervalMs) * intervalMs;
  return series.slice(lowerBound(series, startTime), lowerBound(series, boundary + 1));
}
