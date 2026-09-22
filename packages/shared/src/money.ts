import * as z from 'zod';

// wire money is decimal strings only: a JSON number has already lost precision in JSON.parse
export const decimalStringSchema = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, { error: 'expected a decimal string like "12.50"' })
  .brand<'DecimalString'>();

export type DecimalString = z.infer<typeof decimalStringSchema>;

// request amounts: same brand, additionally > 0 (no sign, at least one non-zero digit)
export const positiveDecimalStringSchema = decimalStringSchema.refine(
  (value) => !value.startsWith('-') && /[1-9]/.test(value),
  { error: 'expected a positive amount' },
);

export function isDecimalString(value: unknown): value is DecimalString {
  return decimalStringSchema.safeParse(value).success;
}
