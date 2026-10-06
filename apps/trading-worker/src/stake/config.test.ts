import { decimalStringSchema } from '@binarius/shared';
import { describe, expect, it } from 'vitest';
import { StakeStrategy } from './codes';
import {
  assertStakeParams,
  DEFAULT_STAKE_PARAMS,
  type MartingaleLimits,
  type StakeParams,
} from './config';

const d = (text: string) => decimalStringSchema.parse(text);

const LIMITS: MartingaleLimits = {
  maxSteps: 5,
  maxStake: d('100.00'),
  maxSessionLoss: d('100.00'),
  maxSessionDurationMs: 3_600_000,
};

const martingale = (
  patch: Partial<Omit<StakeParams, 'strategy'>> = {},
  limits: Partial<MartingaleLimits> = {},
): StakeParams => ({
  strategy: StakeStrategy.Martingale,
  baseStake: d('1.00'),
  stakeScale: 2,
  ...patch,
  limits: { ...LIMITS, ...limits },
});

const fixed = (patch: Partial<Omit<StakeParams, 'strategy'>> = {}): StakeParams => ({
  ...DEFAULT_STAKE_PARAMS,
  ...patch,
  strategy: StakeStrategy.Fixed,
});

describe('stake params', () => {
  it('K0 the defaults pass and are the fixed strategy; a valid martingale passes', () => {
    expect(() => assertStakeParams(DEFAULT_STAKE_PARAMS)).not.toThrow();
    expect(DEFAULT_STAKE_PARAMS).toEqual({ strategy: 'fixed', baseStake: '1.00', stakeScale: 2 });
    expect(() => assertStakeParams(martingale())).not.toThrow();
  });

  it('K1 stakeScale outside [0, 8] or fractional throws', () => {
    expect(() => assertStakeParams(fixed({ stakeScale: 9 }))).toThrow(/stakeScale/);
    expect(() => assertStakeParams(fixed({ stakeScale: -1 }))).toThrow(/stakeScale/);
    expect(() => assertStakeParams(fixed({ stakeScale: 1.5 }))).toThrow(/stakeScale/);
  });

  it('K2 baseStake with more significant decimals than stakeScale throws; trailing zeros do not', () => {
    expect(() => assertStakeParams(fixed({ baseStake: d('1.005') }))).toThrow(/baseStake/);
    expect(() => assertStakeParams(fixed({ baseStake: d('1.50000') }))).not.toThrow();
    expect(() => assertStakeParams(fixed({ baseStake: d('1.5'), stakeScale: 0 }))).toThrow(
      /baseStake/,
    );
  });

  it('K3 baseStake of zero, a negative or out-of-domain one throws', () => {
    expect(() => assertStakeParams(fixed({ baseStake: d('0.00') }))).toThrow(/baseStake/);
    expect(() => assertStakeParams(fixed({ baseStake: d('-1.00') }))).toThrow(/baseStake/);
    expect(() => assertStakeParams(fixed({ baseStake: d('1000000000000') }))).toThrow(/baseStake/);
  });

  it('K4 maxSteps 1 throws: a one-step martingale is the fixed strategy', () => {
    expect(() => assertStakeParams(martingale({}, { maxSteps: 1 }))).toThrow(/maxSteps/);
    expect(() => assertStakeParams(martingale({}, { maxSteps: 2 }))).not.toThrow();
  });

  it('K5 a fractional maxSteps throws', () => {
    expect(() => assertStakeParams(martingale({}, { maxSteps: 2.5 }))).toThrow(/maxSteps/);
  });

  it('K6 maxStake below baseStake throws; equal passes', () => {
    expect(() => assertStakeParams(martingale({}, { maxStake: d('0.99') }))).toThrow(/maxStake/);
    expect(() => assertStakeParams(martingale({}, { maxStake: d('1.00') }))).not.toThrow();
  });

  it('K7 maxSessionLoss below baseStake throws; equal passes', () => {
    expect(() => assertStakeParams(martingale({}, { maxSessionLoss: d('0.99') }))).toThrow(
      /maxSessionLoss/,
    );
    expect(() => assertStakeParams(martingale({}, { maxSessionLoss: d('1') }))).not.toThrow();
  });

  it('K8 maxSessionDurationMs 0 or fractional throws', () => {
    expect(() => assertStakeParams(martingale({}, { maxSessionDurationMs: 0 }))).toThrow(
      /maxSessionDurationMs/,
    );
    expect(() => assertStakeParams(martingale({}, { maxSessionDurationMs: 1.5 }))).toThrow(
      /maxSessionDurationMs/,
    );
  });

  it('K9 limits on the fixed strategy, no limits on martingale, an unknown strategy throw', () => {
    const fixedWithLimits = { ...fixed(), limits: LIMITS } as unknown as StakeParams;
    expect(() => assertStakeParams(fixedWithLimits)).toThrow(/limits/);
    const { strategy, baseStake, stakeScale } = martingale();
    const withoutLimits = { strategy, baseStake, stakeScale } as unknown as StakeParams;
    expect(() => assertStakeParams(withoutLimits)).toThrow(/limits/);
    const unknown = { ...fixed(), strategy: 'double' } as unknown as StakeParams;
    expect(() => assertStakeParams(unknown)).toThrow(/strategy/);
  });

  it('K10 the defaults are frozen and were checked at import', async () => {
    expect(Object.isFrozen(DEFAULT_STAKE_PARAMS)).toBe(true);
    await expect(import('./config')).resolves.toBeDefined();
  });
});
