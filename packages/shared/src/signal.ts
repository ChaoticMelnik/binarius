import * as z from 'zod';
import { BrokerRestErrorCode, MAX_PAIR_DIGITS } from './broker';
import { PairsCatalogErrorCode } from './catalog';
import { createTradeIntentRequestSchema, telegramUserIdSchema, tradeActionSchema } from './trading';

// The wire shape of a Signal module decision (docs/signal.md). The decider itself lives in
// packages/signal; the codes and shapes live here because the backend's POST /trading/signal
// carries a decision to the bot, which does not depend on that package. The wire is the current
// version; the older version's shapes stay so that its journal lines still replay (#379).

export const SIGNAL_ALGORITHM_VERSIONS = ['v1', 'v2'] as const;
export type SignalAlgorithmVersion = (typeof SIGNAL_ALGORITHM_VERSIONS)[number];
export const SIGNAL_ALGORITHM_VERSION = 'v2' satisfies SignalAlgorithmVersion;

export const SignalKind = { Signal: 'signal', NoSignal: 'no_signal' } as const;
export type SignalKind = (typeof SignalKind)[keyof typeof SignalKind];

export const NoSignalReason = {
  InvalidCandle: 'invalid_candle',
  CandleGap: 'candle_gap',
  Stale: 'stale',
  InsufficientCandles: 'insufficient_candles',
  VolatilityTooLow: 'volatility_too_low',
  VolatilityTooHigh: 'volatility_too_high',
  VolatilityBelowTickFloor: 'volatility_below_tick_floor',
  TrendFlat: 'trend_flat',
  RsiNeutral: 'rsi_neutral',
  TrendMomentumDisagree: 'trend_momentum_disagree',
  RsiOverbought: 'rsi_overbought',
  RsiOversold: 'rsi_oversold',
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

export const RULE_REFUSAL_REASONS_V1 = [
  NoSignalReason.VolatilityTooLow,
  NoSignalReason.VolatilityTooHigh,
  NoSignalReason.TrendFlat,
  NoSignalReason.RsiNeutral,
  NoSignalReason.TrendMomentumDisagree,
] as const;
export type RuleRefusalReasonV1 = (typeof RULE_REFUSAL_REASONS_V1)[number];

export const RULE_REFUSAL_REASONS = [
  ...RULE_REFUSAL_REASONS_V1,
  NoSignalReason.VolatilityBelowTickFloor,
  NoSignalReason.RsiOverbought,
  NoSignalReason.RsiOversold,
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
export const signalParamsV1Schema = z.strictObject({
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
export type SignalParamsV1 = z.infer<typeof signalParamsV1Schema>;

export const signalParamsSchema = signalParamsV1Schema.extend({
  // no up at RSI >= 50 + rsiExtremeBand, no down at RSI <= 50 - rsiExtremeBand
  rsiExtremeBand: z.number().nonnegative(),
  // ATR in the pair's quote steps (10^-digits)
  minAtrTicks: z.int().positive(),
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

// How long after a candle boundary a closed candle is read, in every reader: the scanner's scan
// (apps/backend), a session's next ask after no_signal (apps/trading-worker, #697),
// the earliest backfill GET and the stand's decision moment. Below the ring's clock rule
// (MARKET_DATA_SKEW_MARGIN_MS, 2 s): on a stalled stream the read comes first and the decision
// is on the candle before (`unclosed`, docs/signal.md -> The scanner). The live broker returned
// the just-closed 15s candle 150 ms after the boundary (2026-10-08). Pilot 2026-10-22: the
// watermark lag p50 212 / p95 364 / max 602 ms, 1.07 % of the scans unclosed at +500.
export const CANDLE_CLOSE_SLACK_MS = 500;

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
export const signalFeaturesV1Schema = z.strictObject({
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
export type SignalFeaturesV1 = z.infer<typeof signalFeaturesV1Schema>;

export const signalFeaturesSchema = signalFeaturesV1Schema.extend({
  // atr x 10^digits of the pair
  atrTicks: z.number(),
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

// Nested by kind, then by reason: zod refuses one flat union with five `no_signal` options
// ("Duplicate discriminator value").
function decisionSchema<
  V extends SignalAlgorithmVersion,
  F extends typeof signalFeaturesV1Schema | typeof signalFeaturesSchema,
  R extends readonly [RuleRefusalReason, ...RuleRefusalReason[]],
>(versionName: V, features: F, ruleReasons: R) {
  const version = z.literal(versionName);
  const noSignalHead = { kind: z.literal(SignalKind.NoSignal), version };
  return z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal(SignalKind.Signal),
      version,
      action: tradeActionSchema,
      features,
    }),
    z.discriminatedUnion('reason', [
      z.strictObject({ ...noSignalHead, reason: z.enum(ruleReasons), features }),
      ...signalDataRefusalSchema.options.map((option) => option.extend(noSignalHead)),
    ]),
  ]);
}

export const signalDecisionV1Schema = decisionSchema(
  'v1',
  signalFeaturesV1Schema,
  RULE_REFUSAL_REASONS_V1,
);
export type SignalDecisionV1 = z.infer<typeof signalDecisionV1Schema>;

export const signalDecisionSchema = decisionSchema(
  SIGNAL_ALGORITHM_VERSION,
  signalFeaturesSchema,
  RULE_REFUSAL_REASONS,
);
export type SignalDecision = z.infer<typeof signalDecisionSchema>;

// --- The journal entry (#666) ----------------------------------------------------------------

// The wire and storage shape of packages/signal's journal entry (journal.ts → SignalJournalEntry):
// a session's decision row stores it, the stand's journal parser reads it. z.object, not strict:
// a pino line carries more keys beside it.
export const journalCandleSchema = z
  .tuple([z.number(), z.number(), z.number(), z.number(), z.number()])
  .readonly();

export const journalFetchSchema = z.object({
  startTime: z.number(),
  limit: z.int(),
  rows: z.int(),
  durationMs: z.number(),
});

export const signalJournalSourceSchema = z.discriminatedUnion('kind', [
  journalFetchSchema.extend({ kind: z.literal('rest') }),
  z.object({
    kind: z.literal('socket'),
    startTime: z.number(),
    closedUntil: z.number(),
    gaps: z.int().nonnegative(),
  }),
]);

const journalEntryBase = {
  assetId: z.int(),
  interval: signalIntervalSchema,
  intervalMs: z.int().positive(),
  nowMs: z.number(),
  series: z.array(journalCandleSchema).readonly(),
};
const journalEntryV2 = {
  ...journalEntryBase,
  version: z.literal('v2'),
  digits: z.int().nonnegative(),
  params: signalParamsSchema.readonly(),
  decision: signalDecisionSchema,
};

export const signalJournalEntrySchema = z.object({
  ...journalEntryV2,
  source: signalJournalSourceSchema,
});
export type SignalJournalEntryWire = z.infer<typeof signalJournalEntrySchema>;

// a v2 line written before #405: the REST facts under fetch
export const signalJournalEntryV2FetchSchema = z.object({
  ...journalEntryV2,
  fetch: journalFetchSchema,
});

export const signalJournalEntryV1Schema = z.object({
  ...journalEntryBase,
  version: z.literal('v1'),
  fetch: journalFetchSchema,
  params: signalParamsV1Schema.readonly(),
  decision: signalDecisionV1Schema,
});

export const storedSignalJournalEntrySchema = z.union([
  signalJournalEntrySchema,
  signalJournalEntryV2FetchSchema,
  signalJournalEntryV1Schema,
]);
export type StoredSignalJournalEntryWire = z.infer<typeof storedSignalJournalEntrySchema>;

// The newest data-socket tick of a pair the backend knew when it answered: price and timestamp are
// the broker's, receivedAtMs the backend's clock at its arrival.
export const lastTickSchema = z.strictObject({
  price: z.number().positive(),
  timestamp: z.number(),
  receivedAtMs: z.number(),
});
export type LastTick = z.infer<typeof lastTickSchema>;

// what a session records of a decision (#666, docs/trade-log.md): the journal entry the decision
// was computed from and the last tick; null without the data socket or before the pair's first tick.
// The entry is narrowed to its signal_decisions columns (bigint > 0, the digits CHECK), so a record
// that parses is one the row accepts; the stored-line schemas the stand reads stay as they are.
export const signalRecordSchema = z.strictObject({
  entry: signalJournalEntrySchema.extend({
    nowMs: z.int().positive(),
    digits: z.int().min(0).max(MAX_PAIR_DIGITS),
  }),
  lastTick: lastTickSchema.nullable(),
});
export type SignalRecord = z.infer<typeof signalRecordSchema>;

// --- Display indicators (#482) ---------------------------------------------------------------

// Shown on the analysis card, never read by the decision (#483's backtest found no MACD or MA gate
// better than v2; docs/signal.md → MACD and MA on history). The one source of the periods: the
// feed computes with them and the card prints them.
export const DISPLAY_INDICATOR_PARAMS = {
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  maShort: 50,
  maLong: 200,
} as const;

// two signal-line points: the cross compares the last two closed candles. The feed's MACD needs
// this many and the card's «данных мало» prints it when the field is absent (#482).
export const MACD_REQUIRED_CANDLES =
  DISPLAY_INDICATOR_PARAMS.macdSlow + DISPLAY_INDICATOR_PARAMS.macdSignal;

export const MacdCross = { Up: 'up', Down: 'down', None: 'none' } as const;
export type MacdCross = (typeof MacdCross)[keyof typeof MacdCross];

const indicatorShortSchema = z.strictObject({
  ok: z.literal(false),
  closedCandles: z.int().nonnegative(),
  required: z.int().positive(),
});

const movingAverageIndicatorSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), value: z.number(), lastClose: z.number() }),
  indicatorShortSchema,
]);

export const signalIndicatorsSchema = z.strictObject({
  macd: z.discriminatedUnion('ok', [
    z.strictObject({
      ok: z.literal(true),
      macd: z.number(),
      signal: z.number(),
      histogram: z.number(),
      cross: z.enum(MacdCross),
    }),
    indicatorShortSchema,
  ]),
  ma50: movingAverageIndicatorSchema,
  ma200: movingAverageIndicatorSchema,
});
export type SignalIndicators = z.infer<typeof signalIndicatorsSchema>;

// --- POST /trading/signal (#258) --------------------------------------------------------------

export const TRADING_SIGNAL_PATH = '/trading/signal';

// Upper estimate of the whole answer: one bounded chart GET (the backend's own budget sits below
// it) and the decision. The bot sizes its request timeout above it (#126).
export const TRADING_SIGNAL_BUDGET_MS = 4_000;

// The route's own refusals, before any chart GET: the pair's digits come from the backend's pairs
// cache (#379), so a missing or stale catalog and an id it does not list are refused.
export const TradingSignalErrorCode = {
  PairUnknown: 'pair_unknown',
  CatalogUnavailable: PairsCatalogErrorCode.Unavailable,
} as const;
export type TradingSignalErrorCode =
  (typeof TradingSignalErrorCode)[keyof typeof TradingSignalErrorCode];

export const SignalFeedOutcome = { Decided: 'decided', FetchFailed: 'fetch_failed' } as const;
export type SignalFeedOutcome = (typeof SignalFeedOutcome)[keyof typeof SignalFeedOutcome];

export const tradingSignalRequestSchema = z.object({
  assetId: createTradeIntentRequestSchema.shape.assetId,
  interval: signalIntervalSchema,
  // only the bot's analysis card sends it (#484): the decision is that user's analysis of this
  // duration, which the route records for the analysis reminder (docs/signal.md)
  analysis: z
    .object({
      telegramUserId: telegramUserIdSchema,
      durationSec: createTradeIntentRequestSchema.shape.durationSec,
    })
    .optional(),
  // only a trading session's worker sends it (#666): the answer then carries the decision's record
  record: z.literal(true).optional(),
});
export type TradingSignalRequest = z.infer<typeof tradingSignalRequestSchema>;
export type TradingSignalAnalysis = NonNullable<TradingSignalRequest['analysis']>;

// An H1 signal of a pair as the backend's H1 scanner holds it (#828, docs/h1.md -> The scanner and
// the signals list): the direction R1 decided on the closed second `second` (its end label f, unix
// ms), when the scanner decided it, and its age at the answer (now - f). Served only while the
// second is current (H1_START_SECOND_MAX_AGE_MS) and the decision is a signal.
export const h1SignalWireSchema = z.strictObject({
  action: tradeActionSchema,
  second: z.int().nonnegative(),
  decidedAt: z.int().nonnegative(),
  ageMs: z.int().nonnegative(),
});
export type H1SignalWire = z.infer<typeof h1SignalWireSchema>;

// A broker failure is an answer, not an HTTP error: the bot's client keeps only `error` from a
// non-2xx body, and retryAfterSec has to reach the user. `h1` is the pair's H1 signal at the answer
// (#828), on both outcomes: the direction the bot shows and trades; the candle decision is the
// card's information rows.
export const tradingSignalResponseSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    outcome: z.literal(SignalFeedOutcome.Decided),
    params: signalParamsSchema,
    decision: signalDecisionSchema,
    // absent when the unbroken tail of the response did not pass the candle checks (docs/signal.md)
    indicators: signalIndicatorsSchema.optional(),
    // present only when the request asked for it (record: true)
    record: signalRecordSchema.optional(),
    h1: h1SignalWireSchema.nullable(),
  }),
  z.strictObject({
    outcome: z.literal(SignalFeedOutcome.FetchFailed),
    code: z.enum(BrokerRestErrorCode),
    retryAfterSec: z.int().nonnegative().optional(),
    h1: h1SignalWireSchema.nullable(),
  }),
]);
export type TradingSignalResponse = z.infer<typeof tradingSignalResponseSchema>;

export const safeParseTradingSignalRequest = (input: unknown) =>
  tradingSignalRequestSchema.safeParse(input);
export const safeParseTradingSignalResponse = (input: unknown) =>
  tradingSignalResponseSchema.safeParse(input);

// --- GET /trading/signals (#343) --------------------------------------------------------------

export const TRADING_SIGNALS_PATH = '/trading/signals';

// The candle intervals the backend's ring builds from the data socket (docs/market-data.md), for
// the analysis's indicators and a v3 session's step, and the key of the signals list: the list of
// GET /trading/signals is keyed intervalForDuration(H1_EXPIRY_SEC), `5s`. `5s` only since #685,
// `15s` too from #382 to #685. The candle scanner that decided them was removed by #828.
export const SIGNAL_SCAN_INTERVALS = ['5s'] as const satisfies readonly SignalInterval[];
export type ScanInterval = (typeof SIGNAL_SCAN_INTERVALS)[number];

// The H1 scanner's list (#828, docs/h1.md -> The scanner and the signals list): one list, keyed by
// the interval of the H1 trade's duration; it holds only the pairs whose newest closed second is
// current and decided an H1 signal. `scanned` counts the pairs with a current decision. Times are
// unix ms. A list's interval is any SignalInterval (#685): a backend and a bot of different
// versions parse each other's answer, and the bot reads only the list of its own duration.
export const tradingSignalsResponseSchema = z.strictObject({
  asOf: z.int().nonnegative(),
  lists: z.array(
    z.strictObject({
      interval: signalIntervalSchema,
      scanned: z.int().nonnegative(),
      signals: z.array(
        h1SignalWireSchema.extend({ assetId: createTradeIntentRequestSchema.shape.assetId }),
      ),
    }),
  ),
});
export type TradingSignalsResponse = z.infer<typeof tradingSignalsResponseSchema>;

export const safeParseTradingSignalsResponse = (input: unknown) =>
  tradingSignalsResponseSchema.safeParse(input);
