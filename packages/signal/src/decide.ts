import {
  MAX_PAIR_DIGITS,
  MomentumDirection,
  NoSignalReason,
  SIGNAL_ALGORITHM_VERSION,
  SignalKind,
  TradeAction,
  TrendDirection,
  type Candle,
  type RuleRefusalReason,
  type RuleRefusalReasonV1,
  type SignalDecision,
  type SignalDecisionV1,
  type SignalFeatures,
  type SignalFeaturesV1,
  type SignalParams,
  type SignalParamsV1,
} from '@binarius/shared';
import { prepareCandles } from './candles';
import {
  assertSignalParams,
  assertSignalParamsV1,
  DEFAULT_SIGNAL_PARAMS,
  DEFAULT_SIGNAL_PARAMS_V1,
} from './config';
import { atr, ema, rsi } from './indicators';

export interface SignalInputV1 {
  candles: readonly Candle[];
  intervalMs: number;
  nowMs: number;
}

export interface SignalInput extends SignalInputV1 {
  // the pair's quote precision from the catalog: one quote step is 10^-digits
  digits: number;
}

export interface SignalDecider {
  version: typeof SIGNAL_ALGORITHM_VERSION;
  params: Readonly<SignalParams>;
  decide(input: SignalInput): SignalDecision;
}

// Replays v1's journal lines only (journal.ts); every runtime caller decides with v2.
export interface SignalDeciderV1 {
  version: 'v1';
  params: Readonly<SignalParamsV1>;
  decide(input: SignalInputV1): SignalDecisionV1;
}

export function assertDigits(digits: number): void {
  if (!Number.isInteger(digits) || digits < 0 || digits > MAX_PAIR_DIGITS) {
    throw new RangeError(
      `signal input: digits must be an integer from 0 to ${MAX_PAIR_DIGITS}, got ${digits}`,
    );
  }
}

function features(closed: readonly Candle[], params: SignalParamsV1): SignalFeaturesV1 {
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

function ruleRefusalV1(
  f: SignalFeaturesV1,
  params: SignalParamsV1,
): RuleRefusalReasonV1 | undefined {
  if (f.atrPct < params.minAtrPct) return NoSignalReason.VolatilityTooLow;
  if (f.atrPct > params.maxAtrPct) return NoSignalReason.VolatilityTooHigh;
  if (f.trend === TrendDirection.Flat) return NoSignalReason.TrendFlat;
  if (f.momentum === MomentumDirection.Neutral) return NoSignalReason.RsiNeutral;
  if (f.trend !== f.momentum) return NoSignalReason.TrendMomentumDisagree;
  return undefined;
}

// The tick floor is a volatility gate and sits with them; the RSI extremes come last, so they are
// named only when trend and momentum already agreed.
function ruleRefusalV2(f: SignalFeatures, params: SignalParams): RuleRefusalReason | undefined {
  if (f.atrPct < params.minAtrPct) return NoSignalReason.VolatilityTooLow;
  if (f.atrPct > params.maxAtrPct) return NoSignalReason.VolatilityTooHigh;
  if (f.atrTicks < params.minAtrTicks) return NoSignalReason.VolatilityBelowTickFloor;
  if (f.trend === TrendDirection.Flat) return NoSignalReason.TrendFlat;
  if (f.momentum === MomentumDirection.Neutral) return NoSignalReason.RsiNeutral;
  if (f.trend !== f.momentum) return NoSignalReason.TrendMomentumDisagree;
  if (f.trend === TrendDirection.Up && f.rsi >= 50 + params.rsiExtremeBand) {
    return NoSignalReason.RsiOverbought;
  }
  if (f.trend === TrendDirection.Down && f.rsi <= 50 - params.rsiExtremeBand) {
    return NoSignalReason.RsiOversold;
  }
  return undefined;
}

const actionOf = (f: SignalFeaturesV1): TradeAction =>
  f.trend === TrendDirection.Up ? TradeAction.Up : TradeAction.Down;

export function createSignalDecider(params: SignalParams = DEFAULT_SIGNAL_PARAMS): SignalDecider {
  assertSignalParams(params);
  const frozen: Readonly<SignalParams> = Object.freeze({ ...params });
  const version = SIGNAL_ALGORITHM_VERSION;

  return {
    version,
    params: frozen,
    decide({ candles, intervalMs, nowMs, digits }) {
      assertDigits(digits);
      const prepared = prepareCandles(candles, intervalMs, nowMs, frozen);
      if (!prepared.ok) return { kind: SignalKind.NoSignal, version, ...prepared.refusal };
      const base = features(prepared.closed, frozen);
      const f: SignalFeatures = { ...base, atrTicks: base.atr * 10 ** digits };
      const reason = ruleRefusalV2(f, frozen);
      if (reason !== undefined) {
        return { kind: SignalKind.NoSignal, version, reason, features: f };
      }
      return { kind: SignalKind.Signal, version, action: actionOf(f), features: f };
    },
  };
}

export function createSignalDeciderV1(
  params: SignalParamsV1 = DEFAULT_SIGNAL_PARAMS_V1,
): SignalDeciderV1 {
  assertSignalParamsV1(params);
  const frozen: Readonly<SignalParamsV1> = Object.freeze({ ...params });
  const version = 'v1';

  return {
    version,
    params: frozen,
    decide({ candles, intervalMs, nowMs }) {
      const prepared = prepareCandles(candles, intervalMs, nowMs, frozen);
      if (!prepared.ok) return { kind: SignalKind.NoSignal, version, ...prepared.refusal };
      const f = features(prepared.closed, frozen);
      const reason = ruleRefusalV1(f, frozen);
      if (reason !== undefined) {
        return { kind: SignalKind.NoSignal, version, reason, features: f };
      }
      return { kind: SignalKind.Signal, version, action: actionOf(f), features: f };
    },
  };
}
