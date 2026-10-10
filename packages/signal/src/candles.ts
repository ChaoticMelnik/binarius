import {
  CandleProblem,
  NoSignalReason,
  type Candle,
  type SignalDataRefusal,
  type SignalParamsV1,
} from '@binarius/shared';

export type PreparedCandles =
  { ok: true; closed: readonly Candle[] } | { ok: false; refusal: SignalDataRefusal };

export function assertSignalClock(intervalMs: number, nowMs: number): void {
  if (!Number.isInteger(intervalMs) || intervalMs <= 0) {
    throw new RangeError(`signal input: intervalMs must be a positive integer, got ${intervalMs}`);
  }
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    throw new RangeError(`signal input: nowMs must be a finite number >= 0, got ${nowMs}`);
  }
}

const invalid = (index: number, problem: CandleProblem): PreparedCandles => ({
  ok: false,
  refusal: { reason: NoSignalReason.InvalidCandle, detail: { index, problem } },
});

function candleProblem(candle: Candle): CandleProblem | undefined {
  const { timestamp, open, high, low, close } = candle;
  if (![timestamp, open, high, low, close].every(Number.isFinite)) return CandleProblem.NonFinite;
  if (!(open > 0 && high > 0 && low > 0 && close > 0)) return CandleProblem.NonPositive;
  if (!(low <= Math.min(open, close) && Math.max(open, close) <= high)) {
    return CandleProblem.OhlcOrder;
  }
  return undefined;
}

// Order: per-candle and step checks in index order, then the first candle starting after nowMs,
// then the forming-candle drop, then staleness, then the count. The first failure wins.
export function prepareCandles(
  candles: readonly Candle[],
  intervalMs: number,
  nowMs: number,
  params: SignalParamsV1,
): PreparedCandles {
  assertSignalClock(intervalMs, nowMs);

  for (let i = 0; i < candles.length; i++) {
    const problem = candleProblem(candles[i]);
    if (problem !== undefined) return invalid(i, problem);
    if (i === 0) continue;
    const previous = candles[i - 1].timestamp;
    const step = candles[i].timestamp - previous;
    if (step <= 0) return invalid(i, CandleProblem.NotAscending);
    if (step === intervalMs) continue;
    if (step % intervalMs === 0) {
      return {
        ok: false,
        refusal: {
          reason: NoSignalReason.CandleGap,
          detail: {
            index: i,
            expectedTimestamp: previous + intervalMs,
            actualTimestamp: candles[i].timestamp,
          },
        },
      };
    }
    return invalid(i, CandleProblem.StepMismatch);
  }

  const firstFuture = candles.findIndex((candle) => candle.timestamp > nowMs);
  if (firstFuture !== -1) return invalid(firstFuture, CandleProblem.InFuture);

  // forming: timestamp <= nowMs < timestamp + intervalMs; the left side holds after the check above
  const closed = candles.slice();
  const last = closed.at(-1);
  if (last !== undefined && last.timestamp + intervalMs > nowMs) closed.pop();

  const required = params.minClosedCandles;
  const lastClosed = closed.at(-1);
  if (lastClosed === undefined) {
    return {
      ok: false,
      refusal: {
        reason: NoSignalReason.InsufficientCandles,
        detail: { closedCandles: 0, required },
      },
    };
  }

  const ageMs = nowMs - (lastClosed.timestamp + intervalMs);
  const maxAgeMs = params.maxStaleIntervals * intervalMs;
  if (ageMs > maxAgeMs) {
    return {
      ok: false,
      refusal: {
        reason: NoSignalReason.Stale,
        detail: { lastCandleTimestamp: lastClosed.timestamp, ageMs, maxAgeMs },
      },
    };
  }

  if (closed.length < required) {
    return {
      ok: false,
      refusal: {
        reason: NoSignalReason.InsufficientCandles,
        detail: { closedCandles: closed.length, required },
      },
    };
  }
  return { ok: true, closed };
}
