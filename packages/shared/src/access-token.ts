import * as z from 'zod';

// POST /trading/accounts/:id/access-token (#90) — the trading worker's only way to a broker access
// token. The worker never holds the client secret or the key that decrypts stored tokens; the
// backend answers with the token alone, behind the internal bearer. Neither side logs either body.

export const ACCESS_TOKEN_PATH = '/trading/accounts/:id/access-token';
export const accessTokenPath = (accountId: string): string =>
  `/trading/accounts/${encodeURIComponent(accountId)}/access-token`;

// The route's longest path is one token exchange under the account's row lock (the backend's
// BROKER_HTTP_TIMEOUT_MS, 5 s) plus database latency. The worker uses it as its request timeout,
// and apps/backend/src/timing.ts holds the exchange inside it.
export const ACCESS_TOKEN_ROUTE_BUDGET_MS = 7_000;

// Why the backend refused to hand out a token: each holds until something changes (the user acts,
// an operator acts, the key is deployed), never because of a passing failure.
export const AccessTokenRefusal = {
  AccountNotFound: 'account_not_found',
  UserBlocked: 'user_blocked',
  AccountPending: 'account_pending',
  AccountRevoked: 'account_revoked',
  KeyUnavailable: 'key_unavailable',
  // the token needs an exchange and the caller passed mayRefresh: false
  RefreshNeeded: 'refresh_needed',
} as const;
export type AccessTokenRefusal = (typeof AccessTokenRefusal)[keyof typeof AccessTokenRefusal];
export const accessTokenRefusalSchema = z.enum(AccessTokenRefusal);

// The caller names its own exchange policy: no default, so a new caller has to decide.
export const accessTokenRequestSchema = z.strictObject({ mayRefresh: z.boolean() });
export type AccessTokenRequest = z.infer<typeof accessTokenRequestSchema>;

export const accessTokenResponseSchema = z.strictObject({ accessToken: z.string().min(1) });
export type AccessTokenResponse = z.infer<typeof accessTokenResponseSchema>;

export const accessTokenRefusalResponseSchema = z.strictObject({ error: accessTokenRefusalSchema });
export type AccessTokenRefusalResponse = z.infer<typeof accessTokenRefusalResponseSchema>;

export const safeParseAccessTokenRequest = (input: unknown) =>
  accessTokenRequestSchema.safeParse(input);
export const safeParseAccessTokenResponse = (input: unknown) =>
  accessTokenResponseSchema.safeParse(input);
export const safeParseAccessTokenRefusalResponse = (input: unknown) =>
  accessTokenRefusalResponseSchema.safeParse(input);
