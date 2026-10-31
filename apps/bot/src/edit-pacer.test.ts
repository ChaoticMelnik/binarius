import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEditPacer, type EditPriority } from './edit-pacer';

// #869: the wait's token bucket on fake timers — the rate, the burst, the priorities, the gap of a
// chat, the pause and the close, read off the moments each take() is answered.

const T0 = 100_000;

function setup({ chatGapMs = 0 }: { chatGapMs?: number } = {}) {
  const pacer = createEditPacer({ editsPerSecond: 5, burst: 5, chatGapMs });
  const granted: { label: string; at: number; result: string }[] = [];
  const take = (label: string, chatId: number, priority: EditPriority = 'housekeeping') =>
    void pacer.take(chatId, priority).then((result) => {
      granted.push({ label, at: Date.now() - T0, result });
    });
  return { pacer, granted, take, labels: () => granted.map(({ label }) => label) };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('createEditPacer (#869)', () => {
  it('EP1 gives the burst at once, then one slot every 200 ms', async () => {
    const s = setup();
    for (let chat = 1; chat <= 10; chat += 1) s.take(`c${String(chat)}`, chat);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.granted.map(({ at }) => at)).toEqual([0, 0, 0, 0, 0, 200, 400, 600, 800, 1_000]);
  });

  it('EP2 refills to the burst after a quiet second, never past it', async () => {
    const s = setup();
    for (let chat = 1; chat <= 5; chat += 1) s.take(`a${String(chat)}`, chat);
    await flush();
    await vi.advanceTimersByTimeAsync(5_000);
    for (let chat = 1; chat <= 7; chat += 1) s.take(`b${String(chat)}`, chat);
    await vi.advanceTimersByTimeAsync(400);
    const second = s.granted.filter(({ label }) => label.startsWith('b')).map(({ at }) => at);
    expect(second).toEqual([5_000, 5_000, 5_000, 5_000, 5_000, 5_200, 5_400]);
  });

  it('EP3 lets a late signal edit go before the housekeeping edits waiting for a slot', async () => {
    const s = setup();
    for (let chat = 1; chat <= 5; chat += 1) s.take(`burst${String(chat)}`, chat);
    s.take('h1', 11);
    s.take('h2', 12);
    s.take('signal', 13, 'signal');
    await vi.advanceTimersByTimeAsync(600);
    expect(s.labels().slice(5)).toEqual(['signal', 'h1', 'h2']);
  });

  it('EP4 edits a chat at most once in chatGapMs, another chat takes the slot meanwhile', async () => {
    const s = setup({ chatGapMs: 1_000 });
    s.take('a1', 1);
    s.take('a2', 1);
    s.take('b1', 2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.granted.map(({ label, at }) => [label, at])).toEqual([
      ['a1', 0],
      ['b1', 0],
      ['a2', 1_000],
    ]);
  });

  it('EP5 gives no slot inside a pause and keeps no more than the burst for after it', async () => {
    const s = setup();
    s.pacer.pause(T0 + 3_000);
    for (let chat = 1; chat <= 7; chat += 1) s.take(`c${String(chat)}`, chat);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(s.granted).toEqual([]);
    expect(s.pacer.pausedUntil()).toBe(T0 + 3_000);
    await vi.advanceTimersByTimeAsync(401);
    expect(s.granted.map(({ at }) => at)).toEqual([
      3_000, 3_000, 3_000, 3_000, 3_000, 3_200, 3_400,
    ]);
  });

  it('EP6 answers every waiting take() closed at close(), and every later one', async () => {
    const s = setup();
    for (let chat = 1; chat <= 7; chat += 1) s.take(`c${String(chat)}`, chat);
    await flush();
    s.pacer.close();
    s.take('late', 99, 'signal');
    await flush();
    expect(s.granted.map(({ result }) => result)).toEqual([
      'slot',
      'slot',
      'slot',
      'slot',
      'slot',
      'closed',
      'closed',
      'closed',
    ]);
    expect(s.granted.every(({ at }) => at === 0)).toBe(true);
  });

  it('EP7 serves a priority first come first served', async () => {
    const s = setup();
    for (let chat = 1; chat <= 5; chat += 1) s.take(`burst${String(chat)}`, chat);
    s.take('s1', 21, 'signal');
    s.take('s2', 22, 'signal');
    s.take('h1', 31);
    s.take('h2', 32);
    s.take('s3', 23, 'signal');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.labels().slice(5)).toEqual(['s1', 's2', 's3', 'h1', 'h2']);
  });

  it('EP8 drops a waiter no longer wanted at its turn without spending a token', async () => {
    const pacer = createEditPacer({ editsPerSecond: 5, burst: 1, chatGapMs: 0 });
    const granted: [string, string, number][] = [];
    let alive = true;
    const take = (label: string, chatId: number, wanted?: () => boolean) =>
      void pacer.take(chatId, 'housekeeping', wanted).then((result) => {
        granted.push([label, result, Date.now() - T0]);
      });
    take('first', 1);
    take('gone', 2, () => alive);
    take('next', 3);
    await flush();
    alive = false;
    await vi.advanceTimersByTimeAsync(200);
    expect(granted).toEqual([
      ['first', 'slot', 0],
      ['gone', 'dropped', 200],
      ['next', 'slot', 200],
    ]);
  });
});
