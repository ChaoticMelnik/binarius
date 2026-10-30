import { describe, expect, it } from 'vitest';
import { createInFlight } from './in-flight';

const held = () => {
  let release!: () => void;
  let fail!: (error: Error) => void;
  const task = new Promise<void>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  return { task, release, fail };
};

describe('createInFlight (#874)', () => {
  it('IF1 settle() resolves after every added task, a rejected one included', async () => {
    const inFlight = createInFlight();
    const a = held();
    const b = held();
    inFlight.add(a.task);
    inFlight.add(b.task);
    let settled = false;
    const done = inFlight.settle().then(() => void (settled = true));
    a.release();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    b.fail(new Error('push failed'));
    await done;
    expect(settled).toBe(true);
  });

  it('IF2 a task added during settle() is waited for too', async () => {
    const inFlight = createInFlight();
    const first = held();
    const second = held();
    inFlight.add(first.task);
    let settled = false;
    const done = inFlight.settle().then(() => void (settled = true));
    inFlight.add(second.task);
    first.release();
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(settled).toBe(false);
    second.release();
    await done;
    expect(settled).toBe(true);
  });

  it('IF3 size follows add and settle', async () => {
    const inFlight = createInFlight();
    expect(inFlight.size).toBe(0);
    const a = held();
    inFlight.add(a.task);
    inFlight.add(Promise.resolve());
    expect(inFlight.size).toBe(2);
    a.release();
    await inFlight.settle();
    expect(inFlight.size).toBe(0);
    await inFlight.settle();
  });
});
