import { describe, expect, it } from 'vitest';
import { createDetachedWork } from './detached';
import { fakeLogger } from './testing';

const CHAT = 4242;
const OTHER_CHAT = 4343;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// a work that records its start and end and settles when the test says so
function heldWork(order: string[], name: string, outcome: 'resolve' | 'reject' = 'resolve') {
  let finish: (() => void) | undefined;
  const work = () => {
    order.push(`${name} start`);
    return new Promise<void>((resolve, reject) => {
      finish = () => {
        order.push(`${name} end`);
        if (outcome === 'resolve') resolve();
        else reject(new Error(`${name} refused`));
      };
    });
  };
  return { work, finish: () => finish?.() };
}

const quickWork = (order: string[], name: string) => () => {
  order.push(name);
  return Promise.resolve();
};

describe('createDetachedWork (#875)', () => {
  it('D1 the work starts after the current task, not inside the call that hands it off', async () => {
    const detached = createDetachedWork({ logger: fakeLogger() });
    const order: string[] = [];
    detached.run(CHAT, () => {
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
    detached.run(CHAT, () => Promise.reject(new Error('pin refused')));
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
      CHAT,
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
    detached.run(CHAT, () => {
      ran.push('before');
      return Promise.resolve();
    });
    await detached.stop();
    detached.run(CHAT, () => {
      ran.push('after');
      return Promise.resolve();
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await detached.settled();
    expect(ran).toEqual([]);
  });
  it("D5 one chat's work runs one at a time: the next starts once the previous has settled", async () => {
    const detached = createDetachedWork({ logger: fakeLogger() });
    const order: string[] = [];
    const first = heldWork(order, '1');
    detached.run(CHAT, first.work);
    await tick();
    detached.run(CHAT, quickWork(order, '2 start'));
    await tick();
    expect(order).toEqual(['1 start']);
    first.finish();
    await detached.settled();
    expect(order).toEqual(['1 start', '1 end', '2 start']);
  });

  it('D6 a newer work replaces the one still waiting for its chat', async () => {
    const detached = createDetachedWork({ logger: fakeLogger() });
    const order: string[] = [];
    const first = heldWork(order, '1');
    detached.run(CHAT, first.work);
    await tick();
    detached.run(CHAT, quickWork(order, '2'));
    detached.run(CHAT, quickWork(order, '3'));
    first.finish();
    await detached.settled();
    expect(order).toEqual(['1 start', '1 end', '3']);
  });

  it('D6b two works of one chat handed off in one task: only the second runs', async () => {
    const detached = createDetachedWork({ logger: fakeLogger() });
    const order: string[] = [];
    detached.run(CHAT, quickWork(order, '1'));
    detached.run(CHAT, quickWork(order, '2'));
    await detached.settled();
    expect(order).toEqual(['2']);
  });

  it('D7 the works of two chats run side by side', async () => {
    const detached = createDetachedWork({ logger: fakeLogger() });
    const order: string[] = [];
    const first = heldWork(order, '1');
    detached.run(CHAT, first.work);
    detached.run(OTHER_CHAT, quickWork(order, '2 start'));
    await tick();
    expect(order).toEqual(['1 start', '2 start']);
    first.finish();
    await detached.settled();
  });

  it("D8 stop() while a chat's work runs and another waits: the waiting one never starts", async () => {
    const detached = createDetachedWork({ logger: fakeLogger() });
    const order: string[] = [];
    const first = heldWork(order, '1');
    detached.run(CHAT, first.work);
    await tick();
    detached.run(CHAT, quickWork(order, '2'));
    let stopped = false;
    const stopping = detached.stop().then(() => {
      stopped = true;
    });
    await tick();
    expect(stopped).toBe(false);
    first.finish();
    await stopping;
    await tick();
    await detached.settled();
    expect(order).toEqual(['1 start', '1 end']);
  });

  it('D9 a refused work still lets the waiting one of its chat run, logged once', async () => {
    const logger = fakeLogger();
    const detached = createDetachedWork({ logger });
    const order: string[] = [];
    const first = heldWork(order, '1', 'reject');
    detached.run(CHAT, first.work);
    await tick();
    detached.run(CHAT, quickWork(order, '2'));
    first.finish();
    await detached.settled();
    expect(order).toEqual(['1 start', '1 end', '2']);
    expect(logger.error.mock.calls).toEqual([
      [expect.objectContaining({ err: expect.anything() as unknown }), 'detached work failed'],
    ]);
  });
});
