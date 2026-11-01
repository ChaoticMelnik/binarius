import { describe, expect, it } from 'vitest';
import { createDetachedWork } from './detached';
import { fakeLogger } from './testing';

describe('createDetachedWork (#875)', () => {
  it('D1 the work starts after the current task, not inside the call that hands it off', async () => {
    const detached = createDetachedWork({ logger: fakeLogger() });
    const order: string[] = [];
    detached.run(() => {
      order.push('work');
      return Promise.resolve();
    });
    order.push('handler');
    await Promise.resolve();
    order.push('microtasks');
    await detached.settled();
    expect(order).toEqual(['handler', 'microtasks', 'work']);
  });

  it('D2 a failure is logged and goes nowhere else', async () => {
    const logger = fakeLogger();
    const detached = createDetachedWork({ logger });
    detached.run(() => Promise.reject(new Error('pin refused')));
    await detached.settled();
    expect(logger.error.mock.calls).toEqual([
      [expect.objectContaining({ err: expect.anything() as unknown }), 'detached work failed'],
    ]);
  });

  it('D3 stop() waits for the work already running', async () => {
    const detached = createDetachedWork({ logger: fakeLogger() });
    let finish: (() => void) | undefined;
    let done = false;
    detached.run(
      () =>
        new Promise<void>((resolve) => {
          finish = () => {
            done = true;
            resolve();
          };
        }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    let stoppedAt: boolean | undefined;
    const stopped = detached.stop().then(() => {
      stoppedAt = done;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stoppedAt).toBeUndefined();
    finish?.();
    await stopped;
    expect(stoppedAt).toBe(true);
  });

  it('D4 stop() drops the work not yet started and any handed off after it', async () => {
    const detached = createDetachedWork({ logger: fakeLogger() });
    const ran: string[] = [];
    detached.run(() => {
      ran.push('before');
      return Promise.resolve();
    });
    await detached.stop();
    detached.run(() => {
      ran.push('after');
      return Promise.resolve();
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await detached.settled();
    expect(ran).toEqual([]);
  });
});
