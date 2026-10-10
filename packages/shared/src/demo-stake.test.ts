import { describe, expect, it } from 'vitest';
import {
  checkDemoStake,
  decimalLessThan,
  DemoStakeRefusal,
  demoStakePresets,
  demoStakeScale,
  parseDemoStakeInput,
  type DemoStakeLimits,
} from './demo-stake';
import { decimalStringSchema, type DecimalString } from './money';
import { tradeAmountSchema } from './trading';
import {
  safeParseDemoStakeRefusal,
  safeParseSetDemoStakeRequest,
  safeParseSetDemoStakeResponse,
} from './trading-access';
import { demoStakeSettings, stakeSettingsFor } from './trading-session';

const d = (value: string): DecimalString => decimalStringSchema.parse(value);
const limits = (minTradeAmount: string, demoAvailable: string): DemoStakeLimits => ({
  minTradeAmount: d(minTradeAmount),
  demoAvailable: d(demoAvailable),
});

describe('demoStakeScale', () => {
  it.each([
    ['1.00000000', 2],
    ['1', 2],
    ['0.5', 2],
    ['0.001', 3],
    ['0.00000001', 8],
  ])('min %s → %i', (min, scale) => {
    expect(demoStakeScale(d(min))).toBe(scale);
  });
});

describe('checkDemoStake', () => {
  const snapshot = limits('1.00000000', '100.00000000');

  it.each([
    ['1', null],
    ['1.5', null],
    ['1.50', null],
    ['100', null],
    ['100.00000000', null],
    ['1.234', DemoStakeRefusal.Precision],
    ['0.99', DemoStakeRefusal.BelowMinimum],
    ['100.01', DemoStakeRefusal.AboveAvailable],
  ])('%s → %s', (amount, refusal) => {
    expect(checkDemoStake(d(amount), snapshot)).toBe(refusal);
  });

  it('checks precision first, then the minimum, then the balance', () => {
    expect(checkDemoStake(d('0.001'), limits('1', '0'))).toBe(DemoStakeRefusal.Precision);
    expect(checkDemoStake(d('0.5'), limits('1', '0'))).toBe(DemoStakeRefusal.BelowMinimum);
  });

  it('allows the minimum scale of a finer broker minimum', () => {
    expect(checkDemoStake(d('0.005'), limits('0.001', '1'))).toBeNull();
    expect(checkDemoStake(d('0.0005'), limits('0.001', '1'))).toBe(DemoStakeRefusal.Precision);
  });

  it('compares by value across 8 fraction digits, not by spelling', () => {
    expect(checkDemoStake(d('0.01'), limits('0.01000000', '0.01000000'))).toBeNull();
    expect(checkDemoStake(d('999999999999.99'), limits('1', '999999999999.98999999'))).toBe(
      DemoStakeRefusal.AboveAvailable,
    );
  });

  it('refuses everything against a negative demo balance', () => {
    expect(checkDemoStake(d('1'), limits('1', '-5'))).toBe(DemoStakeRefusal.AboveAvailable);
  });
});

describe('demoStakePresets', () => {
  it('multiplies the minimum and keeps the canonical spelling', () => {
    expect(demoStakePresets(limits('1.00000000', '10000.00000000'))).toEqual(['1', '2', '5', '10']);
    expect(demoStakePresets(limits('0.3', '100'))).toEqual(['0.3', '0.6', '1.5', '3']);
  });

  it('drops presets above the demo balance, keeping one equal to it', () => {
    expect(demoStakePresets(limits('1', '5'))).toEqual(['1', '2', '5']);
    expect(demoStakePresets(limits('1', '0.5'))).toEqual([]);
  });

  it('offers nothing for a minimum of 0', () => {
    expect(demoStakePresets(limits('0', '100'))).toEqual([]);
  });

  it('drops presets outside numeric(20,8)', () => {
    const presets = demoStakePresets(limits('200000000000', '999999999999.99999999'));
    expect(presets).toEqual(['200000000000', '400000000000']);
    for (const preset of presets) expect(tradeAmountSchema.safeParse(preset).success).toBe(true);
  });
});

describe('parseDemoStakeInput', () => {
  it.each([
    ['5', '5'],
    [' 5 ', '5'],
    ['1,5', '1.5'],
    ['1.50', '1.5'],
    ['01.5', '1.5'],
    ['2,50', '2.5'],
    ['1.234', '1.234'],
    ['0.00000001', '0.00000001'],
    ['999999999999.99999999', '999999999999.99999999'],
  ])('%j → %s', (text, amount) => {
    expect(parseDemoStakeInput(text)).toBe(amount);
  });

  it.each([
    'abc',
    '-5',
    '0',
    '0,00',
    '1 000',
    '1e3',
    '1.2.3',
    '1,2.3',
    '1,2,3',
    '.5',
    '5.',
    '0.000000001',
    '1000000000000',
    '',
    '+5',
  ])('refuses %j', (text) => {
    expect(parseDemoStakeInput(text)).toBeUndefined();
  });

  it('accepts only what tradeAmountSchema accepts', () => {
    for (const text of ['1', '0.00000001', '999999999999.99999999', '12.5']) {
      const parsed = parseDemoStakeInput(text);
      expect(parsed !== undefined && tradeAmountSchema.safeParse(parsed).success).toBe(true);
    }
  });
});

describe('demoStakeSettings', () => {
  it('keeps stakeSettingsFor exactly without a saved stake', () => {
    for (const min of ['1.00000000', '0.5', '0']) {
      expect(demoStakeSettings(null, d(min))).toEqual(stakeSettingsFor(d(min)));
    }
  });

  it('takes the saved stake, with a scale of at least 2', () => {
    expect(demoStakeSettings(d('5.00000000'), d('1.00000000'))).toEqual({
      baseStake: '5',
      stakeScale: 2,
    });
  });

  it("widens the scale by the stake's own fraction length", () => {
    expect(demoStakeSettings(d('0.0003'), d('1'))).toEqual({
      baseStake: '0.0003',
      stakeScale: 4,
    });
    expect(demoStakeSettings(d('5'), d('0.001'))).toEqual({ baseStake: '5', stakeScale: 3 });
  });
});

describe('POST /trading/demo-stake contracts', () => {
  it('takes an amount or null, strictly', () => {
    expect(safeParseSetDemoStakeRequest({ telegramUserId: '1', amount: '5' }).success).toBe(true);
    expect(safeParseSetDemoStakeRequest({ telegramUserId: '1', amount: null }).success).toBe(true);
    for (const amount of ['0', '-1', '1.123456789', 5, undefined]) {
      expect(safeParseSetDemoStakeRequest({ telegramUserId: '1', amount }).success).toBe(false);
    }
    expect(
      safeParseSetDemoStakeRequest({ telegramUserId: '1', amount: '5', extra: 1 }).success,
    ).toBe(false);
  });

  it('answers the saved stake or null', () => {
    expect(safeParseSetDemoStakeResponse({ demoStake: '5' }).success).toBe(true);
    expect(safeParseSetDemoStakeResponse({ demoStake: null }).success).toBe(true);
    expect(safeParseSetDemoStakeResponse({}).success).toBe(false);
  });

  it('carries the limits on a bounds refusal only', () => {
    const limitsBody = { minTradeAmount: '1', demoAvailable: '10', scale: 2 };
    expect(
      safeParseDemoStakeRefusal({ error: 'stake_below_minimum', limits: limitsBody }).success,
    ).toBe(true);
    expect(safeParseDemoStakeRefusal({ error: 'stake_below_minimum' }).success).toBe(false);
    expect(safeParseDemoStakeRefusal({ error: 'balance_unavailable' }).success).toBe(true);
    expect(safeParseDemoStakeRefusal({ error: 'user_not_found' }).success).toBe(true);
    expect(safeParseDemoStakeRefusal({ error: 'validation' }).success).toBe(false);
  });
});

describe('decimalLessThan', () => {
  it.each([
    ['0.99', '1', true],
    ['1', '1.00000000', false],
    ['1.00000001', '1', false],
    ['0.00000001', '0.00000002', true],
    ['10', '9.99999999', false],
    ['123456789012.5', '123456789012.50000001', true],
  ])('%s < %s is %s', (a, b, expected) => {
    expect(decimalLessThan(d(a), d(b))).toBe(expected);
  });
});
