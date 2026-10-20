import { describe, expect, it } from 'vitest';
import { createSecondSeries, secondOf, type ClosedSecond } from './seconds';

// The second series of the H1 shadow (#669, docs/h1.md -> The second series). T is a second's end
// label; a tick at T + 300 belongs to the second T + 1000.
const T = 1_760_000_000_000;
const A = 101;
const B = 202;
const MARGIN = 500;

function series(capacitySec = 320) {
  const s = createSecondSeries({ capacitySec, closeMarginMs: MARGIN });
  const events: ClosedSecond[] = [];
  s.onClosed((closed) => events.push(closed));
  // receipt 40 ms after the broker's time unless given
  const tick = (assetId: number, timestamp: number, price: number, receivedAtMs = timestamp + 40) =>
    s.push(assetId, 5, { price, timestamp }, receivedAtMs);
  return { s, events, tick };
}

const seconds = (events: readonly ClosedSecond[]) => events.map((event) => event.second);

describe('the second series (#669)', () => {
  it('H-W1: the first tick opens the series and closes nothing', () => {
    const { s, events, tick } = series();
    tick(A, T + 300, 1.1);
    expect(events).toEqual([]);
    expect(s.close(A, T + 1_000)).toBeNaN();
    expect(s.counters()).toMatchObject({ pairs: 1, closedByTick: 0, closedByClock: 0 });
  });

  it('H-W2: a tick of the next second closes the previous one with the last tick at or before it', () => {
    const { s, events, tick } = series();
    tick(A, T + 100, 1.1);
    tick(A, T + 700, 1.2, T + 760);
    tick(A, T + 1_200, 1.3, T + 1_270);
    expect(events).toEqual([
      { assetId: A, second: T + 1_000, closedBy: 'tick', closedAtMs: T + 1_270 },
    ]);
    expect(s.close(A, T + 1_000)).toBe(1.2);
    expect(s.lastTickOf(A, T + 1_000)).toEqual({
      price: 1.2,
      timestamp: T + 700,
      receivedAtMs: T + 760,
    });
  });

  it('H-W3: a quiet gap carries the last price over every second it closes', () => {
    const { s, events, tick } = series();
    tick(A, T + 500, 1.1, T + 540);
    tick(A, T + 3_500, 1.4);
    expect(seconds(events)).toEqual([T + 1_000, T + 2_000, T + 3_000]);
    for (const second of [T + 1_000, T + 2_000, T + 3_000]) {
      expect(s.close(A, second)).toBe(1.1);
      expect(s.lastTickOf(A, second)).toEqual({
        price: 1.1,
        timestamp: T + 500,
        receivedAtMs: T + 540,
      });
    }
  });

  it('H-W4: a tick on a boundary is in its own second, closed by the next tick past it', () => {
    const { s, events, tick } = series();
    expect(secondOf(T + 1_000)).toBe(T + 1_000);
    tick(A, T + 500, 1.1);
    tick(A, T + 1_000, 1.2);
    expect(events).toEqual([]);
    tick(A, T + 1_001, 1.3);
    expect(seconds(events)).toEqual([T + 1_000]);
    expect(s.close(A, T + 1_000)).toBe(1.2);
  });

  it('H-W5: the clock closes a second margin after its end, several in one pass in order', () => {
    const { s, events, tick } = series();
    tick(A, T + 500, 1.1);
    s.advance(T + 1_000 + MARGIN - 1);
    expect(events).toEqual([]);
    s.advance(T + 1_000 + MARGIN);
    expect(events).toEqual([
      { assetId: A, second: T + 1_000, closedBy: 'clock', closedAtMs: T + 1_000 + MARGIN },
    ]);
    s.advance(T + 4_000 + MARGIN);
    expect(seconds(events)).toEqual([T + 1_000, T + 2_000, T + 3_000, T + 4_000]);
    expect(events.slice(1).every((event) => event.closedAtMs === T + 4_000 + MARGIN)).toBe(true);
    expect(s.close(A, T + 4_000)).toBe(1.1);
    expect(s.counters()).toMatchObject({ closedByClock: 4, closedByTick: 0 });
  });

  it('H-W6: a late tick is counted and changes no closed second', () => {
    const { s, events, tick } = series();
    tick(A, T + 500, 1.1);
    s.advance(T + 1_000 + MARGIN);
    tick(A, T + 900, 1.9, T + 1_600);
    expect(s.close(A, T + 1_000)).toBe(1.1);
    expect(s.counters().late).toBe(1);
    tick(A, T + 1_200, 1.2);
    tick(A, T + 2_100, 1.3);
    expect(s.close(A, T + 2_000)).toBe(1.2);
    expect(seconds(events)).toEqual([T + 1_000, T + 2_000]);
  });

  it('H-W7: an older tick in the open second keeps the newest; an equal time received later replaces it', () => {
    const { s, tick } = series();
    tick(A, T + 600, 1.1);
    tick(A, T + 400, 1.9);
    tick(A, T + 1_100, 1.0);
    expect(s.close(A, T + 1_000)).toBe(1.1);
    tick(A, T + 1_500, 1.2, T + 1_540);
    tick(A, T + 1_500, 1.3, T + 1_590);
    tick(A, T + 2_100, 1.0);
    expect(s.lastTickOf(A, T + 2_000)).toEqual({
      price: 1.3,
      timestamp: T + 1_500,
      receivedAtMs: T + 1_590,
    });
  });

  it("H-W8: prices are rounded to the digits of the pair's first tick", () => {
    const { s } = series();
    s.push(A, 3, { price: 0.69461999999, timestamp: T + 100 }, T + 140);
    s.push(A, 5, { price: 0.12345678, timestamp: T + 1_100 }, T + 1_140);
    s.push(A, 5, { price: 0.5, timestamp: T + 2_100 }, T + 2_140);
    expect(s.close(A, T + 1_000)).toBe(0.695);
    expect(s.close(A, T + 2_000)).toBe(0.123);
    expect(s.digitsOf(A)).toBe(3);
    expect(() => s.push(B, 11, { price: 1, timestamp: T }, T)).toThrow(RangeError);
  });

  describe('H-W9: a drop', () => {
    it('a: the seconds before the first tick after it are NaN, from its own second on the price is known', () => {
      const { s, events, tick } = series();
      tick(A, T + 500, 1.1);
      s.onDrop();
      tick(A, T + 3_400, 1.4);
      expect(seconds(events)).toEqual([T + 1_000, T + 2_000, T + 3_000]);
      for (const second of [T + 1_000, T + 2_000, T + 3_000]) {
        expect(s.close(A, second)).toBeNaN();
        expect(s.lastTickOf(A, second)).toBeUndefined();
      }
      tick(A, T + 4_100, 1.5);
      expect(s.close(A, T + 4_000)).toBe(1.4);
      expect(s.counters().holeSeconds).toBe(3);
    });

    it('b: the clock closes NaN during it', () => {
      const { s, tick } = series();
      tick(A, T + 500, 1.1);
      s.onDrop();
      s.advance(T + 2_000 + MARGIN);
      expect(s.close(A, T + 1_000)).toBeNaN();
      expect(s.close(A, T + 2_000)).toBeNaN();
      tick(A, T + 2_600, 1.3);
      s.advance(T + 3_000 + MARGIN);
      expect(s.close(A, T + 3_000)).toBe(1.3);
    });

    it('c: two drops before the next tick are one hole', () => {
      const { s, tick } = series();
      tick(A, T + 500, 1.1);
      s.onDrop();
      s.onDrop();
      tick(A, T + 2_500, 1.3);
      expect(s.counters().holeSeconds).toBe(2);
      tick(A, T + 3_500, 1.4);
      expect(s.close(A, T + 3_000)).toBe(1.3);
    });

    it('d: a pair first heard after it has no history and no hole', () => {
      const { s, tick } = series();
      tick(A, T + 500, 1.1);
      s.onDrop();
      tick(B, T + 600, 2.1);
      tick(B, T + 1_600, 2.2);
      expect(s.close(B, T + 1_000)).toBe(2.1);
      expect(s.counters().holeSeconds).toBe(0);
    });
  });

  it('H-W10: a window is complete only over closed seconds the series holds, NaN inside allowed', () => {
    const { s, tick } = series();
    tick(A, T + 500, 1.1);
    s.onDrop();
    tick(A, T + 2_500, 1.3);
    tick(A, T + 3_500, 1.4);
    const full = s.window(A, T + 3_000, 3);
    expect(full.complete).toBe(true);
    expect(Array.from(full.closes)).toEqual([NaN, NaN, 1.3]);
    const early = s.window(A, T + 3_000, 4);
    expect(early.complete).toBe(false);
    expect(Array.from(early.closes)).toEqual([NaN, NaN, NaN, 1.3]);
    expect(s.window(A, T + 4_000, 1).complete).toBe(false);
    expect(s.window(B, T + 3_000, 1)).toEqual({
      closes: Float64Array.from([NaN]),
      complete: false,
    });
  });

  it('H-W11: close and lastTickOf outside the series are NaN and undefined', () => {
    const { s, tick } = series();
    tick(A, T + 500, 1.1);
    tick(A, T + 1_500, 1.2);
    expect(s.close(A, T)).toBeNaN();
    expect(s.close(A, T + 2_000)).toBeNaN();
    expect(s.close(A, T + 1_500)).toBeNaN();
    expect(s.close(B, T + 1_000)).toBeNaN();
    expect(s.lastTickOf(A, T + 2_000)).toBeUndefined();
    expect(s.lastTickOf(B, T + 1_000)).toBeUndefined();
  });

  it('H-W12: the series holds capacitySec seconds; a jump past it empties the pair without events', () => {
    const { s, events, tick } = series(5);
    tick(A, T + 500, 1.1);
    s.advance(T + 3_000 + MARGIN);
    s.advance(T + 7_000 + MARGIN);
    expect(events).toHaveLength(7);
    expect(s.close(A, T + 2_000)).toBeNaN();
    expect(s.close(A, T + 3_000)).toBe(1.1);
    expect(s.window(A, T + 7_000, 5).complete).toBe(true);
    expect(s.window(A, T + 7_000, 6).complete).toBe(false);
    s.advance(T + 13_000 + MARGIN);
    expect(events).toHaveLength(7);
    expect(s.counters().resets).toBe(1);
    expect(s.close(A, T + 13_000)).toBeNaN();
    s.advance(T + 14_000 + MARGIN);
    expect(seconds(events.slice(7))).toEqual([T + 14_000]);
    expect(s.window(A, T + 14_000, 1).complete).toBe(true);
    expect(s.window(A, T + 14_000, 2).complete).toBe(false);
  });

  it('H-W13: a tick the ring would refuse is dropped', () => {
    const { s, tick } = series();
    tick(A, T + 500, 1.1);
    tick(A, T + 1_500, Number.NaN);
    tick(A, T + 1_500, -1);
    tick(A, T + 1_500, 1.5, T + 1_500 + 60_001);
    expect(s.close(A, T + 1_000)).toBeNaN();
    expect(s.counters()).toMatchObject({ closedByTick: 0, late: 0 });
  });

  it('H-W14: listeners see the updated state, each its own call; unsubscribed ones stop', () => {
    const s = createSecondSeries({ capacitySec: 320, closeMarginMs: MARGIN });
    const seen: number[] = [];
    const other: number[] = [];
    s.onClosed(({ assetId, second }) => seen.push(s.close(assetId, second)));
    const off = s.onClosed(({ second }) => other.push(second));
    s.push(A, 5, { price: 1.1, timestamp: T + 500 }, T + 540);
    s.push(A, 5, { price: 1.2, timestamp: T + 1_500 }, T + 1_540);
    off();
    s.push(A, 5, { price: 1.3, timestamp: T + 2_500 }, T + 2_540);
    s.push(B, 5, { price: 2.1, timestamp: T + 2_500 }, T + 2_540);
    s.advance(T + 3_000 + MARGIN);
    expect(seen).toEqual([1.1, 1.2, 1.3, 2.1]);
    expect(other).toEqual([T + 1_000]);
    expect(s.counters()).toEqual({
      pairs: 2,
      ahead: 0,
      late: 0,
      closedByTick: 2,
      closedByClock: 2,
      holeSeconds: 0,
      resets: 0,
    });
  });

  it('H-W15: a tick more than the margin past its receipt is dropped and counted, and opens no pair', () => {
    const { s, events, tick } = series();
    tick(A, T + 100, 1.1);
    tick(A, T + 59_000, 1.9, T + 200);
    expect(events).toEqual([]);
    expect(s.counters().ahead).toBe(1);
    tick(A, T + 1_400, 1.2);
    expect(seconds(events)).toEqual([T + 1_000]);
    expect(s.close(A, T + 1_000)).toBe(1.1);
    tick(A, T + 2_500, 1.3, T + 2_500 - MARGIN);
    expect(seconds(events)).toEqual([T + 1_000, T + 2_000]);
    tick(A, T + 3_500, 1.4, T + 3_500 - MARGIN - 1);
    expect(seconds(events)).toEqual([T + 1_000, T + 2_000]);
    tick(B, T + 59_000, 2.1, T + 200);
    expect(s.counters()).toMatchObject({ pairs: 1, ahead: 3, late: 0 });
    expect(s.close(B, T + 1_000)).toBeNaN();
  });
});
