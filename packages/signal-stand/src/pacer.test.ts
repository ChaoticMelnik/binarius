import { describe, expect, it } from 'vitest';
import { createPacer, type Clock } from './pacer';

function fakeClock(): Clock & { sleeps: number[] } {
  let now = 1_000_000;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => now,
    sleep: (ms) => {
      sleeps.push(ms);
      now += ms;
      return Promise.resolve();
    },
  };
}

describe('pacer', () => {
  it('F8 lets the cap through at once and makes the next GET wait for the refill', async () => {
    const clock = fakeClock();
    const pacer = createPacer(120, clock);
    for (let i = 0; i < 120; i++) await pacer.take();
    expect(clock.sleeps).toEqual([]);
    await pacer.take();
    expect(clock.sleeps).toEqual([60_000]);
    for (let i = 0; i < 119; i++) await pacer.take();
    expect(clock.sleeps).toEqual([60_000]);
  });
});
