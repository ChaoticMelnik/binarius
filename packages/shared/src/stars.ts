import * as z from 'zod';
import { telegramUserIdSchema, tokenCountSchema } from './trading';

// Buying tokens for Telegram Stars (#117, docs/stars.md). The packages, the invoice payload and the
// contract of the three internal routes the bot calls: POST /payments/stars/invoice, /pre-checkout
// and /paid.

// A deploy changes the table; each purchase freezes the price and the tokens it was credited at in
// its star_payments row, so a change never rewrites a past purchase.
export const STAR_PACKAGES = [
  { code: 'p50', tokens: 50n, stars: 100 },
  { code: 'p150', tokens: 150n, stars: 250 },
  { code: 'p500', tokens: 500n, stars: 750 },
] as const;
export type StarPackage = (typeof STAR_PACKAGES)[number];
export type StarPackageCode = StarPackage['code'];

export const starPackageOf = (code: string): StarPackage | undefined =>
  STAR_PACKAGES.find((candidate) => candidate.code === code);

// Telegram's currency code for Stars; an invoice in it takes no provider token.
export const STARS_CURRENCY = 'XTR';

// star_payments.status (Rule 1). `held`: recorded, nothing credited — the payment failed a check at
// credit time (StarPaymentHoldReason) and waits for a staff member.
export const StarPaymentStatus = { Paid: 'paid', Held: 'held', Refunded: 'refunded' } as const;
export type StarPaymentStatus = (typeof StarPaymentStatus)[keyof typeof StarPaymentStatus];

export const StarPaymentHoldReason = {
  Currency: 'currency',
  Amount: 'amount',
  Package: 'package',
  Payer: 'payer',
} as const;
export type StarPaymentHoldReason =
  (typeof StarPaymentHoldReason)[keyof typeof StarPaymentHoldReason];

// --- The invoice payload ----------------------------------------------------------------------

// `stars:<package code>:<users.id>`. Telegram hands it back unchanged in the pre-checkout query, in
// successful_payment and in the bot's Star transactions, so it is what ties a payment to a user and
// a package. Bot API: 1-128 bytes.
export const STARS_PAYLOAD_MAX_BYTES = 128;
const STARS_PAYLOAD_PATTERN =
  /^stars:([a-z0-9]{1,16}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export const starsInvoicePayload = (code: StarPackageCode, userId: string): string =>
  `stars:${code}:${userId}`;

// The one parser of a payload: the package code is returned as written, known or not — a package
// removed by a deploy between the invoice and the payment is the credit's to hold, not a stranger's
// payload.
export function parseStarsInvoicePayload(
  payload: string,
): { packageCode: string; userId: string } | undefined {
  const match = STARS_PAYLOAD_PATTERN.exec(payload);
  if (match === null) return undefined;
  return { packageCode: match[1]!, userId: match[2]! };
}

// --- Timing (Rule 10) -------------------------------------------------------------------------

// What POST /payments/stars/pre-checkout may spend: its reads. The bot's timeout for the call sits
// above it, and Telegram's 10 s for the answer above both (apps/bot/src/timing.ts).
export const STARS_PRECHECKOUT_BUDGET_MS = 2_000;

// --- The routes ---------------------------------------------------------------------------------

export const StarsErrorCode = {
  UserNotFound: 'user_not_found',
  UserBlocked: 'user_blocked',
  NoActiveAccount: 'no_active_account',
  PackageUnknown: 'package_unknown',
  PayloadUnknown: 'payload_unknown',
} as const;
export type StarsErrorCode = (typeof StarsErrorCode)[keyof typeof StarsErrorCode];

// Any string a caller sends, bounded: an unknown code is the route's 409, not a 400.
const packageCodeSchema = z.string().min(1).max(16);
// The payload as Telegram returned it. Bounded by the Bot API's own limit in bytes; parsed by the
// route, so a malformed one is an answer rather than a validation failure.
const invoicePayloadSchema = z
  .string()
  .refine((value) => new TextEncoder().encode(value).length <= STARS_PAYLOAD_MAX_BYTES);
const currencySchema = z.string().min(1).max(16);
const starAmountSchema = z.int().positive().max(2_147_483_647);

export const starsInvoiceRequestSchema = z.object({
  telegramUserId: telegramUserIdSchema,
  packageCode: packageCodeSchema,
});
export type StarsInvoiceRequest = z.infer<typeof starsInvoiceRequestSchema>;

export const starsInvoiceResponseSchema = z.object({
  payload: z.string().refine((value) => parseStarsInvoicePayload(value) !== undefined),
  package: z.object({
    code: packageCodeSchema,
    tokens: tokenCountSchema,
    stars: starAmountSchema,
  }),
});
export type StarsInvoiceResponse = z.infer<typeof starsInvoiceResponseSchema>;

export const StarsPreCheckoutRefusal = {
  Payload: 'payload',
  Package: 'package',
  Currency: 'currency',
  Amount: 'amount',
  Payer: 'payer',
  UserNotFound: 'user_not_found',
  UserBlocked: 'user_blocked',
  NoActiveAccount: 'no_active_account',
} as const;
export type StarsPreCheckoutRefusal =
  (typeof StarsPreCheckoutRefusal)[keyof typeof StarsPreCheckoutRefusal];

export const starsPreCheckoutRequestSchema = z.object({
  telegramUserId: telegramUserIdSchema,
  invoicePayload: invoicePayloadSchema,
  currency: currencySchema,
  totalAmount: starAmountSchema,
});
export type StarsPreCheckoutRequest = z.infer<typeof starsPreCheckoutRequestSchema>;

export const starsPreCheckoutResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), reason: z.enum(StarsPreCheckoutRefusal) }),
]);
export type StarsPreCheckoutResponse = z.infer<typeof starsPreCheckoutResponseSchema>;

// Bot API: telegram_payment_charge_id is an opaque string; star_payments bounds it to 1-255.
export const STAR_CHARGE_ID_MAX = 255;
const chargeIdSchema = z.string().min(1).max(STAR_CHARGE_ID_MAX);

export const starsPaidRequestSchema = z.object({
  telegramUserId: telegramUserIdSchema,
  telegramPaymentChargeId: chargeIdSchema,
  // empty for a Stars payment in practice; kept when Telegram sends one
  providerPaymentChargeId: z.string().max(STAR_CHARGE_ID_MAX).nullable(),
  invoicePayload: invoicePayloadSchema,
  currency: currencySchema,
  totalAmount: starAmountSchema,
  // the message's `date`, Unix seconds: Telegram's clock, not ours
  paidAt: z.int().positive(),
});
export type StarsPaidRequest = z.infer<typeof starsPaidRequestSchema>;

export const StarsCreditOutcome = {
  Credited: 'credited',
  AlreadyCredited: 'already_credited',
  Held: 'held',
} as const;
export type StarsCreditOutcome = (typeof StarsCreditOutcome)[keyof typeof StarsCreditOutcome];

export const starsPaidResponseSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.enum([StarsCreditOutcome.Credited, StarsCreditOutcome.AlreadyCredited]),
    tokens: tokenCountSchema,
    balance: tokenCountSchema,
  }),
  z.object({ outcome: z.literal(StarsCreditOutcome.Held) }),
]);
export type StarsPaidResponse = z.infer<typeof starsPaidResponseSchema>;

// --- Refunds (#118, docs/stars.md → Refunds) -----------------------------------------------------

// The staff member's reason for `stars refund`, kept in the audit row: the kill switch's rule, code
// points without control characters.
export const STAR_REFUND_REASON_MAX = 200;
const REFUND_REASON_SHAPE = new RegExp(`^[^\\p{Cc}]{1,${STAR_REFUND_REASON_MAX}}$`, 'u');
export const starRefundReasonSchema = z
  .string()
  .trim()
  .regex(REFUND_REASON_SHAPE, {
    error: `expected 1-${STAR_REFUND_REASON_MAX} characters without control characters`,
  });
