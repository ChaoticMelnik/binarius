import {
  safeParseBinaryPairs,
  safeParseBrokerError,
  safeParseBrokerUser,
  safeParseCandles,
  safeParseOpenTrade,
  safeParseTradesList,
  toBinaryPair,
  toBrokerTrade,
  toBrokerUser,
  toCandle,
  toChartRequestWire,
  toOpenTrade,
  toOpenTradeRequestWire,
  type BinaryPair,
  type BrokerTrade,
  type BrokerUser,
  type Candle,
  type ChartRequest,
  type OpenTrade,
  type OpenTradeRequest,
} from '@binarius/shared';
import { BROKER_REST_TIMEOUT_MS, MAX_DETAIL_LENGTH } from '../intents/config';

// An error body longer than this is not parsed for its message: the envelope seen live is a
// few dozen characters, and a page this size is not one.
export const MAX_ERROR_BODY_CHARS = 16_384;

// Told apart by the HTTP status and the transport failure, never by the body text. Which rows
// mean "the broker refused before acting" and which mean "the outcome is unknown" is the table in
// docs/broker-rest.md -> Errors; a REST open that ends unavailable or contract_violation may have
// opened.
export const BrokerRestErrorCode = {
  // 401
  Unauthorized: 'unauthorized',
  // 429; retryAfterSec when Retry-After is an integer
  RateLimited: 'rate_limited',
  // any other 4xx
  Rejected: 'rejected',
  // 5xx, a failed or timed-out fetch, a 2xx body cut mid-flight
  Unavailable: 'unavailable',
  // a 2xx body that is not JSON or fails the schema, and any 3xx
  ContractViolation: 'contract_violation',
  // the caller's signal fired first
  Aborted: 'aborted',
} as const;
export type BrokerRestErrorCode = (typeof BrokerRestErrorCode)[keyof typeof BrokerRestErrorCode];

// Carries no cause, URL, header or body: a thrown error ends up in a log line, and any of those
// can hold the bearer token. `detail` is the broker's error message only, cut to
// MAX_DETAIL_LENGTH, for logs and never for storage.
export class BrokerRestError extends Error {
  readonly code: BrokerRestErrorCode;
  // declared, not initialized: an absent field is not an own property at all
  declare readonly status?: number;
  declare readonly retryAfterSec?: number;
  declare readonly detail?: string;

  constructor(
    code: BrokerRestErrorCode,
    fields: { status?: number; retryAfterSec?: number; detail?: string } = {},
  ) {
    super(code);
    this.name = 'BrokerRestError';
    this.code = code;
    if (fields.status !== undefined) Object.assign(this, { status: fields.status });
    if (fields.retryAfterSec !== undefined) {
      Object.assign(this, { retryAfterSec: fields.retryAfterSec });
    }
    if (fields.detail !== undefined) Object.assign(this, { detail: fields.detail });
  }
}

// The method, the path and the bearer rule travel together, so a call cannot reach one endpoint
// while being authorized as another. The keys are the mock broker's MockRestEndpoint
// (rest.test.ts checks the two agree).
export const BROKER_REST_ENDPOINTS = {
  user: { method: 'GET', path: '/v1/broker/user', bearer: true },
  pairs: { method: 'GET', path: '/v1/broker/pairs/binary', bearer: false },
  tradesList: { method: 'GET', path: '/v1/broker/user/trades', bearer: true },
  openTrade: { method: 'POST', path: '/v1/broker/user/trades', bearer: true },
  chart: { method: 'GET', path: '/v1/broker/chart', bearer: false },
} as const;
export type BrokerRestEndpoint = keyof typeof BROKER_REST_ENDPOINTS;

export const TradeListStatus = { Open: 'open', Closed: 'closed' } as const;
export type TradeListStatus = (typeof TradeListStatus)[keyof typeof TradeListStatus];

export interface TradeListFilter {
  status?: TradeListStatus;
  isDemo?: boolean;
  limit?: number;
  offset?: number;
}

export interface BrokerAuth {
  accessToken: string;
}

export interface BrokerCallOptions {
  signal?: AbortSignal;
}

export interface BrokerRestClient {
  getUser(auth: BrokerAuth, options?: BrokerCallOptions): Promise<BrokerUser>;
  listPairs(options?: BrokerCallOptions): Promise<BinaryPair[]>;
  listTrades(
    auth: BrokerAuth,
    filter?: TradeListFilter,
    options?: BrokerCallOptions,
  ): Promise<BrokerTrade[]>;
  openTrade(
    auth: BrokerAuth,
    request: OpenTradeRequest,
    options?: BrokerCallOptions,
  ): Promise<OpenTrade>;
  getChart(request: ChartRequest, options?: BrokerCallOptions): Promise<Candle[]>;
}

export interface BrokerRestClientOptions {
  baseUrl: string;
  timeoutMs?: number;
}

type SafeParse<T> = (input: unknown) => { success: true; data: T } | { success: false };

interface Call<W> {
  endpoint: BrokerRestEndpoint;
  auth?: BrokerAuth;
  query?: Record<string, string | number | boolean>;
  body?: unknown;
  signal: AbortSignal | undefined;
  parse: SafeParse<W>;
}

function statusCode(status: number): BrokerRestErrorCode {
  if (status === 401) return BrokerRestErrorCode.Unauthorized;
  if (status === 429) return BrokerRestErrorCode.RateLimited;
  if (status >= 400 && status < 500) return BrokerRestErrorCode.Rejected;
  return BrokerRestErrorCode.Unavailable;
}

function retryAfterSecOf(response: Response): number | undefined {
  const raw = response.headers.get('retry-after');
  return raw !== null && /^\d+$/.test(raw) ? Number(raw) : undefined;
}

// Any failure here leaves detail undefined: the status already decided the code.
async function detailOf(response: Response): Promise<string | undefined> {
  try {
    if (!(response.headers.get('content-type') ?? '').startsWith('application/json')) {
      await response.body?.cancel();
      return undefined;
    }
    const text = await response.text();
    if (text.length > MAX_ERROR_BODY_CHARS) return undefined;
    const parsed = safeParseBrokerError(JSON.parse(text));
    return parsed.success ? parsed.data.error.message.slice(0, MAX_DETAIL_LENGTH) : undefined;
  } catch {
    return undefined;
  }
}

export function createBrokerRestClient(options: BrokerRestClientOptions): BrokerRestClient {
  const timeoutMs = options.timeoutMs ?? BROKER_REST_TIMEOUT_MS;

  // A failure while the combined signal is aborted by the caller's own signal is the caller's
  // limit; one aborted by our timeout, or no abort at all, is the broker's unavailability. The
  // reason identifies which signal fired first, whatever happened after.
  function failure(combined: AbortSignal, signal: AbortSignal | undefined, status?: number) {
    const callerFirst =
      signal !== undefined &&
      signal.aborted &&
      combined.aborted &&
      combined.reason === signal.reason;
    return callerFirst
      ? new BrokerRestError(BrokerRestErrorCode.Aborted)
      : new BrokerRestError(BrokerRestErrorCode.Unavailable, { status });
  }

  async function send<W>(call: Call<W>): Promise<W> {
    const { method, path, bearer } = BROKER_REST_ENDPOINTS[call.endpoint];
    const url = new URL(path, options.baseUrl);
    for (const [key, value] of Object.entries(call.query ?? {})) {
      url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = { accept: 'application/json' };
    if (bearer && call.auth !== undefined) {
      headers.authorization = `Bearer ${call.auth.accessToken}`;
    }
    if (call.body !== undefined) headers['content-type'] = 'application/json';
    const timeout = AbortSignal.timeout(timeoutMs);
    // bounds the headers and the body read alike
    const combined = call.signal === undefined ? timeout : AbortSignal.any([call.signal, timeout]);

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
        // a redirect is never followed: fetch would replay a POST to the target, and whether the
        // origin acted on the request is unknowable
        redirect: 'manual',
        signal: combined,
      });
    } catch {
      throw failure(combined, call.signal);
    }

    const { status } = response;
    if (status >= 300 && status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new BrokerRestError(BrokerRestErrorCode.ContractViolation, { status });
    }
    if (status < 200 || status >= 400) {
      const code = statusCode(status);
      const retryAfterSec =
        code === BrokerRestErrorCode.RateLimited ? retryAfterSecOf(response) : undefined;
      const detail = await detailOf(response);
      throw new BrokerRestError(code, { status, retryAfterSec, detail });
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (error) {
      // a body that arrived and is not JSON breaks the contract; one cut mid-flight is transport
      if (error instanceof SyntaxError) {
        throw new BrokerRestError(BrokerRestErrorCode.ContractViolation, { status });
      }
      throw failure(combined, call.signal, status);
    }
    const parsed = call.parse(json);
    if (!parsed.success) {
      throw new BrokerRestError(BrokerRestErrorCode.ContractViolation, { status });
    }
    return parsed.data;
  }

  return {
    getUser: async (auth, callOptions) =>
      toBrokerUser(
        await send({
          endpoint: 'user',
          auth,
          signal: callOptions?.signal,
          parse: safeParseBrokerUser,
        }),
      ),
    listPairs: async (callOptions) =>
      (
        await send({ endpoint: 'pairs', signal: callOptions?.signal, parse: safeParseBinaryPairs })
      ).map(toBinaryPair),
    listTrades: async (auth, filter = {}, callOptions) => {
      const query: Record<string, string | number | boolean> = {};
      if (filter.status !== undefined) query.status = filter.status;
      if (filter.isDemo !== undefined) query.is_demo = filter.isDemo;
      if (filter.limit !== undefined) query.limit = filter.limit;
      if (filter.offset !== undefined) query.offset = filter.offset;
      const wire = await send({
        endpoint: 'tradesList',
        auth,
        query,
        signal: callOptions?.signal,
        parse: safeParseTradesList,
      });
      return wire.trades.map(toBrokerTrade);
    },
    openTrade: async (auth, request, callOptions) =>
      toOpenTrade(
        await send({
          endpoint: 'openTrade',
          auth,
          body: toOpenTradeRequestWire(request),
          signal: callOptions?.signal,
          parse: safeParseOpenTrade,
        }),
      ),
    getChart: async (request, callOptions) =>
      (
        await send({
          endpoint: 'chart',
          query: toChartRequestWire(request),
          signal: callOptions?.signal,
          parse: safeParseCandles,
        })
      ).map(toCandle),
  };
}
