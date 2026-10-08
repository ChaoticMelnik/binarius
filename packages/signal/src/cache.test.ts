import {
  SIGNAL_ALGORITHM_VERSION,
  SIGNAL_CHART_INTERVAL_MS,
  type BrokerRestErrorCode,
  type SignalInterval,
} from '@binarius/shared';
import { describe, expect, it } from 'vitest';
import { createCachedSignalFeed } from './cache';
import { DEFAULT_SIGNAL_PARAMS } from './config';
import { createSignalDecider } from './decide';
import type { SignalEvaluation, SignalFeed, SignalFeedRequest, SignalFetchFacts } from './feed';

const MINUTE = SIGNAL_CHART_INTERVAL_MS['1m'];
const HOUR = SIGNAL_CHART_INTERVAL_MS['1h'];
// a boundary of every interval in the table
const B = Math.floor(1_760_000_000_000 / HOUR) * HOUR;
const MAX_TTL_MS = 30_000;

let clock = B;
const now = () => clock;

function facts({ assetId, interval }: SignalFeedRequest): SignalFetchFacts {
  return {
    assetId,
    interval,
    intervalMs: SIGNAL_CHART_INTERVAL_MS[interval],
    nowMs: clock,
    startTime: 0,
    limit: 60,
  };
}

// what the real feed answers: the entry carries the clock reading taken before the fetch
function decided(request: SignalFeedRequest): SignalEvaluation {
  const { assetId, interval, intervalMs, nowMs } = facts(request);
  return {
    outcome: 'decided',
    entry: {
      assetId,
      interval,
      intervalMs,
      nowMs,
      fetch: { startTime: 0, limit: 60, rows: 0, durationMs: 1 },
      version: SIGNAL_ALGORITHM_VERSION,
      params: DEFAULT_SIGNAL_PARAMS,
      series: [],
      decision: {
        kind: 'no_signal',
        version: SIGNAL_ALGORITHM_VERSION,
        reason: 'insufficient_candles',
        detail: { closedCandles: 0, required: 50 },
      },
    },
  };
}

const failed =
  (code: BrokerRestErrorCode, retryAfterSec?: number) =>
  (request: SignalFeedRequest): SignalEvaluation => ({
    outcome: 'fetch_failed',
    request: facts(request),
    code,
    ...(retryAfterSec === undefined ? {} : { retryAfterSec }),
  });

type Answer = (
  request: SignalFeedRequest,
  signal: AbortSignal | undefined,
) => Promise<SignalEvaluation>;

function stubFeed(answer: Answer = (request) => Promise.resolve(decided(request))) {
  const calls: SignalFeedRequest[] = [];
  const feed: SignalFeed = {
    decider: createSignalDecider(),
    evaluate(request, options) {
      calls.push(request);
      return answer(request, options?.signal);
    },
  };
  return { feed, calls };
}

const cached = (feed: SignalFeed, maxEntries?: number) =>
  createCachedSignalFeed(feed, { fetchBudgetMs: 3_000, maxTtlMs: MAX_TTL_MS, maxEntries, now });

const at = (offsetMs: number) => {
  clock = B + offsetMs;
};

const req = (interval: SignalInterval = '1m', assetId = 101): SignalFeedRequest => ({
  assetId,
  interval,
});

function deferred() {
  let resolve!: (value: SignalEvaluation) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<SignalEvaluation>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createCachedSignalFeed', () => {
  it('C1 two calls inside one minute make one inner call and answer the same entry', async () => {
    const { feed, calls } = stubFeed();
    const cache = cached(feed);
    at(10_000);
    const first = await cache.evaluate(req());
    at(20_000);
    const second = await cache.evaluate(req());
    expect(calls).toHaveLength(1);
    expect(second).toBe(first);
  });

  it('C2 a decision is held to the end of its candle, not past it', async () => {
    const { feed, calls } = stubFeed();
    const cache = cached(feed);
    at(40_000);
    await cache.evaluate(req());
    at(MINUTE - 100);
    await cache.evaluate(req());
    expect(calls).toHaveLength(1);
    at(MINUTE);
    await cache.evaluate(req());
    expect(calls).toHaveLength(2);
  });

  it('C3 on a long interval the hold is capped at maxTtlMs', async () => {
    const { feed, calls } = stubFeed();
    const cache = cached(feed);
    at(10_000);
    await cache.evaluate(req('1h'));
    at(10_000 + MAX_TTL_MS - 1);
    await cache.evaluate(req('1h'));
    expect(calls).toHaveLength(1);
    at(10_000 + MAX_TTL_MS);
    await cache.evaluate(req('1h'));
    expect(calls).toHaveLength(2);
  });

  it('C4 concurrent calls share one inner call, and the settled result is then held', async () => {
    const gate = deferred();
    const { feed, calls } = stubFeed(() => gate.promise);
    const cache = cached(feed);
    at(5_000);
    const first = cache.evaluate(req());
    const second = cache.evaluate(req());
    expect(calls).toHaveLength(1);
    const answer = decided(req());
    gate.resolve(answer);
    expect(await first).toBe(answer);
    expect(await second).toBe(answer);
    expect(await cache.evaluate(req())).toBe(answer);
    expect(calls).toHaveLength(1);
  });

  it.each<BrokerRestErrorCode>([
    'unavailable',
    'rejected',
    'contract_violation',
    'unauthorized',
    'aborted',
    'rate_limited',
  ])('C5 fetch_failed %s without retryAfterSec is not held', async (code) => {
    const { feed, calls } = stubFeed((request) => Promise.resolve(failed(code)(request)));
    const cache = cached(feed);
    at(1_000);
    await cache.evaluate(req());
    await cache.evaluate(req());
    expect(calls).toHaveLength(2);
  });

  it('C6 rate_limited with retryAfterSec is held for it, counting down', async () => {
    const { feed, calls } = stubFeed((request) =>
      Promise.resolve(failed('rate_limited', 7)(request)),
    );
    const cache = cached(feed);
    at(1_000);
    expect(await cache.evaluate(req())).toMatchObject({ code: 'rate_limited', retryAfterSec: 7 });
    at(6_000);
    expect(await cache.evaluate(req())).toMatchObject({
      outcome: 'fetch_failed',
      code: 'rate_limited',
      retryAfterSec: 2,
    });
    at(7_999);
    expect(await cache.evaluate(req())).toMatchObject({ retryAfterSec: 1 });
    expect(calls).toHaveLength(1);
    at(8_000);
    await cache.evaluate(req());
    expect(calls).toHaveLength(2);
  });

  it('C6 a retryAfterSec above maxTtlMs is held for maxTtlMs', async () => {
    const { feed, calls } = stubFeed((request) =>
      Promise.resolve(failed('rate_limited', 90)(request)),
    );
    const cache = cached(feed);
    at(1_000);
    await cache.evaluate(req());
    at(1_000 + MAX_TTL_MS - 1);
    expect(await cache.evaluate(req())).toMatchObject({ retryAfterSec: 1 });
    expect(calls).toHaveLength(1);
    at(1_000 + MAX_TTL_MS);
    await cache.evaluate(req());
    expect(calls).toHaveLength(2);
  });

  it('C7 a throw rejects every waiter, holds nothing, and the next call fetches', async () => {
    const gate = deferred();
    let answering = false;
    const { feed, calls } = stubFeed((request) =>
      answering ? Promise.resolve(decided(request)) : gate.promise,
    );
    const cache = cached(feed);
    at(1_000);
    const first = cache.evaluate(req());
    const second = cache.evaluate(req());
    const error = new RangeError('clock');
    gate.reject(error);
    await expect(first).rejects.toBe(error);
    await expect(second).rejects.toBe(error);
    expect(calls).toHaveLength(1);
    answering = true;
    expect((await cache.evaluate(req())).outcome).toBe('decided');
    expect(calls).toHaveLength(2);
  });

  it('C7 a synchronous throw of the inner feed leaves no in-flight entry behind', async () => {
    let throwing = true;
    const { feed, calls } = stubFeed((request) => {
      if (throwing) throw new RangeError('clock');
      return Promise.resolve(decided(request));
    });
    const cache = cached(feed);
    at(1_000);
    await expect(cache.evaluate(req())).rejects.toThrow(RangeError);
    throwing = false;
    expect((await cache.evaluate(req())).outcome).toBe('decided');
    expect(calls).toHaveLength(2);
  });

  it('C8 beyond maxEntries the oldest key is dropped', async () => {
    const { feed, calls } = stubFeed();
    const cache = cached(feed, 2);
    at(1_000);
    await cache.evaluate(req('1m', 1));
    await cache.evaluate(req('1m', 2));
    await cache.evaluate(req('1m', 3));
    expect(calls).toHaveLength(3);
    await cache.evaluate(req('1m', 2));
    await cache.evaluate(req('1m', 3));
    expect(calls).toHaveLength(3);
    await cache.evaluate(req('1m', 1));
    expect(calls).toHaveLength(4);
  });

  it('C9 the inner call carries the budget: a fetch that never answers ends aborted, unheld', async () => {
    const { feed, calls } = stubFeed((request, signal) => {
      if (signal === undefined) throw new Error('the cache passed no deadline');
      return new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve(failed('aborted')(request)), { once: true });
      });
    });
    const cache = createCachedSignalFeed(feed, { fetchBudgetMs: 50, maxTtlMs: MAX_TTL_MS, now });
    at(1_000);
    expect(await cache.evaluate(req())).toMatchObject({ outcome: 'fetch_failed', code: 'aborted' });
    expect(calls).toHaveLength(1);
    await cache.evaluate(req());
    expect(calls).toHaveLength(2);
  });

  it('C10 one asset on two intervals is two keys', async () => {
    const { feed, calls } = stubFeed();
    const cache = cached(feed);
    at(1_000);
    await cache.evaluate(req('1m'));
    await cache.evaluate(req('5m'));
    await cache.evaluate(req('1m'));
    await cache.evaluate(req('5m'));
    expect(calls).toEqual([req('1m'), req('5m')]);
  });

  it('C11 a hold survives the process clock moving back', async () => {
    const { feed, calls } = stubFeed();
    const cache = cached(feed);
    at(30_000);
    await cache.evaluate(req());
    at(30_000 - HOUR);
    await cache.evaluate(req());
    expect(calls).toHaveLength(1);
  });

  // #343: the scanner at B + 500 ms must not wait for a manual fetch started before B
  it("C12 a call in the next candle does not join the previous candle's fetch", async () => {
    const pending = [deferred(), deferred()];
    const { feed, calls } = stubFeed(() => pending[calls.length - 1]!.promise);
    const cache = cached(feed);
    at(-200);
    const before = decided(req('15s'));
    const first = cache.evaluate(req('15s'));
    at(500);
    const after = decided(req('15s'));
    const second = cache.evaluate(req('15s'));
    expect(calls).toHaveLength(2);
    pending[0]!.resolve(before);
    pending[1]!.resolve(after);
    expect(await first).toBe(before);
    expect(await second).toBe(after);
  });

  it('C13 a late result of the older fetch does not replace the newer hold', async () => {
    const pending = [deferred(), deferred()];
    const { feed, calls } = stubFeed(() => pending[calls.length - 1]!.promise);
    const cache = cached(feed);
    at(-200);
    const before = decided(req('15s'));
    const first = cache.evaluate(req('15s'));
    at(500);
    const after = decided(req('15s'));
    const second = cache.evaluate(req('15s'));
    pending[1]!.resolve(after);
    await second;
    pending[0]!.resolve(before);
    await first;
    at(1_000);
    expect(await cache.evaluate(req('15s'))).toBe(after);
    expect(calls).toHaveLength(2);
  });

  it('exposes the inner decider', () => {
    const { feed } = stubFeed();
    expect(cached(feed).decider).toBe(feed.decider);
  });
});
