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

describe('the tick window (#668)', () => {
  // receipt 100 ms after the broker time: the clamp never binds
  const push = (
    store: ReturnType<typeof createTickStore>,
    assetId: number,
    at: number,
    price = 1.1,
  ) => store.push(assetId, { price, timestamp: at }, at + 100);

  it('T5 between returns the ticks inside [from, until], both ends in, by broker time', () => {
    const store = createTickStore();
    for (const offset of [0, 1_000, 2_000, 3_000]) push(store, 101, AT + offset, 1 + offset / 1e4);
    push(store, 102, AT + 1_500);
    const window = store.between(101, AT + 1_000, AT + 2_000);
    expect(window).toEqual({
      ticks: [
        { price: 1.1, timestamp: AT + 1_000, receivedAtMs: AT + 1_100 },
        { price: 1.2, timestamp: AT + 2_000, receivedAtMs: AT + 2_100 },
      ],
      coverage: 'complete',
    });
  });

  it('T6 ticks arriving out of broker order come back sorted, ties by receipt', () => {
    const store = createTickStore();
    store.push(101, { price: 1.3, timestamp: AT + 2_000 }, AT + 2_050);
    store.push(101, { price: 1.1, timestamp: AT + 1_000 }, AT + 2_100);
    store.push(101, { price: 1.2, timestamp: AT + 1_000 }, AT + 2_090);
    expect(store.between(101, AT, AT + 3_000).ticks.map((t) => t.price)).toEqual([1.2, 1.1, 1.3]);
  });

  it('T7 ticks older than the buffer behind the watermark are pruned and the window below reads uncovered', () => {
    const store = createTickStore({ bufferMs: 10_000 });
    push(store, 101, AT);
    push(store, 101, AT + 5_000);
    push(store, 101, AT + 12_000);
    expect(store.between(101, AT + 2_000, AT + 12_000)).toEqual({
      ticks: [
        { price: 1.1, timestamp: AT + 5_000, receivedAtMs: AT + 5_100 },
        { price: 1.1, timestamp: AT + 12_000, receivedAtMs: AT + 12_100 },
      ],
      coverage: 'complete',
    });
    expect(store.between(101, AT, AT + 12_000).coverage).toBe('uncovered');
    expect(store.counters().held).toBe(2);
    push(store, 101, AT + 1_000);
    expect(store.counters()).toMatchObject({ held: 2, dropped: 1 });
  });

  it('T8 the per-pair cap drops the oldest by arrival, counts it and raises the floor past it', () => {
    const store = createTickStore({ maxPerPair: 3 });
    for (const offset of [0, 1_000, 2_000, 3_000]) push(store, 101, AT + offset);
    expect(store.counters()).toMatchObject({ held: 3, dropped: 1 });
    expect(store.between(101, AT + 1_000, AT + 3_000).coverage).toBe('complete');
    expect(store.between(101, AT, AT + 3_000).coverage).toBe('uncovered');
  });

  it('T9 a drop opens a hole from the watermark to the next tick; a window overlapping it reads hole', () => {
    const store = createTickStore();
    push(store, 101, AT);
    push(store, 101, AT + 1_000);
    store.onDrop();
    push(store, 101, AT + 5_000);
    expect(store.between(101, AT, AT + 1_000).coverage).toBe('hole');
    expect(store.between(101, AT + 3_000, AT + 6_000).coverage).toBe('hole');
    expect(store.between(101, AT, AT + 999).coverage).toBe('complete');
    expect(store.between(101, AT + 5_001, AT + 6_000).coverage).toBe('complete');
    expect(store.counters().holes).toBe(1);
  });

  it('T10 a second drop before the next tick keeps the first mark: one hole', () => {
    const store = createTickStore();
    push(store, 101, AT);
    store.onDrop();
    push(store, 101, AT - 500);
    store.onDrop();
    push(store, 101, AT + 4_000);
    expect(store.counters().holes).toBe(1);
    expect(store.between(101, AT + 1, AT + 3_999).coverage).toBe('hole');
    expect(store.between(101, AT + 4_001, AT + 5_000).coverage).toBe('complete');
  });

  it('T11 a pending mark reaches every window ending at or after it', () => {
    const store = createTickStore();
    push(store, 101, AT);
    push(store, 101, AT + 1_000);
    store.onDrop();
    expect(store.between(101, AT, AT + 999).coverage).toBe('complete');
    expect(store.between(101, AT, AT + 1_000).coverage).toBe('hole');
    expect(store.between(101, AT + 2_000, AT + 9_000).coverage).toBe('hole');
  });

  it('T12 a window starting before the first tick of the process is uncovered', () => {
    const store = createTickStore();
    expect(store.between(101, AT, AT + 1_000)).toEqual({ ticks: [], coverage: 'uncovered' });
    push(store, 102, AT + 500);
    expect(store.between(101, AT, AT + 1_000).coverage).toBe('uncovered');
    expect(store.between(101, AT + 500, AT + 1_000).coverage).toBe('complete');
  });

  it('T13 a quiet pair inside the coverage reads complete and empty', () => {
    const store = createTickStore();
    push(store, 101, AT);
    push(store, 101, AT + 10_000);
    expect(store.between(101, AT + 1_000, AT + 9_000)).toEqual({ ticks: [], coverage: 'complete' });
    expect(store.between(103, AT + 1_000, AT + 9_000)).toEqual({ ticks: [], coverage: 'complete' });
  });

  it('T14 counters and the watermark', () => {
    const store = createTickStore();
    expect(store.watermark(101)).toBeUndefined();
    push(store, 101, AT + 2_000);
    push(store, 101, AT + 1_000);
    push(store, 102, AT);
    expect(store.watermark(101)).toBe(AT + 2_000);
    expect(store.counters()).toEqual({ pairs: 2, held: 3, ahead: 0, dropped: 0, holes: 0 });
  });

  it('T15 a tick ahead of its receipt is kept but moves the watermark only to receipt + 500 ms', () => {
    const store = createTickStore();
    push(store, 101, AT);
    store.push(101, { price: 1.5, timestamp: AT + 30_000 }, AT + 1_000);
    expect(store.watermark(101)).toBe(AT + 1_500);
    expect(store.counters().ahead).toBe(1);
    expect(store.between(101, AT + 29_000, AT + 31_000).ticks).toEqual([
      { price: 1.5, timestamp: AT + 30_000, receivedAtMs: AT + 1_000 },
    ]);
    expect(store.last(101)).toEqual({
      price: 1.5,
      timestamp: AT + 30_000,
      receivedAtMs: AT + 1_000,
    });
  });
});
