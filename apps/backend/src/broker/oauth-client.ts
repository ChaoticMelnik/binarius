import { safeParseOAuthTokenResponse, toOAuthTokens, type OAuthTokens } from '@binarius/shared';

// One attempt per exchange, bounded by a real transport abort. Retrying is not an option:
// both the authorization code and the refresh token are single-use, so a repeat after a
// timeout either loses the pair the broker already issued or looks like a replayed token.
export const BROKER_HTTP_TIMEOUT_MS = 5_000;

export const BrokerOAuthErrorCode = {
  // the broker rejected the grant: an expired, reused or foreign code / a consumed refresh token
  InvalidGrant: 'invalid_grant',
  // 4xx other than invalid_grant: our request or configuration is wrong
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
  refresh(input: { refreshToken: string }): Promise<OAuthTokens>;
}

export interface BrokerOAuthClientOptions {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  timeoutMs?: number;
}

export function createBrokerOAuthClient(options: BrokerOAuthClientOptions): BrokerOAuthClient {
  const timeoutMs = options.timeoutMs ?? BROKER_HTTP_TIMEOUT_MS;
  const tokenUrl = new URL('/v1/broker/oauth/token', options.baseUrl).toString();

  async function post(form: Record<string, string>): Promise<OAuthTokens> {
    let response: Response;
    try {
      response = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          ...form,
          client_id: options.clientId,
          client_secret: options.clientSecret,
        }).toString(),
        // aborts the request itself: a bare timer would leave the socket open past the
        // handler and past the shutdown budget
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new BrokerOAuthError(BrokerOAuthErrorCode.Unavailable);
    }

    if (!response.ok) {
      if (response.status >= 500) {
        throw new BrokerOAuthError(BrokerOAuthErrorCode.Unavailable, response.status);
      }
      throw new BrokerOAuthError(
        (await readErrorCode(response)) === 'invalid_grant'
          ? BrokerOAuthErrorCode.InvalidGrant
          : BrokerOAuthErrorCode.Rejected,
        response.status,
      );
    }

    const body: unknown = await response.json().catch(() => undefined);
    const parsed = safeParseOAuthTokenResponse(body);
    if (!parsed.success) throw new BrokerOAuthError(BrokerOAuthErrorCode.ContractViolation);
    const tokens = toOAuthTokens(parsed.data);
    // an access token that is already expired, or one claiming to outlive the refresh token,
    // would put a nonsense expiry into the database
    if (tokens.expiresInSec <= 0 || tokens.expiresInSec > MAX_EXPIRES_IN_SEC) {
      throw new BrokerOAuthError(BrokerOAuthErrorCode.ContractViolation);
    }
    return tokens;
  }

  return {
    exchangeCode: ({ code, redirectUri }) =>
      post({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
    // the documented contract covers the authorization_code grant only; the refresh form
    // follows RFC 6749 and is falsifiable by the first real call (#8/#35)
    refresh: ({ refreshToken }) =>
      post({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  };
}

const MAX_EXPIRES_IN_SEC = 30 * 24 * 60 * 60;

// the error body is read only to tell invalid_grant from any other rejection; nothing from it
// is kept or logged
async function readErrorCode(response: Response): Promise<string | undefined> {
  const body: unknown = await response.json().catch(() => undefined);
  if (typeof body !== 'object' || body === null) return undefined;
  const { error } = body as { error?: unknown };
  return typeof error === 'string' ? error : undefined;
}
