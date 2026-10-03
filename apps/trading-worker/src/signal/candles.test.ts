import type { Candle } from '@binarius/shared';
import { describe, expect, it } from 'vitest';
import { prepareCandles, type PreparedCandles } from './candles';
import { DEFAULT_SIGNAL_PARAMS } from './config';
import { closedNow, INTERVAL_MS, trending } from './testing';

const I = INTERVAL_MS;
const prepare = (candles: readonly Candle[], nowMs: number, intervalMs = I): PreparedCandles =>
  prepareCandles(candles, intervalMs, nowMs, DEFAULT_SIGNAL_PARAMS);

const shiftFrom = (series: Candle[], from: number, byMs: number): Candle[] =>
  series.map((c, i) => (i >= from ? { ...c, timestamp: c.timestamp + byMs } : c));

const invalid = (index: number, problem: string) => ({
  ok: false,
  refusal: { reason: 'invalid_candle', detail: { index, problem } },
});

describe('prepareCandles', () => {
  it('C1 a non-finite price is non_finite at its index', () => {
    const series = trending(60, 0.5);
    series[5] = { ...series[5], close: NaN };
    expect(prepare(series, closedNow(series))).toEqual(invalid(5, 'non_finite'));
  });

  it('C2 a zero or negative-zero price is non_positive at its index', () => {
    for (const low of [0, -0]) {
      const series = trending(60, 0.5);
      series[5] = { ...series[5], low };
      expect(prepare(series, closedNow(series))).toEqual(invalid(5, 'non_positive'));
    }
  });

  it('C3 high below min(open, close) is ohlc_order', () => {
    const series = trending(60, 0.5);
    series[5] = { ...series[5], high: Math.min(series[5].open, series[5].close) - 0.01 };
    expect(prepare(series, closedNow(series))).toEqual(invalid(5, 'ohlc_order'));
  });

  it('C4 a duplicate timestamp is not_ascending at it; a reversed series at index 1', () => {
    const duplicate = trending(60, 0.5);
    duplicate[5] = { ...duplicate[5], timestamp: duplicate[4].timestamp };
    expect(prepare(duplicate, closedNow(duplicate))).toEqual(invalid(5, 'not_ascending'));

    const reversed = trending(60, 0.5).reverse();
    expect(prepare(reversed, closedNow(trending(60, 0.5)))).toEqual(invalid(1, 'not_ascending'));
  });

  it('C5 a step of 1.5 intervals is step_mismatch', () => {
    const series = shiftFrom(trending(60, 0.5), 5, I / 2);
    expect(prepare(series, closedNow(series))).toEqual(invalid(5, 'step_mismatch'));
  });

  it('C6 one or two missing candles are candle_gap naming the first missing start', () => {
    for (const missing of [1, 2]) {
      const series = shiftFrom(trending(60, 0.5), 5, missing * I);
      const t4 = series[4].timestamp;
      expect(prepare(series, closedNow(series))).toEqual({
        ok: false,
        refusal: {
          reason: 'candle_gap',
          detail: { index: 5, expectedTimestamp: t4 + I, actualTimestamp: t4 + (missing + 1) * I },
        },
      });
    }
  });

  it('C7 a forming last candle (timestamp <= nowMs < timestamp + intervalMs) is dropped and not counted', () => {
    const series = trending(61, 0.5);
    const forming = series[60].timestamp;
    for (const nowMs of [forming, forming + I - 1]) {
      const result = prepare(series, nowMs);
      expect(result.ok && result.closed.length).toBe(60);
      expect(result.ok && result.closed.at(-1)).toBe(series[59]);
    }

    const fifty = trending(50, 0.5);
    expect(prepare(fifty, fifty[49].timestamp + 1)).toEqual({
      ok: false,
      refusal: { reason: 'insufficient_candles', detail: { closedCandles: 49, required: 50 } },
    });
  });

  it('C8 a candle with timestamp + intervalMs === nowMs is closed and kept', () => {
    const series = trending(60, 0.5);
    const result = prepare(series, series[59].timestamp + I);
    expect(result.ok && result.closed.length).toBe(60);
  });

  it('C9 the first candle that starts after nowMs is in_future at its index', () => {
    const formingPlusOne = trending(61, 0.5);
    expect(prepare(formingPlusOne, formingPlusOne[59].timestamp + I - 1)).toEqual(
      invalid(60, 'in_future'),
    );

    const formingPlusTwo = trending(62, 0.5);
    expect(prepare(formingPlusTwo, formingPlusTwo[59].timestamp + I - 1)).toEqual(
      invalid(60, 'in_future'),
    );

    const one = trending(1, 0.5);
    expect(prepare(one, one[0].timestamp - 1)).toEqual(invalid(0, 'in_future'));

    const three = trending(3, 0.5);
    expect(prepare(three, three[0].timestamp - 1)).toEqual(invalid(0, 'in_future'));
  });

  it('C10 an age equal to maxStaleIntervals × intervalMs is not stale', () => {
    const series = trending(60, 0.5);
    const maxAgeMs = DEFAULT_SIGNAL_PARAMS.maxStaleIntervals * I;
    expect(prepare(series, series[59].timestamp + I + maxAgeMs).ok).toBe(true);
  });

  it('C11 an age one millisecond over the maximum is stale', () => {
    const series = trending(60, 0.5);
    const maxAgeMs = DEFAULT_SIGNAL_PARAMS.maxStaleIntervals * I;
    expect(prepare(series, series[59].timestamp + I + maxAgeMs + 1)).toEqual({
      ok: false,
      refusal: {
        reason: 'stale',
        detail: { lastCandleTimestamp: series[59].timestamp, ageMs: maxAgeMs + 1, maxAgeMs },
      },
    });
  });

  it('C12 exactly minClosedCandles closed candles pass; one fewer is insufficient_candles', () => {
    const fifty = trending(50, 0.5);
    expect(prepare(fifty, closedNow(fifty)).ok).toBe(true);

    const fortyNine = trending(49, 0.5);
    expect(prepare(fortyNine, closedNow(fortyNine))).toEqual({
      ok: false,
      refusal: { reason: 'insufficient_candles', detail: { closedCandles: 49, required: 50 } },
    });
  });

  it('C13 an empty series is insufficient_candles with 0 closed', () => {
    expect(prepare([], 1_000)).toEqual({
      ok: false,
      refusal: { reason: 'insufficient_candles', detail: { closedCandles: 0, required: 50 } },
    });
  });

  it('C14 intervalMs 0, -1 and 1.5 throw RangeError', () => {
    const series = trending(60, 0.5);
    for (const intervalMs of [0, -1, 1.5]) {
      expect(() => prepare(series, closedNow(series), intervalMs)).toThrow(RangeError);
    }
  });

  it('C15 nowMs NaN and -1 throw RangeError', () => {
    const series = trending(60, 0.5);
    for (const nowMs of [NaN, -1]) {
      expect(() => prepare(series, nowMs)).toThrow(RangeError);
    }
  });
});
