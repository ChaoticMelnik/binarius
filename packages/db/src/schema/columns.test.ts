import { describe, expect, it } from 'vitest';
import type { DecimalString } from '@binarius/shared';
import {
  MONEY_SHAPE,
  PAYOUT_MAX,
  PAYOUT_PRECISION,
  PAYOUT_SCALE,
  moneyInColumn,
  payoutInColumn,
} from './columns';

describe('payoutInColumn (#675)', () => {
  it.each<[string, number | null, number | null]>([
    ['null', null, null],
    ['NaN', Number.NaN, null],
    ['Infinity', Number.POSITIVE_INFINITY, null],
    ['-Infinity', Number.NEGATIVE_INFINITY, null],
    ['-0.0001', -0.0001, null],
    ['-0.00001', -0.00001, null],
    ['0', 0, 0],
    ['85.5', 85.5, 85.5],
    ['9999.9999', 9999.9999, 9999.9999],
    ['9999.99995', 9999.99995, null],
    ['10000', 10_000, null],
    ['1e21', 1e21, null],
  ])('C1 payoutInColumn(%s) is %s', (_label, value, expected) => {
    expect(payoutInColumn(value)).toBe(expected);
  });

  it("C2 PAYOUT_MAX is the column's own largest value", () => {
    expect(PAYOUT_MAX).toBe(9999.9999);
    expect(PAYOUT_MAX + 10 ** -PAYOUT_SCALE).toBe(10 ** (PAYOUT_PRECISION - PAYOUT_SCALE));
  });
});

describe('moneyInColumn (#675)', () => {
  it.each<[string, DecimalString | null]>([
    ['0', '0' as DecimalString],
    ['12.5', '12.5' as DecimalString],
    ['007.5', '007.5' as DecimalString],
    ['123456789012.12345678', '123456789012.12345678' as DecimalString],
    ['1234567890123', null],
    ['0.123456789', null],
    ['-1', null],
    ['-0', null],
  ])('C3 moneyInColumn(%s) is %s', (value, expected) => {
    expect(moneyInColumn(value as DecimalString)).toBe(expected);
  });

  it("C4 MONEY_SHAPE is numeric(20,8)'s shape: no sign, 12 integer and 8 fraction digits", () => {
    expect(MONEY_SHAPE.source).toBe('^\\d{1,12}(\\.\\d{1,8})?$');
  });
});
