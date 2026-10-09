import { pino } from 'pino';
import {
  logOptions,
  SIGNAL_ALGORITHM_VERSION,
  type BinaryPair,
  type BrokerRestErrorCode,
  type PairsCatalogView,
  type SignalDecision,
} from '@binarius/shared';
import {
  createCachedSignalFeed,
  createSignalFeed,
  DEFAULT_SIGNAL_PARAMS,
  type SignalEvaluation,
  type SignalFeedRequest,
} from '@binarius/signal';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createScanPacer, type ScanPacer } from './pacer';
import {
  createSignalScanner,
  eligiblePairs,
  freshSignals,
  SCAN_INTERVAL_MS,
  topPairs,
} from './scanner';

// a 15 s boundary
const B = 1_760_000_010_000;
const SLACK_MS = 500;
const LOG_EVERY_MS = 60_000;

const pair = (id: number, fields: Partial<BinaryPair> = {}): BinaryPair => ({
  id,
  symbol: `PAIR${id}`,
  type: 'currency',
  digits: 5,
  payout: 80,
  maxPayout: 90,
  minTimeframe: 5,
  maxTimeframe: 3600,
  scheduledUntil: 0,
  ...fields,
});

const view = (pairs: BinaryPair[], fresh = true): PairsCatalogView => ({
  pairs,
  fetchedAt: B,
  ageMs: 0,
  fresh,
});

const features = (lastCandleTimestamp: number) => ({
  emaFast: 1.1,
  emaSlow: 1.09,
  emaSlowSlope: 0.001,
  rsi: 60,
  atr: 0.001,
  atrPct: 0.05,
  lastClose: 1.1,
  lastCandleTimestamp,
  closedCandles: 59,
  trend: 'up' as const,
  momentum: 'up' as const,
  atrTicks: 100,
});

// the decision on the candle that closed at the last boundary before `nowMs`
function signal(nowMs: number): SignalDecision {
  const closed = Math.floor(nowMs / SCAN_INTERVAL_MS) * SCAN_INTERVAL_MS - SCAN_INTERVAL_MS;
  return {
    kind: 'signal',
    version: SIGNAL_ALGORITHM_VERSION,
    action: 'up',
    features: features(closed),
  };
}

function decided(request: SignalFeedRequest, decision: SignalDecision): SignalEvaluation {
  return {
    outcome: 'decided',
    entry: {
      assetId: request.assetId,
      interval: request.interval,
      digits: request.digits,
      intervalMs: SCAN_INTERVAL_MS,
      nowMs: Date.now(),
      fetch: { startTime: 0, limit: 60, rows: 0, durationMs: 1 },
      version: SIGNAL_ALGORITHM_VERSION,
      params: DEFAULT_SIGNAL_PARAMS,
      series: [],
      decision,
    },
  };
}

const failed = (
  request: SignalFeedRequest,
  code: BrokerRestErrorCode,
  retryAfterSec?: number,
): SignalEvaluation => ({
  outcome: 'fetch_failed',
  request: { ...request, intervalMs: SCAN_INTERVAL_MS, nowMs: Date.now(), startTime: 0, limit: 60 },
  code,
  ...(retryAfterSec === undefined ? {} : { retryAfterSec }),
});

type Answer = (request: SignalFeedRequest) => SignalEvaluation | Promise<SignalEvaluation>;

function harness(
  options: {
    pairs?: BinaryPair[];
    answer?: Answer;
    maxPairs?: number;
    pacer?: ScanPacer;
    // the scanner logs through a real pino logger (logOptions) into this sink instead
    sink?: (line: string) => void;
  } = {},
) {
  const state = {
    view: view(options.pairs ?? [pair(1), pair(2)]) as PairsCatalogView | undefined,
    // how far the scanner's clock reads behind the timers' clock
    skewMs: 0,
  };
  const calls: number[] = [];
  const requests: SignalFeedRequest[] = [];
  const answer: Answer = options.answer ?? ((request) => decided(request, signal(Date.now())));
  const logger = { info: vi.fn(), warn: vi.fn() };
  const scanner = createSignalScanner({
    feed: {
      evaluate: (request) => {
        calls.push(request.assetId);
        requests.push(request);
        return Promise.resolve(answer(request));
      },
    },
    catalog: { read: () => state.view },
    pacer:
      options.pacer ??
      createScanPacer({
        perMinute: 100,
        capacity: 25,
        backoffMinMs: 15_000,
        backoffMaxMs: 120_000,
        now: Date.now,
      }),
    logger: options.sink === undefined ? logger : pino(logOptions('info'), { write: options.sink }),
    now: () => Date.now() - state.skewMs,
    maxPairs: options.maxPairs ?? 25,
    slackMs: SLACK_MS,
    concurrency: 4,
    logEveryMs: LOG_EVERY_MS,
  });
  return { state, calls, requests, logger, scanner };
}

// to the scan moment of the candle that starts `candles` boundaries after B
const toScan = async (candles: number) => {
  await vi.advanceTimersByTimeAsync(B + candles * SCAN_INTERVAL_MS + SLACK_MS - Date.now());
};

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  });
  vi.setSystemTime(B + 3_000);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('signal scanner', () => {
  it('S1 nothing runs before the boundary plus the slack, then every candle', async () => {
    const h = harness();
    h.scanner.start();
    await vi.advanceTimersByTimeAsync(B + SCAN_INTERVAL_MS + SLACK_MS - 1 - Date.now());
    expect(h.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls).toEqual([1, 2]);
    await toScan(2);
    expect(h.calls).toEqual([1, 2, 1, 2]);
    await h.scanner.stop();
  });

  it('S2 only open pairs that accept a 15 s trade are scanned', () => {
    const pairs = [
      pair(1, { minTimeframe: 60 }),
      pair(2, { scheduledUntil: B + 60_000 }),
      pair(3, { maxTimeframe: 10 }),
      pair(4, { scheduledUntil: B - 1 }),
      pair(5),
    ];
    expect(eligiblePairs(view(pairs), B + 3_000).map((p) => p.id)).toEqual([4, 5]);
  });

  it('S3 the top pairs by payout, then by id', () => {
    const pairs = [
      pair(7, { payout: 80 }),
      pair(9, { payout: 90 }),
      pair(8, { payout: 90 }),
      pair(6, { payout: 70 }),
    ];
    expect(topPairs(pairs, 2)).toEqual([8, 9]);
  });

  it("S4 a catalog change between candles changes the next candle's set", async () => {
    const h = harness();
    h.scanner.start();
    await toScan(1);
    h.state.view = view([pair(3)]);
    await toScan(2);
    expect(h.calls).toEqual([1, 2, 3]);
    await h.scanner.stop();
  });

  it('S5 a scanned pair is a cache hit for POST /trading/signal in the same candle', async () => {
    const getChart = vi.fn(() => Promise.resolve([]));
    const cached = createCachedSignalFeed(
      createSignalFeed({ rest: { getChart }, logger: { info: vi.fn(), warn: vi.fn() } }),
      { fetchBudgetMs: 3_000, maxTtlMs: 30_000 },
    );
    const scanner = createSignalScanner({
      feed: cached,
      catalog: { read: () => view([pair(1)]) },
      pacer: createScanPacer({
        perMinute: 100,
        capacity: 25,
        backoffMinMs: 15_000,
        backoffMaxMs: 120_000,
        now: Date.now,
      }),
      logger: { info: vi.fn(), warn: vi.fn() },
      now: Date.now,
      maxPairs: 25,
      slackMs: SLACK_MS,
      concurrency: 4,
      logEveryMs: LOG_EVERY_MS,
    });
    scanner.start();
    await toScan(1);
    expect(getChart).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    await cached.evaluate({ assetId: 1, interval: '15s', digits: 5 });
    expect(getChart).toHaveBeenCalledTimes(1);
    await scanner.stop();
  });

  it('S5b a manual call still in flight across the boundary does not answer the scan', async () => {
    // the broker answers each chart GET after 1 s
    const getChart = vi.fn(
      () => new Promise<[]>((resolve) => setTimeout(() => resolve([]), 1_000)),
    );
    const cached = createCachedSignalFeed(
      createSignalFeed({ rest: { getChart }, logger: { info: vi.fn(), warn: vi.fn() } }),
      { fetchBudgetMs: 3_000, maxTtlMs: 30_000 },
    );
    const scanner = createSignalScanner({
      feed: cached,
      catalog: { read: () => view([pair(1)]) },
      pacer: createScanPacer({
        perMinute: 100,
        capacity: 25,
        backoffMinMs: 15_000,
        backoffMaxMs: 120_000,
        now: Date.now,
      }),
      logger: { info: vi.fn(), warn: vi.fn() },
      now: Date.now,
      maxPairs: 25,
      slackMs: SLACK_MS,
      concurrency: 4,
      logEveryMs: LOG_EVERY_MS,
    });
    scanner.start();
    await vi.advanceTimersByTimeAsync(B + SCAN_INTERVAL_MS - 200 - Date.now());
    const manual = cached.evaluate({ assetId: 1, interval: '15s', digits: 5 });
    await toScan(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await manual;
    expect(getChart).toHaveBeenCalledTimes(2);
    expect(scanner.snapshot().entries.get(1)?.decidedAtMs).toBe(B + SCAN_INTERVAL_MS + SLACK_MS);
    await scanner.stop();
  });

  it('S6 a stale or missing catalog scans nothing and warns once per streak', async () => {
    const h = harness();
    h.state.view = view([pair(1)], false);
    h.scanner.start();
    await toScan(1);
    h.state.view = undefined;
    await toScan(2);
    expect(h.calls).toEqual([]);
    expect(h.logger.warn).toHaveBeenCalledTimes(1);
    expect(h.scanner.snapshot().scanned).toEqual([]);
    h.state.view = view([pair(1)]);
    await toScan(3);
    h.state.view = view([pair(1)], false);
    await toScan(4);
    expect(h.logger.warn).toHaveBeenCalledTimes(2);
    await h.scanner.stop();
  });

  it('S7 one pair throwing or failing does not stop the others or the next candle', async () => {
    const h = harness({
      pairs: [pair(1, { payout: 90 }), pair(2, { payout: 85 }), pair(3)],
      answer: (request) => {
        if (request.assetId === 1) throw new TypeError('boom');
        if (request.assetId === 2) return failed(request, 'unavailable');
        return decided(request, signal(Date.now()));
      },
    });
    h.scanner.start();
    await toScan(1);
    expect([...h.scanner.snapshot().entries.keys()]).toEqual([3]);
    expect(h.scanner.snapshot().entries.get(3)).toMatchObject({ kind: 'signal', action: 'up' });
    expect(h.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ assetId: 1, err: { name: 'TypeError' } }),
      'signal scan failed',
    );
    await toScan(2);
    expect(h.calls).toEqual([1, 2, 3, 1, 2, 3]);
    await h.scanner.stop();
  });

  it('S8 stop() waits for the calls in flight and drops the queued ones', async () => {
    const releases: (() => void)[] = [];
    const h = harness({
      // six pairs, four in flight at once: 5 and 6 wait in the queue
      pairs: [1, 2, 3, 4, 5, 6].map((id) => pair(id, { payout: 90 - id })),
      answer: (request) =>
        new Promise((resolve) => {
          releases.push(() => resolve(decided(request, signal(Date.now()))));
        }),
    });
    h.scanner.start();
    await toScan(1);
    expect(h.calls).toEqual([1, 2, 3, 4]);
    let stopped = false;
    const stopping = h.scanner.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    for (const release of releases) release();
    await stopping;
    expect(stopped).toBe(true);
    await toScan(3);
    expect(h.calls).toEqual([1, 2, 3, 4]);
  });

  it('S9 a pair that left the top is gone from the snapshot', async () => {
    const h = harness({ pairs: [pair(1, { payout: 90 }), pair(2)], maxPairs: 1 });
    h.scanner.start();
    await toScan(1);
    expect([...h.scanner.snapshot().entries.keys()]).toEqual([1]);
    h.state.view = view([pair(1, { payout: 70 }), pair(2)]);
    await toScan(2);
    expect([...h.scanner.snapshot().entries.keys()]).toEqual([2]);
    await h.scanner.stop();
  });

  it('S10 the log line every period', async () => {
    const h = harness({
      pairs: [pair(1, { payout: 90 }), pair(2, { payout: 85 }), pair(3)],
      answer: (request) =>
        request.assetId === 2
          ? failed(request, 'unavailable')
          : decided(
              request,
              request.assetId === 3
                ? {
                    kind: 'no_signal',
                    version: SIGNAL_ALGORITHM_VERSION,
                    reason: 'insufficient_candles',
                    detail: { closedCandles: 0, required: 50 },
                  }
                : signal(Date.now()),
            ),
    });
    h.scanner.start();
    await vi.advanceTimersByTimeAsync(LOG_EVERY_MS);
    expect(h.scanner.snapshot().entries.get(3)).toMatchObject({
      kind: 'no_signal',
      reason: 'insufficient_candles',
    });
    expect(h.logger.info).toHaveBeenCalledTimes(1);
    const [fields, message] = h.logger.info.mock.calls[0] as [Record<string, unknown>, string];
    expect(message).toBe('signal scanner');
    // four candles in the minute: B+15 s, +30 s, +45 s, +60 s
    expect(fields).toEqual({
      eligible: 3,
      scanned: 3,
      signals: 1,
      noSignal: 4,
      skipped: 0,
      failed: { unavailable: 4 },
      rateLimited: 0,
      pausedMs: 0,
      lagMsP95: SLACK_MS,
    });
    await h.scanner.stop();
  });

  it('S11 a 429 pauses the scanner: the next candle sends nothing until the pause ends', async () => {
    let limited = true;
    const h = harness({
      pairs: [pair(1)],
      answer: (request) =>
        limited ? failed(request, 'rate_limited', 20) : decided(request, signal(Date.now())),
    });
    h.scanner.start();
    await toScan(1);
    limited = false;
    await toScan(2);
    expect(h.calls).toEqual([1]);
    await toScan(3);
    expect(h.calls).toEqual([1, 1]);
    await h.scanner.stop();
  });

  it('S12 a timer that fires 1 ms early still scans its candle once', async () => {
    const h = harness();
    h.scanner.start();
    // from here the scanner's clock reads 1 ms behind the timers', as on an early fire
    h.state.skewMs = 1;
    await toScan(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(h.calls).toEqual([1, 2]);
    await vi.advanceTimersByTimeAsync(B + 2 * SCAN_INTERVAL_MS + SLACK_MS + 1 - Date.now());
    expect(h.calls).toEqual([1, 2, 1, 2]);
    await h.scanner.stop();
  });

  it('S13 a scan takes no pair after its candle ended', async () => {
    const h = harness({
      pairs: [1, 2, 3, 4, 5, 6].map((id) => pair(id, { payout: 90 - id })),
      // slower than a candle: the first wave answers after the next boundary
      answer: (request) =>
        new Promise((resolve) => {
          setTimeout(() => resolve(decided(request, signal(Date.now()))), 16_000);
        }),
    });
    h.scanner.start();
    await toScan(1);
    await vi.advanceTimersByTimeAsync(16_500);
    expect(h.calls).toEqual([1, 2, 3, 4, 1, 2, 3, 4]);
    const stopping = h.scanner.stop();
    await vi.advanceTimersByTimeAsync(16_000);
    await stopping;
    expect(h.calls).toEqual([1, 2, 3, 4, 1, 2, 3, 4]);
  });

  it('S15 after a forward clock jump the candle in progress is scanned at once', async () => {
    const h = harness();
    h.scanner.start();
    // the scanner's clock reads 16 s ahead when the timer for B + 15.5 s fires
    h.state.skewMs = -16_000;
    await toScan(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(h.calls).toEqual([1, 2]);
    // the ended candle's target was not scanned at all: nothing counted as skipped for it
    await vi.advanceTimersByTimeAsync(B + 3_000 + LOG_EVERY_MS - Date.now());
    expect(h.logger.info.mock.calls[0]?.[0]).toMatchObject({ skipped: 0 });
    await h.scanner.stop();
  });

  it('S16 after the clock moved back 20 s the next scan comes within one candle', async () => {
    const h = harness();
    h.scanner.start();
    h.state.skewMs = 20_000;
    await toScan(1);
    expect(h.calls).toEqual([1, 2]);
    await vi.advanceTimersByTimeAsync(5_010);
    expect(h.calls).toEqual([1, 2, 1, 2]);
    await h.scanner.stop();
  });

  // #379: no cycle starts on a pair paying less than the floor, so the scanner neither decides
  // nor serves it; the log line's `eligible` counts the pairs at or above it
  it('S18 a pair paying 79 % is not eligible, not scanned and not served', async () => {
    const h = harness({ pairs: [pair(1, { payout: 79 }), pair(2, { payout: 80 })] });
    expect(eligiblePairs(h.state.view!, B + 3_000).map((p) => p.id)).toEqual([2]);
    h.scanner.start();
    await toScan(1);
    expect(h.calls).toEqual([2]);
    const snapshot = h.scanner.snapshot();
    expect(snapshot.scanned).toEqual([2]);
    expect(freshSignals(snapshot, Date.now()).map((s) => s.assetId)).toEqual([2]);
    await vi.advanceTimersByTimeAsync(B + 3_000 + LOG_EVERY_MS - Date.now());
    const [fields] = h.logger.info.mock.calls[0] as [Record<string, unknown>];
    expect(fields).toMatchObject({ eligible: 1, scanned: 1 });
    await h.scanner.stop();
  });

  it("S19 every evaluation carries the pair's digits from the catalog", async () => {
    const h = harness({ pairs: [pair(1, { digits: 3 }), pair(2, { digits: 7 })] });
    h.scanner.start();
    await toScan(1);
    expect(h.requests).toStrictEqual([
      { assetId: 1, interval: '15s', digits: 3 },
      { assetId: 2, interval: '15s', digits: 7 },
    ]);
    await h.scanner.stop();
  });

  it('S14 the log line counts no eligible pair while the catalog is stale', async () => {
    const h = harness();
    h.scanner.start();
    await toScan(1);
    h.state.view = view([pair(1), pair(2)], false);
    await vi.advanceTimersByTimeAsync(B + 3_000 + LOG_EVERY_MS - Date.now());
    const [fields] = h.logger.info.mock.calls[0] as [Record<string, unknown>];
    expect(fields).toMatchObject({ eligible: 0, scanned: 0 });
    await h.scanner.stop();
  });
});

describe('signal scanner logs (Rule 8)', () => {
  it('S17 the real log lines carry the error by name and code, never its message', async () => {
    const lines: string[] = [];
    const h = harness({
      pairs: [pair(1)],
      sink: (line) => void lines.push(line),
      answer: () => {
        throw new TypeError('GET https://SECRET-host/v1/broker/chart?token=SECRET-token failed');
      },
    });
    h.scanner.start();
    await vi.advanceTimersByTimeAsync(LOG_EVERY_MS);
    await h.scanner.stop();
    const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(parsed.find((line) => line.msg === 'signal scan failed')).toMatchObject({
      level: 40,
      assetId: 1,
      err: { name: 'TypeError' },
    });
    expect(parsed.find((line) => line.msg === 'signal scanner')).toMatchObject({
      failed: { threw: 4 },
    });
    expect(lines.filter((line) => line.includes('SECRET-'))).toEqual([]);
  });
});

describe('freshSignals', () => {
  const closed = B - SCAN_INTERVAL_MS;
  const entry = { kind: 'signal' as const, action: 'up' as const, decidedAtMs: B + 500 };

  it('serves a signal on the candle that closed most recently, with its age', () => {
    const snapshot = {
      scanned: [1],
      entries: new Map([[1, { ...entry, lastCandleTimestamp: closed }]]),
    };
    expect(freshSignals(snapshot, B + 2_000)).toEqual([
      { assetId: 1, action: 'up', lastCandleTimestamp: closed, decidedAt: B + 500, ageMs: 2_000 },
    ]);
  });

  it('serves nothing once the candle changed without a recompute', () => {
    const snapshot = {
      scanned: [1],
      entries: new Map([[1, { ...entry, lastCandleTimestamp: closed }]]),
    };
    expect(freshSignals(snapshot, B + SCAN_INTERVAL_MS)).toEqual([]);
  });

  it('serves nothing for a no_signal or a pair outside the scanned set', () => {
    const snapshot = {
      scanned: [1],
      entries: new Map([
        [1, { kind: 'no_signal' as const, lastCandleTimestamp: closed, decidedAtMs: B + 500 }],
        [2, { ...entry, lastCandleTimestamp: closed }],
      ]),
    };
    expect(freshSignals(snapshot, B + 2_000)).toEqual([]);
  });
});
