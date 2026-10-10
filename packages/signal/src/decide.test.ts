import {
  MAX_PAIR_DIGITS,
  SIGNAL_ALGORITHM_VERSION,
  signalDecisionSchema,
  signalDecisionV1Schema,
  type Candle,
  type SignalDecision,
} from '@binarius/shared';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SIGNAL_PARAMS } from './config';
import { createSignalDecider, createSignalDeciderV1 } from './decide';
import {
  burst,
  closedNow,
  fall,
  integerSeries,
  INTERVAL_MS,
  mildFall,
  mildRise,
  seriesFrom,
  sine,
  tickSeries,
  trending,
} from './testing';

// the series around 100 move in hundredths
const DIGITS = 2;
const decider = createSignalDecider();
const decide = (
  candles: readonly Candle[],
  nowMs = closedNow(candles),
  digits = DIGITS,
): SignalDecision => decider.decide({ candles, intervalMs: INTERVAL_MS, nowMs, digits });
const deciderV1 = createSignalDeciderV1();
const decideV1 = (candles: readonly Candle[]) =>
  deciderV1.decide({ candles, intervalMs: INTERVAL_MS, nowMs: closedNow(candles) });
const outcome = (decision: { kind: string; reason?: string; action?: string }) =>
  decision.kind === 'signal' ? `signal ${decision.action}` : decision.reason;

const range = (n: number, f: (i: number) => number): number[] =>
  Array.from({ length: n }, (_, i) => f(i));

// 57 rising closes, then three drops of 2: the trend still points up, RSI sits in the band
const rsiNeutralSeries = (): Candle[] =>
  seriesFrom([...range(57, (i) => 100 + 0.5 * i), 126, 124, 122]);
// 53 rising closes, then seven drops of 2: fast EMA still above slow, the slow slope negative
const trendFlatSeries = (): Candle[] =>
  seriesFrom([...range(53, (i) => 100 + i), ...range(7, (i) => 150 - 2 * i)]);
// 59 rising closes, then one drop of 10: trend up, momentum down
const disagreeSeries = (): Candle[] => seriesFrom([...range(59, (i) => 100 + 0.5 * i), 119]);

function deepFreeze(candles: Candle[]): readonly Candle[] {
  candles.forEach((candle) => Object.freeze(candle));
  return Object.freeze(candles);
}

describe('createSignalDecider', () => {
  it('D1 a rising series is a signal up with trend and momentum up', () => {
    const decision = decide(mildRise());
    expect(decision.kind).toBe('signal');
    expect(decision.kind === 'signal' && decision.action).toBe('up');
    expect('features' in decision && decision.features.trend).toBe('up');
    expect('features' in decision && decision.features.momentum).toBe('up');
  });

  it('D2 a falling series is a signal down', () => {
    const decision = decide(mildFall());
    expect(decision.kind === 'signal' && decision.action).toBe('down');
  });

  it('D3 a flat series without wicks is volatility_too_low, not rsi_neutral', () => {
    const decision = decide(seriesFrom(Array<number>(60).fill(100), { wick: 0 }));
    expect(decision.kind === 'no_signal' && decision.reason).toBe('volatility_too_low');
  });

  it('D4 ATR% above maxAtrPct is volatility_too_high', () => {
    const series = trending(60, 0.5);
    const decision = createSignalDecider({ ...DEFAULT_SIGNAL_PARAMS, maxAtrPct: 0.5 }).decide({
      candles: series,
      intervalMs: INTERVAL_MS,
      nowMs: closedNow(series),
      digits: DIGITS,
    });
    expect(decision.kind === 'no_signal' && decision.reason).toBe('volatility_too_high');
  });

  it('D5 a trend without direction is trend_flat', () => {
    const decision = decide(trendFlatSeries());
    expect(decision.kind === 'no_signal' && decision.reason).toBe('trend_flat');
    if (!('features' in decision)) throw new Error('expected features');
    expect(decision.features.trend).toBe('flat');
    expect(decision.features.momentum).toBe('down');
    expect(decision.features.emaFast > decision.features.emaSlow).toBe(true);
    expect(decision.features.emaSlowSlope < 0).toBe(true);
  });

  it('D6 a directed trend with RSI inside the band is rsi_neutral', () => {
    const decision = decide(rsiNeutralSeries());
    expect(decision.kind === 'no_signal' && decision.reason).toBe('rsi_neutral');
    if (!('features' in decision)) throw new Error('expected features');
    expect(decision.features.trend).toBe('up');
    expect(decision.features.momentum).toBe('neutral');
  });

  it('D7 trend up with momentum down is trend_momentum_disagree', () => {
    const decision = decide(disagreeSeries());
    expect(decision.kind === 'no_signal' && decision.reason).toBe('trend_momentum_disagree');
    if (!('features' in decision)) throw new Error('expected features');
    expect(decision.features.trend).toBe('up');
    expect(decision.features.momentum).toBe('down');
    expect(decision.features.rsi <= 45).toBe(true);
  });

  it('D8 a data refusal passes through whole with the version set', () => {
    expect(decide(trending(49, 0.5))).toStrictEqual({
      kind: 'no_signal',
      version: 'v2',
      reason: 'insufficient_candles',
      detail: { closedCandles: 49, required: 50 },
    });
  });

  it('D9 volume present or absent gives the same decision', () => {
    const plain = trending(60, 0.5);
    const withVolume = plain.map((candle, i) => ({ ...candle, volume: 1_000 + 37 * (i % 5) }));
    expect(decide(withVolume)).toStrictEqual(decide(plain));
  });

  it('D10 a decision survives a JSON round trip unchanged and holds only finite numbers', () => {
    const series = [
      trending(60, 0.5),
      trendFlatSeries(),
      rsiNeutralSeries(),
      disagreeSeries(),
      ...Array.from({ length: 40 }, (_, k) => sine(60, 3, 37, k)),
    ];
    for (const candles of series) {
      const decision = decide(candles);
      expect(JSON.parse(JSON.stringify(decision))).toStrictEqual(decision);
      if ('features' in decision) {
        for (const value of Object.values(decision.features)) {
          if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true);
        }
      }
    }
  });

  it('D11 a deep-frozen input with a forming candle decides the same twice', () => {
    const candles = deepFreeze(trending(61, 0.5));
    const nowMs = candles[60].timestamp + 1;
    const first = decider.decide({ candles, intervalMs: INTERVAL_MS, nowMs, digits: DIGITS });
    const second = decider.decide({ candles, intervalMs: INTERVAL_MS, nowMs, digits: DIGITS });
    expect(second).toStrictEqual(first);
  });

  it('D12 decider.params is frozen and equal to the params given', () => {
    const params = { ...DEFAULT_SIGNAL_PARAMS, rsiBand: 7 };
    const custom = createSignalDecider(params);
    expect(Object.isFrozen(custom.params)).toBe(true);
    expect(custom.params).toEqual(params);
  });

  it('D13 decider.version is SIGNAL_ALGORITHM_VERSION', () => {
    expect(decider.version).toBe(SIGNAL_ALGORITHM_VERSION);
  });

  it('D14 wrong params throw at createSignalDecider, before any decide', () => {
    expect(() =>
      createSignalDecider({ ...DEFAULT_SIGNAL_PARAMS, emaFast: 21, emaSlow: 9 }),
    ).toThrow(/emaFast/);
  });

  // the decider's output against the wire schema the backend sends it under (#258): S1 in
  // shared's signal.test.ts checks hand-written fixtures, which move with the schema
  it.each([
    ['signal', () => decide(mildRise())],
    ['volatility_too_low', () => decide(seriesFrom(Array<number>(60).fill(100), { wick: 0 }))],
    [
      'candle_gap',
      () => {
        const series = trending(60, 0.5);
        series.splice(30, 1);
        return decide(series);
      },
    ],
    [
      'stale',
      () => {
        const series = trending(60, 0.5);
        return decide(series, closedNow(series) + 10 * INTERVAL_MS);
      },
    ],
    ['insufficient_candles', () => decide(trending(10, 0.5))],
    ['volatility_below_tick_floor', () => decide(tickSeries(0.0124, 5), undefined, 5)],
    ['rsi_overbought', () => decide(burst())],
    ['rsi_oversold', () => decide(fall())],
    [
      'invalid_candle',
      () => {
        const series = trending(60, 0.5);
        series[20] = { ...series[20], close: Number.NaN };
        return decide(series);
      },
    ],
  ])('D15 a %s decision parses back through signalDecisionSchema unchanged', (shape, make) => {
    const decision = make();
    expect(decision.kind === 'signal' ? 'signal' : decision.reason).toBe(shape);
    const parsed = signalDecisionSchema.safeParse(JSON.parse(JSON.stringify(decision)));
    expect(parsed.error).toBeUndefined();
    expect(parsed.data).toStrictEqual(decision);
  });

  it('D16 a burst up (d9c92776) is rsi_overbought where v1 signalled up', () => {
    const decision = decide(burst());
    expect(decision.kind === 'no_signal' && decision.reason).toBe('rsi_overbought');
    if (!('features' in decision)) throw new Error('expected features');
    expect(decision.features.trend).toBe('up');
    expect(decision.features.momentum).toBe('up');
    expect(decision.features.rsi).toBeGreaterThanOrEqual(65);
    expect(decision.features.rsi).toBeLessThan(80);
  });

  it('D17 a sharp fall is rsi_oversold', () => {
    const decision = decide(fall());
    expect(decision.kind === 'no_signal' && decision.reason).toBe('rsi_oversold');
    if (!('features' in decision)) throw new Error('expected features');
    expect(decision.features.trend).toBe('down');
    expect(decision.features.rsi).toBeLessThanOrEqual(35);
  });

  it('D18 a rise with RSI between 55 and 65 still signals up', () => {
    const decision = decide(mildRise());
    expect(outcome(decision)).toBe('signal up');
    if (!('features' in decision)) throw new Error('expected features');
    expect(decision.features.rsi).toBeGreaterThanOrEqual(55);
    expect(decision.features.rsi).toBeLessThan(65);
  });

  // 2e25e081: a 5-digit pair near 0.0124 whose every move is one quote step; the last variant
  // moves two steps with one-step wicks, so its ATR of ~4 steps passes a floor of 3, not of 5
  it.each([
    ['without wicks', {}, 0.79],
    ['with one-step wicks', { wickTicks: 1 }, 2.79],
    ['two-step moves with one-step wicks', { wickTicks: 1, pattern: [2] }, 4],
  ])('D19 one-step moves %s are volatility_below_tick_floor', (_, options, ticks) => {
    const decision = decide(tickSeries(0.0124, 5, options), undefined, 5);
    expect(decision.kind === 'no_signal' && decision.reason).toBe('volatility_below_tick_floor');
    if (!('features' in decision)) throw new Error('expected features');
    expect(decision.features.atrTicks).toBeCloseTo(ticks, 2);
    expect(decision.features.atrTicks).toBeLessThan(5);
    // v1's corridor lets the same series through
    expect(decision.features.atrPct).toBeGreaterThan(DEFAULT_SIGNAL_PARAMS.minAtrPct);
  });

  it('D20 the same closes on a 7-digit pair are 79 steps and pass the floor', () => {
    const decision = decide(tickSeries(0.0124, 5), undefined, 7);
    expect(decision.kind === 'no_signal' && decision.reason).not.toBe(
      'volatility_below_tick_floor',
    );
    if (!('features' in decision)) throw new Error('expected features');
    expect(decision.features.atrTicks).toBeCloseTo(78.8, 1);
  });

  it('D21 an ATR of exactly minAtrTicks steps is not refused by the floor', () => {
    const decision = decide(integerSeries(60, 1000, 5), undefined, 0);
    if (!('features' in decision)) throw new Error('expected features');
    expect(decision.features.atrTicks).toBe(5);
    expect(outcome(decision)).toBe('rsi_neutral');
  });

  it('D22 the v1 decider keeps its rules: the burst signals up, the one-step drift too', () => {
    expect(outcome(decideV1(burst()))).toBe('signal up');
    expect(outcome(decideV1(fall()))).toBe('signal down');
    expect(outcome(decideV1(tickSeries(0.0124, 5)))).toBe('signal up');
    expect(deciderV1.version).toBe('v1');
  });

  it('D23 v2 features carry atrTicks, v1 features do not; each parses through its own schema', () => {
    const v2 = decide(burst());
    const v1 = decideV1(burst());
    expect('features' in v2 && 'atrTicks' in v2.features).toBe(true);
    expect('features' in v1 && 'atrTicks' in v1.features).toBe(false);
    expect(signalDecisionSchema.safeParse(v2).success).toBe(true);
    expect(signalDecisionV1Schema.safeParse(v1).success).toBe(true);
    expect(signalDecisionSchema.safeParse(v1).success).toBe(false);
    expect(signalDecisionV1Schema.safeParse(v2).success).toBe(false);
  });

  it.each([-1, 2.5, Number.NaN])('D24 digits %s throw before any decision', (digits) => {
    expect(() => decide(trending(60, 0.5), undefined, digits)).toThrow(RangeError);
  });

  // #379 review m3: 10 ** 309 is Infinity, which would pass the tick floor and not replay
  it('D25 digits above MAX_PAIR_DIGITS throw; at the bound atrTicks stays finite', () => {
    expect(MAX_PAIR_DIGITS).toBe(10);
    expect(() => decide(trending(60, 0.5), undefined, 11)).toThrow(RangeError);
    expect(() => decide(trending(60, 0.5), undefined, 309)).toThrow(RangeError);
    const decision = decide(trending(60, 0.5), undefined, 10);
    if (!('features' in decision)) throw new Error('expected features');
    expect(Number.isFinite(decision.features.atrTicks)).toBe(true);
  });
});
