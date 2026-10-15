import { BrokerRestError, type BrokerRestClient } from '@binarius/broker-rest';
import {
  errorLogFields,
  SIGNAL_CHART_INTERVAL_MS,
  SignalFeedOutcome,
  type BrokerRestErrorCode,
  type Candle,
  type SignalIndicators,
  type SignalInterval,
} from '@binarius/shared';
import { assertSignalClock } from './candles';
import { assertDigits, createSignalDecider, type SignalDecider } from './decide';
import { displayIndicators } from './display';
import { assertFeedLimit, SIGNAL_CHART_LIMIT, SIGNAL_FETCH_LIMIT } from './feed-config';
import { toJournalCandle, type SignalJournalEntry } from './journal';

export interface SignalFeedRequest {
  assetId: number;
  interval: SignalInterval;
  // the pair's quote precision from the caller's catalog read (#379)
  digits: number;
}

export interface SignalFetchFacts {
  assetId: number;
  interval: SignalInterval;
  intervalMs: number;
  nowMs: number;
  startTime: number;
  limit: number;
}

export type SignalEvaluation =
  | {
      outcome: typeof SignalFeedOutcome.Decided;
      entry: SignalJournalEntry;
      // absent when the unbroken tail of the response did not pass the candle checks
      indicators?: SignalIndicators;
    }
  | {
      outcome: typeof SignalFeedOutcome.FetchFailed;
      request: SignalFetchFacts;
      code: BrokerRestErrorCode;
      status?: number;
      retryAfterSec?: number;
    };

// pino's logger fits; the backend passes one that forwards to the app's logger (#258)
export interface SignalFeedLogger {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
}

export interface SignalFeedDeps {
  rest: Pick<BrokerRestClient, 'getChart'>;
  decider?: SignalDecider;
  logger: SignalFeedLogger;
  // the decision's nowMs; the window is built from the same reading
  now?: () => number;
}

export interface SignalFeed {
  readonly decider: SignalDecider;
  evaluate(
    request: SignalFeedRequest,
    options?: { signal?: AbortSignal },
  ): Promise<SignalEvaluation>;
}

// `limit` candle starts ending on the current interval boundary; the last one is the forming candle
export function chartWindow(
  nowMs: number,
  intervalMs: number,
  limit: number,
): { startTime: number; limit: number } {
  const boundary = Math.floor(nowMs / intervalMs) * intervalMs;
  return { startTime: boundary - (limit - 1) * intervalMs, limit };
}

// The rows a fetch of SIGNAL_CHART_LIMIT with the same right edge returns: cut by time, as the
// #381 stand's seriesAt cuts its cache, not by count: a missing forming or late closed candle
// would otherwise pull in older rows. Rows outside the window, a future one included, do not
// reach the decision, as they would not reach it from that fetch's answer either.
export function decisionRows(
  candles: readonly Candle[],
  nowMs: number,
  intervalMs: number,
): Candle[] {
  const { startTime } = chartWindow(nowMs, intervalMs, SIGNAL_CHART_LIMIT);
  const boundary = Math.floor(nowMs / intervalMs) * intervalMs;
  return candles.filter(({ timestamp }) => startTime <= timestamp && timestamp <= boundary);
}

export function createSignalFeed(deps: SignalFeedDeps): SignalFeed {
  const { rest, logger, now = Date.now } = deps;
  const decider = deps.decider ?? createSignalDecider();
  assertFeedLimit(SIGNAL_CHART_LIMIT, decider.params);

  return {
    decider,
    async evaluate({ assetId, interval, digits }, options) {
      const intervalMs: number | undefined = SIGNAL_CHART_INTERVAL_MS[interval];
      if (intervalMs === undefined) {
        throw new RangeError(`signal feed: unknown interval ${String(interval)}`);
      }
      const nowMs = now();
      // a broken clock or digits cost no broker call
      assertSignalClock(intervalMs, nowMs);
      assertDigits(digits);
      const window = chartWindow(nowMs, intervalMs, SIGNAL_FETCH_LIMIT);
      const request: SignalFetchFacts = { assetId, interval, intervalMs, nowMs, ...window };

      const started = performance.now();
      let candles;
      try {
        candles = await rest.getChart(
          { assetId, interval, ...window },
          { signal: options?.signal },
        );
      } catch (error) {
        if (!(error instanceof BrokerRestError)) throw error;
        const { status, retryAfterSec, detail } = error;
        logger.warn(
          { ...errorLogFields(error), status, retryAfterSec, detail, signal: request },
          'signal fetch failed',
        );
        return {
          outcome: SignalFeedOutcome.FetchFailed,
          request,
          code: error.code,
          ...(status === undefined ? {} : { status }),
          ...(retryAfterSec === undefined ? {} : { retryAfterSec }),
        };
      }
      const durationMs = Math.round(performance.now() - started);

      // the decision, its journal series and the #381 stand do not change with the longer fetch
      const decisionCandles = decisionRows(candles, nowMs, intervalMs);
      const decision = decider.decide({ candles: decisionCandles, intervalMs, nowMs, digits });
      const entry: SignalJournalEntry = {
        assetId,
        interval,
        digits,
        intervalMs,
        nowMs,
        fetch: { ...window, rows: candles.length, durationMs },
        version: decider.version,
        params: decider.params,
        series: decisionCandles.map(toJournalCandle),
        decision,
      };
      logger.info({ signal: entry }, 'signal decision');
      const indicators = displayIndicators(candles, intervalMs, nowMs, decider.params);
      return {
        outcome: SignalFeedOutcome.Decided,
        entry,
        ...(indicators === undefined ? {} : { indicators }),
      };
    },
  };
}
