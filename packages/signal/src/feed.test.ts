import {
  BrokerRestError,
  createBrokerRestClient,
  type BrokerRestClient,
} from '@binarius/broker-rest';
import { startMockBroker, type MockBroker } from '@binarius/mock-broker';
import { logOptions, SIGNAL_CHART_INTERVAL_MS, type Candle } from '@binarius/shared';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SIGNAL_PARAMS } from './config';
import { createSignalDecider } from './decide';
import { chartWindow, createSignalFeed, type SignalEvaluation } from './feed';
import { SIGNAL_CHART_LIMIT, SIGNAL_FETCH_LIMIT, SIGNAL_PACER_RETRY_SEC } from './feed-config';
import { replaySignalJournalEntry, type SignalJournalEntry } from './journal';
import type { CandleWindow, SignalCandleSource, SignalRestPacer } from './source';
import { closedNow, INTERVAL_MS, mildRise, seriesFrom, tickSeries, trending } from './testing';

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

    const entry = decided(await feed.evaluate({ assetId: 101, interval: '1m', digits: 5 }));

    const { startTime } = chartWindow(T, I, SIGNAL_FETCH_LIMIT);
    expect(entry.source).toMatchObject({ kind: 'rest', startTime, limit: SIGNAL_FETCH_LIMIT });
    // the fixture includes the forming candle, as the live chart does
    expect(entry.source).toMatchObject({ rows: SIGNAL_FETCH_LIMIT });
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
        limit: String(SIGNAL_FETCH_LIMIT),
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
    expect(line.signal.version).toBe('v2');
    expect(line.signal.digits).toBe(5);
    expect(replaySignalJournalEntry(line.signal)).toStrictEqual(entry.decision);
    expect(lines[0]).not.toContain('[Redacted]');
    expect(lines[0]).not.toContain(broker.url);
  });

  // #313: the demo's 5 and 15 s trades are analysed on their own candles; the window still
  // counts candles, so it spans SIGNAL_FETCH_LIMIT steps of the short interval
  it.each(['5s', '15s'] as const)(
    'F2b on the mock broker a %s evaluation asks %s candles and is decided',
    async (interval) => {
      const step = SIGNAL_CHART_INTERVAL_MS[interval];
      const now = Math.floor(T / step) * step + 2_000;
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(now);
      const feed = createSignalFeed({
        rest: createBrokerRestClient({ baseUrl: broker.url }),
        logger: sink(),
      });

      const entry = decided(await feed.evaluate({ assetId: 202, interval, digits: 2 }));

      const { startTime } = chartWindow(now, step, SIGNAL_FETCH_LIMIT);
      expect(broker.rest.journal[0]?.query).toMatchObject({
        asset_id: '202',
        interval,
        start_time: String(startTime),
      });
      expect(entry.series).toHaveLength(SIGNAL_CHART_LIMIT);
      expect((entry.series.at(-1)?.[0] ?? 0) - (entry.series.at(-2)?.[0] ?? 0)).toBe(step);
      expect(entry.series.at(-1)?.[0]).toBe(Math.floor(now / step) * step);
      expect(parsedLines()[0]).toMatchObject({ msg: 'signal decision', signal: { interval } });
    },
  );

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

      const result = await feed.evaluate({ assetId: 101, interval: '1m', digits: 5 });

      const request = {
        assetId: 101,
        interval: '1m',
        intervalMs: I,
        nowMs: T,
        ...chartWindow(T, I, SIGNAL_FETCH_LIMIT),
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

    const result = await feed.evaluate({ assetId: 101, interval: '1m', digits: 5 });

    expect(result).toMatchObject({ outcome: 'fetch_failed', code: 'unavailable' });
    expect(parsedLines()).toMatchObject([{ level: 40, msg: 'signal fetch failed' }]);
  });

  it('F3c an already aborted signal is fetch_failed aborted and nothing is sent', async () => {
    const feed = createSignalFeed({
      rest: createBrokerRestClient({ baseUrl: broker.url }),
      logger: sink(),
    });

    const result = await feed.evaluate(
      { assetId: 101, interval: '1m', digits: 5 },
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

    await expect(feed.evaluate({ assetId: 101, interval: '1m', digits: 5 })).rejects.toBe(thrown);
    expect(lines).toHaveLength(0);
  });

  it('F5 a broken clock throws before any broker call', async () => {
    const feed = createSignalFeed({
      rest: createBrokerRestClient({ baseUrl: broker.url }),
      logger: sink(),
      now: () => Number.NaN,
    });

    await expect(feed.evaluate({ assetId: 101, interval: '1m', digits: 5 })).rejects.toThrow(
      RangeError,
    );
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

  const rising = mildRise();
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

      const entry = decided(await feed.evaluate({ assetId: 101, interval: '1m', digits: 5 }));

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
        }).evaluate({ assetId: 101, interval: '1m', digits: 5 }),
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

    await feed.evaluate({ assetId: 101, interval: '1m', digits: 5 });

    expect(lines).toHaveLength(1);
    expect(lines[0]?.length).toBeLessThan(LOG_LINE_BUDGET);
  });

  // 2e25e081's one-step drift: the request's digits decide the tick floor, and the line keeps them
  it.each([
    [5, 'volatility_below_tick_floor'],
    [7, 'rsi_overbought'],
  ])('F10 the line carries digits %i and replays to %s', async (digits, reason) => {
    const candles = tickSeries(0.0124, 5);
    const feed = createSignalFeed({
      rest: stubRest(candles),
      logger: sink(),
      now: () => closedNow(candles),
    });

    const entry = decided(await feed.evaluate({ assetId: 101, interval: '1m', digits }));

    const [line] = parsedLines() as [{ signal: SignalJournalEntry }];
    expect(line.signal.digits).toBe(digits);
    expect(entry.decision).toMatchObject({ reason });
    expect(replaySignalJournalEntry(line.signal)).toStrictEqual(entry.decision);
  });

  it.each([-1, 11])('F11 digits %i throw before any broker call', async (digits) => {
    const getChart = vi.fn(() => Promise.resolve(trending(60, 0.5)));
    const feed = createSignalFeed({ rest: { getChart }, logger: sink() });
    await expect(feed.evaluate({ assetId: 101, interval: '1m', digits })).rejects.toThrow(
      RangeError,
    );
    expect(getChart).not.toHaveBeenCalled();
  });

  // #482: the broker is asked SIGNAL_FETCH_LIMIT rows; the decision and its journal series are the
  // rows a fetch of SIGNAL_CHART_LIMIT with the same right edge returns, cut by time. nowMs = T is
  // inside the candle starting at B, so that fetch starts at B - 59 * I.
  describe('F12 the decision window of a 300-row response', () => {
    const W0 = B - 59 * I;
    const starts = (from: number, to: number) =>
      Array.from({ length: (to - from) / I + 1 }, (_, k) => from + k * I);
    // aligned rows up to and including `last`, 300 starts back from B
    const answer = (last: number, missing: readonly number[] = []) =>
      mildRise(SIGNAL_FETCH_LIMIT - 45, { start: B - 299 * I }).filter(
        ({ timestamp }) => timestamp <= last && !missing.includes(timestamp),
      );
    const run = async (candles: readonly Candle[]) =>
      decided(
        await createSignalFeed({ rest: stubRest(candles), logger: sink(), now: () => T }).evaluate({
          assetId: 101,
          interval: '1m',
          digits: 5,
        }),
      );
    const seriesStarts = (entry: SignalJournalEntry) =>
      entry.series.map(([timestamp]) => timestamp);

    it('a: no forming candle leaves 59 rows from B - 59 I', async () => {
      const entry = await run(answer(B - I));
      expect(entry.source).toMatchObject({ kind: 'rest', rows: 299 });
      expect(seriesStarts(entry)).toStrictEqual(starts(W0, B - I));
      expect(entry.series).toHaveLength(59);
    });

    it.each([
      [1, 58],
      [2, 57],
    ])('b: %i late closed candles leave %i rows, none before B - 59 I', async (late, rows) => {
      const entry = await run(answer(B - (1 + late) * I));
      expect(seriesStarts(entry)).toStrictEqual(starts(W0, B - (1 + late) * I));
      expect(entry.series).toHaveLength(rows);
    });

    it('c: a gap just before the window is not candle_gap; the decision is the one of case a', async () => {
      const entry = await run(answer(B - I, [B - 60 * I]));
      expect(seriesStarts(entry)).toStrictEqual(starts(W0, B - I));
      expect(entry.decision).not.toMatchObject({ reason: 'candle_gap' });
      expect(entry.decision).toStrictEqual((await run(answer(B - I))).decision);
    });

    it('d: a gap inside the window is candle_gap at the index a 60-row fetch gives', async () => {
      const entry = await run(answer(B, [B - 30 * I]));
      expect(entry.series).toHaveLength(59);
      expect(entry.decision).toMatchObject({
        reason: 'candle_gap',
        detail: { index: 29, expectedTimestamp: B - 30 * I, actualTimestamp: B - 29 * I },
      });
    });

    it('the full answer decides on B - 59 I .. B and gives MA200', async () => {
      const result = await createSignalFeed({
        rest: stubRest(answer(B)),
        logger: sink(),
        now: () => T,
      }).evaluate({ assetId: 101, interval: '1m', digits: 5 });
      const entry = decided(result);
      expect(entry.source).toMatchObject({
        kind: 'rest',
        limit: SIGNAL_FETCH_LIMIT,
        rows: SIGNAL_FETCH_LIMIT,
      });
      expect(seriesStarts(entry)).toStrictEqual(starts(W0, B));
      expect(result).toMatchObject({ indicators: { ma200: { ok: true } } });
    });
  });

  it('F13 118 rows with a forming one: MA200 is short 117 of 200, MA50 and MACD have values', async () => {
    const rows = mildRise(118 - 45);
    const nowMs = closedNow(rows.slice(0, -1));
    const feed = createSignalFeed({ rest: stubRest(rows), logger: sink(), now: () => nowMs });

    const result = await feed.evaluate({ assetId: 101, interval: '1m', digits: 5 });

    expect(result).toMatchObject({
      indicators: {
        macd: { ok: true },
        ma50: { ok: true },
        ma200: { ok: false, closedCandles: 117, required: 200 },
      },
    });
  });

  it('F14 a gap in the early rows leaves the indicators to the rows after it', async () => {
    const rows = mildRise(SIGNAL_FETCH_LIMIT - 45 + 1).filter((_, i) => i !== 10);
    const nowMs = closedNow(rows);

    const result = await createSignalFeed({
      rest: stubRest(rows),
      logger: sink(),
      now: () => nowMs,
    }).evaluate({ assetId: 101, interval: '1m', digits: 5 });

    expect(result).toMatchObject({
      indicators: { macd: { ok: true }, ma50: { ok: true }, ma200: { ok: true } },
    });
    expect(decided(result).decision).toMatchObject({ kind: 'signal' });
  });
});

// #405: the data socket's window through the SignalCandleSource port. The window is the ring's: the
// closed candles of SIGNAL_FETCH_LIMIT buckets up to the boundary, the forming one apart, and the
// closed buckets without a candle as gaps.
describe('createSignalFeed with a candle source', () => {
  const I15 = SIGNAL_CHART_INTERVAL_MS['15s'];
  const B15 = Math.floor(1_760_000_000_000 / I15) * I15;
  const T15 = B15 + 7_000;
  const W15 = B15 - (SIGNAL_FETCH_LIMIT - 1) * I15;
  const req = { assetId: 101, interval: '15s', digits: 5 } as const;

  // 300 rows from W15 to B15, the last one forming at T15
  const rows15 = (missing: readonly number[] = []) =>
    mildRise(SIGNAL_FETCH_LIMIT - 45, { start: W15, intervalMs: I15 }).filter(
      ({ timestamp }) => !missing.includes(timestamp),
    );

  function windowOf(rows: readonly Candle[], { forming = true } = {}): CandleWindow {
    const closed = rows.filter(({ timestamp }) => timestamp < B15).map((row) => ({ ...row }));
    const formingRow = rows.find(({ timestamp }) => timestamp === B15);
    const have = new Set(closed.map(({ timestamp }) => timestamp));
    const gaps: number[] = [];
    for (let bucket = W15; bucket < B15; bucket += I15) if (!have.has(bucket)) gaps.push(bucket);
    return {
      candles: closed,
      ...(forming && formingRow !== undefined ? { forming: { ...formingRow } } : {}),
      closedUntil: B15,
      startTime: W15,
      gaps,
    };
  }

  function fakeSource(windowFor: (interval: string) => CandleWindow | undefined) {
    const reads: { assetId: number; interval: string; nowMs: number }[] = [];
    const requests: { assetId: number; interval: string }[] = [];
    const source: SignalCandleSource = {
      read(assetId, interval, nowMs) {
        reads.push({ assetId, interval, nowMs });
        return windowFor(interval);
      },
      request(assetId, interval) {
        requests.push({ assetId, interval });
      },
    };
    return { source, reads, requests };
  }

  const noRest = () => ({ getChart: vi.fn<BrokerRestClient['getChart']>() });

  function socketFeed(window: CandleWindow | undefined, extra: { pacer?: SignalRestPacer } = {}) {
    const fake = fakeSource(() => window);
    const rest = noRest();
    const feed = createSignalFeed({
      rest,
      source: fake.source,
      logger: sink(),
      now: () => T15,
      ...extra,
    });
    return { feed, rest, ...fake };
  }

  it('F15 the same 300 rows through REST and through the window: one decision, series, indicators', async () => {
    const rows = rows15();
    const viaRest = await createSignalFeed({
      rest: stubRest(rows),
      logger: sink(),
      now: () => T15,
    }).evaluate(req);
    const { feed, rest, reads } = socketFeed(windowOf(rows));
    const viaSocket = await feed.evaluate(req);

    const restEntry = decided(viaRest);
    const socketEntry = decided(viaSocket);
    expect(socketEntry.decision).toStrictEqual(restEntry.decision);
    expect(socketEntry.series).toStrictEqual(restEntry.series);
    expect(viaSocket.outcome === 'decided' && viaSocket.indicators).toStrictEqual(
      viaRest.outcome === 'decided' && viaRest.indicators,
    );
    expect(socketEntry.series).toHaveLength(SIGNAL_CHART_LIMIT);
    expect(socketEntry.source).toStrictEqual({
      kind: 'socket',
      startTime: W15,
      closedUntil: B15,
      gaps: 0,
    });
    expect(replaySignalJournalEntry(socketEntry)).toStrictEqual(socketEntry.decision);
    expect(reads).toStrictEqual([{ assetId: 101, interval: '15s', nowMs: T15 }]);
    expect(rest.getChart).not.toHaveBeenCalled();
  });

  it('F16 a gap inside the decision window is candle_gap and one refill request, no GET', async () => {
    const { feed, rest, requests } = socketFeed(windowOf(rows15([B15 - 30 * I15])));
    const entry = decided(await feed.evaluate(req));
    expect(entry.decision).toMatchObject({ kind: 'no_signal', reason: 'candle_gap' });
    expect(requests).toStrictEqual([{ assetId: 101, interval: '15s' }]);
    expect(entry.source).toStrictEqual({
      kind: 'socket',
      startTime: W15,
      closedUntil: B15,
      gaps: 1,
    });
    expect(rest.getChart).not.toHaveBeenCalled();
  });

  it('F17 an empty window is insufficient_candles with no closed candle, and a refill request', async () => {
    const { feed, requests } = socketFeed(windowOf([]));
    const entry = decided(await feed.evaluate(req));
    expect(entry.decision).toMatchObject({
      reason: 'insufficient_candles',
      detail: { closedCandles: 0 },
    });
    expect(entry.series).toStrictEqual([]);
    expect(requests).toStrictEqual([{ assetId: 101, interval: '15s' }]);
  });

  it('F18 a window without gaps asks for no refill', async () => {
    const { feed, requests } = socketFeed(windowOf(rows15()));
    decided(await feed.evaluate(req));
    expect(requests).toStrictEqual([]);
  });

  it('F19 no window reads REST: one GET, source rest with the facts of the GET', async () => {
    const rows = rows15();
    const fake = fakeSource(() => undefined);
    const getChart = vi.fn(stubRest(rows).getChart);
    const feed = createSignalFeed({
      rest: { getChart },
      source: fake.source,
      logger: sink(),
      now: () => T15,
    });
    const entry = decided(await feed.evaluate(req));
    expect(getChart).toHaveBeenCalledTimes(1);
    expect(entry.source).toMatchObject({
      kind: 'rest',
      startTime: W15,
      limit: SIGNAL_FETCH_LIMIT,
      rows: SIGNAL_FETCH_LIMIT,
    });
    expect(entry.source).toHaveProperty('durationMs');
    expect(fake.requests).toStrictEqual([]);
  });

  it('F20 an interval the source does not build goes to REST', async () => {
    const fake = fakeSource((interval) => (interval === '1m' ? undefined : windowOf(rows15())));
    const getChart = vi.fn(stubRest(mildRise(15)).getChart);
    const feed = createSignalFeed({ rest: { getChart }, source: fake.source, logger: sink() });
    const result = await feed.evaluate({ assetId: 101, interval: '1m', digits: 5 });
    expect(decided(result).source.kind).toBe('rest');
    expect(getChart).toHaveBeenCalledTimes(1);
  });

  it("F21 the forming candle ends the series as REST's would; without it the last closed one does", async () => {
    const withForming = decided(await socketFeed(windowOf(rows15())).feed.evaluate(req));
    expect(withForming.series.at(-1)?.[0]).toBe(B15);
    expect(withForming.series).toHaveLength(SIGNAL_CHART_LIMIT);
    const without = decided(
      await socketFeed(windowOf(rows15(), { forming: false })).feed.evaluate(req),
    );
    expect(without.series.at(-1)?.[0]).toBe(B15 - I15);
    expect(without.series).toHaveLength(SIGNAL_CHART_LIMIT - 1);
    expect(without.decision).toStrictEqual(withForming.decision);
  });

  it('F22 the indicators read the whole window: a gap early leaves MA200 short, the decision stands', async () => {
    const full = await socketFeed(windowOf(rows15())).feed.evaluate(req);
    expect(full).toMatchObject({ indicators: { ma200: { ok: true } } });
    const gapped = socketFeed(windowOf(rows15([W15 + 99 * I15])));
    const result = await gapped.feed.evaluate(req);
    expect(result).toMatchObject({
      indicators: {
        macd: { ok: true },
        ma50: { ok: true },
        ma200: { ok: false, closedCandles: 199, required: 200 },
      },
    });
    expect(decided(result).decision).toMatchObject({ kind: 'signal' });
    expect(gapped.requests).toHaveLength(1);
  });

  it('F23 evaluate writes the line by default and not with journal: false; journal() writes; fromSource does not', async () => {
    const { feed } = socketFeed(windowOf(rows15()));
    const entry = decided(await feed.evaluate(req));
    expect(parsedLines()).toMatchObject([{ level: 30, msg: 'signal decision' }]);
    await feed.evaluate(req, { journal: false });
    const fromSource = feed.fromSource(req);
    expect(fromSource?.outcome).toBe('decided');
    expect(lines).toHaveLength(1);
    feed.journal(entry);
    expect(parsedLines()).toHaveLength(2);
    expect(parsedLines()[1]).toMatchObject({ msg: 'signal decision' });
    expect((parsedLines()[1] as { signal: unknown }).signal).toStrictEqual(
      JSON.parse(JSON.stringify(entry)),
    );
  });

  it('F23b fromSource without a window is undefined and makes no GET', () => {
    const { feed, rest } = socketFeed(undefined);
    expect(feed.fromSource(req)).toBeUndefined();
    expect(rest.getChart).not.toHaveBeenCalled();
    expect(lines).toHaveLength(0);
  });

  describe('F24 the pacer gates every REST GET', () => {
    function fakePacer(take: boolean, pausedUntil?: number) {
      const pacer = {
        tryTake: vi.fn(() => take),
        onRateLimited: vi.fn<SignalRestPacer['onRateLimited']>(() => 0),
        onDecided: vi.fn(),
        pausedUntil: vi.fn(() => pausedUntil),
      };
      return pacer satisfies SignalRestPacer;
    }
    const restFeed = (rest: Pick<BrokerRestClient, 'getChart'>, pacer: SignalRestPacer) =>
      createSignalFeed({ rest, pacer, logger: sink(), now: () => T15 });

    it('an empty bucket without a pause refuses with rate_limited and the retry constant; no GET', async () => {
      const getChart = vi.fn<BrokerRestClient['getChart']>();
      const result = await restFeed({ getChart }, fakePacer(false)).evaluate(req);
      expect(result).toStrictEqual({
        outcome: 'fetch_failed',
        request: {
          assetId: 101,
          interval: '15s',
          intervalMs: I15,
          nowMs: T15,
          startTime: W15,
          limit: SIGNAL_FETCH_LIMIT,
        },
        code: 'rate_limited',
        retryAfterSec: SIGNAL_PACER_RETRY_SEC,
      });
      expect(SIGNAL_PACER_RETRY_SEC).toBe(1);
      expect(getChart).not.toHaveBeenCalled();
      expect(parsedLines()).toMatchObject([
        { level: 40, msg: 'signal fetch refused: no token', retryAfterSec: 1 },
      ]);
    });

    it('a pause answers what is left of it', async () => {
      const getChart = vi.fn<BrokerRestClient['getChart']>();
      const result = await restFeed({ getChart }, fakePacer(false, T15 + 37_000)).evaluate(req);
      expect(result).toMatchObject({ code: 'rate_limited', retryAfterSec: 37 });
      expect(getChart).not.toHaveBeenCalled();
    });

    it('a 2xx resets the backoff', async () => {
      const pacer = fakePacer(true);
      decided(await restFeed(stubRest(rows15()), pacer).evaluate(req));
      expect(pacer.tryTake).toHaveBeenCalledTimes(1);
      expect(pacer.onDecided).toHaveBeenCalledTimes(1);
      expect(pacer.onRateLimited).not.toHaveBeenCalled();
    });

    it('a 429 pauses the pacer for its Retry-After; another failure does not', async () => {
      const pacer = fakePacer(true);
      const failing = (error: BrokerRestError) => ({ getChart: () => Promise.reject(error) });
      await restFeed(
        failing(new BrokerRestError('rate_limited', { status: 429, retryAfterSec: 20 })),
        pacer,
      ).evaluate(req);
      expect(pacer.onRateLimited.mock.calls).toStrictEqual([[20]]);
      await restFeed(failing(new BrokerRestError('unavailable', { status: 503 })), pacer).evaluate(
        req,
      );
      expect(pacer.onRateLimited).toHaveBeenCalledTimes(1);
      expect(pacer.onDecided).not.toHaveBeenCalled();
    });

    it('a window of the source takes no token', async () => {
      const pacer = fakePacer(false);
      const { feed } = socketFeed(windowOf(rows15()), { pacer });
      decided(await feed.evaluate(req));
      expect(pacer.tryTake).not.toHaveBeenCalled();
    });
  });

  it('F25 a feed without a pacer sends its GET ungated', async () => {
    const getChart = vi.fn(stubRest(rows15()).getChart);
    decided(
      await createSignalFeed({ rest: { getChart }, logger: sink(), now: () => T15 }).evaluate(req),
    );
    expect(getChart).toHaveBeenCalledTimes(1);
  });
});
