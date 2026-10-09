import { describe, expect, it } from 'vitest';
import { createFailureWindow, tripsAt } from './window';

const THRESHOLD = { minFailures: 10, failurePercent: 50 };

describe('the failure window (#96)', () => {
  it('W1 below the floor never trips, whatever the share', () => {
    const window = createFailureWindow(120_000);
    for (let i = 0; i < 9; i += 1) window.record(`k${i}`, true, 1_000);
    expect(window.stats(1_000)).toEqual({ failures: 9, total: 9 });
    expect(tripsAt(window.stats(1_000), THRESHOLD)).toBe(false);
  });

  it('W2 the floor reached under the share does not trip', () => {
    const window = createFailureWindow(120_000);
    for (let i = 0; i < 10; i += 1) window.record(`f${i}`, true, 1_000);
    for (let i = 0; i < 11; i += 1) window.record(`a${i}`, false, 1_000);
    expect(tripsAt(window.stats(1_000), THRESHOLD)).toBe(false);
  });

  it('W3 trips at exactly the floor and exactly the share', () => {
    const window = createFailureWindow(120_000);
    for (let i = 0; i < 10; i += 1) window.record(`f${i}`, true, 1_000);
    for (let i = 0; i < 10; i += 1) window.record(`a${i}`, false, 1_000);
    expect(window.stats(1_000)).toEqual({ failures: 10, total: 20 });
    expect(tripsAt(window.stats(1_000), THRESHOLD)).toBe(true);
  });

  it('W4 an event as old as the window drops out', () => {
    const window = createFailureWindow(120_000);
    window.record('old', true, 0);
    window.record('new', true, 60_000);
    expect(window.stats(119_999)).toEqual({ failures: 2, total: 2 });
    expect(window.stats(120_000)).toEqual({ failures: 1, total: 1 });
  });

  it('W5 a key that failed and then answered counts as answered', () => {
    const window = createFailureWindow(120_000);
    window.record('k', true, 1_000);
    window.record('k', false, 2_000);
    expect(window.stats(2_000)).toEqual({ failures: 0, total: 1 });
  });

  it('W6 one key failing twice counts once, and its latest time keeps it', () => {
    const window = createFailureWindow(120_000);
    window.record('k', true, 0);
    window.record('other', false, 1_000);
    window.record('k', true, 100_000);
    expect(window.stats(100_000)).toEqual({ failures: 1, total: 2 });
    // past the first event, before the second: k stays, other drops at 121 s
    expect(window.stats(121_000)).toEqual({ failures: 1, total: 1 });
  });

  it('clears to nothing', () => {
    const window = createFailureWindow(120_000);
    window.record('k', true, 0);
    window.clear();
    expect(window.stats(0)).toEqual({ failures: 0, total: 0 });
  });
});
