import { TradeAction, type Candle } from '@binarius/shared';
import { PRICE_STEP_MS } from './config';

export type PriceAt = (ms: number) => number | undefined;

// the close of the 1s row labelled floor(ms / 1000) x 1000; a missing row is no price, never the
// nearest one
export function priceIndex(series: readonly Candle[]): PriceAt {
  const first = series[0]?.timestamp;
  if (first === undefined) return () => undefined;
  const last = series[series.length - 1].timestamp;
  const closes = new Float64Array((last - first) / PRICE_STEP_MS + 1).fill(NaN);
  for (const candle of series) {
    if (candle.timestamp % PRICE_STEP_MS === 0) {
      closes[(candle.timestamp - first) / PRICE_STEP_MS] = candle.close;
    }
  }
  return (ms) => {
    const index = (Math.floor(ms / PRICE_STEP_MS) * PRICE_STEP_MS - first) / PRICE_STEP_MS;
    const close = index >= 0 && index < closes.length ? closes[index] : NaN;
    return Number.isNaN(close) ? undefined : close;
  };
}

// the first source that has the row
export const firstPrice =
  (...sources: readonly PriceAt[]): PriceAt =>
  (ms) => {
    for (const source of sources) {
      const price = source(ms);
      if (price !== undefined) return price;
    }
    return undefined;
  };

export type Outcome = 'win' | 'loss' | 'tie';

// a tie returns the stake: neither a win nor a loss
export function outcomeOf(action: TradeAction, entry: number, exit: number): Outcome {
  if (exit === entry) return 'tie';
  return exit > entry === (action === TradeAction.Up) ? 'win' : 'loss';
}
