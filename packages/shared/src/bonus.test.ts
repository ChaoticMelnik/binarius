import { describe, expect, it } from 'vitest';
import {
  BONUS_RULE_TOKENS_MAX,
  bonusRuleParamsProblem,
  isBonusRuleKind,
  parseBonusRuleParams,
} from './bonus';

describe('parseBonusRuleParams', () => {
  it.each(['link_bonus', 'referral_reward'] as const)('reads %s tokens as a bigint', (kind) => {
    expect(parseBonusRuleParams(kind, { tokens: '150' })).toEqual({ tokens: 150n });
    expect(parseBonusRuleParams(kind, { tokens: '1' })).toEqual({ tokens: 1n });
    expect(parseBonusRuleParams(kind, { tokens: String(BONUS_RULE_TOKENS_MAX) })).toEqual({
      tokens: BONUS_RULE_TOKENS_MAX,
    });
  });

  it.each([
    ['a JSON number', { tokens: 150 }],
    ['zero', { tokens: '0' }],
    ['a leading zero', { tokens: '0150' }],
    ['a sign', { tokens: '-5' }],
    ['a fraction', { tokens: '1.5' }],
    ['one over the cap', { tokens: String(BONUS_RULE_TOKENS_MAX + 1n) }],
    ['an unknown key', { tokens: '5', extra: 1 }],
    ['no tokens', {}],
    ['not an object', '5'],
  ])('refuses a fixed-tokens rule with %s', (_label, params) => {
    expect(parseBonusRuleParams('link_bonus', params)).toBeUndefined();
    expect(bonusRuleParamsProblem('link_bonus', params)).toEqual(expect.any(String));
  });

  it('reads the deposit_bonus shape as decimal strings', () => {
    const params = { tokensPerUsd: '0.5', minAmountUsd: '0', maxTokens: '500' };
    expect(parseBonusRuleParams('deposit_bonus', params)).toEqual(params);
    expect(bonusRuleParamsProblem('deposit_bonus', params)).toBeUndefined();
  });

  it.each([
    ['a missing field', { tokensPerUsd: '1', minAmountUsd: '0' }],
    ['a zero rate', { tokensPerUsd: '0', minAmountUsd: '0', maxTokens: '5' }],
    ['a negative minimum', { tokensPerUsd: '1', minAmountUsd: '-1', maxTokens: '5' }],
    ['a zero cap', { tokensPerUsd: '1', minAmountUsd: '0', maxTokens: '0' }],
    ['a number', { tokensPerUsd: 1, minAmountUsd: '0', maxTokens: '5' }],
    ['nine fraction digits', { tokensPerUsd: '0.123456789', minAmountUsd: '0', maxTokens: '5' }],
    ['an unknown key', { tokensPerUsd: '1', minAmountUsd: '0', maxTokens: '5', tokens: '1' }],
  ])('refuses a deposit_bonus with %s', (_label, params) => {
    expect(parseBonusRuleParams('deposit_bonus', params)).toBeUndefined();
  });

  it('names the field of the first problem', () => {
    expect(bonusRuleParamsProblem('link_bonus', { tokens: '1001' })).toBe(
      'tokens: expected at most 1000 tokens',
    );
  });
});

describe('isBonusRuleKind', () => {
  it('knows the three kinds and nothing else', () => {
    expect(['link_bonus', 'referral_reward', 'deposit_bonus'].every(isBonusRuleKind)).toBe(true);
    expect(isBonusRuleKind('promo')).toBe(false);
  });
});
