import {
  NoSignalReason,
  SignalKind,
  TradeAction,
  TrendDirection,
  type SignalDecision,
  type SignalFeatures,
} from '@binarius/shared';
import { assertSignalParams, createSignalDecider, DEFAULT_SIGNAL_PARAMS } from '@binarius/signal';
import { describe, expect, it } from 'vitest';
import { priceIndex } from './price';
import { decisionContext, type Market } from './simulate';
import { aggregate, secondsPath, T0 } from './testing';
import {
  REVERT_GRID,
  V2_GRID,
  V2_PRODUCTION_POINT,
  VARIANTS,
  type DecisionContext,
} from './variants';

const variant = (name: string) => VARIANTS.find((v) => v.name === name)!;

const features = (over: Partial<SignalFeatures> = {}): SignalFeatures => ({
  emaFast: 1,
  emaSlow: 1,
  emaSlowSlope: 0,
  rsi: 50,
  atr: 0.001,
  atrPct: 0.1,
  lastClose: 1,
  lastCandleTimestamp: T0,
  closedCandles: 59,
  trend: TrendDirection.Up,
  momentum: 'up',
  atrTicks: 100,
  ...over,
});
const signal = (action: TradeAction, over: Partial<SignalFeatures> = {}): SignalDecision => ({
  kind: SignalKind.Signal,
  version: 'v2',
  action,
  features: features(over),
});
const rule = (reason: string, over: Partial<SignalFeatures> = {}) =>
  ({
    kind: SignalKind.NoSignal,
    version: 'v2',
    reason,
    features: features(over),
  }) as SignalDecision;
const data = (): SignalDecision => ({
  kind: SignalKind.NoSignal,
  version: 'v2',
  reason: NoSignalReason.InsufficientCandles,
  detail: { closedCandles: 3, required: 50 },
});

const ctx = (v2: SignalDecision): DecisionContext => ({
  nowMs: T0,
  v1: () => {
    throw new Error('not read');
  },
  v2: () => v2,
});

function market(): Market {
  const seconds = secondsPath(T0, 4 * 3600);
  return {
    assetId: 1,
    digits: 5,
    price: priceIndex(seconds),
    series: {
      '5s': aggregate(seconds, 5_000),
      '15s': aggregate(seconds, 15_000),
    },
  };
}

describe('variants', () => {
  it('V1 v1 passes a signal through and refuses every no_signal', () => {
    const v1 = variant('v1');
    const withV1 = (decision: unknown): DecisionContext => ({
      ...ctx(data()),
      v1: () => decision as never,
    });
    expect(v1.decide(withV1({ ...signal(TradeAction.Down), version: 'v1' }), {})).toEqual({
      action: 'down',
    });
    expect(v1.decide(withV1({ ...rule(NoSignalReason.TrendFlat), version: 'v1' }), {})).toEqual({
      refusal: NoSignalReason.TrendFlat,
    });
  });

  it('V2 v2 at the production point equals createSignalDecider() on the fixture, decision by decision', () => {
    const m = market();
    const production = createSignalDecider();
    const seen = new Set<string>();
    for (let nowMs = T0 + 600_000 + 2_000; nowMs < T0 + 4 * 3600_000; nowMs += 5_000) {
      const stand = decisionContext(m, '5s', nowMs).v2(V2_PRODUCTION_POINT);
      const candles = m.series['5s']!.filter(
        (c) => c.timestamp > nowMs - 60 * 5_000 && c.timestamp <= nowMs,
      );
      expect(stand).toEqual(production.decide({ candles, intervalMs: 5_000, nowMs, digits: 5 }));
      expect(variant('v2').decide(decisionContext(m, '5s', nowMs), V2_PRODUCTION_POINT)).toEqual(
        stand.kind === SignalKind.Signal ? { action: stand.action } : { refusal: stand.reason },
      );
      seen.add(stand.kind === SignalKind.Signal ? 'signal' : stand.reason);
    }
    expect(seen.has('signal')).toBe(true);
    expect(seen.size).toBeGreaterThan(2);
  });

  it('V5 revert trades against an RSI extreme and keeps v2 data and volatility refusals', () => {
    const revert = variant('revert');
    const band = { band: 15 };
    expect(revert.decide(ctx(rule(NoSignalReason.TrendFlat, { rsi: 65 })), band)).toEqual({
      action: 'down',
    });
    expect(revert.decide(ctx(signal(TradeAction.Up, { rsi: 64.99 })), band)).toEqual({
      refusal: 'revert_rsi_inside_band',
    });
    expect(revert.decide(ctx(rule(NoSignalReason.RsiOversold, { rsi: 35 })), band)).toEqual({
      action: 'up',
    });
    expect(revert.decide(ctx(rule(NoSignalReason.RsiNeutral, { rsi: 35.01 })), band)).toEqual({
      refusal: 'revert_rsi_inside_band',
    });
    for (const reason of [
      NoSignalReason.VolatilityTooLow,
      NoSignalReason.VolatilityTooHigh,
      NoSignalReason.VolatilityBelowTickFloor,
    ]) {
      expect(revert.decide(ctx(rule(reason, { rsi: 90 })), band)).toEqual({ refusal: reason });
    }
    expect(revert.decide(ctx(data()), band)).toEqual({
      refusal: NoSignalReason.InsufficientCandles,
    });
  });

  it('V9 the grids: 9 / 3 / 1 points, every v2 point a valid parameter set', () => {
    expect(V2_GRID).toHaveLength(9);
    expect(REVERT_GRID).toHaveLength(3);
    expect(variant('v1').grid).toHaveLength(1);
    expect(V2_GRID).toContainEqual(V2_PRODUCTION_POINT);
    for (const point of V2_GRID) {
      expect(() => assertSignalParams({ ...DEFAULT_SIGNAL_PARAMS, ...point })).not.toThrow();
      expect(point.rsiExtremeBand).toBeGreaterThan(DEFAULT_SIGNAL_PARAMS.rsiBand);
    }
  });
});
