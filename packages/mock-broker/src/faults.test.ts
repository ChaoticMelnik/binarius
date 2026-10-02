import { describe, expect, it } from 'vitest';
import { FaultQueue, RateWindow, scriptedMessage } from './faults';

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
