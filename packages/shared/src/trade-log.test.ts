import { describe, expect, it } from 'vitest';
import {
  DecisionTicksDetail,
  DecisionTicksStatus,
  shadowTicksSampled,
  SIGNAL_DECISION_DETAIL_PATTERN,
  SIGNAL_VERSION_PATTERN,
  SignalDecisionContext,
  SignalDecisionOutcome,
  tradeLogTicksSchema,
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

describe('the ticks around a decision (#668)', () => {
  it('TL1 the shadow sample is 1 in 20 by the uuid head', () => {
    expect(shadowTicksSampled('00000000-0000-4000-8000-000000000000')).toBe(true);
    expect(shadowTicksSampled('00140000-0000-4000-8000-000000000000')).toBe(true);
    expect(shadowTicksSampled('00150000-0000-4000-8000-000000000000')).toBe(false);
    expect(shadowTicksSampled('21ff81cf-0000-4000-8000-000000000000')).toBe(false);
    let sampled = 0;
    for (let i = 0; i < 10_000; i += 1) {
      const head = Math.floor(Math.random() * 0x10000)
        .toString(16)
        .padStart(4, '0');
      if (shadowTicksSampled(`${head}0000-0000-4000-8000-000000000000`)) sampled += 1;
    }
    expect(sampled / 10_000).toBeGreaterThan(0.03);
    expect(sampled / 10_000).toBeLessThan(0.07);
  });

  const row = (over: Record<string, unknown>) => ({
    status: DecisionTicksStatus.Complete,
    detail: null,
    fromMs: 1_000,
    untilMs: 2_000,
    count: 1,
    rows: [[1_500, 1_510, 1.25]],
    ...over,
  });

  it('TL2 the export ticks schema accepts each status and refuses a malformed row', () => {
    expect(tradeLogTicksSchema.safeParse(row({})).success).toBe(true);
    expect(
      tradeLogTicksSchema.safeParse(
        row({ status: DecisionTicksStatus.Truncated, detail: DecisionTicksDetail.Hole }),
      ).success,
    ).toBe(true);
    expect(
      tradeLogTicksSchema.safeParse(
        row({
          status: DecisionTicksStatus.Unavailable,
          detail: DecisionTicksDetail.Quiet,
          count: 0,
          rows: [],
        }),
      ).success,
    ).toBe(true);
    expect(tradeLogTicksSchema.safeParse(row({ rows: [[1_500, 1_510, 0]] })).success).toBe(false);
    expect(tradeLogTicksSchema.safeParse(row({ rows: [[1_500, 1_510, 1.25, 1]] })).success).toBe(
      false,
    );
    expect(
      tradeLogTicksSchema.safeParse(row({ status: 'truncated', detail: 'restart' })).success,
    ).toBe(false);
    expect(tradeLogTicksSchema.safeParse(row({ detail: DecisionTicksDetail.Hole })).success).toBe(
      false,
    );
    expect(tradeLogTicksSchema.safeParse(row({ count: 2 })).success).toBe(false);
  });
});
