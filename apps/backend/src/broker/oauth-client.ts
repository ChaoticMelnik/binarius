import {
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
  // code), 401 on the refresh (an unknown or already consumed refresh token)
  InvalidGrant: 'invalid_grant',
  // any other 4xx: our request or configuration is wrong
  Rejected: 'rejected',
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
}

export interface BrokerOAuthClientOptions {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  timeoutMs?: number;
}

// The status each endpoint answers when it refuses the grant; the two differ, so one map cannot
// serve both. Observed against the live broker (docs/binodex-oauth.md -> Broker contract).
const INVALID_GRANT_STATUS = {
  token: 400,
  refresh: 401,
} as const;
type BrokerEndpoint = keyof typeof INVALID_GRANT_STATUS;

function classify(endpoint: BrokerEndpoint, status: number): BrokerOAuthErrorCode {
  if (status >= 500) return BrokerOAuthErrorCode.Unavailable;
  return status === INVALID_GRANT_STATUS[endpoint]
    ? BrokerOAuthErrorCode.InvalidGrant
    : BrokerOAuthErrorCode.Rejected;
}

export function createBrokerOAuthClient(options: BrokerOAuthClientOptions): BrokerOAuthClient {
  const timeoutMs = options.timeoutMs ?? BROKER_HTTP_TIMEOUT_MS;
  const tokenUrl = new URL('/v1/broker/oauth/token', options.baseUrl).toString();
  const refreshUrl = new URL('/v1/broker/user-auth/refresh', options.baseUrl).toString();

  async function post(
    endpoint: BrokerEndpoint,
    url: string,
    request: { contentType: string; body: string },
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(url, {
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
      const body = await post('token', tokenUrl, {
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
      const body = await post('refresh', refreshUrl, {
        contentType: 'application/json',
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
      const parsed = safeParseRefreshTokenResponse(body);
      if (!parsed.success) throw new BrokerOAuthError(BrokerOAuthErrorCode.ContractViolation);
      return withSaneExpiry(toRefreshedTokens(parsed.data));
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
