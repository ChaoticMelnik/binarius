import * as z from 'zod';
import { idWireSchema, toId } from './ids';
import { telegramUserIdSchema, tradeModeSchema, type TradeMode } from './trading';

// --- Token responses ---------------------------------------------------------------------------
// POST /v1/broker/user-auth/refresh answers with the pair alone; POST /v1/broker/oauth/token adds
// the user the code was issued to. Contract verified against the live broker (docs/binodex-oauth.md
// -> Broker contract).

export const refreshTokenResponseWireSchema = z.looseObject({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  token_type: z.string(),
  expires_in: z.int().nonnegative(),
});
export type RefreshTokenResponseWire = z.infer<typeof refreshTokenResponseWireSchema>;

export const oauthTokenResponseWireSchema = refreshTokenResponseWireSchema.extend({
  user: z.looseObject({
    id: idWireSchema,
    email: z.string(),
    is_partner_client: z.boolean(),
  }),
});
export type OAuthTokenResponseWire = z.infer<typeof oauthTokenResponseWireSchema>;

export interface RefreshedTokens {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresInSec: number;
}

export interface OAuthTokens extends RefreshedTokens {
  user: { id: string; email: string | null; isPartnerClient: boolean };
}

// A blank address is no address: '' and whitespace only. Anything else stays as the broker sent
// it, /account's rule since #185. The same function runs in the db projections for rows stored
// before #214.
export const addressOrNull = (email: string | null): string | null =>
  email === null || email.trim() === '' ? null : email;

export function toRefreshedTokens(wire: RefreshTokenResponseWire): RefreshedTokens {
  return {
    accessToken: wire.access_token,
    refreshToken: wire.refresh_token,
    tokenType: wire.token_type,
    expiresInSec: wire.expires_in,
  };
}

export function toOAuthTokens(wire: OAuthTokenResponseWire): OAuthTokens {
  return {
    ...toRefreshedTokens(wire),
    user: {
      id: toId(wire.user.id),
      email: addressOrNull(wire.user.email),
      isPartnerClient: wire.user.is_partner_client,
    },
  };
}

export const parseRefreshTokenResponse = (input: unknown): RefreshedTokens =>
  toRefreshedTokens(refreshTokenResponseWireSchema.parse(input));
export const safeParseRefreshTokenResponse = (input: unknown) =>
  refreshTokenResponseWireSchema.safeParse(input);

export const parseOAuthTokenResponse = (input: unknown): OAuthTokens =>
  toOAuthTokens(oauthTokenResponseWireSchema.parse(input));
export const safeParseOAuthTokenResponse = (input: unknown) =>
  oauthTokenResponseWireSchema.safeParse(input);

// POST /v1/broker/user-auth/email/send-code answers `{ status: true }`; email/login answers the
// same body as the code exchange (oauthTokenResponseWireSchema) — spike #102.
export const emailSendCodeResponseWireSchema = z.looseObject({ status: z.literal(true) });
export const safeParseBrokerEmailSendCodeResponse = (input: unknown) =>
  emailSendCodeResponseWireSchema.safeParse(input);

// --- Widget session (POST /v1/broker/widget-sessions) -----------------------------------------

export interface WidgetSessionRequest {
  origin: string;
  mode: TradeMode;
}

export const widgetSessionRequestWireSchema = z.object({
  origin: z.string().min(1),
  mode: tradeModeSchema,
});
export type WidgetSessionRequestWire = z.infer<typeof widgetSessionRequestWireSchema>;

export function toWidgetSessionRequestWire(
  request: WidgetSessionRequest,
): WidgetSessionRequestWire {
  return { origin: request.origin, mode: request.mode };
}

export const widgetSessionResponseWireSchema = z.looseObject({
  session: z.string().min(1),
  expires_in: z.int().nonnegative(),
});
export type WidgetSessionResponseWire = z.infer<typeof widgetSessionResponseWireSchema>;

export interface WidgetSession {
  session: string;
  expiresInSec: number;
}

export function toWidgetSession(wire: WidgetSessionResponseWire): WidgetSession {
  return { session: wire.session, expiresInSec: wire.expires_in };
}

export const parseWidgetSessionResponse = (input: unknown): WidgetSession =>
  toWidgetSession(widgetSessionResponseWireSchema.parse(input));
export const safeParseWidgetSessionResponse = (input: unknown) =>
  widgetSessionResponseWireSchema.safeParse(input);

// --- Login flow contract (issue #9) ------------------------------------------------------------

// Reasons this flow may revoke a broker account. Trading halts (trading_halted/halted_reason)
// belong to reconciliation (haltAccountForManualReview, packages/db) and are never written here.
export const AuthRevokedReason = {
  // the broker refused our refresh token: it has already been consumed, which is what a
  // replayed refresh token looks like from our side
  RefreshInvalidGrant: 'refresh_invalid_grant',
  // timeout, network failure or 5xx: the broker may have consumed the token, so presenting it
  // again would be the replay we must never perform
  RefreshOutcomeUnknown: 'refresh_outcome_unknown',
  RefreshExpired: 'refresh_expired',
  // the stored hash does not match the stored ciphertext — storage, not the broker, is wrong
  StorageInconsistent: 'storage_inconsistent',
} as const;
export type AuthRevokedReason = (typeof AuthRevokedReason)[keyof typeof AuthRevokedReason];
export const authRevokedReasonSchema = z.enum(AuthRevokedReason);

// Why trading on an account stopped (broker_accounts.halted_reason, #90): reconciliation could not
// tell which broker trade an intent became, found none once the window closed (absence is not
// proven before #274), or the one it found disagrees with the intent. Only an operator lifts it,
// writing trading_halted and halted_reason together.
export const AccountHaltReason = {
  ReconciliationAmbiguous: 'reconciliation_ambiguous',
  ReconciliationNotFound: 'reconciliation_not_found',
  TradeMismatch: 'trade_mismatch',
} as const;
export type AccountHaltReason = (typeof AccountHaltReason)[keyof typeof AccountHaltReason];
export const accountHaltReasonSchema = z.enum(AccountHaltReason);

// A freshly linked account starts pending: the OAuth callback proves someone authorized at the
// broker, not that the Telegram user who started the login is that someone. Confirming in the
// bot is what makes it usable.
export const BrokerAccountStatus = {
  Pending: 'pending',
  Active: 'active',
  Revoked: 'revoked',
} as const;
export type BrokerAccountStatus = (typeof BrokerAccountStatus)[keyof typeof BrokerAccountStatus];

export const OAuthErrorCode = {
  InvalidState: 'invalid_state',
  InvalidCode: 'invalid_code',
  BrokerUnavailable: 'broker_unavailable',
  BrokerContractViolation: 'broker_contract_violation',
  BrokerAccountTaken: 'broker_account_taken',
  BrokerAccountNotFound: 'broker_account_not_found',
  AccountNotPending: 'account_not_pending',
  UserBlocked: 'user_blocked',
  // a route-wide ceiling
  TooManyRequests: 'too_many_requests',
  // one Telegram user's or one address's allowance on the email login
  TooManyAttempts: 'too_many_attempts',
  // the broker refused the address the code was asked for
  InvalidEmail: 'invalid_email',
  // the callback's Telegram initData is missing a valid signature or is too old; nothing was spent
  InvalidTelegramAuth: 'invalid_telegram_auth',
  // the initData is valid but belongs to someone other than the state's owner; the state is spent
  TelegramUserMismatch: 'telegram_user_mismatch',
} as const;
export type OAuthErrorCode = (typeof OAuthErrorCode)[keyof typeof OAuthErrorCode];

// Why a confirmed link paid no starter pack. Not an error: the account is linked either way.
export const LinkBonusSkipReason = {
  NotPartnerClient: 'not_partner_client',
  AlreadyGranted: 'already_granted',
} as const;
export type LinkBonusSkipReason = (typeof LinkBonusSkipReason)[keyof typeof LinkBonusSkipReason];

// The two apps/web pages of the Mini App login (#114). The broker redirects to the callback page,
// so BROKER_OAUTH_REDIRECT_URI must end with OAUTH_CALLBACK_PATH; the backend derives the login
// page's URL from that URI's origin.
export const OAUTH_LOGIN_PATH = '/oauth/login';
export const OAUTH_CALLBACK_PATH = '/oauth/callback';
// the login page's query parameter carrying the broker authorize URL
export const MINI_APP_AUTHORIZE_PARAM = 'authorize';

// Both the backend's callback route and apps/web's forward of it accept bodies up to this size:
// every field of the callback at its schema maximum (256 + 512 + 4096) plus the JSON around them.
export const OAUTH_CALLBACK_BODY_LIMIT_BYTES = 8 * 1024;

// How long the backend may hold POST /auth/binodex/callback: the code exchange and the push that
// follows (database work is ordinary latency). It lives here rather than in either process because
// both size their own chains against it — apps/backend/src/timing.ts must fit inside it,
// apps/web/src/timing.ts must wait longer than it.
export const OAUTH_CALLBACK_BUDGET_MS = 8_000;

export const startLoginRequestSchema = z.object({ telegramUserId: telegramUserIdSchema });
export type StartLoginRequest = z.infer<typeof startLoginRequestSchema>;

export const startLoginResponseSchema = z.object({
  authorizeUrl: z.url(),
  state: z.string().min(1),
  expiresAt: z.iso.datetime({ offset: true }),
  // the apps/web login page that opens authorizeUrl inside the Mini App; only for an https
  // redirect URI, because Telegram accepts only https in a web_app button
  miniAppUrl: z.url().optional(),
});
export type StartLoginResponse = z.infer<typeof startLoginResponseSchema>;

// a measured initData with photo_url is ~300 bytes; the bound only stops an unbounded field
export const INIT_DATA_MAX_LENGTH = 4096;

// The callback is public. Everything the login acts on lives in the state row the backend issued;
// `initData` is the Mini App's signed Telegram launch data, raw as `Telegram.WebApp.initData`
// gives it, and proves which Telegram user finished the login.
export const oauthCallbackRequestSchema = z.object({
  state: z.string().min(1).max(256),
  code: z.string().min(1).max(512),
  initData: z.string().min(1).max(INIT_DATA_MAX_LENGTH),
});
export type OAuthCallbackRequest = z.infer<typeof oauthCallbackRequestSchema>;

// allowlisted projection of broker_accounts: ciphertexts, key id and the refresh hash never
// leave the process
export const brokerAccountViewSchema = z.object({
  id: z.uuid(),
  brokerUserId: z.string().min(1),
  email: z.string().nullable(),
  isPartnerClient: z.boolean(),
  status: z.enum(BrokerAccountStatus),
  createdAt: z.iso.datetime({ offset: true }),
});
export type BrokerAccountView = z.infer<typeof brokerAccountViewSchema>;

export const oauthCallbackResponseSchema = z.object({ account: brokerAccountViewSchema });
export type OAuthCallbackResponse = z.infer<typeof oauthCallbackResponseSchema>;

// The bot confirms on behalf of the Telegram user who started the login, so both identities
// travel: the account alone would let any caller activate any pending row it can name.
export const confirmLoginRequestSchema = z.object({
  telegramUserId: telegramUserIdSchema,
  accountId: z.uuid(),
});
export type ConfirmLoginRequest = z.infer<typeof confirmLoginRequestSchema>;

// What the confirm did about the starter pack. `tokens` is a decimal string, never a number:
// the amount is a bigint in the backend, and the bot prints it rather than knowing it.
export const linkBonusGrantViewSchema = z.discriminatedUnion('granted', [
  z.object({ granted: z.literal(true), tokens: z.string().regex(/^[1-9]\d*$/) }),
  z.object({ granted: z.literal(false), reason: z.enum(LinkBonusSkipReason) }),
]);
export type LinkBonusGrantView = z.infer<typeof linkBonusGrantViewSchema>;

export const confirmLoginResponseSchema = z.object({
  account: brokerAccountViewSchema,
  grant: linkBonusGrantViewSchema,
});
export type ConfirmLoginResponse = z.infer<typeof confirmLoginResponseSchema>;

// --- Email login (issue #162) ------------------------------------------------------------------

// Trimmed before the format check: `z.email().trim()` checks first and rejects surrounding
// spaces. The case is kept on the wire — the broker normalizes it.
export const emailAddressSchema = z.string().trim().max(254).pipe(z.email());
// the broker accepts any shape and answers "Invalid or expired code", so no format is guessed here
export const emailLoginCodeSchema = z.string().trim().min(1).max(64);

export const emailSendCodeRequestSchema = z.object({
  telegramUserId: telegramUserIdSchema,
  email: emailAddressSchema,
});
export type EmailSendCodeRequest = z.infer<typeof emailSendCodeRequestSchema>;

export const emailSendCodeResponseSchema = z.object({ codeSent: z.literal(true) });
export type EmailSendCodeResponse = z.infer<typeof emailSendCodeResponseSchema>;

export const emailLoginRequestSchema = z.object({
  telegramUserId: telegramUserIdSchema,
  email: emailAddressSchema,
  code: emailLoginCodeSchema,
});
export type EmailLoginRequest = z.infer<typeof emailLoginRequestSchema>;

export const safeParseStartLoginRequest = (input: unknown) =>
  startLoginRequestSchema.safeParse(input);
export const safeParseOAuthCallbackRequest = (input: unknown) =>
  oauthCallbackRequestSchema.safeParse(input);
export const safeParseOAuthCallbackResponse = (input: unknown) =>
  oauthCallbackResponseSchema.safeParse(input);
export const safeParseConfirmLoginRequest = (input: unknown) =>
  confirmLoginRequestSchema.safeParse(input);
export const safeParseConfirmLoginResponse = (input: unknown) =>
  confirmLoginResponseSchema.safeParse(input);

// an email login activates the account in the same step, so it answers what a confirm answers
export const emailLoginResponseSchema = confirmLoginResponseSchema;
export type EmailLoginResponse = ConfirmLoginResponse;

export const safeParseEmailSendCodeRequest = (input: unknown) =>
  emailSendCodeRequestSchema.safeParse(input);
export const safeParseEmailSendCodeResponse = (input: unknown) =>
  emailSendCodeResponseSchema.safeParse(input);
export const safeParseEmailLoginRequest = (input: unknown) =>
  emailLoginRequestSchema.safeParse(input);
export const safeParseEmailLoginResponse = (input: unknown) =>
  emailLoginResponseSchema.safeParse(input);
