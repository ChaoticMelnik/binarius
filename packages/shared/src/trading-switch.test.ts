import { describe, expect, it } from 'vitest';
import { TRADING_SWITCH_REASON_MAX, tradingSwitchReasonSchema } from './trading-switch';

describe('tradingSwitchReasonSchema', () => {
  it('trims and accepts a reason at the bound', () => {
    const reason = 'я'.repeat(TRADING_SWITCH_REASON_MAX);
    expect(tradingSwitchReasonSchema.parse(`  ${reason}  `)).toBe(reason);
  });

  it('counts code points, not UTF-16 units', () => {
    expect(
      tradingSwitchReasonSchema.safeParse('😀'.repeat(TRADING_SWITCH_REASON_MAX)).success,
    ).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['spaces only', '   '],
    ['one over the bound', 'x'.repeat(TRADING_SWITCH_REASON_MAX + 1)],
    ['a line break', 'инцидент\nброкера'],
    ['a tab', 'инцидент\tброкера'],
    ['NUL', 'инцидент\u0000'],
  ])('refuses %s', (_label, raw) => {
    expect(tradingSwitchReasonSchema.safeParse(raw).success).toBe(false);
  });
});
