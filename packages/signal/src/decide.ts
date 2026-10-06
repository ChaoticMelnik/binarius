import {
  MomentumDirection,
  NoSignalReason,
  SIGNAL_ALGORITHM_VERSION,
  SignalKind,
  TradeAction,
  TrendDirection,
  type Candle,
  type RuleRefusalReason,
  type SignalDecision,
  type SignalFeatures,
  type SignalParams,
} from '@binarius/shared';
import { prepareCandles } from './candles';
import { assertSignalParams, DEFAULT_SIGNAL_PARAMS } from './config';
import { atr, ema, rsi } from './indicators';

export interface SignalInput {
  candles: readonly Candle[];
  intervalMs: number;
  nowMs: number;
}

type Version = typeof SIGNAL_ALGORITHM_VERSION;

export interface SignalDecider {
  version: Version;
  params: Readonly<SignalParams>;
  decide(input: SignalInput): SignalDecision;
}

function features(closed: readonly Candle[], params: SignalParams): SignalFeatures {
  const closes = closed.map((candle) => candle.close);
  const fastSeries = ema(closes, params.emaFast);
  const slowSeries = ema(closes, params.emaSlow);
  const emaFast = fastSeries[fastSeries.length - 1];
  const emaSlow = slowSeries[slowSeries.length - 1];
  const emaSlowSlope = emaSlow - slowSeries[slowSeries.length - 1 - params.slopeLookback];
  const rsiSeries = rsi(closes, params.rsiPeriod);
  const rsiValue = rsiSeries[rsiSeries.length - 1];
  const atrSeries = atr(closed, params.atrPeriod);
  const atrValue = atrSeries[atrSeries.length - 1];
  const last = closed[closed.length - 1];

  let trend: TrendDirection = TrendDirection.Flat;
  if (emaFast > emaSlow && emaSlowSlope > 0) trend = TrendDirection.Up;
  else if (emaFast < emaSlow && emaSlowSlope < 0) trend = TrendDirection.Down;

  let momentum: MomentumDirection = MomentumDirection.Neutral;
  if (rsiValue >= 50 + params.rsiBand) momentum = MomentumDirection.Up;
  else if (rsiValue <= 50 - params.rsiBand) momentum = MomentumDirection.Down;

  return {
    emaFast,
    emaSlow,
    emaSlowSlope,
    rsi: rsiValue,
    atr: atrValue,
    atrPct: (atrValue / last.close) * 100,
    lastClose: last.close,
    lastCandleTimestamp: last.timestamp,
    closedCandles: closed.length,
    trend,
    momentum,
  };
}

function ruleRefusal(f: SignalFeatures, params: SignalParams): RuleRefusalReason | undefined {
  if (f.atrPct < params.minAtrPct) return NoSignalReason.VolatilityTooLow;
  if (f.atrPct > params.maxAtrPct) return NoSignalReason.VolatilityTooHigh;
  if (f.trend === TrendDirection.Flat) return NoSignalReason.TrendFlat;
  if (f.momentum === MomentumDirection.Neutral) return NoSignalReason.RsiNeutral;
  if (f.trend !== f.momentum) return NoSignalReason.TrendMomentumDisagree;
  return undefined;
}

export function createSignalDecider(params: SignalParams = DEFAULT_SIGNAL_PARAMS): SignalDecider {
  assertSignalParams(params);
  const frozen: Readonly<SignalParams> = Object.freeze({ ...params });
  const version = SIGNAL_ALGORITHM_VERSION;

  return {
    version,
    params: frozen,
    decide({ candles, intervalMs, nowMs }) {
      const prepared = prepareCandles(candles, intervalMs, nowMs, frozen);
      if (!prepared.ok) return { kind: SignalKind.NoSignal, version, ...prepared.refusal };
      const f = features(prepared.closed, frozen);
      const reason = ruleRefusal(f, frozen);
      if (reason !== undefined) {
        return { kind: SignalKind.NoSignal, version, reason, features: f };
      }
      const action = f.trend === TrendDirection.Up ? TradeAction.Up : TradeAction.Down;
      return { kind: SignalKind.Signal, version, action, features: f };
    },
  };
}
