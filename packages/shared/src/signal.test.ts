import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  DATA_REFUSAL_REASONS,
  intervalForDuration,
  NoSignalReason,
  RULE_REFUSAL_REASONS,
  safeParseTradingSignalRequest,
  safeParseTradingSignalResponse,
  signalDecisionSchema,
  type DataRefusalReason,
  type RuleRefusalReason,
  type SignalParams,
} from './signal';

const features = {
  emaFast: 1.1052,
  emaSlow: 1.1047,
  emaSlowSlope: 0.0003,
  rsi: 61.2,
  atr: 0.0004,
  atrPct: 0.036,
  lastClose: 1.1055,
  lastCandleTimestamp: 1_760_000_000_000,
  closedCandles: 58,
  trend: 'up',
  momentum: 'up',
};

const params: SignalParams = {
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
};

const DECISIONS: Record<string, Record<string, unknown>> = {
  signal: { kind: 'signal', version: 'v1', action: 'up', features },
  volatility_too_low: {
    kind: 'no_signal',
    version: 'v1',
    reason: 'volatility_too_low',
    features: { ...features, atrPct: 0.0001, trend: 'flat', momentum: 'neutral' },
  },
  invalid_candle: {
    kind: 'no_signal',
    version: 'v1',
    reason: 'invalid_candle',
    detail: { index: 3, problem: 'non_finite' },
  },
  candle_gap: {
    kind: 'no_signal',
    version: 'v1',
    reason: 'candle_gap',
    detail: { index: 7, expectedTimestamp: 1_760_000_420_000, actualTimestamp: 1_760_000_480_000 },
  },
  stale: {
    kind: 'no_signal',
    version: 'v1',
    reason: 'stale',
    detail: { lastCandleTimestamp: 1_760_000_000_000, ageMs: 600_000, maxAgeMs: 180_000 },
  },
  insufficient_candles: {
    kind: 'no_signal',
    version: 'v1',
    reason: 'insufficient_candles',
    detail: { closedCandles: 9, required: 50 },
  },
};

describe('signalDecisionSchema', () => {
  it.each(Object.entries(DECISIONS))('S1 %s round-trips', (_, decision) => {
    const parsed = signalDecisionSchema.safeParse(JSON.parse(JSON.stringify(decision)));
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual(decision);
  });

  const refused: [string, Record<string, unknown>][] = [
    ['another version', { ...DECISIONS.signal, version: 'v2' }],
    ['a rule reason with a detail', { ...DECISIONS.volatility_too_low, detail: { index: 0 } }],
    ['a data reason with features', { ...DECISIONS.stale, features }],
    ['an unknown reason', { ...DECISIONS.volatility_too_low, reason: 'moon_phase' }],
    [
      'a NaN feature (null on the wire)',
      { ...DECISIONS.signal, features: { ...features, rsi: null } },
    ],
    ['a NaN feature', { ...DECISIONS.signal, features: { ...features, rsi: Number.NaN } }],
    [
      'a fractional closedCandles',
      { ...DECISIONS.signal, features: { ...features, closedCandles: 1.5 } },
    ],
    ['a signal without an action', { kind: 'signal', version: 'v1', features }],
  ];
  it.each(refused)('S2 refuses %s', (_, decision) => {
    expect(signalDecisionSchema.safeParse(decision).success).toBe(false);
  });
});

describe('intervalForDuration', () => {
  it.each([
    [5, '1m'],
    [59, '1m'],
    [60, '1m'],
    [61, '1m'],
    [299, '1m'],
    [300, '5m'],
    [301, '5m'],
    [899, '5m'],
    [900, '15m'],
    [1799, '15m'],
    [1800, '30m'],
    [3599, '30m'],
    [3600, '1h'],
    [7200, '1h'],
  ])('S3 %i s -> %s', (durationSec, interval) => {
    expect(intervalForDuration(durationSec)).toBe(interval);
  });

  it.each([0, -60, 1.5, Number.NaN])('S3 refuses %s', (durationSec) => {
    expect(() => intervalForDuration(durationSec)).toThrow(RangeError);
  });
});

describe('POST /trading/signal contract', () => {
  it('S4 accepts a request', () => {
    expect(safeParseTradingSignalRequest({ assetId: 101, interval: '1m' }).data).toEqual({
      assetId: 101,
      interval: '1m',
    });
  });

  it.each([
    { assetId: 0, interval: '1m' },
    { assetId: 2 ** 31, interval: '1m' },
    { assetId: '101', interval: '1m' },
    { assetId: 101, interval: '2m' },
    { assetId: 101, interval: 60 },
    { assetId: 101 },
  ])('S4 refuses the request %j', (request) => {
    expect(safeParseTradingSignalRequest(request).success).toBe(false);
  });

  it.each([
    { outcome: 'decided', params, decision: DECISIONS.signal },
    { outcome: 'decided', params, decision: DECISIONS.stale },
    { outcome: 'fetch_failed', code: 'rate_limited', retryAfterSec: 7 },
    { outcome: 'fetch_failed', code: 'unavailable' },
  ])('S4 accepts the response %j', (response) => {
    expect(safeParseTradingSignalResponse(response).data).toEqual(response);
  });

  it.each([
    { outcome: 'fetch_failed' },
    { outcome: 'fetch_failed', code: 'rate_limited', retryAfterSec: -1 },
    { outcome: 'fetch_failed', code: 'rate_limited', retryAfterSec: 1.5 },
    { outcome: 'fetch_failed', code: 'teapot' },
    { outcome: 'fetch_failed', code: 'unavailable', status: 503 },
    { outcome: 'decided', decision: DECISIONS.signal },
    { outcome: 'maybe', code: 'unavailable' },
  ])('S4 refuses the response %j', (response) => {
    expect(safeParseTradingSignalResponse(response).success).toBe(false);
  });
});

describe('refusal reasons', () => {
  it('S5 partition NoSignalReason', () => {
    const all = [...DATA_REFUSAL_REASONS, ...RULE_REFUSAL_REASONS];
    expect(new Set(all).size).toBe(all.length);
    expect(new Set(all)).toEqual(new Set(Object.values(NoSignalReason)));
    expectTypeOf<DataRefusalReason | RuleRefusalReason>().toEqualTypeOf<NoSignalReason>();
  });
});
