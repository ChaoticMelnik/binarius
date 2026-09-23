import * as z from 'zod';
import { positiveDecimalStringSchema } from './money';

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
// accepted → settled; unknown → reconciling → accepted | rejected | manual_review.
// A failure before the order reaches the broker (planned/reserved/queued) is a terminal rejected;
// unknown is reachable only from submitting because only a sent order can have an unknown outcome.
// manual_review concludes to settled or rejected: it is a human decision, not a dead end, and
// without those edges an intent parked there could never be resolved — which matters because
// #7's "one active intent per account" index treats every non-terminal status as blocking.
export const TRADE_INTENT_TRANSITIONS: Readonly<
  Record<TradeIntentStatus, readonly TradeIntentStatus[]>
> = {
  planned: ['reserved', 'rejected'],
  reserved: ['queued', 'rejected'],
  queued: ['submitting', 'rejected'],
  submitting: ['accepted', 'rejected', 'unknown'],
  accepted: ['settled'],
  settled: [],
  rejected: [],
  unknown: ['reconciling'],
  reconciling: ['accepted', 'rejected', 'manual_review'],
  manual_review: ['settled', 'rejected'],
};

// `from` is usually a DB column at runtime, so an out-of-enum value answers false, not TypeError
export function canTransition(from: TradeIntentStatus, to: TradeIntentStatus): boolean {
  return TRADE_INTENT_TRANSITIONS[from]?.includes(to) ?? false;
}

export const tradeIntentSchema = z.object({
  id: z.uuid(),
  brokerAccountId: z.string().min(1),
  telegramUserId: z.string().min(1),
  mode: tradeModeSchema,
  assetId: z.int().positive(),
  amount: positiveDecimalStringSchema,
  action: tradeActionSchema,
  durationSec: z.int().positive(),
  clientRequestId: z.string().min(1),
  createdAt: z.iso.datetime({ offset: true }),
});

export type TradeIntent = z.infer<typeof tradeIntentSchema>;

export const parseTradeIntent = (input: unknown): TradeIntent => tradeIntentSchema.parse(input);
export const safeParseTradeIntent = (input: unknown) => tradeIntentSchema.safeParse(input);

// --- ARCH-03 transport contract (issue #42) ---------------------------------------------------

// ARCH-04: how the order reached the broker; the DB CHECK inlines the same literals
export const TradeTransport = { Socket: 'socket', RestFallback: 'rest_fallback' } as const;
export type TradeTransport = (typeof TradeTransport)[keyof typeof TradeTransport];
export const tradeTransportSchema = z.enum(TradeTransport);

// The only values trade_intents.last_error and the dead-letter payload may carry: free-text
// reasons (exception messages, broker responses) could leak secrets into persisted rows.
export const TradeIntentFailureReason = {
  Expired: 'expired',
  ExecutorNotConfigured: 'executor_not_configured',
  ExecutorTimeout: 'executor_timeout',
  ExecutorError: 'executor_error',
  BrokerRejected: 'broker_rejected',
  PublishFailed: 'publish_failed',
  StaleSubmitting: 'stale_submitting',
  InvalidJob: 'invalid_job',
  // the job itself failed (database unreachable while persisting an outcome); DLQ only
  ProcessingFailed: 'processing_failed',
} as const;
export type TradeIntentFailureReason =
  (typeof TradeIntentFailureReason)[keyof typeof TradeIntentFailureReason];
export const tradeIntentFailureReasonSchema = z.enum(TradeIntentFailureReason);

export const TradeIntentErrorCode = {
  UserNotFound: 'user_not_found',
  UserBlocked: 'user_blocked',
  BrokerAccountNotFound: 'broker_account_not_found',
  AmbiguousBrokerAccount: 'ambiguous_broker_account',
  AccountRevoked: 'account_revoked',
  // linked but not yet confirmed in the bot, so it may not trade
  AccountNotConfirmed: 'account_not_confirmed',
  AccountHalted: 'account_halted',
  InsufficientTokens: 'insufficient_tokens',
  ActiveIntentExists: 'active_intent_exists',
  ClientRequestIdConflict: 'client_request_id_conflict',
} as const;
export type TradeIntentErrorCode = (typeof TradeIntentErrorCode)[keyof typeof TradeIntentErrorCode];

const INT4_MAX = 2_147_483_647;
const INT8_MAX = 9_223_372_036_854_775_807n;
const NUMERIC_INTEGER_DIGITS = 12;
const NUMERIC_FRACTION_DIGITS = 8;

const int4PositiveSchema = z.int().positive().max(INT4_MAX);

// trade_intents.amount is numeric(20,8): a longer input would be rounded or rejected by the
// database, and a rounded value would no longer compare equal on an idempotent replay
export const tradeAmountSchema = positiveDecimalStringSchema.refine(
  (value) => {
    const [integer = '', fraction = ''] = value.split('.');
    return integer.length <= NUMERIC_INTEGER_DIGITS && fraction.length <= NUMERIC_FRACTION_DIGITS;
  },
  { error: 'expected at most 12 integer and 8 fractional digits' },
);

// users.telegram_user_id is bigint; Telegram ids are positive and fit int8. Zod 4 runs every
// check even after the regex failed, so the refine must not hand BigInt() a non-numeric string.
export const telegramUserIdSchema = z
  .string()
  .regex(/^[1-9]\d{0,18}$/, { error: 'expected a positive integer string' })
  .refine((value) => /^\d+$/.test(value) && BigInt(value) <= INT8_MAX, {
    error: 'exceeds the bigint range',
  });

export const createTradeIntentRequestSchema = z.object({
  telegramUserId: telegramUserIdSchema,
  brokerAccountId: z.uuid().optional(),
  mode: tradeModeSchema,
  assetId: int4PositiveSchema,
  amount: tradeAmountSchema,
  action: tradeActionSchema,
  durationSec: int4PositiveSchema,
  clientRequestId: z.string().min(1).max(128),
});
export type CreateTradeIntentRequest = z.infer<typeof createTradeIntentRequestSchema>;

// Nullable, not optional: queued intents legitimately have no transport, submission time or
// error yet, and the wire shape must say so instead of omitting the keys.
export const tradeIntentViewSchema = tradeIntentSchema.extend({
  status: tradeIntentStatusSchema,
  version: z.int().positive(),
  tokensReserved: z.string().regex(/^\d+$/),
  transport: tradeTransportSchema.nullable(),
  submittedAt: z.iso.datetime({ offset: true }).nullable(),
  lastError: tradeIntentFailureReasonSchema.nullable(),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type TradeIntentView = z.infer<typeof tradeIntentViewSchema>;

export const parseTradeIntentView = (input: unknown): TradeIntentView =>
  tradeIntentViewSchema.parse(input);
export const safeParseTradeIntentView = (input: unknown) => tradeIntentViewSchema.safeParse(input);
export const safeParseCreateTradeIntentRequest = (input: unknown) =>
  createTradeIntentRequestSchema.safeParse(input);

// the queue carries the id only; the worker re-reads the intent from the database
export const tradeIntentJobPayloadSchema = z.object({ intentId: z.uuid() });
export type TradeIntentJobPayload = z.infer<typeof tradeIntentJobPayloadSchema>;

export const TRADING_INTENTS_DEAD_LETTER_QUEUE = 'trading-intents-dead-letter';
