import { isDecimalString } from '@binarius/shared';
import { describe, expect, it } from 'vitest';
import { formatCents, parseCents, percentOf, requireCents } from './money';

describe('parseCents', () => {
  it.each([
    ['10000.00', 1_000_000n],
    ['10000', 1_000_000n],
    ['0.5', 50n],
    ['0.05', 5n],
    ['0', 0n],
    ['12.34', 1234n],
  ])('reads %j as %s cents', (value, cents) => {
    expect(parseCents(value)).toBe(cents);
  });

  it.each(['1.234', '-1.00', '-0', '', '1.', '.5', '1e3', '+1', ' 1', 'abc'])(
    'refuses %j',
    (value) => {
      expect(parseCents(value)).toBeUndefined();
    },
  );
});

describe('formatCents', () => {
  it.each([
    [1_000_000n, '10000.00'],
    [5n, '0.05'],
    [50n, '0.50'],
    [0n, '0.00'],
    [-1234n, '-12.34'],
    [-5n, '-0.05'],
  ])('writes %s cents as %j', (cents, text) => {
    const formatted = formatCents(cents);
    expect(formatted).toBe(text);
    expect(isDecimalString(formatted)).toBe(true);
  });

  it('round-trips through parseCents', () => {
    for (const value of ['10000.00', '0.01', '1.10', '987654321.99']) {
      expect(formatCents(requireCents(value, 'value'))).toBe(value);
    }
  });
});

describe('requireCents', () => {
  it('throws on a value parseCents refuses', () => {
    expect(() => requireCents('1.001', 'amount')).toThrow(RangeError);
  });
});

describe('percentOf', () => {
  it('floors to whole cents', () => {
    expect(percentOf(1000n, 85)).toBe(850n);
    expect(percentOf(333n, 85)).toBe(283n);
    expect(percentOf(100n, 85.5)).toBe(85n);
    expect(percentOf(1000n, 85.5)).toBe(855n);
  });
});
