import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  BROKER_BALANCE_SLA_MS,
  BROKER_BALANCE_SLA_SEC,
  TRADING_ACCESS_BUDGET_MS,
  brokerBalanceViewSchema,
  isBalanceFresh,
  type BrokerBalanceUnavailableReason,
} from './broker-balance';

const view = {
  real: { available: '100.00000000', held: '0.00000000', total: '100.00000000' },
  demo: { available: '10000.00000000', held: '25.50000000', total: '10025.50000000' },
  minTradeAmount: '1.00000000',
  level: { code: 'standard', rank: 1 },
  restSnapshotAgeSec: 3,
  balanceEventAgeSec: null,
  fresh: true,
};

describe('brokerBalanceViewSchema', () => {
  it('accepts a view', () => {
    const parsed = brokerBalanceViewSchema.safeParse(view);
    expect(parsed.success && parsed.data).toEqual(view);
  });

  it.each([
    ['a stale REST age', { restSnapshotAgeSec: 61, balanceEventAgeSec: null, fresh: false }],
    ['the SLA itself', { restSnapshotAgeSec: 60, balanceEventAgeSec: null, fresh: true }],
    [
      'a recent event over a stale REST age',
      { restSnapshotAgeSec: 600, balanceEventAgeSec: 10, fresh: true },
    ],
  ])('accepts %s', (_label, ages) => {
    expect(brokerBalanceViewSchema.safeParse({ ...view, ...ages }).success).toBe(true);
  });

  it.each([
    ['fresh with stale ages', { restSnapshotAgeSec: 61, balanceEventAgeSec: 90, fresh: true }],
    ['stale with a fresh REST age', { restSnapshotAgeSec: 5, fresh: false }],
    ['a negative age', { restSnapshotAgeSec: -1 }],
    ['a fractional age', { balanceEventAgeSec: 1.5 }],
    ['a negative rank', { level: { code: 'standard', rank: -1 } }],
    ['a signed amount shape that is not decimal', { minTradeAmount: '1e3' }],
  ])('refuses %s', (_label, patch) => {
    expect(brokerBalanceViewSchema.safeParse({ ...view, ...patch }).success).toBe(false);
  });

  it('refuses a disagreeing flag with its own message', () => {
    const parsed = brokerBalanceViewSchema.safeParse({ ...view, fresh: false });
    expect(parsed.error?.issues.map((issue) => issue.message)).toEqual([
      'fresh must agree with the ages',
    ]);
  });

  it('strips unknown keys', () => {
    const parsed = brokerBalanceViewSchema.safeParse({ ...view, brokerAccountId: 'x' });
    expect(parsed.success && parsed.data).toEqual(view);
  });
});

describe('constants', () => {
  it('states the SLA once in two units', () => {
    expect(BROKER_BALANCE_SLA_MS).toBe(BROKER_BALANCE_SLA_SEC * 1000);
    expect(isBalanceFresh(BROKER_BALANCE_SLA_SEC, null)).toBe(true);
    expect(isBalanceFresh(BROKER_BALANCE_SLA_SEC + 1, null)).toBe(false);
  });

  it('gives the route a positive whole budget', () => {
    expect(Number.isInteger(TRADING_ACCESS_BUDGET_MS) && TRADING_ACCESS_BUDGET_MS > 0).toBe(true);
  });

  it('names exactly seven reasons', () => {
    expectTypeOf<BrokerBalanceUnavailableReason>().toEqualTypeOf<
      | 'no_account'
      | 'ambiguous_account'
      | 'account_pending'
      | 'account_revoked'
      | 'user_blocked'
      | 'refreshing'
      | 'broker_unavailable'
    >();
  });
});
