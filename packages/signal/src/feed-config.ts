import type { SignalParams } from '@binarius/shared';
import { DEFAULT_SIGNAL_PARAMS } from './config';

// the window holds this many candle starts; the last one is the forming candle
export const SIGNAL_CHART_LIMIT = 60;

// the forming candle and up to maxStaleIntervals trailing rows the broker has not published yet
// leave limit - 1 - maxStaleIntervals closed candles in the worst accepted case
export function assertFeedLimit(limit: number, params: SignalParams): void {
  const required = 1 + params.maxStaleIntervals + params.minClosedCandles;
  if (!Number.isInteger(limit) || limit < required) {
    throw new RangeError(
      `signal feed: chart limit must be an integer >= 1 + maxStaleIntervals (${params.maxStaleIntervals}) + minClosedCandles (${params.minClosedCandles}) = ${required}, got ${limit}`,
    );
  }
}

// an edited default fails at import, not on the first decision
assertFeedLimit(SIGNAL_CHART_LIMIT, DEFAULT_SIGNAL_PARAMS);
