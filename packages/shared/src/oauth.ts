import * as z from 'zod';
import { idWireSchema, toId } from './ids';
import { telegramUserIdSchema, tradeModeSchema, type TradeMode } from './trading';

// --- Token response (POST /v1/broker/oauth/token) ---------------------------------------------

export const oauthTokenResponseWireSchema = z.looseObject({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  token_type: z.string(),
  expires_in: z.int().nonnegative(),
  user: z.looseObject({
    id: idWireSchema,
    email: z.string(),
    is_partner_client: z.boolean(),
  }),
});
export type OAuthTokenResponseWire = z.infer<typeof oauthTokenResponseWireSchema>;

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresInSec: number;
  user: { id: string; email: string; isPartnerClient: boolean };
}

export function toOAuthTokens(wire: OAuthTokenResponseWire): OAuthTokens {
  return {
    accessToken: wire.access_token,
    refreshToken: wire.refresh_token,
    tokenType: wire.token_type,
    expiresInSec: wire.expires_in,
    user: {
      id: toId(wire.user.id),
      email: wire.user.email,
      isPartnerClient: wire.user.is_partner_client,
    },
  };
}

export const parseOAuthTokenResponse = (input: unknown): OAuthTokens =>
  toOAuthTokens(oauthTokenResponseWireSchema.parse(input));
export const safeParseOAuthTokenResponse = (input: unknown) =>
  oauthTokenResponseWireSchema.safeParse(input);

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
// belong to reconciliation (ARCH-04) and are never written here.
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

export const OAuthErrorCode = {
  InvalidState: 'invalid_state',
  InvalidCode: 'invalid_code',
  BrokerUnavailable: 'broker_unavailable',
  BrokerContractViolation: 'broker_contract_violation',
  BrokerAccountTaken: 'broker_account_taken',
  BrokerAccountNotFound: 'broker_account_not_found',
  AccountNotPending: 'account_not_pending',
  UserBlocked: 'user_blocked',
  TooManyRequests: 'too_many_requests',
} as const;
export type OAuthErrorCode = (typeof OAuthErrorCode)[keyof typeof OAuthErrorCode];

export const startLoginRequestSchema = z.object({ telegramUserId: telegramUserIdSchema });
export type StartLoginRequest = z.infer<typeof startLoginRequestSchema>;

export const startLoginResponseSchema = z.object({
  authorizeUrl: z.url(),
  state: z.string().min(1),
  expiresAt: z.iso.datetime({ offset: true }),
});
export type StartLoginResponse = z.infer<typeof startLoginResponseSchema>;

// the callback carries no user identity: it is public, and everything about the login lives in
// the state row the backend issued
export const oauthCallbackRequestSchema = z.object({
  state: z.string().min(1).max(256),
  code: z.string().min(1).max(512),
});
export type OAuthCallbackRequest = z.infer<typeof oauthCallbackRequestSchema>;

// allowlisted projection of broker_accounts: ciphertexts, key id and the refresh hash never
// leave the process
export const brokerAccountViewSchema = z.object({
  id: z.uuid(),
  brokerUserId: z.string().min(1),
  email: z.string().nullable(),
  isPartnerClient: z.boolean(),
  status: z.enum(['pending', 'active', 'revoked']),
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

export const safeParseStartLoginRequest = (input: unknown) =>
  startLoginRequestSchema.safeParse(input);
export const safeParseOAuthCallbackRequest = (input: unknown) =>
  oauthCallbackRequestSchema.safeParse(input);
export const safeParseConfirmLoginRequest = (input: unknown) =>
  confirmLoginRequestSchema.safeParse(input);
