import { FIXTURE_MESSAGES } from './messages';

export type MockRestEndpoint = 'user' | 'pairs' | 'tradesList' | 'openTrade' | 'chart';

// one scripted answer to the next request on an endpoint, consumed before auth and validation
export type MockScript =
  | { status: number; body?: unknown; headers?: Record<string, string>; retryAfterSec?: number }
  // waits, then the request is handled as usual
  | { delayMs: number }
  // never answers until close(), which answers it 503
  | { hang: true };

// what a request looked like, without the token value or the body: a test proves what the
// client sent without the journal becoming a place secrets collect
export interface MockRequestRecord {
  method: string;
  path: string;
  endpoint?: MockRestEndpoint;
  query: Record<string, string>;
  bearer: 'none' | 'known' | 'unknown';
  bodyKeys?: string[];
  scripted: boolean;
}

const isNonNegativeInteger = (value: unknown) =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

// a script the fixture cannot play as written would test something other than what it says
export function assertScript(script: MockScript): void {
  if ('status' in script) {
    if (!Number.isInteger(script.status) || script.status < 200 || script.status > 599) {
      throw new RangeError(`failNext: status must be an integer in 200..599, got ${script.status}`);
    }
    if (script.retryAfterSec !== undefined && !isNonNegativeInteger(script.retryAfterSec)) {
      throw new RangeError(
        `failNext: retryAfterSec must be a non-negative integer, got ${script.retryAfterSec}`,
      );
    }
    return;
  }
  if ('delayMs' in script) {
    if (!isNonNegativeInteger(script.delayMs)) {
      throw new RangeError(
        `failNext: delayMs must be a non-negative integer, got ${script.delayMs}`,
      );
    }
    return;
  }
  if ('hang' in script && script.hang === true) return;
  throw new TypeError('failNext: a script is { status }, { delayMs } or { hang: true }');
}

export class FaultQueue {
  private readonly queues = new Map<MockRestEndpoint, MockScript[]>();

  push(endpoint: MockRestEndpoint, script: MockScript): void {
    assertScript(script);
    const queue = this.queues.get(endpoint);
    if (queue === undefined) this.queues.set(endpoint, [script]);
    else queue.push(script);
  }

  shift(endpoint: MockRestEndpoint): MockScript | undefined {
    return this.queues.get(endpoint)?.shift();
  }
}

// the envelope text for a scripted status without a body; none of them was seen live
export function scriptedMessage(status: number): string {
  if (status === 429) return FIXTURE_MESSAGES.tooManyRequests;
  if (status === 502 || status === 503 || status === 504)
    return FIXTURE_MESSAGES.serviceUnavailable;
  if (status >= 500) return FIXTURE_MESSAGES.internal;
  return FIXTURE_MESSAGES.requestFailed;
}

const WINDOW_MS = 60_000;

// reports x-ratelimit-* the way the live broker does (a fixed window, reset in unix seconds);
// it counts but never refuses - a 429 comes only from a script
export class RateWindow {
  private windowStart = 0;
  private count = 0;

  constructor(private readonly limit: number) {}

  hit(nowMs: number): { limit: number; remaining: number; reset: number } {
    const start = Math.floor(nowMs / WINDOW_MS) * WINDOW_MS;
    if (start !== this.windowStart) {
      this.windowStart = start;
      this.count = 0;
    }
    this.count += 1;
    return {
      limit: this.limit,
      remaining: Math.max(0, this.limit - this.count),
      reset: (start + WINDOW_MS) / 1000,
    };
  }
}
