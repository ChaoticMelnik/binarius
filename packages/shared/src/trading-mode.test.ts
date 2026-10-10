import { describe, expect, it } from 'vitest';
import {
  safeParseSetTradingModeRequest,
  safeParseSetTradingModeResponse,
  safeParseTradingModeRefusal,
  TradingModeErrorCode,
} from './trading-mode';

describe('safeParseSetTradingModeRequest', () => {
  it.each(['demo', 'real'])('accepts mode %s', (mode) => {
    const input = { telegramUserId: '42', mode };
    const parsed = safeParseSetTradingModeRequest(input);
    expect(parsed.success && parsed.data).toEqual(input);
  });

  it.each([
    ['an unknown mode', { telegramUserId: '42', mode: 'paper' }],
    ['no mode', { telegramUserId: '42' }],
    ['a numeric id', { telegramUserId: 42, mode: 'demo' }],
    ['an unknown key', { telegramUserId: '42', mode: 'demo', amount: '1' }],
  ])('refuses %s', (_label, input) => {
    expect(safeParseSetTradingModeRequest(input).success).toBe(false);
  });
});

describe('safeParseSetTradingModeResponse', () => {
  it('accepts the mode and whether it changed', () => {
    const input = { tradingMode: 'real', changed: true };
    const parsed = safeParseSetTradingModeResponse(input);
    expect(parsed.success && parsed.data).toEqual(input);
  });

  it.each([
    ['without changed', { tradingMode: 'demo' }],
    ['an unknown mode', { tradingMode: 'paper', changed: false }],
    ['an unknown key', { tradingMode: 'demo', changed: false, extra: 1 }],
  ])('refuses a body %s', (_label, input) => {
    expect(safeParseSetTradingModeResponse(input).success).toBe(false);
  });
});

describe('safeParseTradingModeRefusal', () => {
  it.each(Object.values(TradingModeErrorCode))('accepts %s', (error) => {
    expect(safeParseTradingModeRefusal({ error }).success).toBe(true);
  });

  it.each([
    ['an unknown code', { error: 'stake_below_minimum' }],
    ['an unknown key', { error: 'demo_only', limits: {} }],
  ])('refuses %s', (_label, input) => {
    expect(safeParseTradingModeRefusal(input).success).toBe(false);
  });
});
