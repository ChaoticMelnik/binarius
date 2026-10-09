import type { SignalParams, SignalParamsV1 } from '@binarius/shared';

// Uncalibrated by decision (#132): the corridor refuses a dead feed and a shock, it is not tuned.
// v1's values, kept for its journal lines (#379).
export const DEFAULT_SIGNAL_PARAMS_V1: Readonly<SignalParamsV1> = Object.freeze({
  emaFast: 9,
  emaSlow: 21,
  slopeLookback: 3,
  rsiPeriod: 14,
  rsiBand: 5,
  atrPeriod: 14,
  minAtrPct: 0.001,
  maxAtrPct: 2,
  minClosedCandles: 50,
  maxStaleIntervals: 2,
});

// Expert values (#379, owner 2026-10-09): no up at RSI >= 65, no down at RSI <= 35, ATR of at
// least 5 quote steps. The backtest stand (#381) tunes them.
export const DEFAULT_SIGNAL_PARAMS: Readonly<SignalParams> = Object.freeze({
  ...DEFAULT_SIGNAL_PARAMS_V1,
  rsiExtremeBand: 15,
  minAtrTicks: 5,
});

export function minClosedCandlesFloor(params: SignalParamsV1): number {
  return Math.max(
    params.emaSlow + params.slopeLookback,
    params.rsiPeriod + 1,
    params.atrPeriod + 1,
  );
}

function fail(field: keyof SignalParams, rule: string, value: number): never {
  throw new RangeError(`signal params: ${field} must be ${rule}, got ${value}`);
}

export function assertSignalParamsV1(params: SignalParamsV1): void {
  for (const field of ['emaFast', 'emaSlow', 'rsiPeriod', 'atrPeriod'] as const) {
    if (!Number.isInteger(params[field]) || params[field] < 2) {
      fail(field, 'an integer >= 2', params[field]);
    }
  }
  if (params.emaFast >= params.emaSlow) {
    fail('emaFast', `< emaSlow (${params.emaSlow})`, params.emaFast);
  }
  for (const field of ['slopeLookback', 'maxStaleIntervals'] as const) {
    if (!Number.isInteger(params[field]) || params[field] < 1) {
      fail(field, 'an integer >= 1', params[field]);
    }
  }
  if (!Number.isFinite(params.rsiBand) || params.rsiBand < 0 || params.rsiBand >= 50) {
    fail('rsiBand', 'finite, >= 0 and < 50', params.rsiBand);
  }
  if (!Number.isFinite(params.minAtrPct) || params.minAtrPct < 0) {
    fail('minAtrPct', 'finite and >= 0', params.minAtrPct);
  }
  if (!Number.isFinite(params.maxAtrPct) || params.maxAtrPct <= params.minAtrPct) {
    fail('maxAtrPct', `finite and > minAtrPct (${params.minAtrPct})`, params.maxAtrPct);
  }
  const floor = minClosedCandlesFloor(params);
  if (!Number.isInteger(params.minClosedCandles) || params.minClosedCandles < floor) {
    fail('minClosedCandles', `an integer >= ${floor}`, params.minClosedCandles);
  }
}

export function assertSignalParams(params: SignalParams): void {
  assertSignalParamsV1(params);
  // a band at or inside rsiBand would refuse every signal of its direction
  const extreme = params.rsiExtremeBand;
  if (!Number.isFinite(extreme) || extreme <= params.rsiBand || extreme > 50) {
    fail('rsiExtremeBand', `finite, > rsiBand (${params.rsiBand}) and <= 50`, extreme);
  }
  if (!Number.isInteger(params.minAtrTicks) || params.minAtrTicks < 1) {
    fail('minAtrTicks', 'an integer >= 1', params.minAtrTicks);
  }
}

// a default edited out of its rules fails at import, not on the first decision
assertSignalParamsV1(DEFAULT_SIGNAL_PARAMS_V1);
assertSignalParams(DEFAULT_SIGNAL_PARAMS);
