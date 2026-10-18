import { BrokerRestError, type BrokerRestClient } from '@binarius/broker-rest';
import {
  BrokerRestErrorCode,
  errorLogFields,
  SIGNAL_CHART_INTERVAL_MS,
  SignalFeedOutcome,
  type Candle,
  type SignalIndicators,
  type SignalInterval,
} from '@binarius/shared';
import { assertSignalClock } from './candles';
import { assertDigits, createSignalDecider, type SignalDecider } from './decide';
import { displayIndicators } from './display';
import {
  assertFeedLimit,
  SIGNAL_CHART_LIMIT,
  SIGNAL_FETCH_LIMIT,
  SIGNAL_PACER_RETRY_SEC,
} from './feed-config';
import { toJournalCandle, type SignalJournalEntry, type SignalJournalSource } from './journal';
import type { SignalCandleSource, SignalRestPacer } from './source';

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

export type SignalDecidedEvaluation = Extract<
  SignalEvaluation,
  { outcome: typeof SignalFeedOutcome.Decided }
>;

export interface SignalFeedDeps {
  rest: Pick<BrokerRestClient, 'getChart'>;
  decider?: SignalDecider;
  logger: SignalFeedLogger;
  // the decision's nowMs; the window is built from the same reading
  now?: () => number;
  // the data socket's candles (#405); without a window for the key the feed reads REST
  source?: SignalCandleSource;
  // the gate of every REST GET (docs/signal.md -> The budget); absent, a GET is never refused
  pacer?: SignalRestPacer;
}

export interface SignalFeed {
  readonly decider: SignalDecider;
  // journal (default true) writes the decided result's `signal decision` line
  evaluate(
    request: SignalFeedRequest,
    options?: { signal?: AbortSignal; journal?: boolean },
  ): Promise<SignalEvaluation>;
  // the source's window only, synchronously, with no line; undefined without a window
  fromSource(request: SignalFeedRequest): SignalDecidedEvaluation | undefined;
  journal(entry: SignalJournalEntry): void;
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
  const { rest, logger, source, pacer, now = Date.now } = deps;
  const decider = deps.decider ?? createSignalDecider();
  assertFeedLimit(SIGNAL_CHART_LIMIT, decider.params);

  // one code for both sources: the decision, its journal series and the display indicators read
  // the same rows with the same nowMs
  function decideRows(
    { assetId, interval, digits }: SignalFeedRequest,
    rows: readonly Candle[],
    intervalMs: number,
    nowMs: number,
    entrySource: SignalJournalSource,
  ): SignalDecidedEvaluation {
    // the decision, its journal series and the #381 stand do not change with the longer window
    const decisionCandles = decisionRows(rows, nowMs, intervalMs);
    const decision = decider.decide({ candles: decisionCandles, intervalMs, nowMs, digits });
    const entry: SignalJournalEntry = {
      assetId,
      interval,
      digits,
      intervalMs,
      nowMs,
      source: entrySource,
      version: decider.version,
      params: decider.params,
      series: decisionCandles.map(toJournalCandle),
      decision,
    };
    const indicators = displayIndicators(rows, intervalMs, nowMs, decider.params);
    return {
      outcome: SignalFeedOutcome.Decided,
      entry,
      ...(indicators === undefined ? {} : { indicators }),
    };
  }

  // an unknown interval throws; the clock is read once per call
  function prepare({ interval, digits }: SignalFeedRequest): { intervalMs: number; nowMs: number } {
    const intervalMs: number | undefined = SIGNAL_CHART_INTERVAL_MS[interval];
    if (intervalMs === undefined) {
      throw new RangeError(`signal feed: unknown interval ${String(interval)}`);
    }
    const nowMs = now();
    // a broken clock or digits cost no broker call and no read
    assertSignalClock(intervalMs, nowMs);
    assertDigits(digits);
    return { intervalMs, nowMs };
  }

  // A gap, a short or a stale series is the decider's honest refusal, never a wait; any gap in the
  // window asks the source for a refill (#405, owner's answer 1).
  function fromWindow(
    request: SignalFeedRequest,
    intervalMs: number,
    nowMs: number,
  ): SignalDecidedEvaluation | undefined {
    const window = source?.read(request.assetId, request.interval, nowMs);
    if (source === undefined || window === undefined) return undefined;
    if (window.gaps.length > 0) source.request(request.assetId, request.interval);
    // The ring's forming candle is the latest bucket it has not closed: the current bucket of
    // nowMs, or the one before it while neither the watermark nor the clock margin has closed it
    // (ring.test.ts R3). Only the current one goes in, as REST's forming row, and the decider drops
    // it by nowMs; the one before is left out, so the decision is on the candle before it, which
    // the scanner counts as unclosed and GET /trading/signals does not serve.
    const current = Math.floor(nowMs / intervalMs) * intervalMs;
    const { forming } = window;
    const rows =
      forming === undefined || forming.timestamp !== current
        ? window.candles
        : [...window.candles, forming];
    return decideRows(request, rows, intervalMs, nowMs, {
      kind: 'socket',
      startTime: window.startTime,
      closedUntil: window.closedUntil,
      gaps: window.gaps.length,
    });
  }

  function journal(entry: SignalJournalEntry): void {
    logger.info({ signal: entry }, 'signal decision');
  }

  return {
    decider,
    fromSource(request) {
      const { intervalMs, nowMs } = prepare(request);
      return fromWindow(request, intervalMs, nowMs);
    },
    journal,
    async evaluate(request, options) {
      const { assetId, interval } = request;
      const { intervalMs, nowMs } = prepare(request);
      const writeLine = options?.journal ?? true;
      const windowed = fromWindow(request, intervalMs, nowMs);
      if (windowed !== undefined) {
        if (writeLine) journal(windowed.entry);
        return windowed;
      }

      const window = chartWindow(nowMs, intervalMs, SIGNAL_FETCH_LIMIT);
      const facts: SignalFetchFacts = { assetId, interval, intervalMs, nowMs, ...window };
      if (pacer !== undefined && !pacer.tryTake()) {
        const pausedUntil = pacer.pausedUntil();
        const retryAfterSec =
          pausedUntil === undefined
            ? SIGNAL_PACER_RETRY_SEC
            : Math.max(1, Math.ceil((pausedUntil - nowMs) / 1000));
        logger.warn({ retryAfterSec, signal: facts }, 'signal fetch refused: no token');
        return {
          outcome: SignalFeedOutcome.FetchFailed,
          request: facts,
          code: BrokerRestErrorCode.RateLimited,
          retryAfterSec,
        };
      }

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
        if (error.code === BrokerRestErrorCode.RateLimited) pacer?.onRateLimited(retryAfterSec);
        logger.warn(
          { ...errorLogFields(error), status, retryAfterSec, detail, signal: facts },
          'signal fetch failed',
        );
        return {
          outcome: SignalFeedOutcome.FetchFailed,
          request: facts,
          code: error.code,
          ...(status === undefined ? {} : { status }),
          ...(retryAfterSec === undefined ? {} : { retryAfterSec }),
        };
      }
      const durationMs = Math.round(performance.now() - started);
      pacer?.onDecided();

      const result = decideRows(request, candles, intervalMs, nowMs, {
        kind: 'rest',
        ...window,
        rows: candles.length,
        durationMs,
      });
      if (writeLine) journal(result.entry);
      return result;
    },
  };
}
