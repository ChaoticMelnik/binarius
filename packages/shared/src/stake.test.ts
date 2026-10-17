import { describe, expect, it } from 'vitest';
import { decimalStringSchema, type DecimalString } from './money';
import {
  checkStake,
  decimalLessThan,
  parseStakeInput,
  STAKE_AMOUNT_PATTERN,
  STAKE_RISK_THRESHOLD,
  StakeRefusal,
  stakeIsRisky,
  stakePresets,
  stakeScale,
  type StakeLimits,
} from './stake';
import { tradeAmountSchema } from './trading';
import {
  safeParseSetStakeRequest,
  safeParseSetStakeResponse,
  safeParseStakeRefusal,
} from './trading-access';
import { stakeSettingsFor, stakeSettingsFrom } from './trading-session';

const d = (value: string): DecimalString => decimalStringSchema.parse(value);
const limits = (minTradeAmount: string, available: string): StakeLimits => ({
  minTradeAmount: d(minTradeAmount),
  available: d(available),
});

describe('stakeScale', () => {
  it.each([
    ['1.00000000', 2],
    ['1', 2],
    ['0.5', 2],
    ['0.001', 3],
    ['0.00000001', 8],
  ])('min %s → %i', (min, scale) => {
    expect(stakeScale(d(min))).toBe(scale);
  });
});

describe('checkStake', () => {
  const snapshot = limits('1.00000000', '100.00000000');

  it.each([
    ['1', null],
    ['1.5', null],
    ['1.50', null],
    ['100', null],
    ['100.00000000', null],
    ['1.234', StakeRefusal.Precision],
    ['0.99', StakeRefusal.BelowMinimum],
    ['100.01', StakeRefusal.AboveAvailable],
  ])('%s → %s', (amount, refusal) => {
    expect(checkStake(d(amount), snapshot)).toBe(refusal);
  });

  it('checks precision first, then the minimum, then the balance', () => {
    expect(checkStake(d('0.001'), limits('1', '0'))).toBe(StakeRefusal.Precision);
    expect(checkStake(d('0.5'), limits('1', '0'))).toBe(StakeRefusal.BelowMinimum);
  });

  it('allows the minimum scale of a finer broker minimum', () => {
    expect(checkStake(d('0.005'), limits('0.001', '1'))).toBeNull();
    expect(checkStake(d('0.0005'), limits('0.001', '1'))).toBe(StakeRefusal.Precision);
  });

  it('compares by value across 8 fraction digits, not by spelling', () => {
    expect(checkStake(d('0.01'), limits('0.01000000', '0.01000000'))).toBeNull();
    expect(checkStake(d('999999999999.99'), limits('1', '999999999999.98999999'))).toBe(
      StakeRefusal.AboveAvailable,
    );
  });

  it('refuses everything against a negative balance', () => {
    expect(checkStake(d('1'), limits('1', '-5'))).toBe(StakeRefusal.AboveAvailable);
  });
});

describe('stakePresets', () => {
  it('multiplies the minimum and keeps the canonical spelling', () => {
    expect(stakePresets(limits('1.00000000', '10000.00000000'))).toEqual(['1', '2', '5', '10']);
    expect(stakePresets(limits('0.3', '100'))).toEqual(['0.3', '0.6', '1.5', '3']);
  });

  it('drops presets above the available balance, keeping one equal to it', () => {
    expect(stakePresets(limits('1', '5'))).toEqual(['1', '2', '5']);
    expect(stakePresets(limits('1', '0.5'))).toEqual([]);
  });

  it('offers nothing for a minimum of 0', () => {
    expect(stakePresets(limits('0', '100'))).toEqual([]);
  });

  it('drops presets outside numeric(20,8)', () => {
    const presets = stakePresets(limits('200000000000', '999999999999.99999999'));
    expect(presets).toEqual(['200000000000', '400000000000']);
    for (const preset of presets) expect(tradeAmountSchema.safeParse(preset).success).toBe(true);
  });
});

describe('parseStakeInput', () => {
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
    expect(parseStakeInput(text)).toBe(amount);
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
    expect(parseStakeInput(text)).toBeUndefined();
  });

  it('accepts only what tradeAmountSchema accepts', () => {
    for (const text of ['1', '0.00000001', '999999999999.99999999', '12.5']) {
      const parsed = parseStakeInput(text);
      expect(parsed !== undefined && tradeAmountSchema.safeParse(parsed).success).toBe(true);
    }
  });
});

describe('STAKE_AMOUNT_PATTERN', () => {
  it('is numeric(20,8) without a capturing group', () => {
    expect(STAKE_AMOUNT_PATTERN).toBe(String.raw`\d{1,12}(?:\.\d{1,8})?`);
    const amount = new RegExp(`^${STAKE_AMOUNT_PATTERN}$`);
    expect(amount.test('999999999999.99999999')).toBe(true);
    expect(amount.test('1000000000000')).toBe(false);
    expect(amount.test('0.000000001')).toBe(false);
  });
});

describe('stakeSettingsFrom', () => {
  it('keeps stakeSettingsFor exactly without a saved stake', () => {
    for (const min of ['1.00000000', '0.5', '0']) {
      expect(stakeSettingsFrom(null, d(min))).toEqual(stakeSettingsFor(d(min)));
    }
  });

  it('takes the saved stake, with a scale of at least 2', () => {
    expect(stakeSettingsFrom(d('5.00000000'), d('1.00000000'))).toEqual({
      baseStake: '5',
      stakeScale: 2,
    });
  });

  it("takes the minimum's grid, not the stake's own fraction length", () => {
    expect(stakeSettingsFrom(d('2.5'), d('0.001'))).toEqual({ baseStake: '2.5', stakeScale: 3 });
    expect(stakeSettingsFrom(d('5'), d('0.001'))).toEqual({ baseStake: '5', stakeScale: 3 });
  });
});

describe('POST /trading/stake contracts', () => {
  it('takes a mode and an amount or null, strictly', () => {
    for (const mode of ['demo', 'real']) {
      expect(safeParseSetStakeRequest({ telegramUserId: '1', mode, amount: '5' }).success).toBe(
        true,
      );
      expect(safeParseSetStakeRequest({ telegramUserId: '1', mode, amount: null }).success).toBe(
        true,
      );
    }
    for (const amount of ['0', '-1', '1.123456789', 5, undefined]) {
      expect(safeParseSetStakeRequest({ telegramUserId: '1', mode: 'demo', amount }).success).toBe(
        false,
      );
    }
    expect(safeParseSetStakeRequest({ telegramUserId: '1', amount: '5' }).success).toBe(false);
    expect(
      safeParseSetStakeRequest({ telegramUserId: '1', mode: 'both', amount: '5' }).success,
    ).toBe(false);
    expect(
      safeParseSetStakeRequest({ telegramUserId: '1', mode: 'demo', amount: '5', extra: 1 })
        .success,
    ).toBe(false);
  });

  it('answers the mode and the saved stake or null', () => {
    expect(safeParseSetStakeResponse({ mode: 'real', stake: '5' }).success).toBe(true);
    expect(safeParseSetStakeResponse({ mode: 'demo', stake: null }).success).toBe(true);
    expect(safeParseSetStakeResponse({ stake: '5' }).success).toBe(false);
    expect(safeParseSetStakeResponse({ demoStake: '5' }).success).toBe(false);
  });

  it("carries the limits with the mode's balance on a bounds refusal only", () => {
    const limitsBody = { minTradeAmount: '1', available: '10', scale: 2 };
    expect(
      safeParseStakeRefusal({ error: 'stake_below_minimum', limits: limitsBody }).success,
    ).toBe(true);
    expect(
      safeParseStakeRefusal({ error: 'insufficient_balance', limits: limitsBody }).success,
    ).toBe(true);
    expect(
      safeParseStakeRefusal({
        error: 'stake_below_minimum',
        limits: { minTradeAmount: '1', demoAvailable: '10', scale: 2 },
      }).success,
    ).toBe(false);
    expect(safeParseStakeRefusal({ error: 'stake_below_minimum' }).success).toBe(false);
    expect(safeParseStakeRefusal({ error: 'balance_unavailable' }).success).toBe(true);
    expect(safeParseStakeRefusal({ error: 'user_not_found' }).success).toBe(true);
    expect(safeParseStakeRefusal({ error: 'validation' }).success).toBe(false);
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

// #476: the «· риск» mark from $10 inclusive, compared in bigint at scale 8 (Rule 2)
describe('stakeIsRisky', () => {
  it('marks from $10, inclusive', () => {
    expect(STAKE_RISK_THRESHOLD).toBe('10');
    expect(stakeIsRisky(d('10'))).toBe(true);
    expect(stakeIsRisky(d('10.00000000'))).toBe(true);
  });

  it.each([
    ['9.99', false],
    ['9.99999999', false],
    ['10.00000001', true],
    ['999999999999.99999999', true],
    ['1', false],
  ])('%s is risky: %s', (amount, expected) => {
    expect(stakeIsRisky(d(amount))).toBe(expected);
  });
});
