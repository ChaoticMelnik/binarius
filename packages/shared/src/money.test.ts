import { describe, expect, it } from 'vitest';
import {
  decimalStringSchema,
  isDecimalString,
  moneyWireSchema,
  normalizeDecimal,
  numericDomainDecimalSchema,
  positiveDecimalStringSchema,
} from './money';

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

describe('positiveDecimalStringSchema', () => {
  it.each(['0.01', '10.00', '100', '0.000001'])('accepts %j', (value) => {
    expect(positiveDecimalStringSchema.parse(value)).toBe(value);
  });

  it.each(['0', '0.00', '-0', '-1', '-0.5', '', 'abc'])('rejects %j', (value) => {
    expect(positiveDecimalStringSchema.safeParse(value).success).toBe(false);
  });
});

describe('moneyWireSchema', () => {
  it.each([
    [1000000, '1000000'],
    [0, '0'],
    [-0, '0'],
    [-10, '-10'],
    [2 ** 53 - 1, '9007199254740991'],
  ])('converts the integer %j to the decimal string %j', (value, expected) => {
    const parsed = moneyWireSchema.parse(value);
    expect(parsed).toBe(expected);
    expect(isDecimalString(parsed)).toBe(true);
  });

  it.each(['0', '12.50', '-3', '100000000000000000000'])(
    'passes the string %j through',
    (value) => {
      expect(moneyWireSchema.parse(value)).toBe(value);
    },
  );

  it.each([
    [1.5, '1.5'],
    [-1.5, '-1.5'],
    [9998.5, '9998.5'],
    [10000.5, '10000.5'],
    [1.275, '1.275'],
    [0.000001, '0.000001'],
    [123456789012.123, '123456789012.123'],
  ])('converts the fraction %j to the decimal string %j', (value, expected) => {
    const parsed = moneyWireSchema.parse(value);
    expect(parsed).toBe(expected);
    expect(isDecimalString(parsed)).toBe(true);
  });

  it.each([
    1234567890123.456,
    0.30000000000000004,
    12345678901234.566,
    1e-7,
    5e-7,
    2 ** 53,
    1e21,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    true,
    null,
    '1e3',
  ])('rejects %j', (value) => {
    expect(moneyWireSchema.safeParse(value).success).toBe(false);
  });

  // over 15 significant digits JSON.parse may round the text to a short double: accepted, not
  // detectable after parsing (docs/broker-rest.md -> Money)
  it.each([
    ['99999999999.999999', '100000000000'],
    ['1.5000000000000001', '1.5'],
  ])('accepts the JSON text %s as %j after JSON.parse rounded it', (text, expected) => {
    expect(moneyWireSchema.parse(JSON.parse(text))).toBe(expected);
  });
});

describe('normalizeDecimal', () => {
  it.each([
    ['10.00000000', '10'],
    ['1.50000000', '1.5'],
    ['0.00000001', '0.00000001'],
    ['007.10', '7.1'],
    ['1.00', '1'],
    ['12.34500000', '12.345'],
    ['0', '0'],
    ['0.0', '0'],
  ])('%s -> %s', (value, canonical) => {
    expect(normalizeDecimal(value)).toBe(canonical);
  });
});

describe('numericDomainDecimalSchema', () => {
  it.each(['10', '10.50', '0.00000001', '999999999999', '999999999999.99999999'])(
    'accepts %j',
    (value) => {
      expect(numericDomainDecimalSchema.parse(value)).toBe(value);
    },
  );

  it.each(['0', '0.00', '-1', '1e5', '1,000', '1000000000000', '1.000000001'])(
    'rejects %j',
    (value) => {
      expect(numericDomainDecimalSchema.safeParse(value).success).toBe(false);
    },
  );
});
