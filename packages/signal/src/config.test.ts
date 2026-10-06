import type { SignalParams } from '@binarius/shared';
import { describe, expect, it } from 'vitest';
import { assertSignalParams, DEFAULT_SIGNAL_PARAMS, minClosedCandlesFloor } from './config';

const withParams = (patch: Partial<SignalParams>): SignalParams => ({
  ...DEFAULT_SIGNAL_PARAMS,
  ...patch,
});

describe('signal params', () => {
  it('K0 the defaults pass; the floor is 24 for them, 31 with rsiPeriod 30, 41 with atrPeriod 40', () => {
    expect(() => assertSignalParams(DEFAULT_SIGNAL_PARAMS)).not.toThrow();
    expect(minClosedCandlesFloor(DEFAULT_SIGNAL_PARAMS)).toBe(24);
    expect(minClosedCandlesFloor(withParams({ rsiPeriod: 30 }))).toBe(31);
    expect(minClosedCandlesFloor(withParams({ atrPeriod: 40 }))).toBe(41);
  });

  it('K1 emaFast equal to emaSlow throws', () => {
    expect(() => assertSignalParams(withParams({ emaFast: 21 }))).toThrow(/emaFast/);
  });

  it('K2 rsiPeriod 1 throws', () => {
    expect(() => assertSignalParams(withParams({ rsiPeriod: 1 }))).toThrow(/rsiPeriod/);
  });

  it('K3 a non-integer atrPeriod throws', () => {
    expect(() => assertSignalParams(withParams({ atrPeriod: 14.5 }))).toThrow(/atrPeriod/);
  });

  it('K4 rsiBand 50 throws', () => {
    expect(() => assertSignalParams(withParams({ rsiBand: 50 }))).toThrow(/rsiBand/);
  });

  it('K5 minAtrPct equal to maxAtrPct throws', () => {
    expect(() => assertSignalParams(withParams({ minAtrPct: 2 }))).toThrow(/maxAtrPct/);
  });

  it('K6 a non-finite maxAtrPct throws', () => {
    expect(() => assertSignalParams(withParams({ maxAtrPct: Infinity }))).toThrow(/maxAtrPct/);
  });

  it('K7 minClosedCandles one below the floor throws', () => {
    expect(() => assertSignalParams(withParams({ minClosedCandles: 23 }))).toThrow(
      /minClosedCandles/,
    );
  });

  it('K8 maxStaleIntervals 0 throws', () => {
    expect(() => assertSignalParams(withParams({ maxStaleIntervals: 0 }))).toThrow(
      /maxStaleIntervals/,
    );
  });

  it('K9 slopeLookback 0 throws', () => {
    expect(() => assertSignalParams(withParams({ slopeLookback: 0 }))).toThrow(/slopeLookback/);
  });

  it('K10 a violation is a RangeError', () => {
    expect(() => assertSignalParams(withParams({ emaSlow: 1 }))).toThrow(RangeError);
  });
});
