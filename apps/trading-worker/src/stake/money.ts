import { decimalStringSchema, type DecimalString } from '@binarius/shared';

// The domain of numeric(20,8) and tradeAmountSchema: at most 12 integer and 8 fractional digits.
// Amounts are bigints scaled by 10^AMOUNT_SCALE; money.test.ts checks the bounds against
// tradeAmountSchema.
export const AMOUNT_INTEGER_DIGITS = 12;
export const AMOUNT_SCALE = 8;
// broker_trades.payout is numeric(8,4)
export const PAYOUT_INTEGER_DIGITS = 4;
export const PAYOUT_SCALE = 4;

const AMOUNT_UNIT = 10n ** BigInt(AMOUNT_SCALE);
// a payout scaled by 10^PAYOUT_SCALE is a percentage: x * payout / 100 = x * scaled / PERCENT_DIVISOR
export const PERCENT_DIVISOR = 100n * 10n ** BigInt(PAYOUT_SCALE);

const AMOUNT = new RegExp(
  `^(-?)(\\d{1,${AMOUNT_INTEGER_DIGITS}})(?:\\.(\\d{1,${AMOUNT_SCALE}}))?$`,
);
const PAYOUT = new RegExp(`^(\\d{1,${PAYOUT_INTEGER_DIGITS}})(?:\\.(\\d{1,${PAYOUT_SCALE}}))?$`);

// a signed decimal inside the domain, or undefined: never rounded
export function parseAmount(text: string): bigint | undefined {
  const match = AMOUNT.exec(text);
  if (match === null) return undefined;
  const [, sign, whole = '0', fraction = ''] = match;
  const value = BigInt(whole) * AMOUNT_UNIT + BigInt(fraction.padEnd(AMOUNT_SCALE, '0'));
  return sign === '-' ? -value : value;
}

function split(value: bigint): { sign: string; whole: bigint; fraction: string } {
  const abs = value < 0n ? -value : value;
  return {
    sign: value < 0n ? '-' : '',
    whole: abs / AMOUNT_UNIT,
    fraction: (abs % AMOUNT_UNIT).toString().padStart(AMOUNT_SCALE, '0'),
  };
}

// canonical text: no trailing fractional zeros, 0 without a fraction
export function formatAmount(value: bigint): DecimalString {
  const { sign, whole, fraction } = split(value);
  const trimmed = fraction.replace(/0+$/, '');
  return decimalStringSchema.parse(`${sign}${whole}${trimmed === '' ? '' : `.${trimmed}`}`);
}

function assertScale(scale: number): void {
  if (!Number.isInteger(scale) || scale < 0 || scale > AMOUNT_SCALE) {
    throw new RangeError(`scale must be an integer in [0, ${AMOUNT_SCALE}], got ${scale}`);
  }
}

function step(scale: number): bigint {
  assertScale(scale);
  return 10n ** BigInt(AMOUNT_SCALE - scale);
}

// exactly `scale` fractional digits: the form the stake is sent in ("10.00")
export function formatStake(value: bigint, scale: number): DecimalString {
  if (value < 0n || value % step(scale) !== 0n) {
    throw new RangeError(`formatStake: ${value} is not a non-negative multiple of scale ${scale}`);
  }
  const { whole, fraction } = split(value);
  return decimalStringSchema.parse(
    scale === 0 ? `${whole}` : `${whole}.${fraction.slice(0, scale)}`,
  );
}

export function ceilToScale(value: bigint, scale: number): bigint {
  if (value < 0n) throw new RangeError(`ceilToScale: negative value ${value}`);
  const unit = step(scale);
  return divCeil(value, unit) * unit;
}

export function floorToScale(value: bigint, scale: number): bigint {
  if (value < 0n) throw new RangeError(`floorToScale: negative value ${value}`);
  const unit = step(scale);
  return (value / unit) * unit;
}

export function divCeil(a: bigint, b: bigint): bigint {
  if (a < 0n || b <= 0n) throw new RangeError(`divCeil: expected a >= 0 and b > 0, got ${a}, ${b}`);
  return (a + b - 1n) / b;
}

// BinaryPair.payout is a JS number (a percentage). String() turns it into decimal text with no
// arithmetic, the same policy as moneyWireSchema; an exponent, a non-finite value, zero or more
// digits than numeric(8,4) holds is refused, never rounded.
export function parsePayout(payout: number): bigint | undefined {
  if (typeof payout !== 'number' || !Number.isFinite(payout)) return undefined;
  const match = PAYOUT.exec(String(payout));
  if (match === null) return undefined;
  const [, whole = '0', fraction = ''] = match;
  const scaled =
    BigInt(whole) * 10n ** BigInt(PAYOUT_SCALE) + BigInt(fraction.padEnd(PAYOUT_SCALE, '0'));
  return scaled > 0n ? scaled : undefined;
}

// the profit the broker credits for `stake` at `payoutScaled`, floored to `scale`: the fixture's
// rule (floor(amount * payout / 100) in cents, docs/mock-broker.md) and the worst case for a broker
// that rounds up or to nearest
export function expectedProfit(stake: bigint, payoutScaled: bigint, scale: number): bigint {
  return floorToScale((stake * payoutScaled) / PERCENT_DIVISOR, scale);
}
