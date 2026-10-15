import type { Candle } from '@binarius/shared';
import { describe, expect, it } from 'vitest';
import { atr, ema, macd, rsi, sma, trueRange } from './indicators';

const bar = (high: number, low: number, close: number): Candle => ({
  timestamp: 0,
  open: close,
  high,
  low,
  close,
});

describe('indicators', () => {
  it('I1 ema([1, 2, 3, 4, 5], 3) = [2, 3, 4] (SMA seed, multiplier 2 / (p + 1))', () => {
    expect(ema([1, 2, 3, 4, 5], 3)).toEqual([2, 3, 4]);
  });

  it('I2 rsi([1, 3, 2, 4, 3], 2) = [200/3, 600/7, 600/11] (Wilder smoothing)', () => {
    const values = rsi([1, 3, 2, 4, 3], 2);
    expect(values).toHaveLength(3);
    expect(values[0]).toBeCloseTo(200 / 3, 10);
    expect(values[1]).toBeCloseTo(600 / 7, 10);
    expect(values[2]).toBeCloseTo(600 / 11, 10);
  });

  it('I3 atr over true ranges [2, 4, 6] with period 2 = [3, 4.5]', () => {
    const candles = [bar(10, 10, 10), bar(11, 9, 10), bar(12, 8, 10), bar(13, 7, 10)];
    expect(atr(candles, 2)).toEqual([3, 4.5]);
  });

  it('I4 trueRange takes each of its three terms: inside bar 2, gap up 7, gap down 10', () => {
    expect(trueRange(bar(11, 9, 10), 10)).toBe(2);
    expect(trueRange(bar(15, 13, 14), 8)).toBe(7);
    expect(trueRange(bar(5, 3, 4), 13)).toBe(10);
  });

  it('I5 a flat series gives RSI 50 and ATR 0; a rising one RSI 100, a falling one RSI 0', () => {
    const flat = Array.from({ length: 20 }, () => bar(100, 100, 100));
    const closes = flat.map((c) => c.close);
    expect(rsi(closes, 14).every((v) => v === 50)).toBe(true);
    expect(atr(flat, 14).every((v) => v === 0)).toBe(true);
    expect(rsi([1, 2, 3, 4, 5], 2)).toEqual([100, 100, 100]);
    expect(rsi([5, 4, 3, 2, 1], 2)).toEqual([0, 0, 0]);
  });

  it('I6 ema on a series shorter than the seed throws RangeError', () => {
    expect(() => ema([1, 2], 3)).toThrow(RangeError);
  });

  it('I7 rsi on a series shorter than the seed throws RangeError', () => {
    expect(() => rsi([1, 2, 3], 3)).toThrow(RangeError);
  });

  it('I8 atr on a series shorter than the seed throws RangeError', () => {
    expect(() => atr([bar(2, 1, 1), bar(2, 1, 1), bar(2, 1, 1)], 3)).toThrow(RangeError);
  });

  it('I9 sma([1, 2, 4, 8, 16], 3) = [7/3, 14/3, 28/3]', () => {
    const values = sma([1, 2, 4, 8, 16], 3);
    expect(values).toHaveLength(3);
    expect(values[0]).toBeCloseTo(7 / 3, 10);
    expect(values[1]).toBeCloseTo(14 / 3, 10);
    expect(values[2]).toBeCloseTo(28 / 3, 10);
  });

  // ema2 = [3/2, 19/6, 115/18, 691/54, 4147/162], ema3 = [7/3, 31/6, 127/12, 511/24];
  // line = [5/6, 11/9, 239/108, 2791/648]; signal = ema2(line) = [37/36, 589/324, 845/243]
  it('I10 macd([1, 2, 4, 8, 16, 32], 2, 3, 2) by hand', () => {
    const { macd: line, signal, histogram } = macd([1, 2, 4, 8, 16, 32], 2, 3, 2);
    const expected = {
      line: [11 / 9, 239 / 108, 2791 / 648],
      signal: [37 / 36, 589 / 324, 845 / 243],
    };
    expect(line).toHaveLength(3);
    expect(signal).toHaveLength(3);
    expect(histogram).toHaveLength(3);
    expected.line.forEach((value, j) => {
      expect(line[j]).toBeCloseTo(value, 10);
      expect(signal[j]).toBeCloseTo(expected.signal[j], 10);
      expect(histogram[j]).toBeCloseTo(value - expected.signal[j], 10);
    });
  });

  it('I11 sma and macd shorter than the seed throw RangeError, as does fast >= slow', () => {
    expect(() => sma([1, 2], 3)).toThrow(RangeError);
    expect(() => macd([1, 2, 4], 2, 3, 2)).toThrow(RangeError);
    expect(() => macd([1, 2, 4, 8], 2, 3, 2)).not.toThrow();
    expect(() => macd([1, 2, 4, 8, 16, 32], 3, 3, 2)).toThrow(RangeError);
  });
});
