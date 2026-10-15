import { DISPLAY_INDICATOR_PARAMS, type SignalParamsV1 } from '@binarius/shared';
import { DEFAULT_SIGNAL_PARAMS } from './config';

// the decision window: the last this many rows of the response; the last one is the forming candle
export const SIGNAL_CHART_LIMIT = 60;

// the rows asked of the broker: the decision reads the last SIGNAL_CHART_LIMIT of them, the card's
// indicators all of them (MA200 needs 200 closed candles, #482)
export const SIGNAL_FETCH_LIMIT = 300;

// the forming candle and up to maxStaleIntervals trailing rows the broker has not published yet
// leave limit - 1 - maxStaleIntervals closed candles in the worst accepted case
export function assertFeedLimit(limit: number, params: SignalParamsV1): void {
  const required = 1 + params.maxStaleIntervals + params.minClosedCandles;
  if (!Number.isInteger(limit) || limit < required) {
    throw new RangeError(
      `signal feed: chart limit must be an integer >= 1 + maxStaleIntervals (${params.maxStaleIntervals}) + minClosedCandles (${params.minClosedCandles}) = ${required}, got ${limit}`,
    );
  }
}

// the same worst case as above, against the longest display indicator
export function assertFetchLimit(limit: number, params: SignalParamsV1): void {
  const required = Math.max(
    SIGNAL_CHART_LIMIT,
    1 + params.maxStaleIntervals + DISPLAY_INDICATOR_PARAMS.maLong,
  );
  if (!Number.isInteger(limit) || limit < required) {
    throw new RangeError(
      `signal feed: fetch limit must be an integer >= max(chart limit ${SIGNAL_CHART_LIMIT}, 1 + maxStaleIntervals (${params.maxStaleIntervals}) + ${DISPLAY_INDICATOR_PARAMS.maLong}) = ${required}, got ${limit}`,
    );
  }
}

// an edited default fails at import, not on the first decision
assertFeedLimit(SIGNAL_CHART_LIMIT, DEFAULT_SIGNAL_PARAMS);
assertFetchLimit(SIGNAL_FETCH_LIMIT, DEFAULT_SIGNAL_PARAMS);
