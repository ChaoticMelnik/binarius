import type pino from 'pino';
import { hashToken } from '@binarius/db';
import {
  ACCESS_TOKEN_ROUTE_BUDGET_MS,
  AccessTokenRefusal,
  accessTokenPath,
  errorLogFields,
  readBody,
  safeParseAccessTokenRefusalResponse,
  safeParseAccessTokenResponse,
  withinDeadline,
  type FetchDeadlineLogger,
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
  // a 2xx without the token, a 404/409 whose code the contract does not know, or a body of
  // either longer than MAX_BACKEND_BODY_BYTES
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
  // is still the stored one (#281). A backend that predates the field answers 400 to it.
  refusedToken?: string | undefined;
}

export interface AccessTokenSource {
  accessToken(brokerAccountId: string, options?: AccessTokenOptions): Promise<AccessTokenOutcome>;
}

const REFUSALS: ReadonlySet<string> = new Set(Object.values(AccessTokenRefusal));
export const isAccessTokenRefusal = (reason: string): reason is AccessTokenRefusal =>
  REFUSALS.has(reason);

// A broker 401 on a token the backend handed out: its fingerprint goes back, and the backend marks
// it expired when it is still the stored one (#281). The answer is only logged - it changes
// nothing in the caller's attempt - and a throw out of the source is caught, so a sure rejection
// does not turn into a throw.
export async function reportRefusedToken(
  tokens: AccessTokenSource,
  logger: Pick<pino.Logger, 'info' | 'warn' | 'error'>,
  ids: { brokerAccountId: string; intentId?: string },
  accessToken: string,
  options: Omit<AccessTokenOptions, 'refusedToken'>,
): Promise<void> {
  try {
    const answer = await tokens.accessToken(ids.brokerAccountId, {
      ...options,
      refusedToken: hashToken(accessToken),
    });
    if (answer.ok || isAccessTokenRefusal(answer.reason)) {
      logger.info({ ...ids, answer: answer.ok ? 'ok' : answer.reason }, 'refused token reported');
      return;
    }
    // the caller's own deadline or stop() cut it: the backend may have written the mark anyway
    if (options.signal?.aborted === true) {
      logger.info(ids, 'refused token report cut');
      return;
    }
    // the backend never answered for the token: the mark may not have been written, and the next
    // 401 reports it again
    logger.warn(
      { ...ids, failure: answer.reason, status: answer.status },
      'refused token not reported',
    );
  } catch (error) {
    logger.error({ ...ids, ...errorLogFields(error) }, 'refused token report failed');
  }
}

export const notConfiguredAccessTokenSource: AccessTokenSource = {
  accessToken: () => Promise.resolve({ ok: false, reason: AccessTokenUnavailable.NotConfigured }),
};

export interface BackendAccessTokenSourceOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  // where an abandoned or late-settled request is logged
  logger?: FetchDeadlineLogger;
}

// The ceiling on the route's body, 2xx or not (Architecture Rule 26): the longest answer the
// contract has is { accessToken: <JWT> }.
export const MAX_BACKEND_BODY_BYTES = 1024 * 1024;

const unavailable = (
  reason: AccessTokenUnavailable,
  status?: number,
): Extract<AccessTokenOutcome, { ok: false }> =>
  status === undefined ? { ok: false, reason } : { ok: false, reason, status };

const isContractStatus = (status: number): boolean =>
  (status >= 200 && status < 300) || status === 404 || status === 409;

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
  logger,
}: BackendAccessTokenSourceOptions): AccessTokenSource {
  return {
    async accessToken(brokerAccountId, { signal, mayRefresh = true, refusedToken } = {}) {
      let status: number;
      let text: string | undefined;
      try {
        // the deadline holds even when fetch ignores its abort (#481); a cut call, settled or
        // abandoned, is the same unreachable backend
        ({ status, text } = await withinDeadline(
          timeoutMs,
          signal,
          async (combined) => {
            const response = await fetch(new URL(accessTokenPath(brokerAccountId), baseUrl), {
              method: 'POST',
              headers: {
                authorization: `Bearer ${token}`,
                'content-type': 'application/json',
                accept: 'application/json',
              },
              body: JSON.stringify({ mayRefresh, refusedToken }),
              signal: combined,
            });
            return {
              status: response.status,
              text: await readBody(response, MAX_BACKEND_BODY_BYTES),
            };
          },
          {
            onAbandoned: (error) =>
              logger?.error(
                { brokerAccountId, timeoutMs, ...errorLogFields(error) },
                'backend request abandoned',
              ),
            onSettledLate: (late) =>
              logger?.warn(
                late.ok
                  ? { brokerAccountId, lateMs: late.lateMs, outcome: 'ok' }
                  : {
                      brokerAccountId,
                      lateMs: late.lateMs,
                      outcome: 'error',
                      ...errorLogFields(late.error),
                    },
                'backend request settled late',
              ),
          },
        ));
      } catch {
        return unavailable(AccessTokenUnavailable.BackendUnreachable);
      }
      if (text === undefined) {
        // over the ceiling: a 2xx or a refusal status breaks the contract, whose bodies are tiny;
        // any other status was never decided by its body
        return unavailable(
          isContractStatus(status)
            ? AccessTokenUnavailable.ContractViolation
            : AccessTokenUnavailable.BackendStatus,
          status,
        );
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

export interface CachedAccessTokenSourceOptions {
  ttlMs: number;
  maxEntries: number;
  now?: () => number;
}

// The worker's token cache (#868, docs/trade-executor.md): an ok answer is reused for ttlMs, which
// is held below the backend's ACCESS_SKEW_MS (intents/config.ts), so a cached token still has time
// left when it goes out. A report of a refused token drops the entry before it asks, and an answer
// to a request that started before the drop is not stored: it may carry the refused token.
// Refusals and failures are never stored. An already aborted signal is not served from the entry,
// so such a caller gets backend_unreachable from inner as it did without the cache.
export function createCachedAccessTokenSource(
  inner: AccessTokenSource,
  { ttlMs, maxEntries, now = Date.now }: CachedAccessTokenSourceOptions,
): AccessTokenSource {
  const entries = new Map<string, { accessToken: string; expiresAt: number }>();
  // per account while it has requests at inner: a drop moves the generation on
  const inFlight = new Map<string, { requests: number; generation: number }>();

  // an entry is stored at the end, so the first one expires first: dropping it is also dropping
  // the expired ones before any live one
  function store(brokerAccountId: string, accessToken: string): void {
    entries.delete(brokerAccountId);
    if (entries.size >= maxEntries) {
      const oldest = entries.keys().next();
      if (oldest.done !== true) entries.delete(oldest.value);
    }
    entries.set(brokerAccountId, { accessToken, expiresAt: now() + ttlMs });
  }

  return {
    async accessToken(brokerAccountId, options = {}) {
      const refused = options.refusedToken !== undefined;
      if (!refused && options.signal?.aborted !== true) {
        const entry = entries.get(brokerAccountId);
        if (entry !== undefined && entry.expiresAt > now()) {
          return { ok: true, accessToken: entry.accessToken };
        }
      }
      let flight = inFlight.get(brokerAccountId);
      if (flight === undefined) {
        flight = { requests: 0, generation: 0 };
        inFlight.set(brokerAccountId, flight);
      }
      if (refused) {
        entries.delete(brokerAccountId);
        flight.generation += 1;
      }
      const generation = flight.generation;
      flight.requests += 1;
      try {
        const answer = await inner.accessToken(brokerAccountId, options);
        if (answer.ok && flight.generation === generation) {
          store(brokerAccountId, answer.accessToken);
        }
        return answer;
      } finally {
        flight.requests -= 1;
        if (flight.requests === 0) inFlight.delete(brokerAccountId);
      }
    },
  };
}
