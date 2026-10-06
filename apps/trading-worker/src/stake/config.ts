import { decimalStringSchema, type DecimalString } from '@binarius/shared';
import { StakeStrategy } from './codes';
import { AMOUNT_SCALE, floorToScale, parseAmount } from './money';

export const STAKE_ALGORITHM_VERSION = 'v1';

export interface MartingaleLimits {
  // the step of the next stake: 1 + consecutive losses
  maxSteps: number;
  maxStake: DecimalString;
  // realized session loss plus the next stake may not exceed it
  maxSessionLoss: DecimalString;
  maxSessionDurationMs: number;
}

interface CommonParams {
  baseStake: DecimalString;
  // fractional digits of every stake; the next martingale stake is rounded up to it
  stakeScale: number;
}

export type StakeParams =
  | (CommonParams & { strategy: typeof StakeStrategy.Fixed })
  | (CommonParams & { strategy: typeof StakeStrategy.Martingale; limits: MartingaleLimits });

// Martingale stays off until its limits are approved (#19): no default limits exist.
export const DEFAULT_STAKE_PARAMS: Readonly<StakeParams> = Object.freeze({
  strategy: StakeStrategy.Fixed,
  baseStake: decimalStringSchema.parse('1.00'),
  stakeScale: 2,
});

function fail(field: string, rule: string, value: unknown): never {
  throw new RangeError(`stake params: ${field} must be ${rule}, got ${String(value)}`);
}

function amount(field: string, value: unknown): bigint {
  const parsed = typeof value === 'string' ? parseAmount(value) : undefined;
  if (parsed === undefined) {
    fail(field, 'a decimal string with at most 12 integer and 8 fractional digits', value);
  }
  return parsed;
}

export function assertStakeParams(params: StakeParams): void {
  const { stakeScale } = params;
  if (!Number.isInteger(stakeScale) || stakeScale < 0 || stakeScale > AMOUNT_SCALE) {
    fail('stakeScale', `an integer in [0, ${AMOUNT_SCALE}]`, stakeScale);
  }
  const base = amount('baseStake', params.baseStake);
  if (base <= 0n) fail('baseStake', '> 0', params.baseStake);
  // the base stake is sent to the broker as it is
  if (floorToScale(base, stakeScale) !== base) {
    fail('baseStake', `at most ${stakeScale} significant fractional digits`, params.baseStake);
  }

  // the strategy is a union tag at compile time; an object that did not come from a literal is
  // checked here as well
  const strategy: unknown = params.strategy;
  if (strategy === StakeStrategy.Fixed) {
    if ('limits' in params) fail('limits', 'absent for the fixed strategy', 'limits');
    return;
  }
  if (strategy !== StakeStrategy.Martingale) {
    fail('strategy', `${StakeStrategy.Fixed} or ${StakeStrategy.Martingale}`, strategy);
  }
  const limits: Partial<MartingaleLimits> | undefined = (params as { limits?: MartingaleLimits })
    .limits;
  if (typeof limits !== 'object' || limits === null) {
    fail('limits', 'present for the martingale strategy', limits);
  }
  // a one-step martingale is the fixed strategy
  if (!Number.isInteger(limits.maxSteps) || (limits.maxSteps ?? 0) < 2) {
    fail('limits.maxSteps', 'an integer >= 2', limits.maxSteps);
  }
  if (amount('limits.maxStake', limits.maxStake) < base) {
    fail('limits.maxStake', `>= baseStake (${params.baseStake})`, limits.maxStake);
  }
  // below the base stake the pre-check would stop every session on its first stake
  if (amount('limits.maxSessionLoss', limits.maxSessionLoss) < base) {
    fail('limits.maxSessionLoss', `>= baseStake (${params.baseStake})`, limits.maxSessionLoss);
  }
  if (!Number.isInteger(limits.maxSessionDurationMs) || (limits.maxSessionDurationMs ?? 0) < 1) {
    fail('limits.maxSessionDurationMs', 'an integer >= 1', limits.maxSessionDurationMs);
  }
}

// a default edited out of its rules fails at import, not on the first decision
assertStakeParams(DEFAULT_STAKE_PARAMS);
