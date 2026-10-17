import { pino } from 'pino';
import {
  logOptions,
  SIGNAL_ALGORITHM_VERSION,
  SIGNAL_CHART_INTERVAL_MS,
  type BinaryPair,
  type PairsCatalogView,
  type ScanInterval,
  type SignalDecision,
} from '@binarius/shared';
import {
  createCachedSignalFeed,
  createSignalFeed,
  DEFAULT_SIGNAL_PARAMS,
  type CachedSignalFeed,
  type CandleWindow,
  type SignalDecidedEvaluation,
  type SignalFeedRequest,
  type SignalJournalSource,
} from '@binarius/signal';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSignalScanner, eligiblePairs, freshSignals } from './scanner';

// a 15 s boundary, so a 5 s one too
const B = 1_760_000_010_000;
const CANDLE_15S_MS: number = SIGNAL_CHART_INTERVAL_MS['15s'];
const CANDLE_5S_MS: number = SIGNAL_CHART_INTERVAL_MS['5s'];
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

const boundaryOf = (nowMs: number, candleMs: number) => Math.floor(nowMs / candleMs) * candleMs;

// the decision on the candle that closed at the last boundary before `nowMs`
function signal(nowMs: number, candleMs = CANDLE_15S_MS): SignalDecision {
  return {
    kind: 'signal',
    version: SIGNAL_ALGORITHM_VERSION,
    action: 'up',
    features: features(boundaryOf(nowMs, candleMs) - candleMs),
  };
}

const noSignal = (
  reason: 'insufficient_candles' | 'candle_gap' | 'stale' = 'insufficient_candles',
): SignalDecision =>
  reason === 'insufficient_candles'
    ? {
        kind: 'no_signal',
        version: SIGNAL_ALGORITHM_VERSION,
        reason,
        detail: { closedCandles: 0, required: 50 },
      }
    : reason === 'candle_gap'
      ? {
          kind: 'no_signal',
          version: SIGNAL_ALGORITHM_VERSION,
          reason,
          detail: { index: 3, expectedTimestamp: 0, actualTimestamp: 1 },
        }
      : {
          kind: 'no_signal',
          version: SIGNAL_ALGORITHM_VERSION,
          reason,
          detail: { lastCandleTimestamp: 0, ageMs: 1, maxAgeMs: 2 },
        };

// the window closed the boundary's candle unless closedUntil says otherwise
function decided(
  request: SignalFeedRequest,
  decision: SignalDecision,
  source?: SignalJournalSource,
): SignalDecidedEvaluation {
  const intervalMs = SIGNAL_CHART_INTERVAL_MS[request.interval];
  return {
    outcome: 'decided',
    entry: {
      assetId: request.assetId,
      interval: request.interval,
      digits: request.digits,
      intervalMs,
      nowMs: Date.now(),
      source: source ?? {
        kind: 'socket',
        startTime: 0,
        closedUntil: boundaryOf(Date.now(), intervalMs),
        gaps: 0,
      },
      version: SIGNAL_ALGORITHM_VERSION,
      params: DEFAULT_SIGNAL_PARAMS,
      series: [],
      decision,
    },
  };
}

type Answer = (request: SignalFeedRequest) => SignalDecidedEvaluation | undefined;

function harness(
  options: {
    interval?: ScanInterval;
    pairs?: BinaryPair[];
    answer?: Answer;
    // a feed in place of the stub; its fromSource is what the scanner calls
    feed?: Pick<CachedSignalFeed, 'fromSource'>;
    // the scanner logs through a real pino logger (logOptions) into this sink instead
    sink?: (line: string) => void;
  } = {},
) {
  const state = {
    view: view(options.pairs ?? [pair(1), pair(2)]) as PairsCatalogView | undefined,
    // how far the scanner's clock reads behind the timers' clock
    skewMs: 0,
    streaming: true,
  };
  const interval = options.interval ?? '15s';
  const calls: number[] = [];
  const requests: SignalFeedRequest[] = [];
  const answer: Answer =
    options.answer ??
    ((request) => decided(request, signal(Date.now(), SIGNAL_CHART_INTERVAL_MS[request.interval])));
  const logger = { info: vi.fn(), warn: vi.fn() };
  const inner = options.feed;
  const scanner = createSignalScanner({
    interval,
    feed: {
      fromSource: (request) => {
        calls.push(request.assetId);
        requests.push(request);
        return inner === undefined ? answer(request) : inner.fromSource(request);
      },
    },
    catalog: { read: () => state.view },
    streaming: () => state.streaming,
    logger: options.sink === undefined ? logger : pino(logOptions('info'), { write: options.sink }),
    now: () => Date.now() - state.skewMs,
    slackMs: SLACK_MS,
    logEveryMs: LOG_EVERY_MS,
  });
  return { state, calls, requests, logger, scanner };
}

// to the scan moment of the candle that starts `candles` boundaries after B
const toScan = async (candles: number, candleMs = CANDLE_15S_MS) => {
  await vi.advanceTimersByTimeAsync(B + candles * candleMs + SLACK_MS - Date.now());
};

const summary = (h: ReturnType<typeof harness>, index = 0) =>
  h.logger.info.mock.calls[index]?.[0] as Record<string, unknown>;

// The real cached feed over a source whose window is `windowFor(assetId)`: an empty window by
// default, which decides insufficient_candles and asks for a refill. Its evaluate throws, so a
// scan that reached REST would fail the test (S30).
function realFeed(windowFor: (assetId: number, nowMs: number) => CandleWindow | undefined) {
  const getChart = vi.fn(() => Promise.reject(new Error('no GET from the scanner')));
  const refills: number[] = [];
  const cache = createCachedSignalFeed(
    createSignalFeed({
      rest: { getChart },
      source: {
        read: (assetId, _interval, nowMs) => windowFor(assetId, nowMs),
        request: (assetId) => void refills.push(assetId),
      },
      logger: { info: vi.fn(), warn: vi.fn() },
    }),
    { fetchBudgetMs: 3_000, maxTtlMs: 30_000 },
  );
  const evaluate = vi.fn<CachedSignalFeed['evaluate']>(() => {
    throw new Error('the scanner never evaluates');
  });
  const feed: CachedSignalFeed = { ...cache, fromSource: cache.fromSource, evaluate };
  return { feed, cache, getChart, evaluate, refills };
}

const emptyWindow = (nowMs: number, candleMs = CANDLE_15S_MS): CandleWindow => {
  const boundary = boundaryOf(nowMs, candleMs);
  const startTime = boundary - 299 * candleMs;
  return {
    candles: [],
    closedUntil: boundary,
    startTime,
    gaps: Array.from({ length: 299 }, (_, k) => startTime + k * candleMs),
  };
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
    await vi.advanceTimersByTimeAsync(B + CANDLE_15S_MS + SLACK_MS - 1 - Date.now());
    expect(h.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls).toEqual([1, 2]);
    await toScan(2);
    expect(h.calls).toEqual([1, 2, 1, 2]);
    await h.scanner.stop();
  });

  it('S1 a 5s scanner runs at its own boundary plus the slack, then every 5 s (#382)', async () => {
    const h = harness({ interval: '5s' });
    h.scanner.start();
    // B + 3 s: the next 5 s boundary is B + 5 s
    await vi.advanceTimersByTimeAsync(B + CANDLE_5S_MS + SLACK_MS - 1 - Date.now());
    expect(h.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls).toEqual([1, 2]);
    await toScan(2, CANDLE_5S_MS);
    expect(h.calls).toEqual([1, 2, 1, 2]);
    expect(new Set(h.requests.map((r) => r.interval))).toEqual(new Set(['5s']));
    await h.scanner.stop();
  });

  it('S2 only open pairs that accept the trade duration are scanned (#382)', () => {
    const pairs = [pair(1, { minTimeframe: 15 }), pair(2)];
    expect(eligiblePairs(view(pairs), B + 3_000, 5).map((p) => p.id)).toEqual([2]);
    expect(eligiblePairs(view(pairs), B + 3_000, 15).map((p) => p.id)).toEqual([1, 2]);
  });

  it('S2 only open pairs that accept a 15 s trade are scanned', () => {
    const pairs = [
      pair(1, { minTimeframe: 60 }),
      pair(2, { scheduledUntil: B + 60_000 }),
      pair(3, { maxTimeframe: 10 }),
      pair(4, { scheduledUntil: B - 1 }),
      pair(5),
    ];
    expect(eligiblePairs(view(pairs), B + 3_000, 15).map((p) => p.id)).toEqual([4, 5]);
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
    const real = realFeed((_, nowMs) => emptyWindow(nowMs));
    const h = harness({ pairs: [pair(1)], feed: real.cache });
    h.scanner.start();
    await toScan(1);
    const scanned = h.scanner.snapshot().entries.get(1);
    expect(scanned).toMatchObject({ kind: 'no_signal', reason: 'insufficient_candles' });
    await vi.advanceTimersByTimeAsync(5_000);
    const answered = await real.cache.evaluate({ assetId: 1, interval: '15s', digits: 5 });
    expect(answered.outcome === 'decided' && answered.entry.nowMs).toBe(scanned?.decidedAtMs);
    expect(real.getChart).not.toHaveBeenCalled();
    await h.scanner.stop();
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

  it('S7 one pair throwing does not stop the others or the next candle', async () => {
    const h = harness({
      pairs: [pair(1), pair(2), pair(3)],
      answer: (request) => {
        if (request.assetId === 1) throw new TypeError('boom');
        return decided(request, signal(Date.now()));
      },
    });
    h.scanner.start();
    await toScan(1);
    expect([...h.scanner.snapshot().entries.keys()]).toEqual([2, 3]);
    expect(h.scanner.snapshot().entries.get(3)).toMatchObject({ kind: 'signal', action: 'up' });
    expect(h.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ assetId: 1, err: { name: 'TypeError' } }),
      'signal scan failed',
    );
    await toScan(2);
    expect(h.calls).toEqual([1, 2, 3, 1, 2, 3]);
    await h.scanner.stop();
  });

  it('S8 nothing is scanned after stop()', async () => {
    const h = harness();
    h.scanner.start();
    await toScan(1);
    await h.scanner.stop();
    await toScan(3);
    expect(h.calls).toEqual([1, 2]);
  });

  it('S9 a pair that left the eligible set is gone from the snapshot', async () => {
    const h = harness({ pairs: [pair(1), pair(2)] });
    h.scanner.start();
    await toScan(1);
    expect([...h.scanner.snapshot().entries.keys()]).toEqual([1, 2]);
    h.state.view = view([pair(1, { payout: 70 }), pair(2)]);
    await toScan(2);
    expect([...h.scanner.snapshot().entries.keys()]).toEqual([2]);
    await h.scanner.stop();
  });

  it('S10 the log line every period', async () => {
    const h = harness({
      pairs: [pair(1), pair(2), pair(3)],
      answer: (request) =>
        decided(request, request.assetId === 3 ? noSignal() : signal(Date.now())),
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
      interval: '15s',
      source: 'live',
      eligible: 3,
      scanned: 3,
      signals: 2,
      decided: 12,
      noSignal: { insufficient_candles: 4 },
      unclosed: 0,
      sourceDown: 0,
      skipped: 0,
      threw: 0,
      lagMsP95: SLACK_MS,
    });
    await h.scanner.stop();
  });

  it('S10 a 5s scanner logs twelve candles a minute with its interval (#382)', async () => {
    const h = harness({
      interval: '5s',
      pairs: [pair(1)],
      answer: (request) => decided(request, noSignal()),
    });
    h.scanner.start();
    await vi.advanceTimersByTimeAsync(LOG_EVERY_MS);
    expect(summary(h)).toMatchObject({
      interval: '5s',
      scanned: 1,
      decided: 12,
      noSignal: { insufficient_candles: 12 },
    });
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
    await vi.advanceTimersByTimeAsync(B + 2 * CANDLE_15S_MS + SLACK_MS + 1 - Date.now());
    expect(h.calls).toEqual([1, 2, 1, 2]);
    await h.scanner.stop();
  });

  it('S13 a scan takes no pair after its candle ended', async () => {
    let jumped = false;
    const h = harness({
      pairs: [1, 2, 3, 4].map((id) => pair(id)),
      answer: (request) => {
        // the second decision of the first scan takes the scanner's clock past the candle's end
        if (request.assetId === 2 && !jumped) {
          jumped = true;
          h.state.skewMs = -CANDLE_15S_MS;
        }
        return decided(request, signal(Date.now()));
      },
    });
    h.scanner.start();
    await toScan(1);
    expect(h.calls).toEqual([1, 2]);
    h.state.skewMs = 0;
    await vi.advanceTimersByTimeAsync(B + 3_000 + LOG_EVERY_MS - Date.now());
    expect(summary(h)).toMatchObject({ skipped: 2 });
    await h.scanner.stop();
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
    expect(summary(h)).toMatchObject({ skipped: 0 });
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

  // #379: no cycle starts on a pair paying less than the floor, so neither scanner instance
  // decides nor serves it; the log line's `eligible` counts the pairs at or above it
  it.each([
    ['15s', 15, CANDLE_15S_MS],
    ['5s', 5, CANDLE_5S_MS],
  ] as const)(
    'S19 on the %s scanner a pair paying 79 percent is not eligible, not scanned and not served',
    async (interval, durationSec, candleMs) => {
      const h = harness({ interval, pairs: [pair(1, { payout: 79 }), pair(2, { payout: 80 })] });
      expect(eligiblePairs(h.state.view!, B + 3_000, durationSec).map((p) => p.id)).toEqual([2]);
      h.scanner.start();
      await toScan(1, candleMs);
      expect(h.calls).toEqual([2]);
      const snapshot = h.scanner.snapshot();
      expect(snapshot.scanned).toEqual([2]);
      expect(freshSignals(snapshot, Date.now()).map((s) => s.assetId)).toEqual([2]);
      await vi.advanceTimersByTimeAsync(B + LOG_EVERY_MS + candleMs - Date.now());
      expect(summary(h)).toMatchObject({ interval, eligible: 1 });
      await h.scanner.stop();
    },
  );

  it.each([
    ['15s', CANDLE_15S_MS],
    ['5s', CANDLE_5S_MS],
  ] as const)(
    "S20 on the %s scanner every decision carries the pair's digits from the catalog",
    async (interval, candleMs) => {
      const h = harness({ interval, pairs: [pair(1, { digits: 3 }), pair(2, { digits: 7 })] });
      h.scanner.start();
      await toScan(1, candleMs);
      expect(h.requests.slice(0, 2)).toStrictEqual([
        { assetId: 1, interval, digits: 3 },
        { assetId: 2, interval, digits: 7 },
      ]);
      await h.scanner.stop();
    },
  );

  it('S14 the log line counts no eligible pair while the catalog is stale', async () => {
    const h = harness();
    h.scanner.start();
    await toScan(1);
    h.state.view = view([pair(1), pair(2)], false);
    await vi.advanceTimersByTimeAsync(B + 3_000 + LOG_EVERY_MS - Date.now());
    expect(summary(h)).toMatchObject({ eligible: 0, scanned: 0 });
    await h.scanner.stop();
  });
});

// #405: the scan decides every eligible pair from the source, with no broker call
describe('signal scanner on the candle source (#405)', () => {
  it.each([
    ['15s', CANDLE_15S_MS],
    ['5s', CANDLE_5S_MS],
  ] as const)(
    'S26/S30 on %s every eligible pair is decided on each of seven candles, with no GET',
    async (interval, candleMs) => {
      const pairs = Array.from({ length: 20 }, (_, i) => pair(100 + i));
      const real = realFeed((_, nowMs) => emptyWindow(nowMs, candleMs));
      const h = harness({ interval, pairs, feed: real.feed });
      h.scanner.start();
      for (let candle = 1; candle <= 7; candle += 1) {
        await toScan(candle, candleMs);
        const snapshot = h.scanner.snapshot();
        expect(snapshot.scanned).toEqual(pairs.map((p) => p.id));
        expect(snapshot.entries.size).toBe(pairs.length);
        for (const entry of snapshot.entries.values()) {
          expect(entry.decidedAtMs).toBe(B + candle * candleMs + SLACK_MS);
        }
      }
      expect(h.calls).toHaveLength(7 * pairs.length);
      expect(real.getChart).not.toHaveBeenCalled();
      expect(real.evaluate).not.toHaveBeenCalled();
      // every empty window asked for its refill once a candle
      expect(real.refills).toHaveLength(7 * pairs.length);
      await h.scanner.stop();
    },
  );

  it('S27 a source that is not streaming clears the snapshot, warns once per streak and logs down', async () => {
    const h = harness();
    h.scanner.start();
    await toScan(1);
    expect(h.scanner.snapshot().entries.size).toBe(2);
    h.state.streaming = false;
    await toScan(2);
    await toScan(3);
    expect(h.calls).toEqual([1, 2]);
    expect(h.scanner.snapshot().scanned).toEqual([]);
    expect(h.scanner.snapshot().entries.size).toBe(0);
    expect(h.logger.warn.mock.calls).toEqual([
      [{ interval: '15s' }, 'signal scan skipped: source not streaming'],
    ]);
    await vi.advanceTimersByTimeAsync(B + 3_000 + LOG_EVERY_MS - Date.now());
    expect(summary(h)).toMatchObject({
      source: 'down',
      eligible: 0,
      scanned: 0,
      signals: 0,
      sourceDown: 3,
      decided: 2,
    });
    h.state.streaming = true;
    await toScan(6);
    h.state.streaming = false;
    await toScan(7);
    expect(h.logger.warn).toHaveBeenCalledTimes(2);
    await h.scanner.stop();
  });

  it('S27b with the source down and no catalog the line says down with no eligible pair', async () => {
    const h = harness();
    h.state.streaming = false;
    h.state.view = undefined;
    h.scanner.start();
    await vi.advanceTimersByTimeAsync(LOG_EVERY_MS);
    expect(summary(h)).toMatchObject({ source: 'down', eligible: 0, scanned: 0, sourceDown: 4 });
    expect(h.calls).toEqual([]);
    await h.scanner.stop();
  });

  it('S28 a source gone from the third pair on skips the rest and keeps the first two', async () => {
    let gone = false;
    const h = harness({
      pairs: [1, 2, 3, 4, 5].map((id) => pair(id)),
      answer: (request) => {
        if (request.assetId === 3) gone = true;
        return gone ? undefined : decided(request, signal(Date.now()));
      },
    });
    h.scanner.start();
    await toScan(1);
    expect(h.calls).toEqual([1, 2, 3]);
    expect([...h.scanner.snapshot().entries.keys()]).toEqual([1, 2]);
    await vi.advanceTimersByTimeAsync(B + 3_000 + LOG_EVERY_MS - Date.now());
    // three on the first candle, all five on each of the three after it
    expect(summary(h)).toMatchObject({ skipped: 3 + 3 * 5, decided: 2 });
    await h.scanner.stop();
  });

  it('S29 the line counts no_signal by reason and the decisions whose window had not closed the candle', async () => {
    const h = harness({
      pairs: [1, 2, 3, 4, 5].map((id) => pair(id)),
      answer: (request) => {
        const boundary = boundaryOf(Date.now(), CANDLE_15S_MS);
        switch (request.assetId) {
          case 1:
            return decided(request, noSignal('candle_gap'));
          case 2:
            return decided(request, noSignal('insufficient_candles'));
          case 3:
            return decided(request, noSignal('stale'));
          case 4:
            // the watermark has not crossed the boundary yet: the candle before is the last closed
            return decided(request, signal(Date.now()), {
              kind: 'socket',
              startTime: 0,
              closedUntil: boundary - 1,
              gaps: 0,
            });
          default:
            return decided(request, signal(Date.now()), {
              kind: 'socket',
              startTime: 0,
              closedUntil: boundary,
              gaps: 0,
            });
        }
      },
    });
    h.scanner.start();
    await vi.advanceTimersByTimeAsync(LOG_EVERY_MS);
    expect(summary(h)).toMatchObject({
      decided: 20,
      noSignal: { candle_gap: 4, insufficient_candles: 4, stale: 4 },
      unclosed: 4,
      lagMsP95: SLACK_MS,
    });
    await h.scanner.stop();
  });

  it('S31 a pair the feed throws on (digits 11) is counted threw; the others are decided', async () => {
    const real = realFeed((_, nowMs) => emptyWindow(nowMs));
    const h = harness({ pairs: [pair(1), pair(2, { digits: 11 }), pair(3)], feed: real.feed });
    h.scanner.start();
    await toScan(1);
    expect([...h.scanner.snapshot().entries.keys()]).toEqual([1, 3]);
    expect(h.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ assetId: 2, err: { name: 'RangeError' } }),
      'signal scan failed',
    );
    await vi.advanceTimersByTimeAsync(B + 3_000 + LOG_EVERY_MS - Date.now());
    expect(summary(h)).toMatchObject({ threw: 4, decided: 8 });
    await h.scanner.stop();
  });

  it('S32 after the source comes back the snapshot holds only the new scan', async () => {
    const h = harness({ pairs: [pair(1), pair(2)] });
    h.scanner.start();
    await toScan(1);
    h.state.streaming = false;
    await toScan(2);
    expect(freshSignals(h.scanner.snapshot(), Date.now())).toEqual([]);
    h.state.streaming = true;
    h.state.view = view([pair(2), pair(3)]);
    // before the first scan after the return nothing is served
    await vi.advanceTimersByTimeAsync(B + 3 * CANDLE_15S_MS + SLACK_MS - 1 - Date.now());
    expect(h.scanner.snapshot().entries.size).toBe(0);
    expect(freshSignals(h.scanner.snapshot(), Date.now())).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    const snapshot = h.scanner.snapshot();
    expect([...snapshot.entries.keys()]).toEqual([2, 3]);
    for (const entry of snapshot.entries.values()) {
      expect(entry.decidedAtMs).toBe(B + 3 * CANDLE_15S_MS + SLACK_MS);
    }
    expect(freshSignals(snapshot, Date.now()).map((s) => s.assetId)).toEqual([2, 3]);
    await h.scanner.stop();
  });

  it('S33 a snapshot of 122 pairs serves every signal on the candle closed last, and only those', async () => {
    const pairs = Array.from({ length: 122 }, (_, i) => pair(1_000 + i));
    const h = harness({
      pairs,
      answer: (request) =>
        // every third pair's window lags a candle: its signal is on an older candle
        request.assetId % 3 === 0
          ? decided(request, signal(Date.now() - CANDLE_15S_MS))
          : decided(request, signal(Date.now())),
    });
    h.scanner.start();
    await toScan(1);
    const served = freshSignals(h.scanner.snapshot(), Date.now()).map((s) => s.assetId);
    expect(served).toEqual(pairs.map((p) => p.id).filter((id) => id % 3 !== 0));
    expect(h.scanner.snapshot().scanned).toHaveLength(122);
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
    expect(parsed.find((line) => line.msg === 'signal scanner')).toMatchObject({ threw: 4 });
    expect(lines.filter((line) => line.includes('SECRET-'))).toEqual([]);
  });
});

describe('freshSignals', () => {
  const closed = B - CANDLE_15S_MS;
  const entry = { kind: 'signal' as const, action: 'up' as const, decidedAtMs: B + 500 };

  it('serves a signal on the candle that closed most recently, with its age', () => {
    const snapshot = {
      interval: '15s' as const,
      scanned: [1],
      entries: new Map([[1, { ...entry, lastCandleTimestamp: closed }]]),
    };
    expect(freshSignals(snapshot, B + 2_000)).toEqual([
      { assetId: 1, action: 'up', lastCandleTimestamp: closed, decidedAt: B + 500, ageMs: 2_000 },
    ]);
  });

  it('serves nothing once the candle changed without a recompute', () => {
    const snapshot = {
      interval: '15s' as const,
      scanned: [1],
      entries: new Map([[1, { ...entry, lastCandleTimestamp: closed }]]),
    };
    expect(freshSignals(snapshot, B + CANDLE_15S_MS)).toEqual([]);
  });

  it('serves a 5s signal on the 5 s candle closed last, and not one candle later (#382)', () => {
    const snapshot = {
      interval: '5s' as const,
      scanned: [1],
      entries: new Map([[1, { ...entry, lastCandleTimestamp: B - CANDLE_5S_MS }]]),
    };
    expect(freshSignals(snapshot, B + 2_000)).toEqual([
      {
        assetId: 1,
        action: 'up',
        lastCandleTimestamp: B - CANDLE_5S_MS,
        decidedAt: B + 500,
        ageMs: 2_000,
      },
    ]);
    expect(freshSignals(snapshot, B + CANDLE_5S_MS)).toEqual([]);
  });

  it('serves nothing for a no_signal or a pair outside the scanned set', () => {
    const snapshot = {
      interval: '15s' as const,
      scanned: [1],
      entries: new Map([
        [1, { kind: 'no_signal' as const, lastCandleTimestamp: closed, decidedAtMs: B + 500 }],
        [2, { ...entry, lastCandleTimestamp: closed }],
      ]),
    };
    expect(freshSignals(snapshot, B + 2_000)).toEqual([]);
  });
});
