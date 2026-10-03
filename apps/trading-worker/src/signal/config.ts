export const SIGNAL_ALGORITHM_VERSION = 'v1';

export interface SignalParams {
  emaFast: number;
  emaSlow: number;
  // slope = slowEma[last] - slowEma[last - slopeLookback]
  slopeLookback: number;
  rsiPeriod: number;
  // up at RSI >= 50 + band, down at RSI <= 50 - band
  rsiBand: number;
  atrPeriod: number;
  // ATR as a percentage of the last close
  minAtrPct: number;
  maxAtrPct: number;
  minClosedCandles: number;
  // the last closed candle may have closed at most this many intervals before nowMs
  maxStaleIntervals: number;
}

// Uncalibrated by decision (#132): the corridor refuses a dead feed and a shock, it is not tuned.
export const DEFAULT_SIGNAL_PARAMS: Readonly<SignalParams> = Object.freeze({
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

export function minClosedCandlesFloor(params: SignalParams): number {
  return Math.max(
    params.emaSlow + params.slopeLookback,
    params.rsiPeriod + 1,
    params.atrPeriod + 1,
  );
}

function fail(field: keyof SignalParams, rule: string, value: number): never {
  throw new RangeError(`signal params: ${field} must be ${rule}, got ${value}`);
}

export function assertSignalParams(params: SignalParams): void {
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

// a default edited out of its rules fails at import, not on the first decision
assertSignalParams(DEFAULT_SIGNAL_PARAMS);
