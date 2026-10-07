import * as z from 'zod';

// Decimal strings are the form this project sends and stores: a JSON number with a fraction may
// already have lost precision in JSON.parse. The broker counts whole currency units and answers a
// whole amount as a JSON integer and a fractional one as a JSON fraction, both in one object
// (live, 2026-10-03, after a 1.5 demo stake); moneyWireSchema below is the one place such a number
// becomes money.
export const decimalStringSchema = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, { error: 'expected a decimal string like "12.50"' })
  .brand<'DecimalString'>();

export type DecimalString = z.infer<typeof decimalStringSchema>;

// DBL_DIG: a decimal text with at most 15 significant digits keeps its numeric value through
// JSON.parse, and String() of that double is the same digits (trailing zeros dropped: 1.50 -> "1.5";
// below 1e-6 String() switches to an exponent and the value is refused). A String() of 16-17
// digits is a float artifact (0.1 + 0.2) or a value that lost precision in JSON.parse. A text
// with more than 15 digits that JSON.parse rounded to a shorter double is not detectable here.
export const MAX_WIRE_SIGNIFICANT_DIGITS = 15;
const PLAIN_FRACTION = /^-?\d+\.\d+$/;
const significantDigits = (text: string) =>
  text.replace('-', '').replace('.', '').replace(/^0+/, '').length;

// Money the broker sends: a decimal string, a safe JSON integer, or a JSON fraction whose String()
// is a plain decimal of at most MAX_WIRE_SIGNIFICANT_DIGITS, converted by String() with no
// arithmetic and no rounding (docs/broker-rest.md -> Money).
export const moneyWireSchema = z.union([
  decimalStringSchema,
  z.int().transform((value) => decimalStringSchema.parse(String(value))),
  z.number().transform((value, ctx) => {
    const text = String(value);
    if (!PLAIN_FRACTION.test(text) || significantDigits(text) > MAX_WIRE_SIGNIFICANT_DIGITS) {
      ctx.addIssue({
        code: 'custom',
        message: `expected a plain decimal with at most ${MAX_WIRE_SIGNIFICANT_DIGITS} significant digits`,
      });
      return z.NEVER;
    }
    return decimalStringSchema.parse(text);
  }),
]);

// request amounts: same brand, additionally > 0 (no sign, at least one non-zero digit)
export const positiveDecimalStringSchema = decimalStringSchema.refine(
  (value) => !value.startsWith('-') && /[1-9]/.test(value),
  { error: 'expected a positive amount' },
);

// numeric(20,8) comes back as '10.00000000' while a request said '10.00': compare the values,
// not the spellings, without ever going through a float. Leading zeros and trailing fraction
// zeros are stripped.
export function normalizeDecimal(value: string): string {
  const [integer = '0', fraction = ''] = value.split('.');
  const int = integer.replace(/^0+(?=\d)/, '');
  const frac = fraction.replace(/0+$/, '');
  return frac === '' ? int : `${int}.${frac}`;
}

export function isDecimalString(value: unknown): value is DecimalString {
  return decimalStringSchema.safeParse(value).success;
}
