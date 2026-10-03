import type { Candle } from '@binarius/shared';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SIGNAL_PARAMS, SIGNAL_ALGORITHM_VERSION } from './config';
import { createSignalDecider, type SignalDecision } from './decide';
import { closedNow, INTERVAL_MS, seriesFrom, sine, trending } from './testing';

const decider = createSignalDecider();
const decide = (candles: readonly Candle[], nowMs = closedNow(candles)): SignalDecision =>
  decider.decide({ candles, intervalMs: INTERVAL_MS, nowMs });

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
    const decision = decide(trending(60, 0.5));
    expect(decision.kind).toBe('signal');
    expect(decision.kind === 'signal' && decision.action).toBe('up');
    expect('features' in decision && decision.features.trend).toBe('up');
    expect('features' in decision && decision.features.momentum).toBe('up');
  });

  it('D2 a falling series is a signal down', () => {
    const decision = decide(trending(60, -0.5, 130));
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
      version: 'v1',
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
    const first = decider.decide({ candles, intervalMs: INTERVAL_MS, nowMs });
    const second = decider.decide({ candles, intervalMs: INTERVAL_MS, nowMs });
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
});
