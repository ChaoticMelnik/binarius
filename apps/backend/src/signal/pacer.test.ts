import { describe, expect, it } from 'vitest';
import { createScanPacer } from './pacer';

function pacer(overrides: { perMinute?: number; capacity?: number } = {}) {
  const clock = { now: 1_000_000 };
  const p = createScanPacer({
    perMinute: overrides.perMinute ?? 100,
    capacity: overrides.capacity ?? 25,
    backoffMinMs: 15_000,
    backoffMaxMs: 120_000,
    now: () => clock.now,
  });
  const takeAll = () => {
    let taken = 0;
    while (p.tryTake()) taken += 1;
    return taken;
  };
  return { clock, p, takeAll };
}

describe('scan pacer', () => {
  it('P1 a full bucket gives one batch, and one 15 s candle refills it', () => {
    const { clock, takeAll } = pacer();
    expect(takeAll()).toBe(25);
    clock.now += 14_000;
    expect(takeAll()).toBe(23);
    clock.now += 1_000 + 15_000;
    expect(takeAll()).toBe(25);
  });

  it('P2 any 60 s window carries at most the ceiling plus one batch', () => {
    const { clock, p } = pacer();
    const taken: number[] = [];
    for (let t = 0; t < 180_000; t += 100) {
      while (p.tryTake()) taken.push(clock.now);
      clock.now += 100;
    }
    for (const start of taken) {
      const inWindow = taken.filter((at) => at >= start && at < start + 60_000).length;
      expect(inWindow).toBeLessThanOrEqual(100 + 25);
    }
    expect(taken.length).toBeLessThanOrEqual(25 + 3 * 100);
  });

  it('P3 a 429 with Retry-After pauses for exactly that long', () => {
    const { clock, p } = pacer();
    expect(p.onRateLimited(20)).toBe(20_000);
    expect(p.pausedUntil()).toBe(clock.now + 20_000);
    clock.now += 19_999;
    expect(p.tryTake()).toBe(false);
    clock.now += 1;
    expect(p.pausedUntil()).toBeUndefined();
    expect(p.tryTake()).toBe(true);
  });

  it('P4 without Retry-After the pause doubles to its cap, and a decided answer resets it', () => {
    const { clock, p } = pacer();
    const pauses: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      p.onRateLimited(undefined);
      const until = p.pausedUntil() ?? 0;
      pauses.push(until - clock.now);
      clock.now = until;
    }
    expect(pauses).toEqual([15_000, 30_000, 60_000, 120_000, 120_000]);
    p.onDecided();
    p.onRateLimited(undefined);
    expect((p.pausedUntil() ?? 0) - clock.now).toBe(15_000);
  });

  it.each([
    [0, 15_000],
    [1, 15_000],
    [10_000, 120_000],
  ])('P3b a Retry-After of %i s pauses for %i ms (held to the backoff bounds)', (sec, ms) => {
    const { clock, p } = pacer();
    p.onRateLimited(sec);
    expect(p.pausedUntil()).toBe(clock.now + ms);
  });

  it('P7 one burst of 429s without Retry-After is one pause, not an escalation', () => {
    const { clock, p } = pacer();
    expect([1, 2, 3, 4].map(() => p.onRateLimited(undefined))).toEqual([15_000, 0, 0, 0]);
    expect(p.pausedUntil()).toBe(clock.now + 15_000);
    clock.now += 15_000;
    p.onRateLimited(undefined);
    expect(p.pausedUntil()).toBe(clock.now + 30_000);
  });

  it('P8 a Retry-After during a pause extends it only when it ends later', () => {
    const { clock, p } = pacer();
    p.onRateLimited(undefined);
    expect(p.onRateLimited(15)).toBe(0);
    expect(p.pausedUntil()).toBe(clock.now + 15_000);
    clock.now += 5_000;
    expect(p.onRateLimited(30)).toBe(20_000);
    expect(p.pausedUntil()).toBe(clock.now + 30_000);
  });

  it('P5 nothing is taken while paused, even with tokens left', () => {
    const { p } = pacer();
    expect(p.tryTake()).toBe(true);
    p.onRateLimited(undefined);
    expect(p.tryTake()).toBe(false);
  });

  it('P6 refuses a pacer that could never give a token', () => {
    expect(() =>
      createScanPacer({
        perMinute: 0,
        capacity: 1,
        backoffMinMs: 1,
        backoffMaxMs: 1,
        now: () => 0,
      }),
    ).toThrow(RangeError);
  });
});
