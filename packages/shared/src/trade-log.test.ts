import { describe, expect, it } from 'vitest';
import {
  SIGNAL_DECISION_DETAIL_PATTERN,
  SIGNAL_VERSION_PATTERN,
  SignalDecisionContext,
  SignalDecisionOutcome,
} from './trade-log';
import { TradeIntentErrorCode } from './trading';
import { TradingSessionErrorCode } from './trading-session';

describe('trade log identifiers (#666)', () => {
  it.each(['v1', 'v2', 'h1', 'a-b_c', 'x'.repeat(16)])('T-id1 version %s fits', (version) => {
    expect(SIGNAL_VERSION_PATTERN.test(version)).toBe(true);
  });

  it.each(['', 'V2', 'v 2', 'x'.repeat(17), "v2'", 'v2\n'])(
    'T-id1 version %j is refused',
    (version) => {
      expect(SIGNAL_VERSION_PATTERN.test(version)).toBe(false);
    },
  );

  it('T-id2 every refusal code a writer records fits the detail pattern', () => {
    for (const code of [
      ...Object.values(TradeIntentErrorCode),
      ...Object.values(TradingSessionErrorCode),
    ]) {
      expect(SIGNAL_DECISION_DETAIL_PATTERN.test(code), code).toBe(true);
    }
    expect(SIGNAL_DECISION_DETAIL_PATTERN.test('x'.repeat(65))).toBe(false);
    expect(SIGNAL_DECISION_DETAIL_PATTERN.test('a-b')).toBe(false);
  });

  it('T-id3 every context and outcome is a bare identifier for the CHECK', () => {
    for (const value of [
      ...Object.values(SignalDecisionContext),
      ...Object.values(SignalDecisionOutcome),
    ]) {
      expect(value).toMatch(/^[a-z0-9_]+$/);
    }
  });
});
