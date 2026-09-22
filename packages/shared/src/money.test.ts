import { describe, expect, it } from 'vitest';
import { decimalStringSchema, isDecimalString } from './money';

describe('decimalStringSchema', () => {
  it.each(['0', '-3', '12.50', '0.001', '100000000000000000000'])('accepts %j', (value) => {
    expect(decimalStringSchema.parse(value)).toBe(value);
    expect(isDecimalString(value)).toBe(true);
  });

  it.each(['', '1e3', '1,5', '.5', '5.', 'NaN', ' 1', '1 ', '+1', 'abc'])('rejects %j', (value) => {
    expect(decimalStringSchema.safeParse(value).success).toBe(false);
    expect(isDecimalString(value)).toBe(false);
  });

  it.each([12.5, 0, null, undefined, true, {}])('rejects non-string %j', (value) => {
    expect(decimalStringSchema.safeParse(value).success).toBe(false);
  });
});
