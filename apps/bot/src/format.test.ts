import { describe, expect, it } from 'vitest';
import { formatAge, formatCount, formatStake, formatUsd } from './format';

const NBSP = ' ';
const spaced = (text: string) => text.replaceAll(' ', NBSP);

describe('formatUsd', () => {
  it.each([
    ['10000.00000000', '$10 000.00'],
    ['0', '$0.00'],
    ['0.00000000', '$0.00'],
    ['9998.5', '$9 998.50'],
    ['5', '$5.00'],
    ['1.555', '$1.55'],
    // a Number(amount).toFixed(2) would round this up to $2.00
    ['1.999', '$1.99'],
    ['123456789012.12345678', '$123 456 789 012.12'],
    ['999', '$999.00'],
    ['1000', '$1 000.00'],
    ['007.5', '$7.50'],
    ['-1.5', '-$1.50'],
    ['-0.001', '$0.00'],
  ])('prints %s as %s', (amount, printed) => {
    expect(formatUsd(amount)).toBe(spaced(printed));
  });

  it('groups the digits with a no-break space, not an ordinary one', () => {
    expect([...formatUsd('1000')].map((char) => char.codePointAt(0))).toContain(0x00a0);
    expect(formatUsd('1000')).not.toContain(' ');
  });

  it('keeps every digit of the widest stored amount (12 integer, 8 fraction digits)', () => {
    expect(formatUsd('999999999999.99999999')).toBe(spaced('$999 999 999 999.99'));
    expect(formatUsd('999999999999.99999999')).toHaveLength(19);
  });
});

describe('formatStake', () => {
  it.each([
    ['5', '$5.00'],
    ['5.00000000', '$5.00'],
    ['2.5', '$2.50'],
    ['0.005', '$0.005'],
    ['0.00000001', '$0.00000001'],
    ['1000.5', '$1 000.50'],
    ['999999999999.99999999', '$999 999 999 999.99999999'],
  ])('prints %s as %s, keeping every fraction digit', (amount, printed) => {
    expect(formatStake(amount)).toBe(spaced(printed));
  });
});

describe('formatCount', () => {
  it.each([
    ['0', '0'],
    ['5', '5'],
    ['1000', '1 000'],
    ['9'.repeat(19), '9 999 999 999 999 999 999'],
  ])('prints %s as %s', (count, printed) => {
    expect(formatCount(count)).toBe(spaced(printed));
  });
});

describe('formatAge', () => {
  it.each([
    [0, '0 с'],
    [59, '59 с'],
    [60, '1 мин'],
    [119, '1 мин'],
    [3599, '59 мин'],
    [7200, '120 мин'],
  ])('prints %i seconds as %s', (seconds, printed) => {
    expect(formatAge(seconds)).toBe(printed);
  });
});
