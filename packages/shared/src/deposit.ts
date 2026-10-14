import * as z from 'zod';
import { INIT_DATA_MAX_LENGTH } from './oauth';

// POST /deposit/widget-session (#11, docs/deposit.md): a session of the broker's cashier widget
// for the Telegram user's own broker account. Public on the backend, like the OAuth callback:
// apps/web forwards the Mini App's signed initData, and that proof is the whole authorization.
export const DEPOSIT_WIDGET_SESSION_PATH = '/deposit/widget-session';

// Both the backend's route and apps/web's forward of it (#111) accept bodies up to this size: the
// initData at its maximum plus the client IP and the JSON around them.
export const DEPOSIT_BODY_LIMIT_BYTES = 8 * 1024;

// How long the backend may hold the route: a token exchange under the account's row lock, then
// the broker call (database work is ordinary latency). It lives here because apps/backend's chain
// must fit inside it and apps/web's forward (#111) must wait longer than it.
export const DEPOSIT_WIDGET_SESSION_BUDGET_MS = 8_000;

// the longest textual IPv6 address with an embedded IPv4 tail
const CLIENT_IP_MAX_LENGTH = 45;

export const depositWidgetSessionRequestSchema = z.strictObject({
  initData: z.string().min(1).max(INIT_DATA_MAX_LENGTH),
  // the user's IP as apps/web saw it; the backend forwards it to the broker only when it parses
  // as an IP address
  clientIp: z.string().min(1).max(CLIENT_IP_MAX_LENGTH).optional(),
});
export type DepositWidgetSessionRequest = z.infer<typeof depositWidgetSessionRequestSchema>;

// The page never builds a URL: widgetUrl and widgetOrigin are always present, and both are in the
// backend's DEPOSIT_WIDGET_ORIGINS, which the page's frame-src names in advance.
export const depositWidgetSessionResponseSchema = z.strictObject({
  session: z.string().min(1),
  expiresInSec: z.int().positive(),
  widgetUrl: z.url({ protocol: /^https$/ }),
  widgetOrigin: z.url({ protocol: /^https$/ }),
});
export type DepositWidgetSessionResponse = z.infer<typeof depositWidgetSessionResponseSchema>;

// The answer's code decides what the page does (docs/deposit.md -> Error table).
export const DepositErrorCode = {
  InvalidTelegramAuth: 'invalid_telegram_auth',
  TooManyRequests: 'too_many_requests',
  // the backend runs DEMO_ONLY (#396): no deposit session is minted
  DemoOnly: 'demo_only',
  NoActiveAccount: 'no_active_account',
  // two or more active broker accounts: which one to fund is not ours to guess
  AmbiguousAccount: 'ambiguous_account',
  UserBlocked: 'user_blocked',
  // the account cannot act for the user until they log in to the broker again
  TokenUnavailable: 'token_unavailable',
  // passing: a retry may succeed
  BrokerUnavailable: 'broker_unavailable',
  // the broker refused the request, or answered with a widget outside the allowlist: a retry
  // would get the same answer
  BrokerRejected: 'broker_rejected',
} as const;
export type DepositErrorCode = (typeof DepositErrorCode)[keyof typeof DepositErrorCode];

export const depositRefusalSchema = z.strictObject({ error: z.enum(DepositErrorCode) });

export const safeParseDepositWidgetSessionRequest = (input: unknown) =>
  depositWidgetSessionRequestSchema.safeParse(input);
export const safeParseDepositWidgetSessionResponse = (input: unknown) =>
  depositWidgetSessionResponseSchema.safeParse(input);
export const safeParseDepositRefusal = (input: unknown) => depositRefusalSchema.safeParse(input);
