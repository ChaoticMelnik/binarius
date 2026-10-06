import type { Candle } from '@binarius/shared';

// Every series is aligned to the end of its input:
//   ema(values, p)[j]  belongs to values[p - 1 + j]
//   rsi(closes, p)[j]  belongs to closes[p + j]
//   atr(candles, p)[j] belongs to candles[p + j]
// A series shorter than the seed is a programmer error: the decider checks the count first.

function assertSeed(name: string, period: number, length: number, required: number): void {
  if (!Number.isInteger(period) || period < 2) {
    throw new RangeError(`${name}: period must be an integer >= 2, got ${period}`);
  }
  if (length < required) {
    throw new RangeError(`${name}: needs at least ${required} values, got ${length}`);
  }
}

function mean(values: readonly number[]): number {
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

const wilder = (previous: number, current: number, period: number): number =>
  (previous * (period - 1) + current) / period;

export function ema(values: readonly number[], period: number): number[] {
  assertSeed('ema', period, values.length, period);
  const k = 2 / (period + 1);
  const out = [mean(values.slice(0, period))];
  for (let i = period; i < values.length; i++) {
    const previous = out[out.length - 1];
    out.push(previous + k * (values[i] - previous));
  }
  return out;
}

function rsiFrom(avgGain: number, avgLoss: number): number {
  // 0/0 is NaN; a loss of 0 alone already gives 100 (g/0 = Infinity) and a gain of 0 gives 0
  if (avgGain === 0 && avgLoss === 0) return 50;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

export function rsi(closes: readonly number[], period: number): number[] {
  assertSeed('rsi', period, closes.length, period + 1);
  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    gains.push(Math.max(change, 0));
    losses.push(Math.max(-change, 0));
  }
  let avgGain = mean(gains.slice(0, period));
  let avgLoss = mean(losses.slice(0, period));
  const out = [rsiFrom(avgGain, avgLoss)];
  for (let i = period; i < gains.length; i++) {
    avgGain = wilder(avgGain, gains[i], period);
    avgLoss = wilder(avgLoss, losses[i], period);
    out.push(rsiFrom(avgGain, avgLoss));
  }
  return out;
}

export function trueRange(candle: Candle, previousClose: number): number {
  return Math.max(
    candle.high - candle.low,
    Math.abs(candle.high - previousClose),
    Math.abs(candle.low - previousClose),
  );
}

export function atr(candles: readonly Candle[], period: number): number[] {
  assertSeed('atr', period, candles.length, period + 1);
  const ranges: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    ranges.push(trueRange(candles[i], candles[i - 1].close));
  }
  let average = mean(ranges.slice(0, period));
  const out = [average];
  for (let i = period; i < ranges.length; i++) {
    average = wilder(average, ranges[i], period);
    out.push(average);
  }
  return out;
}
