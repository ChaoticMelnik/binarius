import * as z from 'zod';
import { decimalStringSchema } from './money';

export const TradeMode = { Demo: 'demo', Real: 'real' } as const;
export type TradeMode = (typeof TradeMode)[keyof typeof TradeMode];
export const tradeModeSchema = z.enum(TradeMode);

export const TradeAction = { Up: 'up', Down: 'down' } as const;
export type TradeAction = (typeof TradeAction)[keyof typeof TradeAction];
export const tradeActionSchema = z.enum(TradeAction);

export const TradeIntentStatus = {
  Planned: 'planned',
  Reserved: 'reserved',
  Queued: 'queued',
  Submitting: 'submitting',
  Accepted: 'accepted',
  Settled: 'settled',
  Rejected: 'rejected',
  Unknown: 'unknown',
  Reconciling: 'reconciling',
  ManualReview: 'manual_review',
} as const;
export type TradeIntentStatus = (typeof TradeIntentStatus)[keyof typeof TradeIntentStatus];
export const tradeIntentStatusSchema = z.enum(TradeIntentStatus);

// ARCH-03: planned → reserved → queued → submitting → accepted | rejected | unknown;
// accepted → settled; unknown → reconciling → accepted | rejected | manual_review
export const TRADE_INTENT_TRANSITIONS: Readonly<
  Record<TradeIntentStatus, readonly TradeIntentStatus[]>
> = {
  planned: ['reserved'],
  reserved: ['queued'],
  queued: ['submitting'],
  submitting: ['accepted', 'rejected', 'unknown'],
  accepted: ['settled'],
  settled: [],
  rejected: [],
  unknown: ['reconciling'],
  reconciling: ['accepted', 'rejected', 'manual_review'],
  manual_review: [],
};

export function canTransition(from: TradeIntentStatus, to: TradeIntentStatus): boolean {
  return TRADE_INTENT_TRANSITIONS[from].includes(to);
}

export const tradeIntentSchema = z.object({
  id: z.uuid(),
  brokerAccountId: z.string().min(1),
  telegramUserId: z.string().min(1),
  mode: tradeModeSchema,
  assetId: z.int().positive(),
  amount: decimalStringSchema,
  action: tradeActionSchema,
  durationSec: z.int().positive(),
  clientRequestId: z.string().min(1),
  createdAt: z.iso.datetime({ offset: true }),
});

export type TradeIntent = z.infer<typeof tradeIntentSchema>;

export const parseTradeIntent = (input: unknown): TradeIntent => tradeIntentSchema.parse(input);
export const safeParseTradeIntent = (input: unknown) => tradeIntentSchema.safeParse(input);
