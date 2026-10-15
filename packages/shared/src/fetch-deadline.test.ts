import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { abandonedFetches, DeadlineError, withinDeadline } from './fetch-deadline';

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('withinDeadline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // first in the file: nothing before it abandoned anything
  it('counts 0 in a process that abandoned nothing', () => {
    expect(abandonedFetches()).toBe(0);
  });

  it('passes a run that settles first through and leaves nothing abandoned', async () => {
    const before = abandonedFetches();
    await expect(withinDeadline(100, undefined, () => Promise.resolve(7))).resolves.toBe(7);
    const failure = new Error('own');
    await expect(withinDeadline(100, undefined, () => Promise.reject(failure))).rejects.toBe(
      failure,
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(abandonedFetches()).toBe(before);
  });

  it('keeps the outcome of a run that settles on its own abort', async () => {
    const outcome = withinDeadline(100, undefined, (signal) => {
      const { promise, reject } = deferred<number>();
      signal.addEventListener('abort', () => reject(new Error('cut by abort')));
      return promise;
    });
    const caught = outcome.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(100);
    expect(await caught).toMatchObject({ message: 'cut by abort' });
    expect(abandonedFetches()).toBe(0);
  });

  it('answers timeout at the deadline when run ignores its signal', async () => {
    const outcome = withinDeadline(100, undefined, () => never<number>());
    const caught = outcome.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(99);
    let settled = false;
    void caught.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    // the cut, then the grace timer one tick later
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(1);
    const error = await caught;
    expect(error).toBeInstanceOf(DeadlineError);
    expect((error as DeadlineError).code).toBe('timeout');
  });

  it('answers aborted when the caller signal fires first, before the deadline', async () => {
    const caller = new AbortController();
    const outcome = withinDeadline(1_000, caller.signal, () => never<number>());
    const caught = outcome.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10);
    caller.abort();
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(1);
    const error = await caught;
    expect((error as DeadlineError).code).toBe('aborted');
  });

  it('answers aborted for a caller signal aborted before the call', async () => {
    const caller = new AbortController();
    caller.abort();
    const caught = withinDeadline(1_000, caller.signal, () => never<number>()).catch(
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(2);
    expect(((await caught) as DeadlineError).code).toBe('aborted');
  });

  it('counts an abandoned run, reports it, and decrements once it settles late', async () => {
    const before = abandonedFetches();
    const late = deferred<number>();
    const onAbandoned = vi.fn();
    const onSettledLate = vi.fn();
    const caught = withinDeadline(100, undefined, () => late.promise, {
      onAbandoned,
      onSettledLate,
    }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(101);
    const error = await caught;
    expect(abandonedFetches()).toBe(before + 1);
    expect(onAbandoned).toHaveBeenCalledExactlyOnceWith(error);
    expect(onSettledLate).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(250);
    late.resolve(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(abandonedFetches()).toBe(before);
    expect(onSettledLate).toHaveBeenCalledExactlyOnceWith({ lateMs: 250, ok: true });
  });

  // an unhandled rejection fails the vitest run itself
  it('swallows a late rejection of an abandoned run and reports its error', async () => {
    const late = deferred<number>();
    const onSettledLate = vi.fn();
    const caught = withinDeadline(100, undefined, () => late.promise, { onSettledLate }).catch(
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(101);
    await caught;
    const failure = new Error('late');
    late.reject(failure);
    await vi.advanceTimersByTimeAsync(0);
    expect(onSettledLate).toHaveBeenCalledExactlyOnceWith({ lateMs: 0, ok: false, error: failure });
  });

  it('turns a synchronous throw of run into its rejection', async () => {
    const failure = new Error('sync');
    await expect(
      withinDeadline(100, undefined, () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });

  it('survives a hook that throws', async () => {
    const before = abandonedFetches();
    const late = deferred<number>();
    const caught = withinDeadline(100, undefined, () => late.promise, {
      onAbandoned: () => {
        throw new Error('hook');
      },
    }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(101);
    expect(await caught).toBeInstanceOf(DeadlineError);
    late.resolve(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(abandonedFetches()).toBe(before);
  });
});
