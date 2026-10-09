import { describe, expect, it } from 'vitest';
import { DEFAULT_SIGNAL_SCAN_PER_MINUTE } from '@binarius/shared/broker-budget';
import { SIGNAL_CHART_INTERVAL_MS } from '@binarius/shared/signal';
import {
  MAX_SIGNAL_SCAN_PER_MINUTE,
  MIN_SIGNAL_SCAN_PER_MINUTE,
  SIGNAL_SCAN_BACKOFF_MAX_MS,
  SIGNAL_SCAN_BACKOFF_MIN_MS,
  signalScanCapacity,
  signalScanPairs,
  signalScanPerMinute,
} from '../timing';
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

  it('P2 any 60 s window carries at most the ceiling plus one batch plus one', () => {
    const { clock, p } = pacer({ capacity: 25 + 1 });
    const taken: number[] = [];
    for (let t = 0; t < 180_000; t += 100) {
      while (p.tryTake()) taken.push(clock.now);
      clock.now += 100;
    }
    for (const start of taken) {
      const inWindow = taken.filter((at) => at >= start && at < start + 60_000).length;
      expect(inWindow).toBeLessThanOrEqual(100 + 26);
    }
    expect(taken.length).toBeLessThanOrEqual(26 + 3 * 100);
  });

  // #382 review M1: the takes of a batch are one burst at the timer's millisecond, and a candle
  // refills exactly one batch, so a fire earlier relative to its boundary than the one before
  // must still find the whole batch
  it.each([
    [DEFAULT_SIGNAL_SCAN_PER_MINUTE, '15s'],
    [DEFAULT_SIGNAL_SCAN_PER_MINUTE, '5s'],
    [MIN_SIGNAL_SCAN_PER_MINUTE, '5s'],
    [MAX_SIGNAL_SCAN_PER_MINUTE, '15s'],
    [MAX_SIGNAL_SCAN_PER_MINUTE, '5s'],
  ] as const)(
    'P9 at the ceiling %i the %s pacer gives the whole batch every candle under a jittery timer',
    (ceiling, interval) => {
      const start = 1_000_000;
      const clock = { now: start };
      const p = createScanPacer({
        perMinute: signalScanPerMinute(ceiling, interval),
        capacity: signalScanCapacity(ceiling, interval),
        backoffMinMs: SIGNAL_SCAN_BACKOFF_MIN_MS,
        backoffMaxMs: SIGNAL_SCAN_BACKOFF_MAX_MS,
        now: () => clock.now,
      });
      const batch = signalScanPairs(ceiling, interval);
      const taken = [1, 0, 2, 2, 1, 3, 0].map((lag, candle) => {
        clock.now = start + candle * SIGNAL_CHART_INTERVAL_MS[interval] + 500 + lag;
        return Array.from({ length: batch }, () => p.tryTake()).filter(Boolean).length;
      });
      expect(taken).toEqual(Array.from({ length: 7 }, () => batch));
    },
  );

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
