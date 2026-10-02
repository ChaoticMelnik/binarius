import * as z from 'zod';

// Decimal strings are the form this project sends and stores: a JSON number with a fraction may
// already have lost precision in JSON.parse. The broker itself answers money as JSON integers
// (live GET /v1/broker/user, 2026-10-02); moneyWireSchema below is the one place such a number
// becomes money.
export const decimalStringSchema = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, { error: 'expected a decimal string like "12.50"' })
  .brand<'DecimalString'>();

export type DecimalString = z.infer<typeof decimalStringSchema>;

// Money the broker sends: a decimal string or a safe JSON integer, converted by String() with no
// arithmetic. A fraction is refused: whether the broker counts whole units or minor units is not
// known yet, and a fractional value would mean guessing (docs/broker-rest.md, open item 1).
export const moneyWireSchema = z.union([
  decimalStringSchema,
  z.int().transform((value) => decimalStringSchema.parse(String(value))),
]);

// request amounts: same brand, additionally > 0 (no sign, at least one non-zero digit)
export const positiveDecimalStringSchema = decimalStringSchema.refine(
  (value) => !value.startsWith('-') && /[1-9]/.test(value),
  { error: 'expected a positive amount' },
);

export function isDecimalString(value: unknown): value is DecimalString {
  return decimalStringSchema.safeParse(value).success;
}
