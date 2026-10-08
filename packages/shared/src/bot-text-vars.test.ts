import { describe, expect, it } from 'vitest';
import { formatAge, formatCount, formatStake, formatUsd } from './bot-text-format';
import { BOT_TEXT_WIDTHS } from './bot-text-messages';
import { BOT_TEXT_VARS, MODE_LABELS, type BotTextVarFallbackKey } from './bot-text-vars';
import type { DecimalString } from './money';

const texts = (key: BotTextVarFallbackKey): string => `«${key}»`;
const money = (value: string) => value as DecimalString;
const COUNT = '9223372036854775807';
const W = BOT_TEXT_WIDTHS;

describe('BOT_TEXT_VARS', () => {
  it('V1 prints a balance only from a fresh snapshot', () => {
    const { demoBalance, realBalance } = BOT_TEXT_VARS;
    expect(demoBalance.format({ amount: money('10000.5'), fresh: true }, texts)).toBe(
      '$10\u00a0000.50',
    );
    expect(demoBalance.format({ amount: money('10000.5'), fresh: false }, texts)).toBe(
      '«balanceUnavailable»',
    );
    expect(demoBalance.format(null, texts)).toBe('«balanceUnavailable»');
    expect(realBalance.format({ amount: money('1234.56'), fresh: false }, texts)).toBe(
      '«balanceUnavailable»',
    );
  });

  it('V1 stands in for an unknown address and an unchosen stake with their texts', () => {
    expect(BOT_TEXT_VARS.email.format(null, texts)).toBe('«accountUnknownAddress»');
    expect(BOT_TEXT_VARS.email.format('ada@example.com', texts)).toBe('ada@example.com');
    expect(BOT_TEXT_VARS.stake.format(null, texts)).toBe('«stakeMinimumLabel»');
    expect(BOT_TEXT_VARS.stake.format(money('5'), texts)).toBe('$5.00');
  });

  it('V1 formats counts, money, the mode, the level, the age and the name', () => {
    expect(BOT_TEXT_VARS.tokens.format('1234', texts)).toBe(formatCount('1234'));
    expect(BOT_TEXT_VARS.reservedTokens.format('3', texts)).toBe('3');
    expect(BOT_TEXT_VARS.minStake.format(money('0.005'), texts)).toBe('$0.005');
    expect(BOT_TEXT_VARS.demoAvailable.format(money('9990'), texts)).toBe(formatStake('9990'));
    expect(BOT_TEXT_VARS.mode.format('demo', texts)).toBe(MODE_LABELS.demo);
    expect(BOT_TEXT_VARS.mode.format('real', texts)).toBe('REAL');
    expect(BOT_TEXT_VARS.level.format('all', texts)).toBe('«levelAll»');
    expect(BOT_TEXT_VARS.level.format('reduced', texts)).toBe('«levelReduced»');
    expect(BOT_TEXT_VARS.level.format('off', texts)).toBe('«levelOff»');
    expect(BOT_TEXT_VARS.age.format(75, texts)).toBe('1 мин');
    expect(BOT_TEXT_VARS.firstName.format(' Ада ', texts)).toBe('Ада');
    expect(BOT_TEXT_VARS.bonusTokens.format('100', texts)).toBe('100');
  });

  // the defaults of BOT_TEXT_VAR_DEFAULT_WIDTHS rest on these (docs/bot-texts.md → Assumptions)
  it('V2 takes the widths of the formatters at the edge of their domains', () => {
    expect(formatUsd('-999999999999.99999999')).toHaveLength(W.usd);
    expect(formatStake('999999999999.99999999')).toHaveLength(W.stake);
    expect(formatUsd('0')).toHaveLength(W.zeroUsd);
    expect(formatCount(COUNT)).toHaveLength(W.count);
    expect(COUNT).toHaveLength(W.rawCount);
    expect(formatAge(99_999 * 60)).toHaveLength(W.age);
  });

  it.each(Object.entries(BOT_TEXT_VARS))(
    'V4 names %s as a placeholder and describes it',
    (name, variable) => {
      expect(name).toMatch(/^[a-z][a-zA-Z0-9]*$/);
      expect(variable.description.trim()).not.toBe('');
      expect(variable.description.length).toBeLessThanOrEqual(200);
      expect(variable.sample.trim()).not.toBe('');
    },
  );
});
