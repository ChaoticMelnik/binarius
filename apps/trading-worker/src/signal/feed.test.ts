import { createBrokerRestClient, type BrokerRestClient } from '@binarius/broker-rest';
import { startMockBroker, type MockBroker } from '@binarius/mock-broker';
import { logOptions, type Candle } from '@binarius/shared';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SIGNAL_PARAMS } from './config';
import { createSignalDecider } from './decide';
import { chartWindow, createSignalFeed, type SignalEvaluation } from './feed';
import { SIGNAL_CHART_INTERVAL_MS, SIGNAL_CHART_LIMIT } from './feed-config';
import { replaySignalJournalEntry, type SignalJournalEntry } from './journal';
import { closedNow, INTERVAL_MS, seriesFrom, trending } from './testing';

// Docker's log copier reads 16 KiB per line; a longer line reaches some drivers split in two
const LOG_LINE_BUDGET = 16 * 1024;

const I = SIGNAL_CHART_INTERVAL_MS['1m'];
const B = Math.floor(1_760_000_000_000 / I) * I;
// 40 s into a minute, as the live probe of 2026-10-06 was
const T = B + 40_000;

let lines: string[] = [];
const sink = () => pino(logOptions('info'), { write: (line: string) => void lines.push(line) });
const parsedLines = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);

const stubRest = (candles: readonly Candle[]): Pick<BrokerRestClient, 'getChart'> => ({
  getChart: () => Promise.resolve(candles.map((candle) => ({ ...candle }))),
});

function decided(result: SignalEvaluation): SignalJournalEntry {
  if (result.outcome !== 'decided') throw new Error(`expected decided, got ${result.outcome}`);
  return result.entry;
}

let broker: MockBroker;

beforeEach(async () => {
  lines = [];
  broker = await startMockBroker();
});

afterEach(async () => {
  vi.useRealTimers();
  await broker.close();
});

describe('chartWindow', () => {
  it('F1 the window is limit candle starts ending on the current boundary', () => {
    const inside = chartWindow(B + 17_000, I, SIGNAL_CHART_LIMIT);
    expect(inside).toStrictEqual({
      startTime: B - (SIGNAL_CHART_LIMIT - 1) * I,
      limit: SIGNAL_CHART_LIMIT,
    });
    expect(inside.startTime + (SIGNAL_CHART_LIMIT - 1) * I).toBe(B);
    expect(chartWindow(B, I, SIGNAL_CHART_LIMIT)).toStrictEqual(inside);
    expect(chartWindow(B + 17_000, I, 1)).toStrictEqual({ startTime: B, limit: 1 });
  });
});

describe('createSignalFeed', () => {
  it('F2 on the mock broker: one chart request, one decision line that replays to the decision', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T);
    const feed = createSignalFeed({
      rest: createBrokerRestClient({ baseUrl: broker.url }),
      logger: sink(),
    });

    const entry = decided(await feed.evaluate({ assetId: 101, interval: '1m' }));

    const { startTime } = chartWindow(T, I, SIGNAL_CHART_LIMIT);
    expect(entry.fetch).toMatchObject({ startTime, limit: SIGNAL_CHART_LIMIT });
    // the fixture includes the forming candle, as the live chart does
    expect(entry.fetch.rows).toBe(SIGNAL_CHART_LIMIT);
    expect(entry.series).toHaveLength(SIGNAL_CHART_LIMIT);
    expect(entry.series.at(-1)?.[0]).toBe(B);
    expect(entry.series[0]?.[0]).toBe(B - (SIGNAL_CHART_LIMIT - 1) * I);
    expect('features' in entry.decision && entry.decision.features.closedCandles).toBe(
      SIGNAL_CHART_LIMIT - 1,
    );

    expect(broker.rest.journal).toHaveLength(1);
    expect(broker.rest.journal[0]).toMatchObject({
      endpoint: 'chart',
      bearer: 'none',
      query: {
        asset_id: '101',
        interval: '1m',
        limit: String(SIGNAL_CHART_LIMIT),
        start_time: String(startTime),
      },
    });

    const logged = parsedLines();
    expect(logged).toHaveLength(1);
    const [line] = logged as [Record<string, unknown> & { signal: SignalJournalEntry }];
    expect(line).toMatchObject({ level: 30, msg: 'signal decision' });
    expect(line.signal).toStrictEqual(JSON.parse(JSON.stringify(entry)));
    expect(line.signal.nowMs).toBe(T);
    expect(line.signal.params).toStrictEqual(DEFAULT_SIGNAL_PARAMS);
    expect(line.signal.version).toBe('v1');
    expect(replaySignalJournalEntry(line.signal)).toStrictEqual(entry.decision);
    expect(lines[0]).not.toContain('[Redacted]');
    expect(lines[0]).not.toContain(broker.url);
  });

  it.each([
    {
      script: { status: 429, retryAfterSec: 7 },
      code: 'rate_limited',
      retryAfterSec: 7,
      detail: 'Too many requests',
    },
    {
      script: { status: 400, body: { error: { message: 'Unsupported interval 60' } } },
      code: 'rejected',
      detail: 'Unsupported interval 60',
    },
    { script: { status: 503 }, code: 'unavailable', detail: 'Service unavailable' },
  ])(
    'F3 HTTP $script.status is fetch_failed $code and one warn line',
    async ({ script, code, retryAfterSec, detail }) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(T);
      broker.rest.failNext('chart', script);
      const feed = createSignalFeed({
        rest: createBrokerRestClient({ baseUrl: broker.url }),
        logger: sink(),
      });

      const result = await feed.evaluate({ assetId: 101, interval: '1m' });

      const request = {
        assetId: 101,
        interval: '1m',
        intervalMs: I,
        nowMs: T,
        ...chartWindow(T, I, SIGNAL_CHART_LIMIT),
      };
      expect(result).toStrictEqual({
        outcome: 'fetch_failed',
        request,
        code,
        status: script.status,
        ...(retryAfterSec === undefined ? {} : { retryAfterSec }),
      });

      const logged = parsedLines();
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatchObject({
        level: 40,
        msg: 'signal fetch failed',
        err: { name: 'BrokerRestError', code },
        status: script.status,
        signal: request,
      });
      expect(logged[0]?.retryAfterSec).toBe(retryAfterSec);
      expect(logged[0]?.detail).toBe(detail);
      expect(logged[0]?.signal).not.toHaveProperty('series');
      expect(logged[0]?.signal).not.toHaveProperty('decision');
      expect(lines[0]).not.toContain(broker.url);
    },
  );

  it('F3b a broker that is not listening is fetch_failed unavailable', async () => {
    const closed = await startMockBroker();
    const baseUrl = closed.url;
    await closed.close();
    const feed = createSignalFeed({ rest: createBrokerRestClient({ baseUrl }), logger: sink() });

    const result = await feed.evaluate({ assetId: 101, interval: '1m' });

    expect(result).toMatchObject({ outcome: 'fetch_failed', code: 'unavailable' });
    expect(parsedLines()).toMatchObject([{ level: 40, msg: 'signal fetch failed' }]);
  });

  it('F3c an already aborted signal is fetch_failed aborted and nothing is sent', async () => {
    const feed = createSignalFeed({
      rest: createBrokerRestClient({ baseUrl: broker.url }),
      logger: sink(),
    });

    const result = await feed.evaluate(
      { assetId: 101, interval: '1m' },
      { signal: AbortSignal.abort() },
    );

    expect(result).toMatchObject({ outcome: 'fetch_failed', code: 'aborted' });
    expect(broker.rest.journal).toHaveLength(0);
    expect(parsedLines()).toMatchObject([{ level: 40, msg: 'signal fetch failed' }]);
  });

  it('F4 an error that is not a BrokerRestError propagates and logs nothing', async () => {
    const thrown = new TypeError('programmer error');
    const feed = createSignalFeed({
      rest: { getChart: () => Promise.reject(thrown) },
      logger: sink(),
    });

    await expect(feed.evaluate({ assetId: 101, interval: '1m' })).rejects.toBe(thrown);
    expect(lines).toHaveLength(0);
  });

  it('F5 a broken clock throws before any broker call', async () => {
    const feed = createSignalFeed({
      rest: createBrokerRestClient({ baseUrl: broker.url }),
      logger: sink(),
      now: () => Number.NaN,
    });

    await expect(feed.evaluate({ assetId: 101, interval: '1m' })).rejects.toThrow(RangeError);
    expect(broker.rest.journal).toHaveLength(0);
    expect(lines).toHaveLength(0);
  });

  it('F6 a decider that needs more closed candles than the window gives is refused at construction', () => {
    const tooMany = SIGNAL_CHART_LIMIT - 1 - DEFAULT_SIGNAL_PARAMS.maxStaleIntervals + 1;
    const decider = createSignalDecider({ ...DEFAULT_SIGNAL_PARAMS, minClosedCandles: tooMany });
    expect(() => createSignalFeed({ rest: stubRest([]), decider, logger: sink() })).toThrow(
      RangeError,
    );
  });

  const rising = trending(60, 0.5);
  const flat = seriesFrom(Array<number>(60).fill(100), { wick: 0 });
  const gap = trending(61, 0.5).filter((_, i) => i !== 30);
  const few = trending(10, 0.5);
  const nanCloses = Array.from({ length: 60 }, (_, i) => 100 + 0.5 * i);
  nanCloses[40] = Number.NaN;
  const nan = seriesFrom(nanCloses);
  const staleNow = closedNow(rising) + (DEFAULT_SIGNAL_PARAMS.maxStaleIntervals + 1) * INTERVAL_MS;

  it.each([
    ['a rising series', rising, closedNow(rising), { kind: 'signal', action: 'up' }],
    ['a flat series', flat, closedNow(flat), { reason: 'volatility_too_low' }],
    ['a missing candle', gap, closedNow(gap), { reason: 'candle_gap' }],
    [
      'a clock three intervals on',
      rising,
      staleNow,
      {
        reason: 'stale',
        detail: {
          lastCandleTimestamp: rising.at(-1)?.timestamp,
          ageMs: staleNow - ((rising.at(-1)?.timestamp ?? 0) + INTERVAL_MS),
          maxAgeMs: DEFAULT_SIGNAL_PARAMS.maxStaleIntervals * INTERVAL_MS,
        },
      },
    ],
    ['ten candles', few, closedNow(few), { reason: 'insufficient_candles' }],
    ['a non-finite price', nan, closedNow(nan), { reason: 'invalid_candle' }],
  ] as const)(
    'F7 %s is journaled with the nowMs it was decided at',
    async (_, candles, nowMs, expected) => {
      const feed = createSignalFeed({ rest: stubRest(candles), logger: sink(), now: () => nowMs });

      const entry = decided(await feed.evaluate({ assetId: 101, interval: '1m' }));

      expect(entry.decision).toMatchObject(expected);
      expect(replaySignalJournalEntry(entry)).toStrictEqual(entry.decision);
    },
  );

  it('F8 volume is not journaled and does not change the decision', async () => {
    const plain = trending(60, 0.5);
    const withVolume = plain.map((candle, i) => ({ ...candle, volume: 1000 + i }));
    const nowMs = closedNow(plain);
    const evaluate = async (candles: readonly Candle[]) =>
      decided(
        await createSignalFeed({
          rest: stubRest(candles),
          logger: sink(),
          now: () => nowMs,
        }).evaluate({ assetId: 101, interval: '1m' }),
      );

    const entry = await evaluate(withVolume);

    expect(entry.series.every((tuple) => tuple.length === 5)).toBe(true);
    expect(entry.decision).toStrictEqual((await evaluate(plain)).decision);
  });

  it('F9 a decision line at the worst-case float width stays under the log line budget', async () => {
    // dividing by 3 and multiplying by one ulp above 3 pushes every price off its short decimal
    const closes = Array.from(
      { length: SIGNAL_CHART_LIMIT },
      (_, i) => ((0.64 + i / 3e5) / 3) * 3.0000000000000004,
    );
    const candles = seriesFrom(closes, { wick: 1 / 3e4 });
    const prices = candles.flatMap(({ open, high, low, close }) => [open, high, low, close]);
    // "0." and 16 or more digits: the longest a price below 1 prints
    expect(prices.filter((price) => String(price).length < 18)).toEqual([]);
    const feed = createSignalFeed({
      rest: stubRest(candles),
      logger: sink(),
      now: () => closedNow(candles),
    });

    await feed.evaluate({ assetId: 101, interval: '1m' });

    expect(lines).toHaveLength(1);
    expect(lines[0]?.length).toBeLessThan(LOG_LINE_BUDGET);
  });
});
