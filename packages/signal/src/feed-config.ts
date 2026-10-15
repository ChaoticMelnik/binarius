import { DISPLAY_INDICATOR_PARAMS, type SignalParamsV1 } from '@binarius/shared';
import { DEFAULT_SIGNAL_PARAMS } from './config';

// the decision window: the candle starts of a fetch of this many rows, cut from the response by
// time (decisionRows); the last one is the forming candle
export const SIGNAL_CHART_LIMIT = 60;

// the rows asked of the broker: the decision reads its SIGNAL_CHART_LIMIT window, the card's
// indicators the unbroken tail of the answer (MA200 needs 200 closed candles, #482)
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

// an edited default fails at import, not on the first decision. The fetch limit needs no check
// when a feed is created: assertFeedLimit there bounds maxStaleIntervals <= 59 - minClosedCandles,
// at most 58 for any params (minClosedCandles >= 1) and 9 with the default 50, so the fetch keeps
// 300 - 1 - 58 = 241 >= 200 closed candles for any decider the feed accepts
assertFeedLimit(SIGNAL_CHART_LIMIT, DEFAULT_SIGNAL_PARAMS);
assertFetchLimit(SIGNAL_FETCH_LIMIT, DEFAULT_SIGNAL_PARAMS);
