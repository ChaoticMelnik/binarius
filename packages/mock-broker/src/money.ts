import { decimalStringSchema, type DecimalString } from '@binarius/shared';

// the fixture keeps money as bigint cents (scale 2) and only formats it at the wire
const AMOUNT = /^(\d+)(?:\.(\d{1,2}))?$/;

// a non-negative amount with at most two decimals; anything else is undefined, never rounded
export function parseCents(value: string): bigint | undefined {
  const match = AMOUNT.exec(value);
  if (match === null) return undefined;
  const [, whole = '0', fraction = ''] = match;
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}

export function formatCents(cents: bigint): DecimalString {
  const sign = cents < 0n ? '-' : '';
  const abs = cents < 0n ? -cents : cents;
  const fraction = (abs % 100n).toString().padStart(2, '0');
  return decimalStringSchema.parse(`${sign}${abs / 100n}.${fraction}`);
}

// a seed or a test input the fixture cannot represent is a mistake in the test, not a scenario
export function requireCents(value: string, what: string): bigint {
  const cents = parseCents(value);
  if (cents === undefined) {
    throw new RangeError(`${what} must be a non-negative amount with at most 2 decimals: ${value}`);
  }
  return cents;
}

// floor(amount * percent / 100); percent may carry two decimals (an 85.5% payout)
export function percentOf(cents: bigint, percent: number): bigint {
  const basisPoints = BigInt(Math.round(percent * 100));
  return (cents * basisPoints) / 10_000n;
}
