import {
  DISPLAY_INDICATOR_PARAMS,
  MACD_REQUIRED_CANDLES,
  type SignalIndicators,
} from '@binarius/shared';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SIGNAL_PARAMS } from './config';
import { createSignalDecider } from './decide';
import { displayIndicators } from './display';
import { closedNow, INTERVAL_MS, mildRise, seriesFrom } from './testing';

const show = (closes: readonly number[]): SignalIndicators | undefined => {
  const candles = seriesFrom(closes);
  return displayIndicators(candles, INTERVAL_MS, closedNow(candles), DEFAULT_SIGNAL_PARAMS);
};

const quadratic = (n: number, sign: 1 | -1) =>
  Array.from({ length: n }, (_, i) => 100 + sign * 0.01 * i * i);

const linear = (n: number, a: number, b: number) => Array.from({ length: n }, (_, i) => a + b * i);

// oracles written from the definitions here, not imported from indicators.ts
const naiveEma = (values: readonly number[], period: number): number[] => {
  const alpha = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  const out = [seed / period];
  for (let i = period; i < values.length; i++) {
    out.push(alpha * values[i] + (1 - alpha) * (out.at(-1) as number));
  }
  return out;
};

const naiveLastTwoHistogram = (closes: readonly number[]): [number, number] => {
  const { macdFast, macdSlow, macdSignal } = DISPLAY_INDICATOR_PARAMS;
  const fast = naiveEma(closes, macdFast).slice(macdSlow - macdFast);
  const line = naiveEma(closes, macdSlow).map((slow, j) => fast[j] - slow);
  const signal = naiveEma(line, macdSignal);
  const tail = line.slice(macdSignal - 1);
  return [tail.at(-2) as number, tail.at(-1) as number].map(
    (value, j) => value - (signal.at(j - 2) as number),
  ) as [number, number];
};

describe('displayIndicators', () => {
  it('D1 MACD needs 35 closed candles: 34 is short, 35 has a value', () => {
    expect(MACD_REQUIRED_CANDLES).toBe(35);
    expect(show(quadratic(34, 1))?.macd).toStrictEqual({
      ok: false,
      closedCandles: 34,
      required: 35,
    });
    expect(show(quadratic(35, 1))?.macd).toMatchObject({ ok: true });
  });

  // close_i = a + b*i: SMA_p at the last index is a + b*(last - (p - 1) / 2), and an EMA seeded by
  // the SMA lags by exactly (p - 1) / 2 too, so the MACD line is b*(12.5 - 5.5) = 7b, the signal
  // line the same constant and the histogram zero
  it('D2 on a linear series MA50 and MACD equal their closed forms', () => {
    const a = 100;
    const b = 0.01;
    const closes = linear(120, a, b);
    const indicators = show(closes);
    expect(indicators?.ma50).toMatchObject({ ok: true, lastClose: a + b * 119 });
    if (indicators?.ma50.ok !== true || indicators.macd.ok !== true) throw new Error('expected ok');
    expect(indicators.ma50.value).toBeCloseTo(a + b * (119 - 24.5), 9);
    expect(indicators.macd.macd).toBeCloseTo(7 * b, 9);
    expect(indicators.macd.signal).toBeCloseTo(7 * b, 9);
    expect(indicators.macd.histogram).toBeCloseTo(0, 9);
  });

  it.each([
    ['an accelerating fall then a jump', [...quadratic(60, -1), 100], 'up'],
    ['an accelerating rise then a drop', [...quadratic(60, 1), 100], 'down'],
    ['an accelerating rise', quadratic(60, 1), 'none'],
    ['an accelerating fall', quadratic(60, -1), 'none'],
    ['a flat run then a jump: zero then positive', [...Array<number>(60).fill(100), 101], 'none'],
  ] as const)('D3 %s crosses %s', (_, closes, cross) => {
    const [previous, last] = naiveLastTwoHistogram(closes);
    if (cross === 'up') expect([previous < 0, last > 0]).toStrictEqual([true, true]);
    if (cross === 'down') expect([previous > 0, last < 0]).toStrictEqual([true, true]);
    if (closes.at(-1) === 101) expect([previous, last > 0]).toStrictEqual([0, true]);
    const indicators = show(closes);
    expect(indicators?.macd).toMatchObject({ ok: true, cross });
    if (indicators?.macd.ok !== true) throw new Error('expected ok');
    expect(indicators.macd.histogram).toBeCloseTo(last, 9);
  });

  it('D4 MA200 with 117 closed candles is short 117 of 200; MA50 is the mean of the last 50', () => {
    const closes = linear(117, 100, 0.01);
    const indicators = show(closes);
    expect(indicators?.ma200).toStrictEqual({ ok: false, closedCandles: 117, required: 200 });
    expect(indicators?.ma50).toMatchObject({ ok: true, lastClose: 100 + 0.01 * 116 });
    if (indicators?.ma50.ok !== true) throw new Error('expected ok');
    expect(indicators.ma50.value).toBeCloseTo(100 + 0.01 * (116 - 24.5), 9);
  });

  it('D5 MA200 at 200 closed candles is the mean of all 200; 199 is short', () => {
    const closes = quadratic(200, 1);
    expect(show(closes)?.ma200).toStrictEqual({
      ok: true,
      value: closes.reduce((sum, close) => sum + close, 0) / 200,
      lastClose: closes.at(-1),
    });
    expect(show(closes.slice(1))?.ma200).toStrictEqual({
      ok: false,
      closedCandles: 199,
      required: 200,
    });
  });

  it('D6 the forming candle is not counted and lastClose is the decision features lastClose', () => {
    const candles = mildRise(60);
    const nowMs = closedNow(candles.slice(0, -1));
    const indicators = displayIndicators(candles, INTERVAL_MS, nowMs, DEFAULT_SIGNAL_PARAMS);
    const decision = createSignalDecider().decide({
      candles: candles.slice(-60),
      intervalMs: INTERVAL_MS,
      nowMs,
      digits: 2,
    });
    if (!('features' in decision)) throw new Error('expected features');
    expect(indicators?.ma50).toMatchObject({ ok: true, lastClose: decision.features.lastClose });
    expect(indicators?.ma50).toMatchObject({ lastClose: candles.at(-2)?.close });
  });

  it('D7 a broken last candle, a future candle or an empty response gives no indicators', () => {
    const nan = quadratic(80, 1);
    nan[79] = Number.NaN;
    expect(show(nan)).toBeUndefined();
    const candles = seriesFrom(quadratic(80, 1));
    const beforeLast = (candles.at(-1)?.timestamp as number) - 1;
    expect(
      displayIndicators(candles, INTERVAL_MS, beforeLast, DEFAULT_SIGNAL_PARAMS),
    ).toBeUndefined();
    expect(displayIndicators([], INTERVAL_MS, 0, DEFAULT_SIGNAL_PARAMS)).toBeUndefined();
  });

  // 300 closed candles with one row (or one broken price) taken out: the indicators read the rows
  // after it
  it.each([
    ['a gap at the start', 'gap', 1, { macd: true, ma50: true, ma200: true }],
    ['a gap in the middle', 'gap', 150, { macd: true, ma50: true, ma200: 149 }],
    ['a gap before the last closed candle', 'gap', 298, { macd: 1, ma50: 1, ma200: 1 }],
    ['a non-finite price in the middle', 'nan', 150, { macd: true, ma50: true, ma200: 149 }],
  ] as const)('D9 %s: the indicators read the unbroken tail', (_, kind, at, expected) => {
    const all = seriesFrom(linear(300, 100, 0.01));
    const candles =
      kind === 'gap'
        ? all.filter((__, i) => i !== at)
        : all.map((candle, i) => (i === at ? { ...candle, close: Number.NaN } : candle));
    const indicators = displayIndicators(
      candles,
      INTERVAL_MS,
      closedNow(all),
      DEFAULT_SIGNAL_PARAMS,
    );
    const required = { macd: 35, ma50: 50, ma200: 200 } as const;
    for (const key of ['macd', 'ma50', 'ma200'] as const) {
      const want = expected[key];
      expect(indicators?.[key]).toMatchObject(
        want === true ? { ok: true } : { ok: false, closedCandles: want, required: required[key] },
      );
    }
    if (indicators?.ma50.ok !== true) return;
    expect(indicators.ma50.value).toBeCloseTo(100 + 0.01 * (299 - 24.5), 9);
  });

  it('D8 one closed candle is short on all three, not refused', () => {
    expect(show([100])).toStrictEqual({
      macd: { ok: false, closedCandles: 1, required: 35 },
      ma50: { ok: false, closedCandles: 1, required: 50 },
      ma200: { ok: false, closedCandles: 1, required: 200 },
    });
  });
});
