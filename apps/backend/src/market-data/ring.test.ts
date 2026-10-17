import { SIGNAL_SCAN_INTERVALS, type Candle } from '@binarius/shared';
import { chartWindow } from '@binarius/signal';
import { describe, expect, it } from 'vitest';
import { createCandleRing, type CandleRing } from './ring';

// a 15 s boundary, so every 5 s and 15 s bucket below starts at T0 + a multiple of its interval
const T0 = 1_800_000_000_000;
const MARGIN = 2_000;
const EURUSD = 7;
const AAPL = 11;
const DIGITS = 5;

const makeRing = (capacity = 300) =>
  createCandleRing({ capacity, skewMarginMs: MARGIN, intervals: SIGNAL_SCAN_INTERVALS });

// a tick received 50 ms after its time unless the test says otherwise
function push(ring: CandleRing, assetId: number, at: number, price = 1.1, receivedAt = at + 50) {
  ring.push(assetId, DIGITS, { price, timestamp: at }, receivedAt);
}

const times = (candles: readonly Candle[]) => candles.map((candle) => candle.timestamp - T0);

describe('the candle ring (#404)', () => {
  it('R1 builds the candles of both intervals of a pair from its ticks', () => {
    const ring = makeRing();
    push(ring, EURUSD, T0 + 1_000, 1.1);
    push(ring, EURUSD, T0 + 6_000, 1.2);
    push(ring, EURUSD, T0 + 16_000, 1.3);
    const now = T0 + 16_050;

    const five = ring.read(EURUSD, '5s', now);
    expect(five.candles).toEqual([
      { timestamp: T0, open: 1.1, high: 1.1, low: 1.1, close: 1.1 },
      { timestamp: T0 + 5_000, open: 1.1, high: 1.2, low: 1.1, close: 1.2 },
    ]);
    expect(five.gaps.map((gap) => gap - T0)).toContain(10_000);
    expect(five.forming).toEqual({
      timestamp: T0 + 15_000,
      open: 1.2,
      high: 1.3,
      low: 1.2,
      close: 1.3,
    });

    const fifteen = ring.read(EURUSD, '15s', now);
    expect(fifteen.candles).toEqual([
      { timestamp: T0, open: 1.1, high: 1.2, low: 1.1, close: 1.2 },
    ]);
    expect(fifteen.forming?.timestamp).toBe(T0 + 15_000);
    expect(ring.counters().pairs).toBe(1);
  });

  it('R2 closes a bucket once the watermark of any pair reaches its end, before the clock does', () => {
    const ring = makeRing();
    push(ring, EURUSD, T0 + 4_000);
    // the process clock alone would leave the bucket open until T0 + 7 000
    expect(ring.read(EURUSD, '5s', T0 + 4_100).forming?.timestamp).toBe(T0);
    push(ring, AAPL, T0 + 5_000);
    const window = ring.read(EURUSD, '5s', T0 + 5_050);
    expect(times(window.candles)).toEqual([0]);
    expect(window.forming).toBeUndefined();
    expect(window.closedUntil).toBe(T0 + 5_000);
  });

  it('R3 closes a bucket by the process clock margin past its end when no tick moves the watermark', () => {
    const ring = makeRing();
    push(ring, EURUSD, T0 + 1_000);
    expect(ring.read(EURUSD, '5s', T0 + 6_999).forming?.timestamp).toBe(T0);
    const window = ring.read(EURUSD, '5s', T0 + 7_000);
    expect(times(window.candles)).toEqual([0]);
    expect(window.forming).toBeUndefined();
  });

  it('R3b counts a tick that changed a bucket the clock had closed, and not a forming or late one', () => {
    const ring = makeRing();
    push(ring, EURUSD, T0 + 1_000, 1.1);
    expect(ring.closedUntil('5s', T0 + 7_000)).toBe(T0 + 5_000);
    push(ring, EURUSD, T0 + 2_000, 1.5, T0 + 7_000);
    expect(ring.read(EURUSD, '5s', T0 + 7_000).candles[0]?.high).toBe(1.5);
    expect(ring.counters().lateClose).toEqual({ watermark: 0, clock: 1 });
    expect(ring.counters().late).toBe(0);

    push(ring, EURUSD, T0 + 7_500, 1.2, T0 + 7_600);
    expect(ring.counters().lateClose).toEqual({ watermark: 0, clock: 1 });
    // bucket T0 is behind the 5s builder's current one now: refused as late, nothing changed
    push(ring, EURUSD, T0 + 3_000, 1.9, T0 + 7_700);
    expect(ring.counters().lateClose).toEqual({ watermark: 0, clock: 1 });
    expect(ring.counters().late).toBe(1);
  });

  it('R3c counts a tick that changed a bucket the watermark of another pair had closed', () => {
    const ring = makeRing();
    push(ring, EURUSD, T0 + 5_010);
    push(ring, AAPL, T0 + 4_950, 1.1, T0 + 5_060);
    expect(ring.counters().lateClose).toEqual({ watermark: 1, clock: 0 });
  });

  it('R4 takes the later of the two rules', () => {
    const ring = makeRing();
    expect(ring.closedUntil('5s', T0 + 12_000)).toBe(T0 + 10_000);
    push(ring, EURUSD, T0 + 21_000, 1.1, T0 + 12_000);
    expect(ring.closedUntil('5s', T0 + 12_000)).toBe(T0 + 20_000);
    expect(ring.closedUntil('15s', T0 + 12_000)).toBe(T0 + 15_000);
    expect(ring.closedUntil('5s', T0 + 40_000)).toBe(T0 + 35_000);
  });

  it('R5 reads the window of a feed fetch of the capacity, nothing older', () => {
    const ring = makeRing();
    push(ring, EURUSD, T0 + 100);
    push(ring, EURUSD, T0 + 10_100);
    push(ring, EURUSD, T0 + 15_100);
    const now = T0 + 301 * 5_000 + 2_100;
    const window = ring.read(EURUSD, '5s', now);
    expect(window.startTime).toBe(chartWindow(now, 5_000, 300).startTime);
    expect(window.startTime).toBe(T0 + 10_000);
    expect(times(window.candles)).toEqual([10_000, 15_000]);
  });

  it('R6 lists the empty closed buckets of the window as gaps, all of them for an unknown pair', () => {
    const ring = makeRing();
    const now = T0 + 10_000;
    const empty = ring.read(EURUSD, '5s', now);
    expect(empty.candles).toEqual([]);
    expect(empty.forming).toBeUndefined();
    expect(empty.closedUntil).toBe(T0 + 5_000);
    expect(empty.gaps).toHaveLength((empty.closedUntil - empty.startTime) / 5_000);
    expect(empty.gaps[0]).toBe(empty.startTime);
    expect(empty.gaps.at(-1)).toBe(T0);

    push(ring, EURUSD, T0 + 100);
    expect(ring.read(EURUSD, '5s', now).gaps).toHaveLength(empty.gaps.length - 1);
  });

  it('R7 marks a hole from the pair watermark at the drop to its first tick after, on both intervals', () => {
    const ring = makeRing();
    push(ring, EURUSD, T0 + 1_000, 1.1);
    push(ring, EURUSD, T0 + 6_000, 1.2);
    push(ring, EURUSD, T0 + 11_000, 1.3);
    ring.onDrop();
    expect(ring.counters().holes).toBe(0);
    push(ring, EURUSD, T0 + 21_000, 1.4);
    expect(ring.counters().holes).toBe(1);

    const now = T0 + 31_000;
    expect(times(ring.read(EURUSD, '5s', now).candles)).toEqual([0, 5_000]);
    // the 15 s candle at T0 reaches T0 + 11 000: dropped too
    expect(ring.read(EURUSD, '15s', now).candles).toEqual([]);
    // the bucket of the first tick after the drop is reached as well
    expect(ring.counters().holed).toBe(2);

    push(ring, EURUSD, T0 + 26_000, 1.5);
    expect(ring.read(EURUSD, '5s', T0 + 33_000).candles.at(-1)).toEqual({
      timestamp: T0 + 25_000,
      open: 1.4,
      high: 1.5,
      low: 1.4,
      close: 1.5,
    });
  });

  it('R7b gives a pair first heard after a drop a hole of its first bucket', () => {
    const ring = makeRing();
    push(ring, AAPL, T0 + 100);
    ring.onDrop();
    push(ring, EURUSD, T0 + 1_000, 1.1);
    expect(ring.counters().holes).toBe(1);
    push(ring, EURUSD, T0 + 6_000, 1.2);
    expect(times(ring.read(EURUSD, '5s', T0 + 13_000).candles)).toEqual([5_000]);
  });

  it('R7c makes one hole of two drops before the pair ticks again', () => {
    const ring = makeRing();
    push(ring, EURUSD, T0 + 1_000);
    ring.onDrop();
    ring.onDrop();
    push(ring, EURUSD, T0 + 21_000);
    push(ring, EURUSD, T0 + 26_000);
    expect(ring.counters().holes).toBe(1);
  });

  it('R7d leaves the hole open for a repeated tick not past the pair watermark', () => {
    const ring = makeRing();
    push(ring, EURUSD, T0 + 1_000);
    push(ring, EURUSD, T0 + 6_000);
    ring.onDrop();
    push(ring, EURUSD, T0 + 6_000);
    expect(ring.counters().holes).toBe(0);
    push(ring, EURUSD, T0 + 21_000);
    expect(ring.counters().holes).toBe(1);
    expect(times(ring.read(EURUSD, '5s', T0 + 31_000).candles)).toEqual([0]);
  });

  it('R8 fills only empty closed buckets of the window and never replaces a tick candle', () => {
    const ring = makeRing();
    push(ring, EURUSD, T0 + 1_000, 1.1);
    push(ring, EURUSD, T0 + 26_000, 1.2);
    const now = T0 + 26_100;
    const row = (at: number, close: number): Candle => ({
      timestamp: T0 + at,
      open: close,
      high: close,
      low: close,
      close,
    });
    const result = ring.fill(
      EURUSD,
      '5s',
      [row(0, 9), row(5_000, 2), row(25_000, 9), row(7_000, 9), row(5_000, 9)],
      now,
    );
    expect(result).toEqual({ filled: 1, skipped: 4 });
    const window = ring.read(EURUSD, '5s', now);
    expect(window.candles).toEqual([
      { timestamp: T0, open: 1.1, high: 1.1, low: 1.1, close: 1.1 },
      row(5_000, 2),
    ]);
    expect(window.forming?.close).toBe(1.2);
    expect(ring.read(EURUSD, '15s', now).candles.map((candle) => candle.close)).toEqual([1.1]);
  });

  it('R9 counts the missing buckets before and after a fill', () => {
    const ring = makeRing();
    const now = T0 + 20_000;
    const before = ring.missing(EURUSD, '15s', now);
    expect(before).toBe(ring.read(EURUSD, '15s', now).gaps.length);
    ring.fill(EURUSD, '15s', [{ timestamp: T0, open: 1, high: 1, low: 1, close: 1 }], now);
    expect(ring.missing(EURUSD, '15s', now)).toBe(before - 1);
  });

  it('R12 keeps the capacity of candles per builder, the oldest going first', () => {
    const ring = makeRing();
    for (let k = 0; k <= 300; k += 1) push(ring, EURUSD, T0 + k * 5_000 + 100);
    expect(ring.closedBetween('5s', -Infinity, Infinity)).toBe(300);
    const small = makeRing(3);
    for (let k = 0; k < 4; k += 1) push(small, EURUSD, T0 + k * 5_000 + 100);
    expect(small.closedBetween('5s', -Infinity, Infinity)).toBe(3);
    expect(small.closedBetween('5s', -Infinity, T0 + 5_000)).toBe(0);
  });
});
