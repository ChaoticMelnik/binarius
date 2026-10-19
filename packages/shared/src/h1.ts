import { z } from 'zod';
import { SignalKind } from './signal';
import { tradeActionSchema } from './trading';

// The wire shape of an H1 decision (#667, docs/signal-stand.md -> H1): a 5-second move against the
// RMS of the 5-second moves of the last 300 s, on end-labelled 1s closes. The detector lives in
// packages/signal (h1.ts); the shapes, codes and the trade-plan constants live here so that the
// stand and the live parts (#669, #670) read one source.

export const H1_VERSION = 'h1';

export const H1NoSignalReason = {
  NoPrice: 'no_price',
  // a window without movement: sd = 0, hence the current move is 0 too
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

// z.number() refuses NaN and ±Infinity; sd > 0 because a flat window is no_volatility
export const h1FeaturesSchema = z.strictObject({
  move: z.number(),
  sd: z.number().positive(),
  z: z.number().nonnegative(),
  moves: z.int().positive(),
  lastClose: z.number().positive(),
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
