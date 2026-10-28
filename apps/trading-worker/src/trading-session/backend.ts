import {
  PairsCatalogErrorCode,
  TRADING_PAIRS_PATH,
  readBody,
  safeParsePairsCatalogResponse,
  type PairsCatalogResponse,
} from '@binarius/shared';
import { TRADING_SESSION_PAIRS_TIMEOUT_MS } from './config';

// The session orchestrator's read of the pairs catalog from the backend (docs/trading-session.md
// -> Backend calls; the signal read was removed in #835), under the internal bearer, shaped like
// broker/access-token.ts: expected failures are answers, never throws. It does not log; the
// orchestrator logs the outcome codes. A fetch error's cause is dropped: it may name the URL.

export const BackendUnavailable = {
  // fetch failed, timed out or was aborted by the caller
  BackendUnreachable: 'backend_unreachable',
  // any status the route does not answer with
  BackendStatus: 'backend_status',
  // a body the shared schema refuses, or one longer than MAX_BACKEND_BODY_BYTES on a status the
  // route answers with
  ContractViolation: 'contract_violation',
} as const;
export type BackendUnavailable = (typeof BackendUnavailable)[keyof typeof BackendUnavailable];

export type PairsOutcome =
  | { ok: true; catalog: PairsCatalogResponse }
  | {
      ok: false;
      reason: typeof PairsCatalogErrorCode.Unavailable | BackendUnavailable;
      status?: number;
    };

export interface PairsSource {
  read(options?: { signal?: AbortSignal }): Promise<PairsOutcome>;
}

export interface BackendSourceOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
}

// The ceiling on the route's body, 200 or not (Architecture Rule 26).
export const MAX_BACKEND_BODY_BYTES = 1024 * 1024;

const unavailable = (reason: BackendUnavailable, status?: number) =>
  status === undefined ? { ok: false as const, reason } : { ok: false as const, reason, status };

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

async function call(
  url: URL,
  init: RequestInit,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<{ status: number; text: string | undefined } | undefined> {
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      signal: signal === undefined ? timeout : AbortSignal.any([timeout, signal]),
    });
    // text is undefined over the ceiling
    return { status: response.status, text: await readBody(response, MAX_BACKEND_BODY_BYTES) };
  } catch {
    return undefined;
  }
}

export function createBackendPairsSource({
  baseUrl,
  token,
  timeoutMs = TRADING_SESSION_PAIRS_TIMEOUT_MS,
}: BackendSourceOptions): PairsSource {
  return {
    async read({ signal } = {}) {
      const answer = await call(
        new URL(TRADING_PAIRS_PATH, baseUrl),
        {
          method: 'GET',
          headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        },
        timeoutMs,
        signal,
      );
      if (answer === undefined) return unavailable(BackendUnavailable.BackendUnreachable);
      if (answer.status === 503) {
        // the route's own 503 has a tiny body: one past the ceiling breaks the contract
        if (answer.text === undefined)
          return unavailable(BackendUnavailable.ContractViolation, answer.status);
        const body = parseJson(answer.text) as { error?: unknown } | undefined;
        return body?.error === PairsCatalogErrorCode.Unavailable
          ? { ok: false, reason: PairsCatalogErrorCode.Unavailable }
          : unavailable(BackendUnavailable.BackendStatus, answer.status);
      }
      if (answer.status !== 200)
        return unavailable(BackendUnavailable.BackendStatus, answer.status);
      if (answer.text === undefined)
        return unavailable(BackendUnavailable.ContractViolation, answer.status);
      const parsed = safeParsePairsCatalogResponse(parseJson(answer.text));
      return parsed.success
        ? { ok: true, catalog: parsed.data }
        : unavailable(BackendUnavailable.ContractViolation, answer.status);
    },
  };
}
