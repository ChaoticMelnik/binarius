import { describe, expect, it } from 'vitest';
import {
  createPasswordQueue,
  PasswordQueueOverflow,
  PasswordQueueRefusal,
} from './password-queue';

/** A piece of work that finishes only when the test says so. */
function gate() {
  let release!: () => void;
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { done, release };
}

const refusalOf = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

describe('createPasswordQueue', () => {
  it('runs the work and answers with its result', async () => {
    const queue = createPasswordQueue();
    expect(await queue.run(() => Promise.resolve('derived'))).toBe('derived');
    expect([queue.running, queue.waiting]).toEqual([0, 0]);
  });

  // the memory bound: one scrypt at these parameters holds 128 MiB, so what has to be capped
  // is how many exist at once, not how many arrive per minute
  it('never runs more than the concurrency at once', async () => {
    const queue = createPasswordQueue({ concurrency: 2, queueMax: 8 });
    const gates = [gate(), gate(), gate(), gate()];
    let started = 0;
    let peak = 0;
    let inFlight = 0;

    const runs = gates.map((g) =>
      queue.run(async () => {
        started += 1;
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await g.done;
        inFlight -= 1;
      }),
    );
    await Promise.resolve();
    expect(started).toBe(2);

    for (const g of gates) g.release();
    await Promise.all(runs);
    expect(peak).toBe(2);
    expect(started).toBe(4);
  });

  it('refuses once more callers are waiting than the queue holds, without running them', async () => {
    const queue = createPasswordQueue({ concurrency: 1, queueMax: 2 });
    const held = gate();
    let ran = 0;
    const count = () => {
      ran += 1;
      return held.done;
    };
    const running = queue.run(count);
    const queued = [queue.run(count), queue.run(count)];

    const refused = await refusalOf(queue.run(count));

    expect(refused).toBeInstanceOf(PasswordQueueOverflow);
    expect((refused as PasswordQueueOverflow).reason).toBe(PasswordQueueRefusal.Full);
    expect(ran).toBe(1);
    held.release();
    await Promise.all([running, ...queued]);
    expect(ran).toBe(3);
  });

  // a caller that waited out the budget is answered 429; holding it longer would be the queue
  // spending the request's own timeout on its behalf
  it('refuses a caller whose wait ran out, and does not run it later', async () => {
    const queue = createPasswordQueue({ concurrency: 1, queueMax: 4, maxWaitMs: 5 });
    const held = gate();
    let ran = 0;
    const running = queue.run(() => {
      ran += 1;
      return held.done;
    });

    const refused = await refusalOf(
      queue.run(() => {
        ran += 1;
        return Promise.resolve();
      }),
    );

    expect((refused as PasswordQueueOverflow).reason).toBe(PasswordQueueRefusal.TimedOut);
    expect(ran).toBe(1);
    held.release();
    await running;
    // the timed-out caller is gone from the queue, so releasing the slot does not run it
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ran).toBe(1);
    // and the slot it was waiting for is free again: a caller left in the queue after it gave
    // up would be handed that slot and never give it back, so the queue would run dry
    expect(queue.running).toBe(0);
    await expect(queue.run(() => Promise.resolve('after'))).resolves.toBe('after');
  });

  it('frees the slot when the work throws', async () => {
    const queue = createPasswordQueue({ concurrency: 1 });
    await expect(queue.run(() => Promise.reject(new Error('scrypt failed')))).rejects.toThrow(
      'scrypt failed',
    );
    expect(queue.running).toBe(0);
    expect(await queue.run(() => Promise.resolve('next'))).toBe('next');
  });

  it('admits a waiter as soon as a slot frees', async () => {
    const queue = createPasswordQueue({ concurrency: 1, maxWaitMs: 1_000 });
    const first = gate();
    let secondRan = false;
    const running = queue.run(() => first.done);
    const waiting = queue.run(() => {
      secondRan = true;
      return Promise.resolve();
    });

    expect(secondRan).toBe(false);
    first.release();
    await Promise.all([running, waiting]);
    expect(secondRan).toBe(true);
  });
});
