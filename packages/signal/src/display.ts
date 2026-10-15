import {
  DISPLAY_INDICATOR_PARAMS,
  MacdCross,
  type Candle,
  type SignalIndicators,
  type SignalParams,
} from '@binarius/shared';
import { prepareCandles } from './candles';
import { macd, sma } from './indicators';

// two signal-line points: the cross compares the last two closed candles
export const MACD_REQUIRED_CANDLES =
  DISPLAY_INDICATOR_PARAMS.macdSlow + DISPLAY_INDICATOR_PARAMS.macdSignal;

const short = (closedCandles: number, required: number) =>
  ({ ok: false, closedCandles, required }) as const;

function crossOf(previous: number, last: number): MacdCross {
  if (previous < 0 && last > 0) return MacdCross.Up;
  if (previous > 0 && last < 0) return MacdCross.Down;
  return MacdCross.None;
}

function movingAverage(closes: readonly number[], period: number): SignalIndicators['ma50'] {
  if (closes.length < period) return short(closes.length, period);
  return {
    ok: true,
    value: sma(closes, period).at(-1) as number,
    lastClose: closes.at(-1) as number,
  };
}

// The whole response passes the decider's own candle checks with a floor of one closed candle; a
// response that does not pass gives no indicators. Each indicator then refuses on its own count.
export function displayIndicators(
  candles: readonly Candle[],
  intervalMs: number,
  nowMs: number,
  params: SignalParams,
): SignalIndicators | undefined {
  const prepared = prepareCandles(candles, intervalMs, nowMs, { ...params, minClosedCandles: 1 });
  if (!prepared.ok) return undefined;
  const closes = prepared.closed.map((candle) => candle.close);
  const { macdFast, macdSlow, macdSignal, maShort, maLong } = DISPLAY_INDICATOR_PARAMS;

  let macdIndicator: SignalIndicators['macd'];
  if (closes.length < MACD_REQUIRED_CANDLES) {
    macdIndicator = short(closes.length, MACD_REQUIRED_CANDLES);
  } else {
    const series = macd(closes, macdFast, macdSlow, macdSignal);
    const [previous, last] = series.histogram.slice(-2) as [number, number];
    macdIndicator = {
      ok: true,
      macd: series.macd.at(-1) as number,
      signal: series.signal.at(-1) as number,
      histogram: last,
      cross: crossOf(previous, last),
    };
  }

  return {
    macd: macdIndicator,
    ma50: movingAverage(closes, maShort),
    ma200: movingAverage(closes, maLong),
  };
}
