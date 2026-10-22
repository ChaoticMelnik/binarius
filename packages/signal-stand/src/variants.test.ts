import {
  MacdCross,
  NoSignalReason,
  SignalKind,
  TradeAction,
  TrendDirection,
  type SignalDecision,
  type SignalFeatures,
  type SignalIndicators,
} from '@binarius/shared';
import {
  assertSignalParams,
  createSignalDecider,
  DEFAULT_SIGNAL_PARAMS,
  displayIndicators,
  SIGNAL_CHART_LIMIT,
} from '@binarius/signal';
import { describe, expect, it } from 'vitest';
import { priceIndex } from './price';
import { decisionContext, type Market } from './simulate';
import { aggregate, secondsPath, T0 } from './testing';
import {
  comparesWithV2,
  MA_GRID,
  MACD_GRID,
  MACD_MA_GRID,
  pointLabel,
  REVERT_GRID,
  V2_GRID,
  V2_PRODUCTION_POINT,
  VARIANTS,
  type DecisionContext,
} from './variants';
import { seriesAt } from './window';

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

const notRead = (): never => {
  throw new Error('not read');
};
const ctx = (
  v2: SignalDecision,
  minute: SignalDecision = data(),
  indicators: () => SignalIndicators | undefined = notRead,
): DecisionContext => ({
  nowMs: T0,
  v1: notRead,
  v2: () => v2,
  v2OneMinute: () => minute,
  indicators,
});

type Macd = SignalIndicators['macd'];
type Average = SignalIndicators['ma50'];
const macdOf = (histogram: number, cross: MacdCross): Macd => ({
  ok: true,
  macd: 0.0002,
  signal: 0.0001,
  histogram,
  cross,
});
const average = (value: number, lastClose: number): Average => ({ ok: true, value, lastClose });
const short = (closedCandles: number, required: number) =>
  ({ ok: false, closedCandles, required }) as const;
const indicators = (over: Partial<SignalIndicators> = {}): SignalIndicators => ({
  macd: macdOf(0.0001, MacdCross.Up),
  ma50: average(1, 1.1),
  ma200: average(1, 1.1),
  ...over,
});
const withIndicators = (decision: SignalDecision, value: SignalIndicators | undefined) =>
  ctx(decision, data(), () => value);

function market(): Market {
  const seconds = secondsPath(T0, 4 * 3600);
  return {
    assetId: 1,
    digits: 5,
    price: priceIndex(seconds),
    series: {
      '5s': aggregate(seconds, 5_000),
      '15s': aggregate(seconds, 15_000),
      '1m': aggregate(seconds, 60_000),
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

  it('V6 v2+1m trades only when the 1m trend agrees; no 1m data is no trade', () => {
    const confirm = variant('v2+1m');
    const up = signal(TradeAction.Up);
    expect(confirm.decide(ctx(up, signal(TradeAction.Up)), {})).toEqual({ action: 'up' });
    expect(
      confirm.decide(ctx(up, rule(NoSignalReason.RsiNeutral, { trend: TrendDirection.Up })), {}),
    ).toEqual({
      action: 'up',
    });
    expect(
      confirm.decide(ctx(up, signal(TradeAction.Down, { trend: TrendDirection.Down })), {}),
    ).toEqual({
      refusal: '1m_trend_disagrees',
    });
    expect(
      confirm.decide(ctx(up, rule(NoSignalReason.TrendFlat, { trend: TrendDirection.Flat })), {}),
    ).toEqual({
      refusal: '1m_trend_disagrees',
    });
    expect(confirm.decide(ctx(up, data()), {})).toEqual({ refusal: '1m_no_data' });
    expect(confirm.decide(ctx(rule(NoSignalReason.TrendFlat), signal(TradeAction.Up)), {})).toEqual(
      {
        refusal: NoSignalReason.TrendFlat,
      },
    );
  });

  it('V7 the 1m decision 59 s into a minute reads the last closed minute', () => {
    const m = market();
    const boundary = T0 + 3 * 3600_000;
    const minute = decisionContext(m, '5s', boundary + 59_000).v2OneMinute();
    expect(minute).toHaveProperty('features.lastCandleTimestamp', boundary - 60_000);
  });

  it('V9 the grids: 9 / 3 / 1 / 2 / 3 / 6 points, unique names, every v2 point a valid parameter set', () => {
    expect(V2_GRID).toHaveLength(9);
    expect(REVERT_GRID).toHaveLength(3);
    expect(variant('v1').grid).toHaveLength(1);
    expect(variant('v2+1m').grid).toHaveLength(1);
    expect(variant('v2+macd').grid).toBe(MACD_GRID);
    expect(variant('v2+ma').grid).toBe(MA_GRID);
    expect(variant('v2+macd+ma').grid).toBe(MACD_MA_GRID);
    expect([MACD_GRID, MA_GRID, MACD_MA_GRID].map((grid) => grid.length)).toEqual([2, 3, 6]);
    expect(MACD_MA_GRID.map(pointLabel)).toContain('macd=cross ma=50+200');
    const names = VARIANTS.map((v) => v.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(['v1', 'v2', 'revert', 'v2+1m', 'v2+macd', 'v2+ma', 'v2+macd+ma']);
    expect(names.filter(comparesWithV2)).toEqual(['v2+1m', 'v2+macd', 'v2+ma', 'v2+macd+ma']);
    for (const name of ['v2+macd', 'v2+ma', 'v2+macd+ma']) {
      expect(variant(name).intervals).toEqual(['5s', '15s']);
    }
    // #698: production runs without the pause, so no headline row has it
    for (const spec of VARIANTS) expect(spec.headlinePause).toBe(false);
    expect(V2_GRID).toContainEqual(V2_PRODUCTION_POINT);
    for (const point of V2_GRID) {
      expect(() => assertSignalParams({ ...DEFAULT_SIGNAL_PARAMS, ...point })).not.toThrow();
      expect(point.rsiExtremeBand).toBeGreaterThan(DEFAULT_SIGNAL_PARAMS.rsiBand);
    }
  });

  it('V10 v2+macd: cross trades only on a cross in the direction, hist on the histogram sign', () => {
    const macd = variant('v2+macd');
    const cross = { macd: 'cross' };
    const hist = { macd: 'hist' };
    const crossed = indicators({ macd: macdOf(0.0001, MacdCross.Up) });
    const uncrossed = indicators({ macd: macdOf(0.0001, MacdCross.None) });
    const up = signal(TradeAction.Up);
    const down = signal(TradeAction.Down);
    expect(macd.decide(withIndicators(up, crossed), cross)).toEqual({ action: 'up' });
    expect(macd.decide(withIndicators(up, uncrossed), cross)).toEqual({
      refusal: 'macd_no_cross',
    });
    expect(macd.decide(withIndicators(down, crossed), cross)).toEqual({
      refusal: 'macd_no_cross',
    });
    expect(macd.decide(withIndicators(up, crossed), hist)).toEqual({ action: 'up' });
    expect(macd.decide(withIndicators(up, uncrossed), hist)).toEqual({ action: 'up' });
    expect(macd.decide(withIndicators(down, uncrossed), hist)).toEqual({
      refusal: 'macd_hist_disagrees',
    });
    const falling = indicators({ macd: macdOf(-0.0001, MacdCross.Down) });
    expect(macd.decide(withIndicators(down, falling), cross)).toEqual({ action: 'down' });
    expect(macd.decide(withIndicators(down, falling), hist)).toEqual({ action: 'down' });
  });

  it('V10b a zero histogram agrees with neither direction; no MACD is macd_no_data', () => {
    const macd = variant('v2+macd');
    const zero = indicators({ macd: macdOf(0, MacdCross.None) });
    for (const action of [TradeAction.Up, TradeAction.Down]) {
      expect(macd.decide(withIndicators(signal(action), zero), { macd: 'cross' })).toEqual({
        refusal: 'macd_no_cross',
      });
      expect(macd.decide(withIndicators(signal(action), zero), { macd: 'hist' })).toEqual({
        refusal: 'macd_hist_disagrees',
      });
      for (const mode of ['cross', 'hist']) {
        expect(
          macd.decide(withIndicators(signal(action), indicators({ macd: short(20, 35) })), {
            macd: mode,
          }),
        ).toEqual({ refusal: 'macd_no_data' });
      }
    }
  });

  it('V11 v2+ma: the close on the direction side of MA200, MA50 or both; down mirrored; equal is neither', () => {
    const ma = variant('v2+ma');
    // the close below MA200 and above MA50
    const between = indicators({ ma50: average(0.9, 1), ma200: average(1.1, 1) });
    const up = signal(TradeAction.Up);
    const down = signal(TradeAction.Down);
    expect(ma.decide(withIndicators(up, between), { ma: '200' })).toEqual({
      refusal: 'ma200_disagrees',
    });
    expect(ma.decide(withIndicators(up, between), { ma: '50' })).toEqual({ action: 'up' });
    expect(ma.decide(withIndicators(up, between), { ma: '50+200' })).toEqual({
      refusal: 'ma200_disagrees',
    });
    expect(ma.decide(withIndicators(down, between), { ma: '200' })).toEqual({ action: 'down' });
    expect(ma.decide(withIndicators(down, between), { ma: '50' })).toEqual({
      refusal: 'ma50_disagrees',
    });
    expect(ma.decide(withIndicators(down, between), { ma: '50+200' })).toEqual({
      refusal: 'ma50_disagrees',
    });
    const above = indicators({ ma50: average(0.9, 1), ma200: average(0.8, 1) });
    expect(ma.decide(withIndicators(up, above), { ma: '50+200' })).toEqual({ action: 'up' });
    const equal = indicators({ ma50: average(1, 1), ma200: average(1, 1) });
    for (const decision of [up, down]) {
      expect(ma.decide(withIndicators(decision, equal), { ma: '200' })).toEqual({
        refusal: 'ma200_disagrees',
      });
      expect(ma.decide(withIndicators(decision, equal), { ma: '50' })).toEqual({
        refusal: 'ma50_disagrees',
      });
    }
  });

  it('V11b no MA200 (a gap in the last 200 rows) is ma200_no_data; MA50 still trades', () => {
    const ma = variant('v2+ma');
    const gap = indicators({ ma200: short(150, 200) });
    const up = signal(TradeAction.Up);
    expect(ma.decide(withIndicators(up, gap), { ma: '200' })).toEqual({
      refusal: 'ma200_no_data',
    });
    expect(ma.decide(withIndicators(up, gap), { ma: '50' })).toEqual({ action: 'up' });
    expect(ma.decide(withIndicators(up, gap), { ma: '50+200' })).toEqual({
      refusal: 'ma200_no_data',
    });
    expect(
      ma.decide(withIndicators(up, indicators({ ma50: short(40, 50) })), { ma: '50' }),
    ).toEqual({ refusal: 'ma50_no_data' });
  });

  it('V11c no indicators is indicators_unavailable; a v2 refusal comes before they are read', () => {
    for (const name of ['v2+macd', 'v2+ma', 'v2+macd+ma']) {
      const spec = variant(name);
      const point = spec.grid[0];
      expect(spec.decide(withIndicators(signal(TradeAction.Up), undefined), point)).toEqual({
        refusal: 'indicators_unavailable',
      });
      expect(spec.decide(ctx(rule(NoSignalReason.TrendFlat)), point)).toEqual({
        refusal: NoSignalReason.TrendFlat,
      });
      expect(spec.decide(ctx(data()), point)).toEqual({
        refusal: NoSignalReason.InsufficientCandles,
      });
    }
  });

  it('V12 the indicators read the 300-row fetch: MA200 where the 60-row window has none', () => {
    const m = market();
    const nowMs = T0 + 3 * 3600_000 + 2_000;
    const read = decisionContext(m, '5s', nowMs).indicators();
    expect(read?.ma200.ok).toBe(true);
    expect(read?.macd.ok).toBe(true);
    const window = displayIndicators(
      seriesAt(m.series['5s']!, 5_000, nowMs, SIGNAL_CHART_LIMIT),
      5_000,
      nowMs,
      DEFAULT_SIGNAL_PARAMS,
    );
    expect(window?.ma200.ok).toBe(false);
  });

  it('V13 v2+macd+ma: the MACD reason first, then the MA reason, then the trade', () => {
    const both = variant('v2+macd+ma');
    const point = { macd: 'cross', ma: '200' };
    const up = signal(TradeAction.Up);
    const macdNo = macdOf(0.0001, MacdCross.None);
    const maNo = average(1.1, 1);
    expect(
      both.decide(withIndicators(up, indicators({ macd: macdNo, ma200: maNo })), point),
    ).toEqual({ refusal: 'macd_no_cross' });
    expect(both.decide(withIndicators(up, indicators({ ma200: maNo })), point)).toEqual({
      refusal: 'ma200_disagrees',
    });
    expect(both.decide(withIndicators(up, indicators()), point)).toEqual({ action: 'up' });
  });

  it('V14 a point of the wrong shape is a RangeError, not a silent default', () => {
    expect(() =>
      variant('v2+macd').decide(withIndicators(signal(TradeAction.Up), indicators()), {
        macd: 'sign',
      }),
    ).toThrow(RangeError);
    expect(() => variant('revert').decide(ctx(signal(TradeAction.Up)), { band: '15' })).toThrow(
      RangeError,
    );
  });
});
