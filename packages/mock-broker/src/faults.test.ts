import { describe, expect, it } from 'vitest';
import { FaultQueue, RateWindow, scriptKind, scriptedMessage, type MockScript } from './faults';

describe('FaultQueue', () => {
  it('hands scripts out once, in order, per endpoint', () => {
    const queue = new FaultQueue();
    queue.push('user', { status: 500 });
    queue.push('chart', { status: 502 });
    queue.push('user', { delayMs: 5 });
    expect(queue.shift('user')).toEqual({ status: 500 });
    expect(queue.shift('user')).toEqual({ delayMs: 5 });
    expect(queue.shift('user')).toBeUndefined();
    expect(queue.shift('pairs')).toBeUndefined();
    expect(queue.shift('chart')).toEqual({ status: 502 });
  });
});

describe('FaultQueue.push validation', () => {
  it.each([
    [{ status: 199 }, /200\.\.599/],
    [{ status: 600 }, /200\.\.599/],
    [{ status: 429.5 }, /200\.\.599/],
    [{ status: 429, retryAfterSec: -1 }, /retryAfterSec/],
    [{ status: 429, retryAfterSec: 1.5 }, /retryAfterSec/],
    [{ delayMs: -1 }, /delayMs/],
    [{ delayMs: 1.5 }, /delayMs/],
  ] as [MockScript, RegExp][])(
    'refuses %j with a RangeError, queueing nothing',
    (script, message) => {
      const queue = new FaultQueue();
      expect(() => queue.push('user', script)).toThrow(RangeError);
      expect(() => queue.push('user', script)).toThrow(message);
      expect(queue.shift('user')).toBeUndefined();
    },
  );

  it('refuses a script of no known shape with a TypeError', () => {
    const queue = new FaultQueue();
    expect(() => queue.push('user', {} as MockScript)).toThrow(TypeError);
    expect(() => queue.push('user', { hang: false } as unknown as MockScript)).toThrow(TypeError);
  });

  // each mixed shape is refused by the type and at runtime, and queues nothing
  it('refuses a script that mixes shapes', () => {
    // @ts-expect-error status with delayMs
    const statusDelay: MockScript = { status: 429, delayMs: 50 };
    // @ts-expect-error status with hang
    const statusHang: MockScript = { status: 500, hang: true };
    // @ts-expect-error delayMs with hang
    const delayHang: MockScript = { delayMs: 10, hang: true };
    // @ts-expect-error hang must be true
    const hangFalse: MockScript = { hang: false };
    // @ts-expect-error delayMs takes no body
    const delayBody: MockScript = { delayMs: 10, body: {} };
    const cases: [MockScript, RegExp][] = [
      [statusDelay, /exactly one of status, delayMs, hang; got status, delayMs/],
      [statusHang, /exactly one of status, delayMs, hang; got status, hang/],
      [delayHang, /exactly one of status, delayMs, hang; got delayMs, hang/],
      [hangFalse, /hang must be true/],
      [delayBody, /\{ delayMs \} does not take body/],
    ];
    for (const [script, message] of cases) {
      const queue = new FaultQueue();
      expect(() => queue.push('user', script)).toThrow(TypeError);
      expect(() => queue.push('user', script)).toThrow(message);
      expect(queue.shift('user')).toBeUndefined();
    }
  });

  it('ignores a field that is present but undefined', () => {
    const queue = new FaultQueue();
    queue.push('user', { status: 429, delayMs: undefined });
    expect(queue.shift('user')).toEqual({ status: 429, delayMs: undefined });
  });

  it.each([
    { status: 200 },
    { status: 599 },
    { status: 429, retryAfterSec: 0 },
    { status: 503, body: { x: 1 }, headers: { 'x-test': 'y' }, retryAfterSec: 2 },
    { delayMs: 0 },
    { hang: true },
  ] as MockScript[])('accepts the boundary %j', (script) => {
    const queue = new FaultQueue();
    queue.push('user', script);
    expect(queue.shift('user')).toEqual(script);
  });
});

describe('scriptKind', () => {
  it('reads the shape the server plays', () => {
    expect(scriptKind({ status: 429, retryAfterSec: 1 })).toEqual({
      kind: 'answer',
      script: { status: 429, retryAfterSec: 1 },
    });
    expect(scriptKind({ delayMs: 5 })).toEqual({ kind: 'delay', delayMs: 5 });
    expect(scriptKind({ hang: true })).toEqual({ kind: 'hang' });
  });
});

describe('scriptedMessage', () => {
  it.each([
    [429, 'Too many requests'],
    [500, 'Internal error'],
    [501, 'Internal error'],
    [502, 'Service unavailable'],
    [503, 'Service unavailable'],
    [504, 'Service unavailable'],
    [400, 'Request failed'],
    [403, 'Request failed'],
  ])('%d -> %j', (status, message) => {
    expect(scriptedMessage(status)).toBe(message);
  });
});

describe('RateWindow', () => {
  const minute = 1_790_000_040_000;

  it('counts down within a minute, never below 0, and resets at the next minute', () => {
    const window = new RateWindow(2);
    expect(window.hit(minute)).toEqual({ limit: 2, remaining: 1, reset: minute / 1000 + 60 });
    expect(window.hit(minute + 59_999)).toEqual({
      limit: 2,
      remaining: 0,
      reset: minute / 1000 + 60,
    });
    expect(window.hit(minute + 59_999).remaining).toBe(0);
    expect(window.hit(minute + 60_000)).toEqual({
      limit: 2,
      remaining: 1,
      reset: minute / 1000 + 120,
    });
  });
});
