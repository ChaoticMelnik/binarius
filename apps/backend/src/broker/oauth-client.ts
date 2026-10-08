import {
  safeParseBrokerEmailSendCodeResponse,
  safeParseOAuthTokenResponse,
  safeParseRefreshTokenResponse,
  toOAuthTokens,
  toRefreshedTokens,
  type OAuthTokens,
  type RefreshedTokens,
} from '@binarius/shared';

// One attempt per exchange, bounded by a real transport abort. Retrying is not an option:
// both the authorization code and the refresh token are single-use, so a repeat after a
// timeout either loses the pair the broker already issued or looks like a replayed token.
export const BROKER_HTTP_TIMEOUT_MS = 5_000;

// Told apart by the HTTP status alone (`classify`): the broker's error body is free text, never
// parsed and never logged.
export const BrokerOAuthErrorCode = {
  // the broker refused the grant itself: 400 on the code exchange (an expired, reused or foreign
  // code), 401 on the refresh (an unknown or already consumed refresh token), 400 on the email
  // endpoints (an address it does not accept, a wrong or expired email code)
  InvalidGrant: 'invalid_grant',
  // any other 4xx: our request or configuration is wrong
  Rejected: 'rejected',
  // 429 on any endpoint: the broker's rate limiter refused before the request was handled;
  // nothing was consumed
  RateLimited: 'rate_limited',
  // timeout, network failure or 5xx — the outcome is unknown, the broker may have consumed it
  Unavailable: 'unavailable',
  // a 2xx body that does not match the contract
  ContractViolation: 'contract_violation',
} as const;
export type BrokerOAuthErrorCode = (typeof BrokerOAuthErrorCode)[keyof typeof BrokerOAuthErrorCode];

// Carries no response body, no request form and no cause: any of them can hold the client
// secret, the code or a token, and a thrown error ends up in a log line.
export class BrokerOAuthError extends Error {
  constructor(
    readonly code: BrokerOAuthErrorCode,
    readonly status?: number,
  ) {
    super(code);
    this.name = 'BrokerOAuthError';
  }
}

export interface BrokerOAuthClient {
  exchangeCode(input: { code: string; redirectUri: string }): Promise<OAuthTokens>;
  refresh(input: { refreshToken: string }): Promise<RefreshedTokens>;
  sendEmailCode(input: { email: string }): Promise<void>;
  emailLogin(input: { email: string; code: string; partnerCode: string }): Promise<OAuthTokens>;
}

export interface BrokerOAuthClientOptions {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  timeoutMs?: number;
}

// One row per broker endpoint: where it lives and the status it answers when it refuses the
// grant. They differ per endpoint, so one map cannot serve all; and the path and its status
// travel together, so a call cannot reach one endpoint while being classified as another.
// Observed against the live broker (docs/binodex-oauth.md -> Broker contract).
export const BROKER_ENDPOINTS = {
  token: { path: '/v1/broker/oauth/token', invalidGrantStatus: 400 },
  refresh: { path: '/v1/broker/user-auth/refresh', invalidGrantStatus: 401 },
  // 400 `Validation failed: "email" is required` for an address the broker does not accept
  sendCode: { path: '/v1/broker/user-auth/email/send-code', invalidGrantStatus: 400 },
  // 400 `Invalid or expired code`
  emailLogin: { path: '/v1/broker/user-auth/email/login', invalidGrantStatus: 400 },
} as const;
export type BrokerEndpoint = keyof typeof BROKER_ENDPOINTS;

function classify(endpoint: BrokerEndpoint, status: number): BrokerOAuthErrorCode {
  if (status >= 500) return BrokerOAuthErrorCode.Unavailable;
  if (status === 429) return BrokerOAuthErrorCode.RateLimited;
  return status === BROKER_ENDPOINTS[endpoint].invalidGrantStatus
    ? BrokerOAuthErrorCode.InvalidGrant
    : BrokerOAuthErrorCode.Rejected;
}

export function createBrokerOAuthClient(options: BrokerOAuthClientOptions): BrokerOAuthClient {
  const timeoutMs = options.timeoutMs ?? BROKER_HTTP_TIMEOUT_MS;
  const urls = Object.fromEntries(
    Object.entries(BROKER_ENDPOINTS).map(([name, { path }]) => [
      name,
      new URL(path, options.baseUrl).toString(),
    ]),
  ) as Record<BrokerEndpoint, string>;

  async function post(
    endpoint: BrokerEndpoint,
    request: { contentType: string; body: string },
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(urls[endpoint], {
        method: 'POST',
        headers: { 'content-type': request.contentType },
        body: request.body,
        // aborts the request itself: a bare timer would leave the socket open past the
        // handler and past the shutdown budget
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new BrokerOAuthError(BrokerOAuthErrorCode.Unavailable);
    }

    if (!response.ok) {
      // released unread, so the connection does not wait on a body nothing will look at
      await response.body?.cancel().catch(() => undefined);
      throw new BrokerOAuthError(classify(endpoint, response.status), response.status);
    }

    try {
      return await response.json();
    } catch (error) {
      // A body that never finished arriving is a transport failure: the broker answered 2xx,
      // so it has consumed the grant and the outcome is unknown. A body that did arrive and
      // is not JSON is the broker breaking its contract, which retrying would not fix.
      if (!(error instanceof SyntaxError)) {
        throw new BrokerOAuthError(BrokerOAuthErrorCode.Unavailable, response.status);
      }
      throw new BrokerOAuthError(BrokerOAuthErrorCode.ContractViolation, response.status);
    }
  }

  return {
    exchangeCode: async ({ code, redirectUri }) => {
      const body = await post('token', {
        contentType: 'application/x-www-form-urlencoded',
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: options.clientId,
          client_secret: options.clientSecret,
        }).toString(),
      });
      const parsed = safeParseOAuthTokenResponse(body);
      if (!parsed.success) throw new BrokerOAuthError(BrokerOAuthErrorCode.ContractViolation);
      return withSaneExpiry(toOAuthTokens(parsed.data));
    },
    // no client credentials: the refresh token alone identifies the session
    // (docs/binodex-oauth.md -> Broker contract)
    refresh: async ({ refreshToken }) => {
      const body = await post('refresh', {
        contentType: 'application/json',
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
      const parsed = safeParseRefreshTokenResponse(body);
      if (!parsed.success) throw new BrokerOAuthError(BrokerOAuthErrorCode.ContractViolation);
      return withSaneExpiry(toRefreshedTokens(parsed.data));
    },
    sendEmailCode: async ({ email }) => {
      const body = await post('sendCode', {
        contentType: 'application/json',
        body: JSON.stringify({
          client_id: options.clientId,
          client_secret: options.clientSecret,
          email,
        }),
      });
      if (!safeParseBrokerEmailSendCodeResponse(body).success) {
        throw new BrokerOAuthError(BrokerOAuthErrorCode.ContractViolation);
      }
    },
    // sent on every login, new account or existing: the broker registers a new one under it
    emailLogin: async ({ email, code, partnerCode }) => {
      const body = await post('emailLogin', {
        contentType: 'application/json',
        body: JSON.stringify({
          client_id: options.clientId,
          client_secret: options.clientSecret,
          email,
          code,
          partner_code: partnerCode,
        }),
      });
      const parsed = safeParseOAuthTokenResponse(body);
      if (!parsed.success) throw new BrokerOAuthError(BrokerOAuthErrorCode.ContractViolation);
      return withSaneExpiry(toOAuthTokens(parsed.data));
    },
  };
}

const MAX_EXPIRES_IN_SEC = 30 * 24 * 60 * 60;

// an access token that is already expired, or one claiming to outlive the refresh token, would
// put a nonsense expiry into the database
function withSaneExpiry<T extends RefreshedTokens>(tokens: T): T {
  if (tokens.expiresInSec <= 0 || tokens.expiresInSec > MAX_EXPIRES_IN_SEC) {
    throw new BrokerOAuthError(BrokerOAuthErrorCode.ContractViolation);
  }
  return tokens;
}
