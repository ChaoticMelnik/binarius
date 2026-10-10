import * as z from 'zod';
import { numericDomainDecimalSchema, type DecimalString } from './money';

// The broker postbacks (#141, docs/postbacks.md). packages/db builds the CHECKs of
// postback_deliveries and deposit_events from these objects.
export const PostbackSource = { Binodex: 'binodex' } as const;
export type PostbackSource = (typeof PostbackSource)[keyof typeof PostbackSource];

// The cabinet's macro table has no action variable: the Deposit and the FTD postback are told
// apart only by the `event` parameter each one's URL template carries.
export const PostbackEvent = { Deposit: 'deposit', Ftd: 'ftd' } as const;
export type PostbackEvent = (typeof PostbackEvent)[keyof typeof PostbackEvent];

// What a journaled delivery did. A duplicate of a recorded postback id is not journaled at all.
export const PostbackDeliveryOutcome = {
  DepositRecorded: 'recorded',
  DepositRepeated: 'repeated',
  Rejected: 'rejected',
} as const;
export type PostbackDeliveryOutcome =
  (typeof PostbackDeliveryOutcome)[keyof typeof PostbackDeliveryOutcome];

// In the order classifyPostback checks them.
export const PostbackRejectReason = {
  MissingPostbackId: 'missing_postback_id',
  UnknownEvent: 'unknown_event',
  MissingPaymentId: 'missing_payment_id',
  MissingTraderId: 'missing_trader_id',
  InvalidAmount: 'invalid_amount',
} as const;
export type PostbackRejectReason = (typeof PostbackRejectReason)[keyof typeof PostbackRejectReason];

export const PostbackResponseOutcome = {
  Recorded: 'recorded',
  Repeated: 'repeated',
  Duplicate: 'duplicate',
  Rejected: 'rejected',
} as const;
export type PostbackResponseOutcome =
  (typeof PostbackResponseOutcome)[keyof typeof PostbackResponseOutcome];

export const postbackResponseSchema = z.strictObject({
  outcome: z.enum(PostbackResponseOutcome),
  reason: z.enum(PostbackRejectReason).optional(),
});
export type PostbackResponse = z.infer<typeof postbackResponseSchema>;

// The query keys the cabinet fills; the macro names are the broker's (#8).
export const POSTBACK_MACROS = {
  postbackId: 'id',
  paymentId: 'payment_id',
  traderId: 'a',
  amount: 'amount',
  coin: 'coin',
} as const;
// ours, written into each action's URL template
export const POSTBACK_EVENT_PARAM = 'event';

export const POSTBACK_PATH_PREFIX = '/postbacks/binodex/';
// Path-safe without encoding, so the cabinet's template holds it as typed.
export const POSTBACK_URL_SECRET_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

export const POSTBACK_QUERY_MAX_KEYS = 64;
export const POSTBACK_QUERY_KEY_MAX = 64;
export const POSTBACK_QUERY_VALUE_MAX = 256;

// A flat map of strings: a repeated key arrives as an array and is refused here, before anything
// is journaled.
export const postbackQuerySchema = z
  .record(z.string().max(POSTBACK_QUERY_KEY_MAX), z.string().max(POSTBACK_QUERY_VALUE_MAX))
  .refine((query) => Object.keys(query).length <= POSTBACK_QUERY_MAX_KEYS, {
    error: `expected at most ${POSTBACK_QUERY_MAX_KEYS} query keys`,
  });
export type PostbackQuery = z.infer<typeof postbackQuerySchema>;

export type ClassifiedPostback =
  | {
      kind: 'deposit';
      postbackId: string;
      event: PostbackEvent;
      paymentId: string;
      traderId: string;
      amount: DecimalString;
      coin?: string;
    }
  | {
      kind: 'rejected';
      reason: PostbackRejectReason;
      postbackId?: string;
      event?: PostbackEvent;
    };

const eventSchema = z.enum(PostbackEvent);

// An empty value is a macro the cabinet left blank: the same as an absent key.
function filled(query: PostbackQuery, key: string): string | undefined {
  const value = Object.hasOwn(query, key) ? query[key] : undefined;
  return value === undefined || value === '' ? undefined : value;
}

// Pure: the refusals are checked in a fixed order, so one query always gets one reason.
export function classifyPostback(query: PostbackQuery): ClassifiedPostback {
  const postbackId = filled(query, POSTBACK_MACROS.postbackId);
  if (postbackId === undefined) {
    return { kind: 'rejected', reason: PostbackRejectReason.MissingPostbackId };
  }
  const event = eventSchema.safeParse(filled(query, POSTBACK_EVENT_PARAM));
  if (!event.success) {
    return { kind: 'rejected', reason: PostbackRejectReason.UnknownEvent, postbackId };
  }
  const known = { postbackId, event: event.data };
  const paymentId = filled(query, POSTBACK_MACROS.paymentId);
  if (paymentId === undefined) {
    return { kind: 'rejected', reason: PostbackRejectReason.MissingPaymentId, ...known };
  }
  const traderId = filled(query, POSTBACK_MACROS.traderId);
  if (traderId === undefined) {
    return { kind: 'rejected', reason: PostbackRejectReason.MissingTraderId, ...known };
  }
  const amount = numericDomainDecimalSchema.safeParse(filled(query, POSTBACK_MACROS.amount));
  if (!amount.success) {
    return { kind: 'rejected', reason: PostbackRejectReason.InvalidAmount, ...known };
  }
  const coin = filled(query, POSTBACK_MACROS.coin);
  return {
    kind: 'deposit',
    ...known,
    paymentId,
    traderId,
    amount: amount.data,
    ...(coin === undefined ? {} : { coin }),
  };
}
