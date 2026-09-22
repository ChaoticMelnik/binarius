import * as z from 'zod';

// wire money is decimal strings only: a JSON number has already lost precision in JSON.parse
export const decimalStringSchema = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, { error: 'expected a decimal string like "12.50"' })
  .brand<'DecimalString'>();

export type DecimalString = z.infer<typeof decimalStringSchema>;

export function isDecimalString(value: unknown): value is DecimalString {
  return decimalStringSchema.safeParse(value).success;
}
