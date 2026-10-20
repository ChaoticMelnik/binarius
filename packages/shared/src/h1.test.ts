import { describe, expect, it } from 'vitest';
import { breakEvenPct, MIN_CYCLE_PAYOUT_PCT } from './catalog';
import {
  H1_ENTRY_WINDOW_SEC,
  H1_EXPIRY_SEC,
  H1_MIN_PAYOUT_PCT,
  H1_VERSION,
  h1DecisionSchema,
} from './h1';
import { SIGNAL_VERSION_PATTERN } from './trade-log';

const features = { move: 3, sd: 1, z: 3, moves: 60, lastClose: 1004 };
const signal = { kind: 'signal', version: 'h1', action: 'up', features };

describe('the H1 decision wire (#667)', () => {
  it('H-S1: every shape the detector returns parses, a malformed one is refused', () => {
    for (const decision of [
      signal,
      { ...signal, action: 'down', features: { ...features, move: -3, lastClose: 996 } },
      { kind: 'no_signal', version: 'h1', reason: 'below_threshold', features },
      { kind: 'no_signal', version: 'h1', reason: 'no_price', detail: { missing: 'last' } },
      { kind: 'no_signal', version: 'h1', reason: 'no_price', detail: { missing: 'before' } },
      { kind: 'no_signal', version: 'h1', reason: 'no_volatility', detail: { moves: 60 } },
    ]) {
      expect(h1DecisionSchema.safeParse(decision).success, JSON.stringify(decision)).toBe(true);
    }
    for (const decision of [
      { ...signal, features: { ...features, z: Infinity } },
      { ...signal, features: { ...features, z: NaN } },
      { ...signal, features: { ...features, sd: 0 } },
      { ...signal, features: { ...features, moves: 0 } },
      { ...signal, extra: 1 },
      { ...signal, version: 'v2' },
      { kind: 'no_signal', version: 'h1', reason: 'no_history', detail: { moves: 0 } },
      { kind: 'no_signal', version: 'h1', reason: 'no_volatility', detail: { moves: 0 } },
      { kind: 'no_signal', version: 'h1', reason: 'no_price', detail: { missing: 'next' } },
    ]) {
      expect(h1DecisionSchema.safeParse(decision).success, JSON.stringify(decision)).toBe(false);
    }
  });

  it('H-S2: the version fits the decision log version column of #666', () => {
    expect(H1_VERSION).toMatch(SIGNAL_VERSION_PATTERN);
  });

  it('H-S3: the trade plan opens after the closed second and pays above the cycle floor', () => {
    expect(H1_ENTRY_WINDOW_SEC.from).toBeGreaterThanOrEqual(1);
    expect(H1_ENTRY_WINDOW_SEC.to).toBeGreaterThanOrEqual(H1_ENTRY_WINDOW_SEC.from);
    expect(H1_EXPIRY_SEC).toBeGreaterThan(0);
    expect(H1_MIN_PAYOUT_PCT).toBeGreaterThan(MIN_CYCLE_PAYOUT_PCT);
    expect(breakEvenPct(H1_MIN_PAYOUT_PCT)).toBeLessThan(52);
  });
});
