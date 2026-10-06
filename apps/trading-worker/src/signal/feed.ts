import { BrokerRestError, type BrokerRestClient } from '@binarius/broker-rest';
import { errorLogFields, type BrokerRestErrorCode } from '@binarius/shared';
import type { Logger } from 'pino';
import { assertSignalClock } from './candles';
import { createSignalDecider, type SignalDecider } from './decide';
import {
  assertFeedLimit,
  SIGNAL_CHART_INTERVAL_MS,
  SIGNAL_CHART_LIMIT,
  type SignalInterval,
} from './feed-config';
import { toJournalCandle, type SignalJournalEntry } from './journal';

export const SignalFeedOutcome = { Decided: 'decided', FetchFailed: 'fetch_failed' } as const;
export type SignalFeedOutcome = (typeof SignalFeedOutcome)[keyof typeof SignalFeedOutcome];

export interface SignalFeedRequest {
  assetId: number;
  interval: SignalInterval;
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
  | { outcome: typeof SignalFeedOutcome.Decided; entry: SignalJournalEntry }
  | {
      outcome: typeof SignalFeedOutcome.FetchFailed;
      request: SignalFetchFacts;
      code: BrokerRestErrorCode;
      status?: number;
      retryAfterSec?: number;
    };

export interface SignalFeedDeps {
  rest: Pick<BrokerRestClient, 'getChart'>;
  decider?: SignalDecider;
  logger: Pick<Logger, 'info' | 'warn'>;
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

export function createSignalFeed(deps: SignalFeedDeps): SignalFeed {
  const { rest, logger, now = Date.now } = deps;
  const decider = deps.decider ?? createSignalDecider();
  assertFeedLimit(SIGNAL_CHART_LIMIT, decider.params);

  return {
    decider,
    async evaluate({ assetId, interval }, options) {
      const intervalMs: number | undefined = SIGNAL_CHART_INTERVAL_MS[interval];
      if (intervalMs === undefined) {
        throw new RangeError(`signal feed: unknown interval ${String(interval)}`);
      }
      const nowMs = now();
      // a broken clock costs no broker call
      assertSignalClock(intervalMs, nowMs);
      const window = chartWindow(nowMs, intervalMs, SIGNAL_CHART_LIMIT);
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

      const decision = decider.decide({ candles, intervalMs, nowMs });
      const entry: SignalJournalEntry = {
        assetId,
        interval,
        intervalMs,
        nowMs,
        fetch: { ...window, rows: candles.length, durationMs },
        version: decider.version,
        params: decider.params,
        series: candles.map(toJournalCandle),
        decision,
      };
      logger.info({ signal: entry }, 'signal decision');
      return { outcome: SignalFeedOutcome.Decided, entry };
    },
  };
}
