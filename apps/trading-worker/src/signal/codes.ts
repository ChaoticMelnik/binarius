// The codes live apart from candles.ts and decide.ts because both produce reasons and
// decide.ts imports candles.ts.

export const SignalKind = { Signal: 'signal', NoSignal: 'no_signal' } as const;
export type SignalKind = (typeof SignalKind)[keyof typeof SignalKind];

export const NoSignalReason = {
  InvalidCandle: 'invalid_candle',
  CandleGap: 'candle_gap',
  Stale: 'stale',
  InsufficientCandles: 'insufficient_candles',
  VolatilityTooLow: 'volatility_too_low',
  VolatilityTooHigh: 'volatility_too_high',
  TrendFlat: 'trend_flat',
  RsiNeutral: 'rsi_neutral',
  TrendMomentumDisagree: 'trend_momentum_disagree',
} as const;
export type NoSignalReason = (typeof NoSignalReason)[keyof typeof NoSignalReason];

export type DataRefusalReason =
  | typeof NoSignalReason.InvalidCandle
  | typeof NoSignalReason.CandleGap
  | typeof NoSignalReason.Stale
  | typeof NoSignalReason.InsufficientCandles;
export type RuleRefusalReason = Exclude<NoSignalReason, DataRefusalReason>;

export const CandleProblem = {
  NonFinite: 'non_finite',
  NonPositive: 'non_positive',
  OhlcOrder: 'ohlc_order',
  NotAscending: 'not_ascending',
  StepMismatch: 'step_mismatch',
  InFuture: 'in_future',
} as const;
export type CandleProblem = (typeof CandleProblem)[keyof typeof CandleProblem];

export const TrendDirection = { Up: 'up', Down: 'down', Flat: 'flat' } as const;
export type TrendDirection = (typeof TrendDirection)[keyof typeof TrendDirection];

export const MomentumDirection = { Up: 'up', Down: 'down', Neutral: 'neutral' } as const;
export type MomentumDirection = (typeof MomentumDirection)[keyof typeof MomentumDirection];
