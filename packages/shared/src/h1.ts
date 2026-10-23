import { z } from 'zod';
import { MAX_PAIR_DIGITS } from './broker';
import { SignalKind } from './signal';
import { TradeAction, tradeActionSchema } from './trading';

// The wire shape of an H1 decision (#667, docs/signal-stand.md -> H1): a 5-second move against the
// RMS of the 5-second moves of the last 300 s, on end-labelled 1s closes. The detector lives in
// packages/signal (h1.ts); the shapes, codes and the trade-plan constants live here so that the
// stand and the live parts (#669, #670) read one source.

export const H1_VERSION = 'h1';

export const H1NoSignalReason = {
  NoPrice: 'no_price',
  // a window without movement: sd = 0, hence the current move is 0 too (inside H1_PRICE_RANGE)
  NoVolatility: 'no_volatility',
  BelowThreshold: 'below_threshold',
} as const;
export type H1NoSignalReason = (typeof H1NoSignalReason)[keyof typeof H1NoSignalReason];

export const H1MissingPrice = { Last: 'last', Before: 'before' } as const;
export type H1MissingPrice = (typeof H1MissingPrice)[keyof typeof H1MissingPrice];

// The shape only; the rules between fields and the defaults are packages/signal's h1.ts.
export const h1ParamsSchema = z.strictObject({
  moveSec: z.int().positive(),
  sdWindowSec: z.int().positive(),
  sdStepSec: z.int().positive(),
  threshold: z.number().positive(),
});
export type H1Params = z.infer<typeof h1ParamsSchema>;

// R1, the live rule (#667's optimisation, issuecomment-6288355378 on #667): a 3-second move, entry
// +1 s, expiry 5 s. The analysis scaled the RMS of the 5-second moves by sqrt(3/5); the detector
// takes the RMS of the 3-second moves, so the step and the threshold are #669's Step 0 point: on
// stand-30d's 7 pairs >= 94 out-of-sample, 311.2 trades/pair-h (the closest to the analysis' 321)
// at 58.77 % (58.5 % there). The table: docs/h1.md -> R1.
export const H1_R1_PARAMS: Readonly<H1Params> = Object.freeze({
  moveSec: 3,
  sdWindowSec: 300,
  sdStepSec: 5,
  threshold: 1,
});

// The closes the H1 detector reads as prices (#667, Rule 43). Inside the range a move's square and
// the mean of up to 2^53 squares stay normal doubles (H-S4), so sd is finite, sd = 0 only on a flat
// window, and every decision passes h1DecisionSchema.
export const H1_PRICE_RANGE = { min: 1e-100, max: 1e100 } as const;

// z.number() refuses NaN and ±Infinity; sd > 0 because a flat window is no_volatility, and lastClose
// is in H1_PRICE_RANGE, where neither overflows (Rule 43)
export const h1FeaturesSchema = z.strictObject({
  move: z.number(),
  sd: z.number().positive(),
  z: z.number().nonnegative(),
  moves: z.int().positive(),
  lastClose: z.number().min(H1_PRICE_RANGE.min).max(H1_PRICE_RANGE.max),
});
export type H1Features = z.infer<typeof h1FeaturesSchema>;

const version = z.literal(H1_VERSION);
const noSignalHead = { kind: z.literal(SignalKind.NoSignal), version };

export const h1DecisionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal(SignalKind.Signal),
    version,
    action: tradeActionSchema,
    features: h1FeaturesSchema,
  }),
  z.discriminatedUnion('reason', [
    z.strictObject({
      ...noSignalHead,
      reason: z.literal(H1NoSignalReason.BelowThreshold),
      features: h1FeaturesSchema,
    }),
    z.strictObject({
      ...noSignalHead,
      reason: z.literal(H1NoSignalReason.NoPrice),
      detail: z.strictObject({ missing: z.enum(H1MissingPrice) }),
    }),
    z.strictObject({
      ...noSignalHead,
      reason: z.literal(H1NoSignalReason.NoVolatility),
      detail: z.strictObject({ moves: z.int().positive() }),
    }),
  ]),
]);
export type H1Decision = z.infer<typeof h1DecisionSchema>;

// The trade plan, not the detector's parameters: the backtest's window for the open after the
// closed second the decision rests on (the same second: 49.8 %, +1 s and +2 s: ~56 %, +3 s: 50.9 %)
// and its expiry. The stand's grid and #670's session read them.
export const H1_ENTRY_WINDOW_SEC = { from: 1, to: 2 } as const;
export const H1_EXPIRY_SEC = 5;
// break-even 51.5 %: the forex pairs the backtest found the effect on (#667)
export const H1_MIN_PAYOUT_PCT = 94;

// --- H1 sessions (#670, docs/h1.md -> Sessions) ---------------------------------------------------

// settings.signal.kind of a version 4 trading session: a jsonb key of the row, not a status
export const H1_SESSION_SIGNAL_KIND = 'h1';

// the signal of an H1 session's settings (settingsV4Schema): the detector's parameters, the entry
// delay after the decision's closed second and the trade's expiry
export const h1SessionSignalSchema = z.strictObject({
  kind: z.literal(H1_SESSION_SIGNAL_KIND),
  params: h1ParamsSchema,
  entryDelaySec: z.int().min(1),
  expirySec: z.literal(H1_EXPIRY_SEC),
});
export type H1SessionSignal = z.infer<typeof h1SessionSignalSchema>;

// settled trades per edit of an H1 session's Telegram summary (#707, docs/h1.md -> The session
// message): one message, edited every this many trades and at the finish
export const H1_NOTICE_EVERY_TRADES = 10;

// An H1 session started from the bot (#745, decision В2 of 2026-10-23): its length in trades and
// its loss ceiling as a multiple of the fixed stake; the bot asks for neither, the request's cycles
// are martingale cycles and do not apply
export const H1_BOT_SESSION_TRADES = 50;
export const H1_BOT_MAX_LOSS_MULTIPLIER = 20;

// A tie returns the stake: neither a win nor a loss. A type, not an `as const` object: the bot's
// session card has a tone of the same three values that is not a trade's outcome, and
// local/no-status-literal would tie the two.
export type TradeOutcome = 'win' | 'loss' | 'tie';

export function tradeOutcomeOf(action: TradeAction, entry: number, exit: number): TradeOutcome {
  if (exit === entry) return 'tie';
  return exit > entry === (action === TradeAction.Up) ? 'win' : 'loss';
}

// --- The H1 shadow (#669, docs/h1.md) -------------------------------------------------------------

// the two parameter sets the shadow decides with; a jsonb key of the row (params.set), not a status
export const H1ShadowSet = { R1: 'r1', H1: 'h1' } as const;
export type H1ShadowSet = (typeof H1ShadowSet)[keyof typeof H1ShadowSet];
// params.set of the H1 driver's decision rows (#707, context = session): the shadow's row shape,
// so the export's replay reads both; the shadow's own report reads only context = shadow
export const H1_SESSION_DECISION_SET = 'session';
export const H1_DECISION_SETS = [
  H1ShadowSet.R1,
  H1ShadowSet.H1,
  H1_SESSION_DECISION_SET,
] as const satisfies readonly (H1ShadowSet | typeof H1_SESSION_DECISION_SET)[];

// what closed the decision's second: the pair's first tick past it or the process clock
export const H1SecondClosedBy = { Tick: 'tick', Clock: 'clock' } as const;
export type H1SecondClosedBy = (typeof H1SecondClosedBy)[keyof typeof H1SecondClosedBy];

// an entry without a price at f + g or f + g + expiry (a socket hole) is unpriced
export const H1ShadowEntryOutcome = {
  Win: 'win',
  Loss: 'loss',
  Tie: 'tie',
  Unpriced: 'unpriced',
} as const satisfies Record<string, TradeOutcome | 'unpriced'>;
export type H1ShadowEntryOutcome = (typeof H1ShadowEntryOutcome)[keyof typeof H1ShadowEntryOutcome];

export const h1ShadowParamsSchema = h1ParamsSchema.extend({
  set: z.enum(H1_DECISION_SETS),
  entryDelaySec: z.int().min(1),
  expirySec: z.int().min(1),
});
export type H1ShadowParams = z.infer<typeof h1ShadowParamsSchema>;

export const h1ShadowSourceSchema = z.strictObject({
  kind: z.literal('ticks'),
  symbol: z.string().min(1),
  closedBy: z.enum(H1SecondClosedBy),
  closedAtMs: z.int(),
});
export type H1ShadowSource = z.infer<typeof h1ShadowSourceSchema>;

const shadowPrice = z.number().positive().nullable();
export const h1ShadowResultSchema = z.strictObject({
  entries: z
    .array(
      z.strictObject({
        entryDelaySec: z.int().min(1),
        entryPrice: shadowPrice,
        exitPrice: shadowPrice,
        outcome: z.enum(H1ShadowEntryOutcome),
      }),
    )
    .min(1),
});
export type H1ShadowResult = z.infer<typeof h1ShadowResultSchema>;

// the closes c[f - sdWindowSec .. f] the detector read, null where the second had no price
export const h1ShadowSeriesSchema = z.array(z.number().positive().nullable()).min(1);

// the row as journalEntryOf rebuilds it (the export's `signal`), the input of replayH1Entry
export const h1ShadowEntrySchema = z
  .object({
    assetId: z.int().positive(),
    interval: z.null(),
    digits: z.int().min(0).max(MAX_PAIR_DIGITS),
    nowMs: z.int().positive(),
    source: h1ShadowSourceSchema,
    version: z.literal(H1_VERSION),
    params: h1ShadowParamsSchema,
    series: h1ShadowSeriesSchema,
    decision: h1DecisionSchema,
  })
  .refine((entry) => entry.series.length === entry.params.sdWindowSec + 1, {
    message: 'series must hold sdWindowSec + 1 closes',
    path: ['series'],
  });
export type H1ShadowEntry = z.infer<typeof h1ShadowEntrySchema>;
