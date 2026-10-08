import * as z from 'zod';
import { BrokerRestErrorCode } from './broker';
import { createTradeIntentRequestSchema, tradeActionSchema } from './trading';

// The wire shape of a Signal module v1 decision (docs/signal.md). The decider itself lives in
// packages/signal; the codes and shapes live here because the backend's POST /trading/signal
// carries a decision to the bot, which does not depend on that package.

export const SIGNAL_ALGORITHM_VERSION = 'v1';

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

// A data refusal carries a detail and no features; a rule refusal carries features.
export const DATA_REFUSAL_REASONS = [
  NoSignalReason.InvalidCandle,
  NoSignalReason.CandleGap,
  NoSignalReason.Stale,
  NoSignalReason.InsufficientCandles,
] as const;
export type DataRefusalReason = (typeof DATA_REFUSAL_REASONS)[number];

export const RULE_REFUSAL_REASONS = [
  NoSignalReason.VolatilityTooLow,
  NoSignalReason.VolatilityTooHigh,
  NoSignalReason.TrendFlat,
  NoSignalReason.RsiNeutral,
  NoSignalReason.TrendMomentumDisagree,
] as const;
export type RuleRefusalReason = (typeof RULE_REFUSAL_REASONS)[number];

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

// --- Parameters -------------------------------------------------------------------------------

// The shape only; the rules between fields and the defaults are packages/signal's config.ts.
export const signalParamsSchema = z.strictObject({
  emaFast: z.int().positive(),
  emaSlow: z.int().positive(),
  // slope = slowEma[last] - slowEma[last - slopeLookback]
  slopeLookback: z.int().positive(),
  rsiPeriod: z.int().positive(),
  // up at RSI >= 50 + band, down at RSI <= 50 - band
  rsiBand: z.number().nonnegative(),
  atrPeriod: z.int().positive(),
  // ATR as a percentage of the last close
  minAtrPct: z.number().nonnegative(),
  maxAtrPct: z.number().nonnegative(),
  minClosedCandles: z.int().positive(),
  // the last closed candle may have closed at most this many intervals before nowMs
  maxStaleIntervals: z.int().positive(),
});
export type SignalParams = z.infer<typeof signalParamsSchema>;

// --- Intervals --------------------------------------------------------------------------------

// every entry was accepted by the live broker (owner's probe 2026-10-03: every interval from 1s
// to 1d, docs/signal.md); 5s and 15s analyse the demo's 5 and 15 s trades (#313)
export const SIGNAL_CHART_INTERVAL_MS = {
  '5s': 5_000,
  '15s': 15_000,
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
} as const;

export type SignalInterval = keyof typeof SIGNAL_CHART_INTERVAL_MS;

export const SIGNAL_INTERVALS = Object.keys(SIGNAL_CHART_INTERVAL_MS) as [
  SignalInterval,
  ...SignalInterval[],
];

export const signalIntervalSchema = z.enum(SIGNAL_INTERVALS);

const SHORTEST_INTERVAL = SIGNAL_INTERVALS.reduce((shortest, interval) =>
  SIGNAL_CHART_INTERVAL_MS[interval] < SIGNAL_CHART_INTERVAL_MS[shortest] ? interval : shortest,
);
export const SIGNAL_SHORTEST_INTERVAL_MS: number = SIGNAL_CHART_INTERVAL_MS[SHORTEST_INTERVAL];

const INTERVALS_LONGEST_FIRST = SIGNAL_INTERVALS.map(
  (interval) => [interval, SIGNAL_CHART_INTERVAL_MS[interval]] as const,
).sort(([, a], [, b]) => b - a);

// The longest candle that fits in the trade's duration; below the shortest candle, the shortest
// (#126). A 5 or 15 s trade is analysed on its own sub-minute candle, never on 1m (#313).
export function intervalForDuration(durationSec: number): SignalInterval {
  if (!Number.isInteger(durationSec) || durationSec <= 0) {
    throw new RangeError(
      `signal interval: durationSec must be a positive integer, got ${durationSec}`,
    );
  }
  const fitting = INTERVALS_LONGEST_FIRST.find(([, ms]) => ms <= durationSec * 1000);
  return fitting === undefined ? SHORTEST_INTERVAL : fitting[0];
}

// --- The decision -----------------------------------------------------------------------------

// z.number() refuses NaN and ±Infinity, which JSON would turn into null anyway.
export const signalFeaturesSchema = z.strictObject({
  emaFast: z.number(),
  emaSlow: z.number(),
  emaSlowSlope: z.number(),
  rsi: z.number(),
  atr: z.number(),
  atrPct: z.number(),
  lastClose: z.number(),
  lastCandleTimestamp: z.number(),
  closedCandles: z.int().nonnegative(),
  trend: z.enum(TrendDirection),
  momentum: z.enum(MomentumDirection),
});
export type SignalFeatures = z.infer<typeof signalFeaturesSchema>;

export const signalDataRefusalSchema = z.discriminatedUnion('reason', [
  z.strictObject({
    reason: z.literal(NoSignalReason.InvalidCandle),
    detail: z.strictObject({ index: z.int().nonnegative(), problem: z.enum(CandleProblem) }),
  }),
  z.strictObject({
    reason: z.literal(NoSignalReason.CandleGap),
    detail: z.strictObject({
      index: z.int().nonnegative(),
      expectedTimestamp: z.number(),
      actualTimestamp: z.number(),
    }),
  }),
  z.strictObject({
    reason: z.literal(NoSignalReason.Stale),
    detail: z.strictObject({
      lastCandleTimestamp: z.number(),
      ageMs: z.number(),
      maxAgeMs: z.number(),
    }),
  }),
  z.strictObject({
    reason: z.literal(NoSignalReason.InsufficientCandles),
    detail: z.strictObject({
      closedCandles: z.int().nonnegative(),
      required: z.int().nonnegative(),
    }),
  }),
]);
export type SignalDataRefusal = z.infer<typeof signalDataRefusalSchema>;

const version = z.literal(SIGNAL_ALGORITHM_VERSION);
const noSignalHead = { kind: z.literal(SignalKind.NoSignal), version };

// Nested by kind, then by reason: zod refuses one flat union with five `no_signal` options
// ("Duplicate discriminator value").
export const signalDecisionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal(SignalKind.Signal),
    version,
    action: tradeActionSchema,
    features: signalFeaturesSchema,
  }),
  z.discriminatedUnion('reason', [
    z.strictObject({
      ...noSignalHead,
      reason: z.enum(RULE_REFUSAL_REASONS),
      features: signalFeaturesSchema,
    }),
    ...signalDataRefusalSchema.options.map((option) => option.extend(noSignalHead)),
  ]),
]);
export type SignalDecision = z.infer<typeof signalDecisionSchema>;

// --- POST /trading/signal (#258) --------------------------------------------------------------

export const TRADING_SIGNAL_PATH = '/trading/signal';

// Upper estimate of the whole answer: one bounded chart GET (the backend's own budget sits below
// it) and the decision. The bot sizes its request timeout above it (#126).
export const TRADING_SIGNAL_BUDGET_MS = 4_000;

export const SignalFeedOutcome = { Decided: 'decided', FetchFailed: 'fetch_failed' } as const;
export type SignalFeedOutcome = (typeof SignalFeedOutcome)[keyof typeof SignalFeedOutcome];

export const tradingSignalRequestSchema = z.object({
  assetId: createTradeIntentRequestSchema.shape.assetId,
  interval: signalIntervalSchema,
});
export type TradingSignalRequest = z.infer<typeof tradingSignalRequestSchema>;

// A broker failure is an answer, not an HTTP error: the bot's client keeps only `error` from a
// non-2xx body, and retryAfterSec has to reach the user.
export const tradingSignalResponseSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    outcome: z.literal(SignalFeedOutcome.Decided),
    params: signalParamsSchema,
    decision: signalDecisionSchema,
  }),
  z.strictObject({
    outcome: z.literal(SignalFeedOutcome.FetchFailed),
    code: z.enum(BrokerRestErrorCode),
    retryAfterSec: z.int().nonnegative().optional(),
  }),
]);
export type TradingSignalResponse = z.infer<typeof tradingSignalResponseSchema>;

export const safeParseTradingSignalRequest = (input: unknown) =>
  tradingSignalRequestSchema.safeParse(input);
export const safeParseTradingSignalResponse = (input: unknown) =>
  tradingSignalResponseSchema.safeParse(input);

// --- GET /trading/signals (#343) --------------------------------------------------------------

export const TRADING_SIGNALS_PATH = '/trading/signals';

// The one interval the backend's scanner decides (docs/signal.md -> The scanner): 5s trades keep
// the on-demand analysis, the broker's budget does not fit both.
export const SIGNAL_SCAN_INTERVAL = '15s' satisfies SignalInterval;

// Only the pairs with a signal on the candle that closed most recently; times are unix ms.
export const tradingSignalsResponseSchema = z.strictObject({
  asOf: z.int().nonnegative(),
  interval: z.literal(SIGNAL_SCAN_INTERVAL),
  scanned: z.int().nonnegative(),
  signals: z.array(
    z.strictObject({
      assetId: createTradeIntentRequestSchema.shape.assetId,
      action: tradeActionSchema,
      lastCandleTimestamp: z.number(),
      decidedAt: z.int().nonnegative(),
      ageMs: z.int().nonnegative(),
    }),
  ),
});
export type TradingSignalsResponse = z.infer<typeof tradingSignalsResponseSchema>;

export const safeParseTradingSignalsResponse = (input: unknown) =>
  tradingSignalsResponseSchema.safeParse(input);
