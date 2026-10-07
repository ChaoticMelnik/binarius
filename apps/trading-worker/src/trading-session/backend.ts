import {
  PairsCatalogErrorCode,
  TRADING_PAIRS_PATH,
  TRADING_SIGNAL_BUDGET_MS,
  TRADING_SIGNAL_PATH,
  safeParsePairsCatalogResponse,
  safeParseTradingSignalResponse,
  type PairsCatalogResponse,
  type SignalInterval,
  type TradingSignalResponse,
} from '@binarius/shared';
import { TRADING_SESSION_PAIRS_TIMEOUT_MS } from './config';

// The session orchestrator's two reads from the backend (docs/trading-session.md -> Backend
// calls), under the internal bearer, shaped like broker/access-token.ts: expected failures are
// answers, never throws. Neither logs; the orchestrator logs the outcome codes. A fetch error's
// cause is dropped: it may name the URL.

export const BackendUnavailable = {
  // fetch failed, timed out or was aborted by the caller
  BackendUnreachable: 'backend_unreachable',
  // any status the route does not answer with
  BackendStatus: 'backend_status',
  // a body the shared schema refuses
  ContractViolation: 'contract_violation',
} as const;
export type BackendUnavailable = (typeof BackendUnavailable)[keyof typeof BackendUnavailable];

export type SignalOutcome =
  | { ok: true; response: TradingSignalResponse }
  | { ok: false; reason: BackendUnavailable; status?: number };

export type PairsOutcome =
  | { ok: true; catalog: PairsCatalogResponse }
  | {
      ok: false;
      reason: typeof PairsCatalogErrorCode.Unavailable | BackendUnavailable;
      status?: number;
    };

export interface SignalSource {
  evaluate(
    request: { assetId: number; interval: SignalInterval },
    options?: { signal?: AbortSignal },
  ): Promise<SignalOutcome>;
}

export interface PairsSource {
  read(options?: { signal?: AbortSignal }): Promise<PairsOutcome>;
}

export interface BackendSourceOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
}

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
): Promise<{ status: number; text: string } | undefined> {
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      signal: signal === undefined ? timeout : AbortSignal.any([timeout, signal]),
    });
    return { status: response.status, text: await response.text() };
  } catch {
    return undefined;
  }
}

export function createBackendSignalSource({
  baseUrl,
  token,
  timeoutMs = TRADING_SIGNAL_BUDGET_MS,
}: BackendSourceOptions): SignalSource {
  return {
    async evaluate({ assetId, interval }, { signal } = {}) {
      const answer = await call(
        new URL(TRADING_SIGNAL_PATH, baseUrl),
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify({ assetId, interval }),
        },
        timeoutMs,
        signal,
      );
      if (answer === undefined) return unavailable(BackendUnavailable.BackendUnreachable);
      if (answer.status !== 200)
        return unavailable(BackendUnavailable.BackendStatus, answer.status);
      const parsed = safeParseTradingSignalResponse(parseJson(answer.text));
      return parsed.success
        ? { ok: true, response: parsed.data }
        : unavailable(BackendUnavailable.ContractViolation, answer.status);
    },
  };
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
        const body = parseJson(answer.text) as { error?: unknown } | undefined;
        return body?.error === PairsCatalogErrorCode.Unavailable
          ? { ok: false, reason: PairsCatalogErrorCode.Unavailable }
          : unavailable(BackendUnavailable.BackendStatus, answer.status);
      }
      if (answer.status !== 200)
        return unavailable(BackendUnavailable.BackendStatus, answer.status);
      const parsed = safeParsePairsCatalogResponse(parseJson(answer.text));
      return parsed.success
        ? { ok: true, catalog: parsed.data }
        : unavailable(BackendUnavailable.ContractViolation, answer.status);
    },
  };
}
