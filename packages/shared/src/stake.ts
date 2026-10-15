import {
  decimalStringSchema,
  normalizeDecimal,
  NUMERIC_FRACTION_DIGITS,
  NUMERIC_INTEGER_DIGITS,
  type DecimalString,
} from './money';

// The user's stake in either mode (#297 users.demo_stake, #326 users.real_stake): its scale, its
// bounds against the account's balance snapshot and the picker's presets. The module knows no
// mode: each caller puts that mode's balance into `available`. The one source for the backend
// (save, intents, sessions) and the bot (presets, input). Arithmetic is bigint at scale 8, never
// a JS number (Rule 2). This module imports money.ts only: trading.ts and trading-session.ts
// spell their error codes from StakeRefusal.

// cents are always allowed, whatever the broker's minimum looks like
export const STAKE_MIN_SCALE = 2;
export const STAKE_PRESET_MULTIPLIERS = [1, 2, 5, 10] as const;

export const StakeRefusal = {
  Precision: 'stake_precision',
  BelowMinimum: 'stake_below_minimum',
  AboveAvailable: 'insufficient_balance',
} as const;
export type StakeRefusal = (typeof StakeRefusal)[keyof typeof StakeRefusal];

// available: the balance of the stake's mode (demo.available or real.available)
export interface StakeLimits {
  minTradeAmount: DecimalString;
  available: DecimalString;
}

const UNIT_SCALE = 10n ** BigInt(NUMERIC_FRACTION_DIGITS);

export const decimalScale = (value: string): number =>
  (normalizeDecimal(value).split('.')[1] ?? '').length;

// a decimal of at most NUMERIC_FRACTION_DIGITS fraction digits as an integer of 1e-8 units
function units(value: string): bigint {
  const negative = value.startsWith('-');
  const [integer = '0', fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const amount =
    BigInt(integer) * UNIT_SCALE + BigInt(fraction.padEnd(NUMERIC_FRACTION_DIGITS, '0'));
  return negative ? -amount : amount;
}

function fromUnits(value: bigint): DecimalString {
  const integer = value / UNIT_SCALE;
  const fraction = (value % UNIT_SCALE).toString().padStart(NUMERIC_FRACTION_DIGITS, '0');
  return decimalStringSchema.parse(normalizeDecimal(`${integer}.${fraction}`));
}

// amount × k in bigint (Rule 2), canonical: a multiple of an amount on a grid stays on it. The
// martingale limits of a session (martingaleLimitsFor, #450)
export const multiplyDecimal = (amount: DecimalString, k: bigint): DecimalString =>
  fromUnits(units(amount) * k);

// max(STAKE_MIN_SCALE, fraction digits of the canonical minTradeAmount)
export const stakeScale = (minTradeAmount: DecimalString): number =>
  Math.max(STAKE_MIN_SCALE, decimalScale(minTradeAmount));

// Fixed order: precision, then >= the minimum, then <= the available balance; null = within
// bounds.
// The precision check runs first, so units() never sees more than 8 fraction digits.
export function checkStake(amount: DecimalString, limits: StakeLimits): StakeRefusal | null {
  if (decimalScale(amount) > stakeScale(limits.minTradeAmount)) {
    return StakeRefusal.Precision;
  }
  const value = units(amount);
  if (value < units(limits.minTradeAmount)) return StakeRefusal.BelowMinimum;
  if (value > units(limits.available)) return StakeRefusal.AboveAvailable;
  return null;
}

// a < b on two canonical decimals of at most 8 fraction digits, in bigint (Rule 2): the real
// balance against the broker's minimum when real mode is switched on (#121)
export const decimalLessThan = (a: DecimalString, b: DecimalString): boolean => units(a) < units(b);

// The «· риск» mark of a stake button (#476; #475 colours it): an amount at or above it, in the
// account's currency with no conversion. Only a label: the bounds of a stake are checkStake's.
export const STAKE_RISK_THRESHOLD: DecimalString = decimalStringSchema.parse('10');
export const stakeIsRisky = (amount: DecimalString): boolean =>
  !decimalLessThan(amount, STAKE_RISK_THRESHOLD);

const MAX_UNITS = 10n ** BigInt(NUMERIC_INTEGER_DIGITS) * UNIT_SCALE;

// min × k for every multiplier, canonical, only those positive, <= available and inside
// numeric(20,8); a minimum of 0 offers none
export function stakePresets(limits: StakeLimits): DecimalString[] {
  const min = units(limits.minTradeAmount);
  const available = units(limits.available);
  return STAKE_PRESET_MULTIPLIERS.map((k) => min * BigInt(k))
    .filter((value) => value > 0n && value <= available && value < MAX_UNITS)
    .map(fromUnits);
}

const INPUT_PATTERN = new RegExp(
  `^\\d{1,${NUMERIC_INTEGER_DIGITS}}(\\.\\d{1,${NUMERIC_FRACTION_DIGITS}})?$`,
);

// What the user typed: one ',' or '.' as the separator, digits only, > 0, canonical. The scale
// and the bounds are the backend's (checkStake), so «1.234» parses here.
export function parseStakeInput(text: string): DecimalString | undefined {
  const trimmed = text.trim();
  const separators = trimmed.match(/[.,]/g)?.length ?? 0;
  if (separators > 1) return undefined;
  const plain = trimmed.replace(',', '.');
  if (!INPUT_PATTERN.test(plain) || !/[1-9]/.test(plain)) return undefined;
  return decimalStringSchema.parse(normalizeDecimal(plain));
}
