import { describe, expect, it } from 'vitest';
import { MAILING_SEND_PER_SECOND } from '../timing';
import { createSendPacer } from './engine';

// M10: the rate is the pacer's gap, on a clock the test owns
describe('createSendPacer', () => {
  const run = async (perSecond: number, sends: number) => {
    const clock = { now: 0 };
    const starts: number[] = [];
    const pace = createSendPacer({
      perSecond,
      now: () => clock.now,
      sleep: async (ms) => {
        clock.now += ms;
      },
    });
    for (let index = 0; index < sends; index += 1) {
      await pace();
      starts.push(clock.now);
    }
    return starts;
  };

  it('M10 lets the first send go at once and spaces the rest 1000 / perSecond apart', async () => {
    const starts = await run(MAILING_SEND_PER_SECOND, 41);
    expect(starts[0]).toBe(0);
    const gaps = starts.slice(1).map((at, index) => at - starts[index]!);
    expect(new Set(gaps)).toEqual(new Set([1000 / MAILING_SEND_PER_SECOND]));
    // no window of one second holds more than the rate
    for (const at of starts) {
      expect(starts.filter((other) => other >= at && other < at + 1000).length).toBeLessThanOrEqual(
        MAILING_SEND_PER_SECOND,
      );
    }
  });

  it('does not bank the time no one sent in', async () => {
    const clock = { now: 0 };
    const slept: number[] = [];
    const pace = createSendPacer({
      perSecond: 20,
      now: () => clock.now,
      sleep: async (ms) => {
        slept.push(ms);
        clock.now += ms;
      },
    });
    await pace();
    clock.now += 10_000;
    await pace();
    await pace();
    expect(slept).toEqual([50]);
  });
});
