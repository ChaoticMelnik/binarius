// Test-only fixtures for the stake suites. Compiled by `tsc -b` alongside the *.test.ts files
// next to it and imported by no runtime module.

import { decimalStringSchema, type DecimalString } from '@binarius/shared';
import { SessionTradeKind, StakeStrategy } from './codes';
import type { MartingaleLimits, StakeParams } from './config';
import type { SessionTrade, StakeInput } from './size';

export const START_MS = 1_760_000_000_000;

export const d = (text: string): DecimalString => decimalStringSchema.parse(text);

export const loss = (stake: string): SessionTrade => ({
  kind: SessionTradeKind.Settled,
  stake: d(stake),
  profit: d(`-${stake}`),
});

export const win = (stake: string, profit: string): SessionTrade => ({
  kind: SessionTradeKind.Settled,
  stake: d(stake),
  profit: d(profit),
});

export const tie = (stake: string): SessionTrade => ({
  kind: SessionTradeKind.Settled,
  stake: d(stake),
  profit: d('0'),
});

export const rejected = (): SessionTrade => ({ kind: SessionTradeKind.Rejected });

export const unresolved = (): SessionTrade => ({ kind: SessionTradeKind.Unresolved });

// the suites' values, not defaults: martingale has none
export const TEST_LIMITS: Readonly<MartingaleLimits> = Object.freeze({
  maxSteps: 5,
  maxStake: d('100.00'),
  maxSessionLoss: d('100.00'),
  maxSessionDurationMs: 3_600_000,
});

export function martingale(
  limits: Partial<MartingaleLimits> = {},
  baseStake = '1.00',
  stakeScale = 2,
): StakeParams {
  return {
    strategy: StakeStrategy.Martingale,
    baseStake: d(baseStake),
    stakeScale,
    limits: { ...TEST_LIMITS, ...limits },
  };
}

export function input(patch: Partial<StakeInput> = {}): StakeInput {
  return {
    history: [],
    payout: 85,
    minTradeAmount: d('1.00'),
    available: d('10000.00'),
    sessionStartedAtMs: START_MS,
    nowMs: START_MS + 1000,
    ...patch,
  };
}
