import { describe, expect, it } from 'vitest';
import { createLoginDialog } from './login-dialog';

const clock = (start = 1_000) => {
  let at = start;
  return {
    now: () => at,
    advance: (ms: number) => {
      at += ms;
    },
  };
};

describe('createLoginDialog', () => {
  it('returns what was set, and nothing after delete', () => {
    const dialog = createLoginDialog();
    dialog.set(1, { step: 'code', email: 'ada@example.test' });
    expect(dialog.get(1)).toEqual({ step: 'code', email: 'ada@example.test' });
    expect(dialog.get(2)).toBeUndefined();

    dialog.delete(1);
    expect(dialog.get(1)).toBeUndefined();
  });

  it('keeps an entry until the last millisecond of its TTL and drops it at the TTL', () => {
    const time = clock();
    const dialog = createLoginDialog({ ttlMs: 100, now: time.now });
    dialog.set(1, { step: 'email' });

    time.advance(99);
    expect(dialog.get(1)).toEqual({ step: 'email' });
    time.advance(1);
    expect(dialog.get(1)).toBeUndefined();
  });

  it('gives an entry a new TTL on every set', () => {
    const time = clock();
    const dialog = createLoginDialog({ ttlMs: 100, now: time.now });
    dialog.set(1, { step: 'email' });
    time.advance(60);
    dialog.set(1, { step: 'code', email: 'ada@example.test' });
    time.advance(60);
    expect(dialog.get(1)).toEqual({ step: 'code', email: 'ada@example.test' });
  });

  it('evicts the oldest entry when a new user arrives at the cap', () => {
    const dialog = createLoginDialog({ maxEntries: 2 });
    dialog.set(1, { step: 'email' });
    dialog.set(2, { step: 'email' });
    dialog.set(3, { step: 'email' });

    expect(dialog.get(1)).toBeUndefined();
    expect(dialog.get(2)).toEqual({ step: 'email' });
    expect(dialog.get(3)).toEqual({ step: 'email' });
  });

  it('does not evict first an entry that was set again after it was created', () => {
    const dialog = createLoginDialog({ maxEntries: 2 });
    dialog.set(1, { step: 'email' });
    dialog.set(2, { step: 'email' });
    dialog.set(1, { step: 'code', email: 'ada@example.test' });
    dialog.set(3, { step: 'email' });

    expect(dialog.get(1)).toEqual({ step: 'code', email: 'ada@example.test' });
    expect(dialog.get(2)).toBeUndefined();
  });

  it('evicts nothing when a user already in a full dialog moves to the next step', () => {
    const dialog = createLoginDialog({ maxEntries: 2 });
    dialog.set(1, { step: 'email' });
    dialog.set(2, { step: 'email' });
    dialog.set(2, { step: 'code', email: 'ada@example.test' });

    expect(dialog.get(1)).toEqual({ step: 'email' });
    expect(dialog.get(2)).toEqual({ step: 'code', email: 'ada@example.test' });
  });
});
