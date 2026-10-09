import type { SignalParams } from '@binarius/shared';
import { describe, expect, it } from 'vitest';
import {
  assertSignalParams,
  assertSignalParamsV1,
  DEFAULT_SIGNAL_PARAMS,
  DEFAULT_SIGNAL_PARAMS_V1,
  minClosedCandlesFloor,
} from './config';

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

  it.each([5, 4, Number.NaN])('K11 rsiExtremeBand %s (not above rsiBand 5) throws', (band) => {
    expect(() => assertSignalParams(withParams({ rsiExtremeBand: band }))).toThrow(
      /rsiExtremeBand/,
    );
    expect(() => assertSignalParams(withParams({ rsiExtremeBand: 5.5 }))).not.toThrow();
  });

  it('K12 rsiExtremeBand above 50 throws, 50 passes', () => {
    expect(() => assertSignalParams(withParams({ rsiExtremeBand: 50.5 }))).toThrow(
      /rsiExtremeBand/,
    );
    expect(() => assertSignalParams(withParams({ rsiExtremeBand: 50 }))).not.toThrow();
  });

  it.each([0, 2.5, -1])('K13 minAtrTicks %s throws', (ticks) => {
    expect(() => assertSignalParams(withParams({ minAtrTicks: ticks }))).toThrow(/minAtrTicks/);
  });

  it('K14 the v2 defaults are 15 and 5; the v1 defaults pass v1 only', () => {
    expect(DEFAULT_SIGNAL_PARAMS).toMatchObject({ rsiExtremeBand: 15, minAtrTicks: 5 });
    expect(DEFAULT_SIGNAL_PARAMS).toStrictEqual({
      ...DEFAULT_SIGNAL_PARAMS_V1,
      rsiExtremeBand: 15,
      minAtrTicks: 5,
    });
    expect(() => assertSignalParamsV1(DEFAULT_SIGNAL_PARAMS_V1)).not.toThrow();
    expect(() => assertSignalParams(DEFAULT_SIGNAL_PARAMS_V1 as SignalParams)).toThrow(
      /rsiExtremeBand/,
    );
  });

  it('K15 the v2 assert keeps every v1 rule', () => {
    expect(() => assertSignalParams(withParams({ rsiBand: 50 }))).toThrow(/rsiBand/);
    expect(() => assertSignalParamsV1(withParams({ minAtrTicks: 0 }))).not.toThrow();
  });
});
