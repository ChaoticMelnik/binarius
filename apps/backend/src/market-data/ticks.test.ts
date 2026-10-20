import { describe, expect, it } from 'vitest';
import { createTickStore } from './ticks';

const AT = 1_760_000_000_000;

describe('createTickStore (#666)', () => {
  it('T1 answers the newest tick of a pair with its receipt time, nothing for another pair', () => {
    const store = createTickStore();
    expect(store.last(101)).toBeUndefined();
    store.push(101, { price: 1.1, timestamp: AT }, AT + 20);
    store.push(101, { price: 1.2, timestamp: AT + 500 }, AT + 530);
    expect(store.last(101)).toEqual({ price: 1.2, timestamp: AT + 500, receivedAtMs: AT + 530 });
    expect(store.last(102)).toBeUndefined();
  });

  it('T2 an older tick arriving late does not replace the newest', () => {
    const store = createTickStore();
    store.push(101, { price: 1.2, timestamp: AT + 500 }, AT + 530);
    store.push(101, { price: 1.1, timestamp: AT }, AT + 600);
    expect(store.last(101)).toEqual({ price: 1.2, timestamp: AT + 500, receivedAtMs: AT + 530 });
  });

  it.each([
    ['a zero price', { price: 0, timestamp: AT }],
    ['a NaN price', { price: Number.NaN, timestamp: AT }],
    ['an infinite timestamp', { price: 1.1, timestamp: Number.POSITIVE_INFINITY }],
    ['a tick a minute and more away from its receipt', { price: 1.1, timestamp: AT - 60_001 }],
  ])('T3 drops %s, as the ring does', (_label, tick) => {
    const store = createTickStore();
    store.push(101, tick, AT);
    expect(store.last(101)).toBeUndefined();
  });

  it('T4 a tick of the same broker time replaces the held one (the later receipt)', () => {
    const store = createTickStore();
    store.push(101, { price: 1.1, timestamp: AT }, AT + 10);
    store.push(101, { price: 1.15, timestamp: AT }, AT + 40);
    expect(store.last(101)).toEqual({ price: 1.15, timestamp: AT, receivedAtMs: AT + 40 });
  });
});
