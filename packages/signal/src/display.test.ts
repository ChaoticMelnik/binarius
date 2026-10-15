import { DISPLAY_INDICATOR_PARAMS, type SignalIndicators } from '@binarius/shared';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SIGNAL_PARAMS } from './config';
import { createSignalDecider } from './decide';
import { displayIndicators, MACD_REQUIRED_CANDLES } from './display';
import { macd, sma } from './indicators';
import { closedNow, INTERVAL_MS, mildRise, seriesFrom } from './testing';

const show = (closes: readonly number[]): SignalIndicators | undefined => {
  const candles = seriesFrom(closes);
  return displayIndicators(candles, INTERVAL_MS, closedNow(candles), DEFAULT_SIGNAL_PARAMS);
};

const quadratic = (n: number, sign: 1 | -1) =>
  Array.from({ length: n }, (_, i) => 100 + sign * 0.01 * i * i);

// the precondition of each cross case, read from the MACD series itself
const lastTwo = (closes: readonly number[]) => {
  const { macdFast, macdSlow, macdSignal } = DISPLAY_INDICATOR_PARAMS;
  return macd(closes, macdFast, macdSlow, macdSignal).histogram.slice(-2) as [number, number];
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

  it('D2 an accelerating fall then a jump crosses up; the mirror crosses down', () => {
    const up = [...quadratic(60, -1), 100];
    const [upPrevious, upLast] = lastTwo(up);
    expect(upPrevious).toBeLessThan(0);
    expect(upLast).toBeGreaterThan(0);
    expect(show(up)?.macd).toMatchObject({ ok: true, cross: 'up', histogram: upLast });

    const down = [...quadratic(60, 1), 100];
    const [downPrevious, downLast] = lastTwo(down);
    expect(downPrevious).toBeGreaterThan(0);
    expect(downLast).toBeLessThan(0);
    expect(show(down)?.macd).toMatchObject({ ok: true, cross: 'down', histogram: downLast });
  });

  it('D3 two points on one side are no cross', () => {
    const rising = quadratic(60, 1);
    const [previous, last] = lastTwo(rising);
    expect(previous).toBeGreaterThan(0);
    expect(last).toBeGreaterThan(0);
    expect(show(rising)?.macd).toMatchObject({ ok: true, cross: 'none' });
    expect(show(quadratic(60, -1))?.macd).toMatchObject({ ok: true, cross: 'none' });
  });

  it('D4 MA200 with 117 closed candles is short 117 of 200; MA50 is the SMA of the last 50', () => {
    const closes = quadratic(117, 1);
    const indicators = show(closes);
    expect(indicators?.ma200).toStrictEqual({ ok: false, closedCandles: 117, required: 200 });
    expect(indicators?.ma50).toStrictEqual({
      ok: true,
      value: sma(closes.slice(-50), 50)[0],
      lastClose: closes.at(-1),
    });
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

  it('D7 a gap, a non-finite price or an empty response gives no indicators', () => {
    const gap = seriesFrom(quadratic(80, 1)).filter((_, i) => i !== 5);
    expect(
      displayIndicators(gap, INTERVAL_MS, closedNow(gap), DEFAULT_SIGNAL_PARAMS),
    ).toBeUndefined();
    const nan = quadratic(80, 1);
    nan[3] = Number.NaN;
    expect(show(nan)).toBeUndefined();
    expect(displayIndicators([], INTERVAL_MS, 0, DEFAULT_SIGNAL_PARAMS)).toBeUndefined();
  });

  it('D8 one closed candle is short on all three, not refused', () => {
    expect(show([100])).toStrictEqual({
      macd: { ok: false, closedCandles: 1, required: 35 },
      ma50: { ok: false, closedCandles: 1, required: 50 },
      ma200: { ok: false, closedCandles: 1, required: 200 },
    });
  });
});
