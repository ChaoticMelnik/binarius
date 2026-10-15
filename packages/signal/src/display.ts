import {
  DISPLAY_INDICATOR_PARAMS,
  MACD_REQUIRED_CANDLES,
  MacdCross,
  type Candle,
  type SignalIndicators,
  type SignalParams,
} from '@binarius/shared';
import { candleProblem, prepareCandles } from './candles';
import { macd, sma } from './indicators';

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

// the rows after the response's last break: a step other than intervalMs or a candle that fails
// the per-candle checks; one early gap must not cost all three indicators
function unbrokenTail(candles: readonly Candle[], intervalMs: number): readonly Candle[] {
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candleProblem(candles[i]) !== undefined) return candles.slice(i + 1);
    if (i > 0 && candles[i].timestamp - candles[i - 1].timestamp !== intervalMs) {
      return candles.slice(i);
    }
  }
  return candles;
}

// The unbroken tail passes the decider's own candle checks with a floor of one closed candle (the
// forming candle, the future, staleness); a tail that does not pass gives no indicators. Each
// indicator then refuses on the tail's count.
export function displayIndicators(
  candles: readonly Candle[],
  intervalMs: number,
  nowMs: number,
  params: SignalParams,
): SignalIndicators | undefined {
  const prepared = prepareCandles(unbrokenTail(candles, intervalMs), intervalMs, nowMs, {
    ...params,
    minClosedCandles: 1,
  });
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
