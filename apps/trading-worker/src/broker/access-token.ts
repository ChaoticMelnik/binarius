import {
  ACCESS_TOKEN_ROUTE_BUDGET_MS,
  AccessTokenRefusal,
  accessTokenPath,
  safeParseAccessTokenRefusalResponse,
  safeParseAccessTokenResponse,
} from '@binarius/shared';

// The worker's broker access token comes from the backend (#90): the worker holds neither the
// OAuth client secret nor the key that decrypts stored tokens. Expected failures are answers,
// never throws; a throw out of a source is a bug.

// Nothing was learned about the token: try again later.
export const AccessTokenUnavailable = {
  // fetch failed, timed out or was aborted by the caller
  BackendUnreachable: 'backend_unreachable',
  // any status the route does not answer with: 401 (our bearer is not the backend's), 400, 5xx
  BackendStatus: 'backend_status',
  // a 2xx without the token, or a 404/409 whose code the contract does not know
  ContractViolation: 'contract_violation',
  NotConfigured: 'not_configured',
} as const;
export type AccessTokenUnavailable =
  (typeof AccessTokenUnavailable)[keyof typeof AccessTokenUnavailable];

export type AccessTokenOutcome =
  | { ok: true; accessToken: string }
  // a refusal holds until something changes (AccessTokenRefusal), except refresh_rate_limited
  // (#275, temporary); `status` is the HTTP status behind a backend_status or contract_violation
  // answer
  | { ok: false; reason: AccessTokenRefusal | AccessTokenUnavailable; status?: number };

export interface AccessTokenOptions {
  signal?: AbortSignal;
  // whether the backend may exchange the refresh token for this request; default true (an action
  // the user waits on). A timer passes false.
  mayRefresh?: boolean;
  // sha256 (hashToken) of the token the broker just refused: the backend marks it expired when it
  // is still the stored one (#281). Sent only when set, so a backend that predates the field
  // still takes the body.
  refusedToken?: string;
}

export interface AccessTokenSource {
  accessToken(brokerAccountId: string, options?: AccessTokenOptions): Promise<AccessTokenOutcome>;
}

const REFUSALS: ReadonlySet<string> = new Set(Object.values(AccessTokenRefusal));
export const isAccessTokenRefusal = (reason: string): reason is AccessTokenRefusal =>
  REFUSALS.has(reason);

export const notConfiguredAccessTokenSource: AccessTokenSource = {
  accessToken: () => Promise.resolve({ ok: false, reason: AccessTokenUnavailable.NotConfigured }),
};

export interface BackendAccessTokenSourceOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
}

const unavailable = (
  reason: AccessTokenUnavailable,
  status?: number,
): Extract<AccessTokenOutcome, { ok: false }> =>
  status === undefined ? { ok: false, reason } : { ok: false, reason, status };

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

// Neither body is logged here or by a caller: the answer is a live broker token. A fetch error's
// cause is dropped, not kept: it may name the URL.
export function createBackendAccessTokenSource({
  baseUrl,
  token,
  timeoutMs = ACCESS_TOKEN_ROUTE_BUDGET_MS,
}: BackendAccessTokenSourceOptions): AccessTokenSource {
  return {
    async accessToken(brokerAccountId, { signal, mayRefresh = true, refusedToken } = {}) {
      const timeout = AbortSignal.timeout(timeoutMs);
      let status: number;
      let text: string;
      try {
        const response = await fetch(new URL(accessTokenPath(brokerAccountId), baseUrl), {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify({
            mayRefresh,
            ...(refusedToken === undefined ? {} : { refusedToken }),
          }),
          signal: signal === undefined ? timeout : AbortSignal.any([timeout, signal]),
        });
        status = response.status;
        text = await response.text();
      } catch {
        return unavailable(AccessTokenUnavailable.BackendUnreachable);
      }
      if (status >= 200 && status < 300) {
        const granted = safeParseAccessTokenResponse(parseJson(text));
        return granted.success
          ? { ok: true, accessToken: granted.data.accessToken }
          : unavailable(AccessTokenUnavailable.ContractViolation, status);
      }
      if (status === 404 || status === 409) {
        const refused = safeParseAccessTokenRefusalResponse(parseJson(text));
        return refused.success
          ? { ok: false, reason: refused.data.error }
          : unavailable(AccessTokenUnavailable.ContractViolation, status);
      }
      return unavailable(AccessTokenUnavailable.BackendStatus, status);
    },
  };
}
