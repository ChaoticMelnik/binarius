import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scheduleTicks } from './first-tick';

// #874, Rule 65: min 40, interval 200, random 0.5 → the jitter is 120 ms
const INTERVAL_MS = 200;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function schedule(lastAttemptAgeMs: () => Promise<number | null>) {
  const tick = vi.fn();
  const warn = vi.fn();
  const cancel = scheduleTicks({
    intervalMs: INTERVAL_MS,
    firstTickMinMs: 40,
    random: () => 0.5,
    lastAttemptAgeMs,
    tick,
    logger: { warn },
  });
  return { tick, warn, cancel };
}

describe('scheduleTicks', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('FS1 ticks first at the jitter when no attempt is recorded', async () => {
    const { tick } = schedule(() => Promise.resolve(null));
    await vi.advanceTimersByTimeAsync(119);
    expect(tick).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('FS2 waits an interval after the last attempt, and the jitter when that is sooner', async () => {
    const recent = schedule(() => Promise.resolve(50));
    await vi.advanceTimersByTimeAsync(149);
    expect(recent.tick).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(recent.tick).toHaveBeenCalledTimes(1);
    await recent.cancel();

    const old = schedule(() => Promise.resolve(190));
    await vi.advanceTimersByTimeAsync(119);
    expect(old.tick).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(old.tick).toHaveBeenCalledTimes(1);
    await old.cancel();
  });

  it('FS3 logs a failed read without its message and waits a whole interval', async () => {
    const error = Object.assign(new Error('secret detail'), { code: 'ECONNREFUSED' });
    const { tick, warn } = schedule(() => Promise.reject(error));
    await vi.advanceTimersByTimeAsync(199);
    expect(tick).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    const [fields, message] = warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(message).toBe('first tick: the last attempt read failed, waiting a whole interval');
    expect(fields).toEqual({ err: { name: 'Error', code: 'ECONNREFUSED' } });
    expect(JSON.stringify(fields)).not.toContain('secret detail');
    await vi.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['resolves', (read: ReturnType<typeof deferred<number | null>>) => read.resolve(null)],
    ['rejects', (read: ReturnType<typeof deferred<number | null>>) => read.reject(new Error('x'))],
  ])(
    'FS4 arms nothing when cancelled while the read is pending and the read %s',
    async (_, end) => {
      const read = deferred<number | null>();
      const { tick, warn, cancel } = schedule(() => read.promise);
      let settled = false;
      const cancelled = cancel().then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      end(read);
      await cancelled;
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(tick).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it('FS5 never ticks when cancelled inside the first delay', async () => {
    const { tick, cancel } = schedule(() => Promise.resolve(null));
    await vi.advanceTimersByTimeAsync(60);
    expect(vi.getTimerCount()).toBe(1);
    await cancel();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(tick).not.toHaveBeenCalled();
  });

  it('FS6 runs the interval from the first tick', async () => {
    const intervals = vi.spyOn(globalThis, 'setInterval');
    const { tick, cancel } = schedule(() => Promise.resolve(null));
    const at: number[] = [];
    tick.mockImplementation(() => at.push(Date.now()));
    const started = Date.now();
    await vi.advanceTimersByTimeAsync(520);
    expect(at.map((t) => t - started)).toEqual([120, 320, 520]);
    expect(intervals).toHaveBeenCalledTimes(1);
    expect(intervals.mock.calls[0]?.[1]).toBe(INTERVAL_MS);
    await cancel();
    expect(vi.getTimerCount()).toBe(0);
    intervals.mockRestore();
  });
});
