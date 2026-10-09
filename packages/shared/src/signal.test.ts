import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  DATA_REFUSAL_REASONS,
  intervalForDuration,
  NoSignalReason,
  RULE_REFUSAL_REASONS,
  RULE_REFUSAL_REASONS_V1,
  safeParseTradingSignalRequest,
  safeParseTradingSignalResponse,
  safeParseTradingSignalsResponse,
  SIGNAL_CHART_INTERVAL_MS,
  SIGNAL_ALGORITHM_VERSION,
  SIGNAL_ALGORITHM_VERSIONS,
  SIGNAL_SCAN_INTERVALS,
  SIGNAL_SHORTEST_INTERVAL_MS,
  signalDecisionSchema,
  signalDecisionV1Schema,
  signalParamsSchema,
  signalParamsV1Schema,
  type DataRefusalReason,
  type RuleRefusalReason,
  type SignalParams,
  type SignalParamsV1,
} from './signal';

const featuresV1 = {
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
const features = { ...featuresV1, atrTicks: 4 };

const paramsV1: SignalParamsV1 = {
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
const params: SignalParams = { ...paramsV1, rsiExtremeBand: 15, minAtrTicks: 5 };

const DECISIONS: Record<string, Record<string, unknown>> = {
  signal: { kind: 'signal', version: 'v2', action: 'up', features },
  volatility_too_low: {
    kind: 'no_signal',
    version: 'v2',
    reason: 'volatility_too_low',
    features: { ...features, atrPct: 0.0001, trend: 'flat', momentum: 'neutral' },
  },
  invalid_candle: {
    kind: 'no_signal',
    version: 'v2',
    reason: 'invalid_candle',
    detail: { index: 3, problem: 'non_finite' },
  },
  candle_gap: {
    kind: 'no_signal',
    version: 'v2',
    reason: 'candle_gap',
    detail: { index: 7, expectedTimestamp: 1_760_000_420_000, actualTimestamp: 1_760_000_480_000 },
  },
  stale: {
    kind: 'no_signal',
    version: 'v2',
    reason: 'stale',
    detail: { lastCandleTimestamp: 1_760_000_000_000, ageMs: 600_000, maxAgeMs: 180_000 },
  },
  insufficient_candles: {
    kind: 'no_signal',
    version: 'v2',
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
    ['another version', { ...DECISIONS.signal, version: 'v1' }],
    ['a decision without atrTicks', { ...DECISIONS.signal, features: featuresV1 }],
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
    ['a signal without an action', { kind: 'signal', version: 'v2', features }],
  ];
  it.each(refused)('S2 refuses %s', (_, decision) => {
    expect(signalDecisionSchema.safeParse(decision).success).toBe(false);
  });
});

describe('intervalForDuration', () => {
  it.each([
    [1, '5s'],
    [4, '5s'],
    [5, '5s'],
    [14, '5s'],
    [15, '15s'],
    [59, '15s'],
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

  // the owner's rule (#313): the demo's short trades never fall back to a minute candle
  it.each([5, 15])('S3 a %i s trade is analysed on a sub-minute candle', (durationSec) => {
    const interval = intervalForDuration(durationSec);
    expect(interval).not.toBe('1m');
    expect(SIGNAL_CHART_INTERVAL_MS[interval]).toBe(durationSec * 1000);
  });

  it('S3 the shortest interval is 5s', () => {
    expect(SIGNAL_SHORTEST_INTERVAL_MS).toBe(5_000);
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

describe('GET /trading/signals contract', () => {
  const item = {
    assetId: 101,
    action: 'up',
    lastCandleTimestamp: 1_760_000_000_000,
    decidedAt: 1_760_000_015_500,
    ageMs: 500,
  };
  const list15 = { interval: '15s', scanned: 13, signals: [item] };
  const list5 = { interval: '5s', scanned: 4, signals: [] };
  const answer = { asOf: 1_760_000_016_000, lists: [list15, list5] };

  it('S6 scans 15s then 5s', () => {
    expect(SIGNAL_SCAN_INTERVALS).toEqual(['15s', '5s']);
  });

  it.each([answer, { ...answer, lists: [{ ...list15, signals: [] }, list5] }])(
    'S6 accepts the response %j',
    (response) => {
      expect(safeParseTradingSignalsResponse(response).data).toEqual(response);
    },
  );

  it.each([
    { ...answer, lists: [{ ...list15, interval: '1m' }] },
    { ...answer, lists: [{ ...list15, scanned: -1 }] },
    { ...answer, lists: [{ ...list15, signals: [{ ...item, action: 'sideways' }] }] },
    { ...answer, lists: [{ ...list15, signals: [{ ...item, ageMs: -1 }] }] },
    { ...answer, lists: [{ ...list15, signals: [{ ...item, assetId: 0 }] }] },
    { ...answer, lists: [{ ...list15, signals: [{ ...item, reason: 'flat_trend' }] }] },
    { ...answer, lists: [{ interval: '15s', signals: [] }] },
    { asOf: answer.asOf },
    { asOf: answer.asOf, interval: '15s', scanned: 25, signals: [item] },
  ])('S6 refuses the response %j', (response) => {
    expect(safeParseTradingSignalsResponse(response).success).toBe(false);
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

describe('algorithm versions (#379)', () => {
  it('S7 the current version is the last of the list', () => {
    expect(SIGNAL_ALGORITHM_VERSIONS.at(-1)).toBe(SIGNAL_ALGORITHM_VERSION);
    expect(SIGNAL_ALGORITHM_VERSIONS).toEqual(['v1', 'v2']);
  });

  const v1Signal = { kind: 'signal', version: 'v1', action: 'up', features: featuresV1 };
  const v2Signal = DECISIONS.signal;

  it('S8 each decision parses through its own version only', () => {
    expect(signalDecisionV1Schema.safeParse(v1Signal).data).toEqual(v1Signal);
    expect(signalDecisionSchema.safeParse(v2Signal).data).toEqual(v2Signal);
    expect(signalDecisionSchema.safeParse(v1Signal).success).toBe(false);
    expect(signalDecisionV1Schema.safeParse(v2Signal).success).toBe(false);
    // the v1 shape with the v1 version but v2 features
    expect(signalDecisionV1Schema.safeParse({ ...v1Signal, features }).success).toBe(false);
  });

  it.each(['volatility_below_tick_floor', 'rsi_overbought', 'rsi_oversold'])(
    'S8 %s is a v2 reason only',
    (reason) => {
      const v2 = { kind: 'no_signal', version: 'v2', reason, features };
      const v1 = { kind: 'no_signal', version: 'v1', reason, features: featuresV1 };
      expect(signalDecisionSchema.safeParse(v2).success).toBe(true);
      expect(signalDecisionV1Schema.safeParse(v1).success).toBe(false);
    },
  );

  it('S9 the v1 params refuse the v2 fields, the v2 params require them', () => {
    expect(signalParamsV1Schema.safeParse(paramsV1).success).toBe(true);
    expect(signalParamsV1Schema.safeParse(params).success).toBe(false);
    expect(signalParamsSchema.safeParse(params).data).toEqual(params);
    expect(signalParamsSchema.safeParse(paramsV1).success).toBe(false);
    expect(signalParamsSchema.safeParse({ ...params, extra: 1 }).success).toBe(false);
    expect(signalParamsSchema.safeParse({ ...params, minAtrTicks: 2.5 }).success).toBe(false);
    expect(signalParamsSchema.safeParse({ ...params, rsiExtremeBand: -1 }).success).toBe(false);
  });

  it('S5 the v1 rule reasons are the first five of the v2 list', () => {
    expect(RULE_REFUSAL_REASONS.slice(0, 5)).toEqual([...RULE_REFUSAL_REASONS_V1]);
    expect(RULE_REFUSAL_REASONS).toHaveLength(8);
  });
});
