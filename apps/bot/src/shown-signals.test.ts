import { describe, expect, it } from 'vitest';
import { createShownSignals, type ShownSignalRecord } from './shown-signals';

// The bot's record of the directions it showed (#829, docs/bot-demo.md).
const record = (assetId: number, patch: Partial<ShownSignalRecord> = {}): ShownSignalRecord => ({
  assetId,
  action: 'up',
  second: 1_000_000 + assetId,
  decidedAt: 1_000_400 + assetId,
  ...patch,
});

describe('createShownSignals (#829)', () => {
  it('SS1: remember then take returns the record with its source and time; a second take has none', () => {
    const store = createShownSignals();
    store.remember(7, 'analysis', 5_000, [record(101, { action: 'down' })]);
    expect(store.take(7, 101)).toEqual({
      action: 'down',
      second: 1_000_101,
      decidedAt: 1_000_501,
      shownAtMs: 5_000,
      source: 'analysis',
    });
    expect(store.take(7, 101)).toBeUndefined();
  });

  it('SS2: the newest record of a pair wins', () => {
    const store = createShownSignals();
    store.remember(7, 'list', 5_000, [record(101, { action: 'up' })]);
    store.remember(7, 'analysis', 6_000, [record(101, { action: 'down', second: 2_000_000 })]);
    expect(store.take(7, 101)).toMatchObject({
      action: 'down',
      second: 2_000_000,
      source: 'analysis',
      shownAtMs: 6_000,
    });
  });

  it("SS3: take of an unknown user or pair has none; the user's other pair stays", () => {
    const store = createShownSignals();
    store.remember(7, 'list', 5_000, [record(101), record(102)]);
    expect(store.take(8, 101)).toBeUndefined();
    expect(store.take(7, 103)).toBeUndefined();
    expect(store.take(7, 101)).toMatchObject({ second: 1_000_101 });
    expect(store.take(7, 102)).toMatchObject({ second: 1_000_102 });
  });

  it("SS4: the 33rd pair of a user removes the user's oldest", () => {
    const store = createShownSignals();
    store.remember(
      7,
      'list',
      5_000,
      Array.from({ length: 32 }, (_, i) => record(100 + i)),
    );
    store.remember(7, 'list', 6_000, [record(200)]);
    expect(store.take(7, 100)).toBeUndefined();
    expect(store.take(7, 101)).toBeDefined();
    expect(store.take(7, 200)).toBeDefined();
  });

  it('SS5: the 10 001st user removes the oldest; a user written again is the newest', () => {
    const store = createShownSignals({ maxUsers: 3 });
    for (const user of [1, 2, 3]) store.remember(user, 'list', 5_000, [record(101)]);
    store.remember(1, 'list', 6_000, [record(102)]);
    store.remember(4, 'list', 6_000, [record(101)]);
    expect(store.take(2, 101)).toBeUndefined();
    expect(store.take(1, 101)).toBeDefined();
    expect(store.take(3, 101)).toBeDefined();
    expect(store.take(4, 101)).toBeDefined();
    const bounded = createShownSignals();
    for (let user = 1; user <= 10_001; user += 1) bounded.remember(user, 'list', 1, [record(101)]);
    expect(bounded.size()).toBe(10_000);
    expect(bounded.take(1, 101)).toBeUndefined();
    expect(bounded.take(10_001, 101)).toBeDefined();
  });

  it("SS6: a list's records written in one remember share its source and time", () => {
    const store = createShownSignals();
    const records = Array.from({ length: 12 }, (_, i) => record(100 + i));
    store.remember(7, 'list', 5_000, records);
    for (const one of records) {
      expect(store.take(7, one.assetId)).toEqual({
        action: 'up',
        second: one.second,
        decidedAt: one.decidedAt,
        shownAtMs: 5_000,
        source: 'list',
      });
    }
  });

  it('SS7: size counts the users with records; an empty write adds none', () => {
    const store = createShownSignals();
    store.remember(7, 'list', 5_000, []);
    expect(store.size()).toBe(0);
    store.remember(7, 'list', 5_000, [record(101)]);
    store.remember(8, 'list', 5_000, [record(101)]);
    expect(store.size()).toBe(2);
    store.take(7, 101);
    expect(store.size()).toBe(1);
  });
});
