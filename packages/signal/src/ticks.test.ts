import { NoSignalReason, SignalKind, type Candle } from '@binarius/shared';
import { describe, expect, it } from 'vitest';
import { createSignalDecider } from './decide';
import { aggregateEndLabelled, createCandleBuilder, type CandleBuilder } from './ticks';

const I = 5_000;
const T0 = 1_760_000_000_000;

const builder = (fields: { intervalMs?: number; digits?: number; capacity?: number } = {}) =>
  createCandleBuilder({ intervalMs: I, digits: 5, capacity: 100, ...fields });

const feed = (b: CandleBuilder, ticks: [number, number][]) => {
  for (const [timestamp, price] of ticks) b.push({ timestamp, price });
};

const candle = (timestamp: number, open: number, high: number, low: number, close: number) => ({
  timestamp,
  open,
  high,
  low,
  close,
});

describe('createCandleBuilder', () => {
  it('T1 a tick belongs to the bucket floor(ts / I) x I', () => {
    const b = builder();
    feed(b, [
      [4_999, 1.1],
      [5_000, 1.2],
      [5_001, 1.3],
    ]);
    expect(b.candles().map((c) => c.timestamp)).toEqual([0, 5_000]);
    expect(b.candles()[1]).toEqual(candle(5_000, 1.1, 1.3, 1.1, 1.3));
  });

  it('T2 a new candle opens at the previous close, across an empty bucket too', () => {
    const b = builder();
    feed(b, [
      [T0 + 100, 1.2],
      [T0 + 4_000, 1.25],
      [T0 + 3 * I + 10, 1.3],
    ]);
    const [first, second] = b.candles();
    expect(first).toEqual(candle(T0, 1.2, 1.25, 1.2, 1.25));
    expect(second).toEqual(candle(T0 + 3 * I, 1.25, 1.3, 1.25, 1.3));
  });

  it('T3 high and low include the open', () => {
    const b = builder();
    feed(b, [
      [T0, 1.5],
      [T0 + I, 1.2],
      [T0 + I + 10, 1.3],
    ]);
    expect(b.candles()[1]).toEqual(candle(T0 + I, 1.5, 1.5, 1.2, 1.3));
  });

  it('T4 every price is rounded at digits', () => {
    const b = builder();
    feed(b, [
      [T0, 1.23456789],
      [T0 + I, 0.6946199999999999],
    ]);
    expect(b.candles()).toEqual([
      candle(T0, 1.23457, 1.23457, 1.23457, 1.23457),
      candle(T0 + I, 1.23457, 1.23457, 0.69462, 0.69462),
    ]);

    const integers = builder({ digits: 0 });
    feed(integers, [[T0, 101.6]]);
    expect(integers.candles()[0]?.close).toBe(102);
  });

  it('T5 a tick of an older bucket is late: dropped, counted, the candle unchanged', () => {
    const b = builder();
    feed(b, [
      [T0, 1.1],
      [T0 + I, 1.2],
      [T0 + I - 1, 9.9],
    ]);
    expect(b.late).toBe(1);
    expect(b.candles()).toEqual([
      candle(T0, 1.1, 1.1, 1.1, 1.1),
      candle(T0 + I, 1.1, 1.2, 1.1, 1.2),
    ]);
    expect(b.watermark).toBe(T0 + I);
  });

  it('T6 a bad price or timestamp is invalid: dropped and counted', () => {
    const b = builder();
    feed(b, [
      [T0, Number.NaN],
      [T0, 0],
      [T0, -1],
      [Number.NaN, 1.1],
      [Number.POSITIVE_INFINITY, 1.1],
      [T0, Number.POSITIVE_INFINITY],
    ]);
    expect(b.invalid).toBe(6);
    expect(b.candles()).toEqual([]);
    expect(b.watermark).toBeUndefined();
  });

  it('T7 capacity keeps the newest candles in order', () => {
    const b = builder({ capacity: 120 });
    for (let i = 0; i < 130; i++) b.push({ timestamp: T0 + i * I, price: 1 + i / 1000 });
    const kept = b.candles();
    expect(kept).toHaveLength(120);
    expect(kept[0]?.timestamp).toBe(T0 + 10 * I);
    expect(kept.at(-1)?.timestamp).toBe(T0 + 129 * I);
  });

  it('T8 markHole drops the overlapping candles only', () => {
    const b = builder();
    for (let i = 0; i < 6; i++) b.push({ timestamp: T0 + i * I, price: 1 + i / 100 });
    // [T0 + 2I, T0 + 4I]: the candle at T0 + I ends at the hole's start, the one at T0 + 4I starts
    // at its end; the candles at 2I and 3I overlap it
    b.markHole(T0 + 2 * I, T0 + 4 * I);
    expect(b.candles().map((c) => (c.timestamp - T0) / I)).toEqual([0, 1, 4, 5]);

    b.push({ timestamp: T0 + 6 * I, price: 1.5 });
    expect(b.candles().at(-1)?.open).toBe(1.05);
  });

  it('T10 60 buckets of ticks pass the decider checks', () => {
    const b = builder({ capacity: 200 });
    let price = 1.1;
    for (let i = 0; i < 60 * 5; i++) {
      price += ((i * 7919) % 13) - 6 > 0 ? 0.00007 : -0.00006;
      b.push({ timestamp: T0 + i * 1_000 + 300, price });
    }
    const candles: Candle[] = b.candles();
    expect(candles).toHaveLength(60);
    const decision = createSignalDecider().decide({
      candles,
      intervalMs: I,
      nowMs: T0 + 60 * I + 1,
      digits: 5,
    });
    expect(decision.kind === SignalKind.NoSignal && decision.reason).not.toBe(
      NoSignalReason.InvalidCandle,
    );
    expect('features' in decision).toBe(true);
  });

  it('T11 digits outside the decider bound are refused', () => {
    expect(() => builder({ digits: 11 })).toThrow(RangeError);
    expect(() => builder({ digits: 1.5 })).toThrow(RangeError);
    expect(() => builder({ capacity: 0 })).toThrow(RangeError);
  });
});

describe('aggregateEndLabelled', () => {
  it('T9 rows t+1..t+5 make the candle at t; an incomplete bucket is skipped', () => {
    const rows: Candle[] = [
      candle(T0 + 1_000, 1.0, 1.4, 0.9, 1.1),
      candle(T0 + 2_000, 1.1, 1.2, 1.0, 1.2),
      candle(T0 + 3_000, 1.2, 1.5, 1.1, 1.3),
      candle(T0 + 4_000, 1.3, 1.3, 0.8, 1.2),
      candle(T0 + 5_000, 1.2, 1.3, 1.1, 1.25),
      candle(T0 + 6_000, 1.25, 1.3, 1.2, 1.3),
      candle(T0 + 7_000, 1.3, 1.3, 1.2, 1.2),
    ];
    expect(aggregateEndLabelled(rows, 1_000, I)).toEqual([candle(T0, 1.0, 1.5, 0.8, 1.25)]);
  });

  it('refuses an interval that is not a multiple of the step', () => {
    expect(() => aggregateEndLabelled([], 1_000, 1_500)).toThrow(RangeError);
  });
});
