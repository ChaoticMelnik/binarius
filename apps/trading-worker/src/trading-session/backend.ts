import { isDeepStrictEqual } from 'node:util';
import {
  PairsCatalogErrorCode,
  SignalFeedOutcome,
  TRADING_PAIRS_PATH,
  TRADING_SIGNAL_BUDGET_MS,
  TRADING_SIGNAL_PATH,
  readBody,
  safeParsePairsCatalogResponse,
  safeParseTradingSignalResponse,
  signalRecordSchema,
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
  // a body the shared schema refuses, or one longer than MAX_BACKEND_BODY_BYTES on a status the
  // route answers with
  ContractViolation: 'contract_violation',
} as const;
export type BackendUnavailable = (typeof BackendUnavailable)[keyof typeof BackendUnavailable];

// why a decided answer carries no record: it failed its schema, or it is not the answer's
// decision on the requested pair and interval
export type RecordProblem = 'invalid' | 'mismatch';

export type SignalOutcome =
  | { ok: true; response: TradingSignalResponse; recordProblem?: RecordProblem }
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

// The ceiling on either route's body, 200 or not (Architecture Rule 26).
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
          // the decision's record for the trade log (#666): the entry and the pair's last tick
          body: JSON.stringify({ assetId, interval, record: true }),
        },
        timeoutMs,
        signal,
      );
      if (answer === undefined) return unavailable(BackendUnavailable.BackendUnreachable);
      if (answer.status !== 200)
        return unavailable(BackendUnavailable.BackendStatus, answer.status);
      if (answer.text === undefined)
        return unavailable(BackendUnavailable.ContractViolation, answer.status);
      // the record is read apart from the answer (#666): a bad one is dropped, never refuses it
      const body = parseJson(answer.text);
      let record: unknown;
      if (isPlainObject(body) && 'record' in body) {
        ({ record } = body);
        delete body.record;
      }
      const parsed = safeParseTradingSignalResponse(body);
      if (!parsed.success) return unavailable(BackendUnavailable.ContractViolation, answer.status);
      const response = parsed.data;
      if (response.outcome !== SignalFeedOutcome.Decided || record === undefined)
        return { ok: true, response };
      const read = signalRecordSchema.safeParse(record);
      if (!read.success) return { ok: true, response, recordProblem: 'invalid' };
      const { entry } = read.data;
      if (
        !isDeepStrictEqual(entry.decision, response.decision) ||
        entry.assetId !== assetId ||
        entry.interval !== interval
      )
        return { ok: true, response, recordProblem: 'mismatch' };
      return { ok: true, response: { ...response, record: read.data } };
    },
  };
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

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
