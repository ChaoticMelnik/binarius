import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { DepositModeSwitch, logOptions } from '@binarius/shared';
import type { Db, DepositModeSwitchAttempt } from '@binarius/db';
import { createDepositModeSwitcher, type DepositModeSwitchOps } from './deposit-mode-switch';

// #686: the pass over fake operations; the log is read as the process writes it.
function setup({
  candidates,
  outcomes,
  demoOnly = false,
  onSwitched = () => {},
}: {
  candidates: () => string[];
  outcomes: Record<string, DepositModeSwitchAttempt | Error | (() => Promise<never>)>;
  demoOnly?: boolean;
  onSwitched?: () => void;
}) {
  const lines: string[] = [];
  const attempts: { depositEventId: string; demoOnly: boolean }[] = [];
  let lists = 0;
  const clock = { now: 0 };
  let woken = 0;
  const ops: DepositModeSwitchOps = {
    list: () => {
      lists += 1;
      return Promise.resolve(candidates());
    },
    attempt: async (_db, options) => {
      attempts.push(options);
      const outcome = outcomes[options.depositEventId];
      if (outcome === undefined) throw new Error(`no outcome for ${options.depositEventId}`);
      if (outcome instanceof Error) throw outcome;
      if (typeof outcome === 'function') return outcome();
      return { outcome };
    },
  };
  const switcher = createDepositModeSwitcher({
    db: {} as Db,
    demoOnly,
    logger: pino(logOptions('info'), { write: (line: string) => void lines.push(line) }),
    onSwitched: () => {
      woken += 1;
      onSwitched();
    },
    ops,
    now: () => clock.now,
  });
  const logs = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return {
    switcher,
    attempts,
    clock,
    logs,
    lists: () => lists,
    woken: () => woken,
  };
}

describe('the deposit mode switcher (#686)', () => {
  it('W1 tries every candidate and counts the outcomes in one line', async () => {
    const { switcher, attempts, logs } = setup({
      candidates: () => ['a', 'b', 'c', 'd'],
      outcomes: {
        a: DepositModeSwitch.Switched,
        b: DepositModeSwitch.AlreadyReal,
        c: DepositModeSwitch.AccountInactive,
        d: 'gone',
      },
    });
    await switcher.tick();
    expect(attempts.map((attempt) => attempt.depositEventId)).toEqual(['a', 'b', 'c', 'd']);
    const summary = logs().filter((line) => line.msg === 'deposit mode switch');
    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({ switched: 1, alreadyReal: 1, accountInactive: 1, gone: 1 });
    expect(summary[0]).not.toHaveProperty('failed');
  });

  it('W2 wakes the planner once per switch, and not for any other outcome', async () => {
    const { switcher, woken } = setup({
      candidates: () => ['a', 'b', 'c', 'd', 'e'],
      outcomes: {
        a: DepositModeSwitch.Switched,
        b: DepositModeSwitch.AlreadyReal,
        c: DepositModeSwitch.Switched,
        d: DepositModeSwitch.DemoOnly,
        e: 'session_active',
      },
    });
    await switcher.tick();
    expect(woken()).toBe(2);
  });

  it('W3 a candidate that throws is logged and skipped for the retry delay, the others still run', async () => {
    const { switcher, attempts, clock, logs } = setup({
      candidates: () => ['broken', 'ok'],
      outcomes: {
        broken: Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }),
        ok: DepositModeSwitch.AlreadyReal,
      },
    });
    await switcher.tick();
    expect(attempts.map((attempt) => attempt.depositEventId)).toEqual(['broken', 'ok']);
    const failed = logs().filter((line) => line.msg === 'deposit mode switch failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      level: 40,
      depositEventId: 'broken',
      err: { name: 'Error', code: 'ECONNRESET' },
    });
    expect(JSON.stringify(failed[0])).not.toContain('connection reset');
    expect(logs().find((line) => line.msg === 'deposit mode switch')).toMatchObject({
      failed: 1,
      alreadyReal: 1,
    });

    clock.now += 59_999;
    await switcher.tick();
    expect(attempts.filter((attempt) => attempt.depositEventId === 'broken')).toHaveLength(1);
    clock.now += 1;
    await switcher.tick();
    expect(attempts.filter((attempt) => attempt.depositEventId === 'broken')).toHaveLength(2);
  });

  it('W4 stop() waits for the attempt in flight, takes no further candidate, and later ticks read nothing', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let started!: () => void;
    const inFlight = new Promise<void>((resolve) => (started = resolve));
    const { switcher, attempts, lists } = setup({
      candidates: () => ['slow', 'next'],
      outcomes: {
        slow: async () => {
          started();
          await held;
          throw new Error('unreachable');
        },
        next: DepositModeSwitch.Switched,
      },
    });
    const ticking = switcher.tick();
    await inFlight;
    let stoppedDone = false;
    const stopping = switcher.stop().then(() => (stoppedDone = true));
    await Promise.resolve();
    expect(stoppedDone).toBe(false);
    release();
    await stopping;
    await ticking;
    expect(attempts.map((attempt) => attempt.depositEventId)).toEqual(['slow']);
    await switcher.tick();
    expect(lists()).toBe(1);
  });

  it('W5 a deposit waiting for a session is counted as waiting, with no wake', async () => {
    const { switcher, woken, logs } = setup({
      candidates: () => ['a'],
      outcomes: { a: 'session_active' },
    });
    await switcher.tick();
    expect(woken()).toBe(0);
    expect(logs().find((line) => line.msg === 'deposit mode switch')).toMatchObject({ waiting: 1 });
  });

  it('W6 a wake that throws is logged, and the tick goes on', async () => {
    const { switcher, attempts, logs } = setup({
      candidates: () => ['a', 'b'],
      outcomes: { a: DepositModeSwitch.Switched, b: DepositModeSwitch.Switched },
      onSwitched: () => {
        throw new TypeError('planner gone');
      },
    });
    await switcher.tick();
    expect(attempts).toHaveLength(2);
    const wakes = logs().filter((line) => line.msg === 'deposit mode switch wake failed');
    expect(wakes).toHaveLength(2);
    expect(wakes[0]).toMatchObject({ level: 40, err: { name: 'TypeError' } });
  });

  it('W7 a tick while one runs is the same tick', async () => {
    const { switcher, lists } = setup({
      candidates: () => ['a'],
      outcomes: { a: DepositModeSwitch.AlreadyReal },
    });
    await Promise.all([switcher.tick(), switcher.tick()]);
    expect(lists()).toBe(1);
  });

  it.each([true, false])('W8 hands DEMO_ONLY=%s to the operation', async (demoOnly) => {
    const { switcher, attempts } = setup({
      candidates: () => ['a'],
      outcomes: { a: DepositModeSwitch.DemoOnly },
      demoOnly,
    });
    await switcher.tick();
    expect(attempts).toEqual([{ depositEventId: 'a', demoOnly }]);
  });
});
