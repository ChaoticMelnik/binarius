import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { logOptions } from '@binarius/shared';
import { until } from '@binarius/shared/testing';
import type { Db, planMailingJobs } from '@binarius/db';
import { MAILING_SEND_PER_SECOND } from '../timing';
import { createMailingEngine, createSendPacer } from './engine';

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

// #686: the wake after a commit, against a planner pass held in flight. No start(): no timers.
describe('wakePlan (#686)', () => {
  type Planned = Awaited<ReturnType<typeof planMailingJobs>>;

  function setup({ failFirst = false } = {}) {
    const lines: string[] = [];
    // one gate per pass; `calls` counts the passes that started
    const gates: { open: () => void }[] = [];
    let calls = 0;
    const plan = (() => {
      calls += 1;
      const call = calls;
      return new Promise<Planned>((resolve, reject) => {
        gates.push({
          open: () =>
            failFirst && call === 1 ? reject(new Error('plan failed')) : resolve({} as Planned),
        });
      });
    }) as typeof planMailingJobs;
    const engine = createMailingEngine({
      db: {} as Db,
      push: {
        sendMailing: () => Promise.reject(new Error('no send in these tests')),
        sendMailingPhoto: () => Promise.reject(new Error('no send in these tests')),
      },
      logger: pino(logOptions('info'), { write: (line: string) => void lines.push(line) }),
      cashierUrl: undefined,
      helpLinks: { channelUrl: undefined, reviewsUrl: undefined, managerUrl: undefined },
      photos: {
        help_banner: { photo: () => 'unused', remember: () => {}, forget: () => {} },
        demo_to_real_banner: { photo: () => 'unused', remember: () => {}, forget: () => {} },
      },
      cards: { of: () => Promise.reject(new Error('no card in these tests')) },
      plan,
    });
    const open = async (index: number) => {
      await until(`pass ${String(index + 1)}`, () => gates.length > index);
      gates[index]!.open();
    };
    // one macrotask turn: a pass's end, its finally and the next pass's call to `plan` are all
    // microtasks, so they have run once it is over
    const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    return { engine, open, settle, lines, calls: () => calls };
  }

  it('WP1 runs a pass at once when none is in flight', async () => {
    const { engine, open, settle, calls } = setup();
    engine.wakePlan();
    expect(calls()).toBe(1);
    await open(0);
    await settle();
    expect(calls()).toBe(1);
  });

  it('WP2 a wake during a pass runs exactly one more after it, which starts after the wake', async () => {
    const { engine, open, settle, calls } = setup();
    const inFlight = engine.planTick();
    await settle();
    engine.wakePlan();
    expect(calls()).toBe(1);
    await open(0);
    await inFlight;
    await settle();
    expect(calls()).toBe(2);
    await open(1);
    await settle();
    expect(calls()).toBe(2);
  });

  it('WP3 three wakes during a pass merge into one more pass', async () => {
    const { engine, open, settle, calls } = setup();
    const inFlight = engine.planTick();
    engine.wakePlan();
    engine.wakePlan();
    engine.wakePlan();
    await open(0);
    await inFlight;
    await settle();
    expect(calls()).toBe(2);
    await open(1);
    await settle();
    expect(calls()).toBe(2);
  });

  it('WP4 a wake after stop() runs no pass and does not throw', async () => {
    const { engine, calls } = setup();
    await engine.stop();
    expect(() => engine.wakePlan()).not.toThrow();
    expect(calls()).toBe(0);
  });

  it('WP5 a wake during the pass stop() ends gives no further pass', async () => {
    const { engine, open, settle, calls } = setup();
    const inFlight = engine.planTick();
    engine.wakePlan();
    const stopping = engine.stop();
    await open(0);
    await stopping;
    await inFlight;
    await settle();
    expect(calls()).toBe(1);
  });

  it('WP6 a pass that throws is logged, and the wake that came during it still gets its pass', async () => {
    const { engine, open, settle, calls, lines } = setup({ failFirst: true });
    const inFlight = engine.planTick();
    engine.wakePlan();
    await open(0);
    await inFlight;
    await settle();
    expect(lines.some((line) => line.includes('mailing plan tick failed'))).toBe(true);
    expect(calls()).toBe(2);
    await open(1);
    await settle();
  });
});
