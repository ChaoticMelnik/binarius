import { FIXTURE_MESSAGES } from './messages';

export type MockRestEndpoint = 'user' | 'pairs' | 'tradesList' | 'openTrade' | 'chart';

// one scripted answer to the next request on an endpoint, consumed before auth and validation.
// The shapes exclude each other in the type as well as at runtime (assertScript): a mixed
// object would be played as one shape while the test believes it scripted another.
export type MockAnswerScript = {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  retryAfterSec?: number;
  delayMs?: never;
  hang?: never;
};
type NoAnswerFields = { status?: never; body?: never; headers?: never; retryAfterSec?: never };
export type MockScript =
  | MockAnswerScript
  // waits, then the request is handled as if it arrived only then
  | ({ delayMs: number; hang?: never } & NoAnswerFields)
  // never answers until close(), which answers it 503
  | ({ hang: true; delayMs?: never } & NoAnswerFields);

export type PlayedScript =
  | { kind: 'answer'; script: MockAnswerScript }
  | { kind: 'delay'; delayMs: number }
  | { kind: 'hang' };

// what a request looked like, without the token value or the body: a test proves what the
// client sent without the journal becoming a place secrets collect
export interface MockRequestRecord {
  method: string;
  path: string;
  endpoint?: MockRestEndpoint;
  query: Record<string, string>;
  // 'pending' until the request is observed (while it waits on a delay or a hang); never left
  // after close()
  bearer: 'pending' | 'none' | 'known' | 'unknown';
  bodyKeys?: string[];
  scripted: boolean;
}

const isNonNegativeInteger = (value: unknown) =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

const DISCRIMINATORS = ['status', 'delayMs', 'hang'] as const;
const ANSWER_KEYS: ReadonlySet<string> = new Set(['status', 'body', 'headers', 'retryAfterSec']);

// the one place a script's shape is read: assertScript validates with it, the server plays by it
export function scriptKind(script: MockScript): PlayedScript {
  if (script.hang !== undefined) return { kind: 'hang' };
  if (script.delayMs !== undefined) return { kind: 'delay', delayMs: script.delayMs };
  return { kind: 'answer', script: script as MockAnswerScript };
}

// a script the fixture cannot play as written would test something other than what it says
export function assertScript(script: MockScript): void {
  if (script === null || typeof script !== 'object') {
    throw new TypeError('failNext: a script is { status }, { delayMs } or { hang: true }');
  }
  const fields = Object.entries(script).filter(([, value]) => value !== undefined);
  const present = DISCRIMINATORS.filter((key) => fields.some(([field]) => field === key));
  if (present.length !== 1) {
    throw new TypeError(
      `failNext: a script has exactly one of status, delayMs, hang; got ${present.join(', ') || 'none'}`,
    );
  }
  const [discriminator] = present;
  const allowed = (key: string) =>
    discriminator === 'status' ? ANSWER_KEYS.has(key) : key === discriminator;
  const extra = fields.map(([key]) => key).filter((key) => !allowed(key));
  if (extra.length > 0) {
    throw new TypeError(`failNext: { ${discriminator} } does not take ${extra.join(', ')}`);
  }

  const played = scriptKind(script);
  if (played.kind === 'hang') {
    if (script.hang !== true) throw new TypeError('failNext: hang must be true');
    return;
  }
  if (played.kind === 'delay') {
    if (!isNonNegativeInteger(played.delayMs)) {
      throw new RangeError(
        `failNext: delayMs must be a non-negative integer, got ${played.delayMs}`,
      );
    }
    return;
  }
  const { status, retryAfterSec } = played.script;
  if (!Number.isInteger(status) || status < 200 || status > 599) {
    throw new RangeError(`failNext: status must be an integer in 200..599, got ${status}`);
  }
  if (retryAfterSec !== undefined && !isNonNegativeInteger(retryAfterSec)) {
    throw new RangeError(
      `failNext: retryAfterSec must be a non-negative integer, got ${retryAfterSec}`,
    );
  }
}

// one-shot FIFO queues per endpoint; a script the validator refuses is never queued
export class FaultQueue<Endpoint extends string, Script> {
  private readonly queues = new Map<Endpoint, Script[]>();

  constructor(private readonly validate: (endpoint: Endpoint, script: Script) => void) {}

  push(endpoint: Endpoint, script: Script): void {
    this.validate(endpoint, script);
    const queue = this.queues.get(endpoint);
    if (queue === undefined) this.queues.set(endpoint, [script]);
    else queue.push(script);
  }

  shift(endpoint: Endpoint): Script | undefined {
    return this.queues.get(endpoint)?.shift();
  }
}

export const restFaultQueue = () =>
  new FaultQueue<MockRestEndpoint, MockScript>((_endpoint, script) => assertScript(script));

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
