import {
  MacdCross,
  MomentumDirection,
  NoSignalReason,
  SignalKind,
  TradeAction,
  TrendDirection,
  type Candle,
  type SignalDecision,
  type SignalFeatures,
  type SignalIndicators,
} from '@binarius/shared';
import {
  atr,
  createSignalDecider,
  DEFAULT_SIGNAL_PARAMS,
  type SignalDecider,
} from '@binarius/signal';
import { describe, expect, it } from 'vitest';
import {
  alignSeries,
  compareAggregation,
  compareDecisions,
  compareDisplay,
  compareSeries,
  decideAt,
  decisionCategory,
  DecisionCategory,
  type CompareContext,
  type Span,
} from './candle-spike-compare';

const I = 5_000;
const T0 = 1_760_000_000_000;
const DIGITS = 5;

const round = (value: number) => Number(value.toFixed(DIGITS));

// the broker's convention: open = the previous close, high/low around the body by `wick`
function series(n: number, closeAt: (i: number) => number, start = T0, step = I, wick = 0.00003) {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const close = round(closeAt(i));
    const open = i === 0 ? close : out[i - 1]!.close;
    out.push({
      timestamp: start + i * step,
      open,
      high: round(Math.max(open, close) + wick),
      low: round(Math.min(open, close) - wick),
      close,
    });
  }
  return out;
}

const wave = (i: number) => 1.1 + 0.0004 * Math.sin(i / 4) + 0.00002 * i;

const context = (
  n: number,
  fields: Partial<CompareContext> = {},
  start = T0,
  step = I,
): CompareContext => ({
  range: { firstMs: start, lastMs: start + (n - 1) * step },
  intervalMs: step,
  digits: DIGITS,
  holes: [],
  ...fields,
});

const features = (atrTicks: number): SignalFeatures => ({
  emaFast: 1,
  emaSlow: 1,
  emaSlowSlope: 0,
  rsi: 50,
  atr: atrTicks / 10 ** DIGITS,
  atrPct: 0.01,
  lastClose: 1.1,
  lastCandleTimestamp: T0,
  closedCandles: 59,
  trend: TrendDirection.Flat,
  momentum: MomentumDirection.Neutral,
  atrTicks,
});

const signal = (action: TradeAction, atrTicks = 6): SignalDecision => ({
  kind: SignalKind.Signal,
  version: 'v2',
  action,
  features: features(atrTicks),
});

const refusal = (
  reason: typeof NoSignalReason.TrendFlat | typeof NoSignalReason.VolatilityBelowTickFloor,
  atrTicks = 6,
): SignalDecision => ({
  kind: SignalKind.NoSignal,
  version: 'v2',
  reason,
  features: features(atrTicks),
});

// a decider answering by side: the REST series carries closes below 2, the tick series above
function stubDecider(answer: (side: 'rest' | 'ticks', nowMs: number) => SignalDecision) {
  const decider: SignalDecider = {
    version: 'v2',
    params: DEFAULT_SIGNAL_PARAMS,
    decide: ({ candles, nowMs }) => answer((candles[0]?.close ?? 0) < 2 ? 'rest' : 'ticks', nowMs),
  };
  return decider;
}

const lifted = (rows: readonly Candle[]) =>
  rows.map((c) => ({
    ...c,
    open: c.open + 2,
    high: c.high + 2,
    low: c.low + 2,
    close: c.close + 2,
  }));

describe('alignSeries', () => {
  it('K1 counts both, restOnly and ticksOnly inside the range', () => {
    const rest = series(6, wave);
    const ticks = series(7, wave).filter((_, i) => i !== 2);
    // REST rows 0-4; the ticks lack 2 and add 5 and 6
    const aligned = alignSeries(ticks, rest.slice(0, 5), context(7).range);
    expect([aligned.both, aligned.restOnly, aligned.ticksOnly]).toEqual([4, 1, 2]);
  });
});

describe('compareSeries', () => {
  it('K2 compares at digits; a one-step high lands in bucket 1', () => {
    const rest = series(3, wave);
    rest[0] = { ...rest[0]!, open: 0.69462 };
    const ticks = rest.map((c) => ({ ...c }));
    ticks[0] = { ...ticks[0]!, open: 0.6946199999999999 };
    ticks[1] = { ...ticks[1]!, high: round(ticks[1]!.high + 0.00001) };
    const result = compareSeries(ticks, rest, context(3));
    expect(result).toMatchObject({
      compared: 3,
      openEq: 3,
      closeEq: 3,
      allEq: 2,
      high: [2, 1, 0, 0],
      low: [3, 0, 0, 0],
    });
  });

  it('K3 the ATR difference is the mean and the max over the series', () => {
    const rest = series(40, wave);
    const ticks = rest.map((c, i) => (i === 3 ? { ...c, high: round(c.high + 0.0003) } : c));
    const result = compareSeries(ticks, rest, context(40));
    const a = atr(ticks, 14);
    const relative = atr(rest, 14).map((value, i) => (Math.abs(a[i]! - value) / value) * 100);
    expect(result.atr?.meanPct).toBeCloseTo(
      relative.reduce((sum, value) => sum + value, 0) / relative.length,
      10,
    );
    expect(result.atr?.maxPct).toBeCloseTo(Math.max(...relative), 10);
    expect(result.atr!.maxPct).toBeGreaterThan(result.atr!.meanPct);
  });

  it('K6 rows overlapping a hole are counted apart', () => {
    const rest = series(5, wave);
    const ticks = rest.map((c, i) => (i === 2 ? { ...c, close: round(c.close + 0.001) } : c));
    const holes: Span[] = [{ fromMs: T0 + 2 * I + 1, toMs: T0 + 2 * I + 2 }];
    const result = compareSeries(ticks, rest, context(5, { holes }));
    expect(result).toMatchObject({ compared: 4, closeEq: 4, inHole: 1 });
  });
});

describe('compareAggregation', () => {
  it('K7 the end-labelled 1s rows aggregate exactly to the native series', () => {
    const seconds = series(5 * 12, wave, T0 + 1_000, 1_000);
    const native: Candle[] = [];
    for (let b = 0; b < 12; b++) {
      const rows = seconds.slice(b * 5, b * 5 + 5);
      native.push({
        timestamp: T0 + b * I,
        open: rows[0]!.open,
        high: Math.max(...rows.map((r) => r.high)),
        low: Math.min(...rows.map((r) => r.low)),
        close: rows[4]!.close,
      });
    }
    const result = compareAggregation(seconds, native, context(12));
    expect([result.compared, result.allEq]).toEqual([12, 12]);
  });
});

describe('decisionCategory', () => {
  it('K4 names each kind of difference, from REST to ticks', () => {
    const up = signal(TradeAction.Up);
    const flat = refusal(NoSignalReason.TrendFlat);
    expect(decisionCategory(up, flat)).toBe(DecisionCategory.SignalToNoSignal);
    expect(decisionCategory(flat, up)).toBe(DecisionCategory.NoSignalToSignal);
    expect(decisionCategory(up, signal(TradeAction.Down))).toBe(DecisionCategory.UpDown);
    expect(decisionCategory(up, signal(TradeAction.Up))).toBeUndefined();
    expect(decisionCategory(flat, refusal(NoSignalReason.TrendFlat))).toBeUndefined();
  });
});

describe('compareDecisions', () => {
  // 59 candles in the range: one moment, the close of the last one
  const oneMoment = context(59);
  const rest = series(59, wave);
  const ticks = lifted(rest);

  it('K4 a refusal reason that changes is a difference', () => {
    const decider = stubDecider((side) =>
      side === 'rest'
        ? refusal(NoSignalReason.TrendFlat)
        : refusal(NoSignalReason.VolatilityBelowTickFloor),
    );
    const result = compareDecisions(ticks, rest, { ...oneMoment, decider });
    expect(result.compared).toBe(1);
    expect(result.differ).toBe(1);
    expect(result.categories[DecisionCategory.ReasonChanged]).toBe(1);
  });

  it('K5 the tick floor at minAtrTicks, on rule refusals too', () => {
    const run = (restTicks: number, ticksTicks: number) =>
      compareDecisions(ticks, rest, {
        ...oneMoment,
        decider: stubDecider((side) =>
          side === 'rest'
            ? refusal(NoSignalReason.VolatilityBelowTickFloor, restTicks)
            : refusal(NoSignalReason.TrendFlat, ticksTicks),
        ),
      });
    expect(DEFAULT_SIGNAL_PARAMS.minAtrTicks).toBe(5);
    expect([run(4.9, 5.1).tickFloorCompared, run(4.9, 5.1).tickFloorDiffer]).toEqual([1, 1]);
    expect(run(5, 5.1).tickFloorDiffer).toBe(0);
    expect(run(5, 5).tickFloorDiffer).toBe(0);
  });

  it('K6 moments whose window overlaps a hole are counted apart', () => {
    // three moments: the closes of candles 58, 59 and 60; the hole is inside candle 60
    const restLong = series(61, wave);
    const holes: Span[] = [{ fromMs: T0 + 60 * I + 1, toMs: T0 + 60 * I + 2 }];
    const result = compareDecisions(lifted(restLong), restLong, {
      ...context(61, { holes }),
      decider: stubDecider((side) =>
        side === 'rest' ? signal(TradeAction.Up) : refusal(NoSignalReason.TrendFlat),
      ),
    });
    expect([result.compared, result.differ]).toEqual([2, 2]);
    expect(result.inHole).toEqual({ compared: 1, differ: 1 });
  });

  it('K8 the decision window is cut by time: an older row does not enter it', () => {
    const decider = createSignalDecider();
    const recent = series(59, wave, T0 + 2 * I);
    const older = series(1, wave, T0)[0]!;
    const nowMs = recent.at(-1)!.timestamp + I + 1;
    const ctx = { intervalMs: I, digits: DIGITS, decider };
    const without = decideAt(recent, nowMs, ctx);
    expect(without.kind === SignalKind.NoSignal && without.reason).not.toBe(
      NoSignalReason.CandleGap,
    );
    expect(decideAt([older, ...recent], nowMs, ctx)).toEqual(without);
  });

  it('K10 the display sees the range only: REST history before it does not count', () => {
    const step = 15_000;
    const start = T0 + 180 * step;
    const restLong = series(300, wave, T0, step);
    const ticksInRange = restLong.slice(180);
    const result = compareDecisions(ticksInRange, restLong, {
      ...context(120, {}, start, step),
      decider: createSignalDecider(),
    });
    expect(result.compared).toBe(120 - 58);
    expect(result.display.ma200).toEqual({ compared: 0, sideDiffer: 0, okDiffer: 0 });
    expect(result.display.ma50.compared).toBeGreaterThan(0);
    expect(result.display.ma50.okDiffer).toBe(0);
  });
});

describe('compareDisplay', () => {
  const macd = (cross: MacdCross, histogram: number): SignalIndicators['macd'] => ({
    ok: true,
    macd: 0,
    signal: 0,
    histogram,
    cross,
  });
  const ma = (value: number, lastClose: number): SignalIndicators['ma50'] => ({
    ok: true,
    value,
    lastClose,
  });
  const short = (closedCandles: number, required: number) =>
    ({ ok: false, closedCandles, required }) as const;

  it('K9 cross, sign, MA side and ok on one side only', () => {
    const rest: SignalIndicators = {
      macd: macd(MacdCross.Up, 0.1),
      ma50: ma(1.1, 1.2),
      ma200: short(120, 200),
    };
    const ticks: SignalIndicators = {
      macd: macd(MacdCross.None, 0.1),
      ma50: ma(1.1, 1.0),
      ma200: short(118, 200),
    };
    expect(compareDisplay(rest, ticks)).toEqual({
      macd: { compared: 1, crossDiffer: 1, signDiffer: 0, okDiffer: 0 },
      ma50: { compared: 1, sideDiffer: 1, okDiffer: 0 },
      ma200: { compared: 0, sideDiffer: 0, okDiffer: 0 },
    });

    const oneSide = compareDisplay({ ...rest, ma200: ma(1.0, 1.2) }, undefined);
    expect(oneSide.ma200).toEqual({ compared: 0, sideDiffer: 0, okDiffer: 1 });
    expect(oneSide.macd.okDiffer).toBe(1);
  });
});
