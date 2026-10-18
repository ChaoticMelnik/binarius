import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BrokerRestErrorCode,
  SIGNAL_CHART_INTERVAL_MS,
  SIGNAL_SCAN_INTERVALS,
  type BinaryPair,
  type Candle,
  type ChartRequest,
  type PairsCatalogView,
  type ScanInterval,
} from '@binarius/shared';
import { BrokerRestError } from '@binarius/broker-rest';
import { chartWindow } from '@binarius/signal';
import { createScanPacer, type ScanPacer, type SpareTokenSource } from '../signal/pacer';
import { createCandleBackfill, type CandleBackfill, type CandleBackfillConfig } from './backfill';
import { createCandleRing, type CandleRing } from './ring';
import { createPendingRequests, type PendingRequests } from './source';

// a 15s boundary, 2.6 s in: past the slack and the ring's skew margin
const T0 = 1_800_000_000_000;
const START = T0 + 2_600;
const TICK_PRICE = 1.1;
const REST_CLOSE = 2;

const CONFIG: CandleBackfillConfig = {
  scanMs: 3_600_000,
  pollMs: 3_600_000,
  retryMs: 15_000,
  attempts: 3,
  budgetMs: 3_000,
  concurrency: 2,
  slackMs: 500,
  candles: 300,
};

function pair(id: number, overrides: Partial<BinaryPair> = {}): BinaryPair {
  return {
    id,
    symbol: `P${id}`,
    type: 'currency',
    digits: 5,
    payout: 85,
    maxPayout: 90,
    minTimeframe: 5,
    maxTimeframe: 3600,
    scheduledUntil: 0,
    ...overrides,
  };
}

interface Call extends ChartRequest {
  at: number;
  signal: AbortSignal | undefined;
}

interface Chart {
  calls: Call[];
  // the buckets the broker has no row for
  omit: Set<number>;
  // the answer has no row before the window: its first row is the window's first bucket
  short: boolean;
  // replaces the answer of the next calls, in order
  next: ((call: Call) => Promise<Candle[]>)[];
}

interface Harness {
  clock: { now: number };
  ring: CandleRing;
  requests: PendingRequests;
  catalog: { view: PairsCatalogView | undefined };
  chart: Chart;
  pacer: ScanPacer;
  stream: { on: boolean };
  warns: { fields: Record<string, unknown>; msg: string }[];
  errors: { fields: Record<string, unknown>; msg: string }[];
  backfill: CandleBackfill;
  // the calls of one element, as `${assetId}:${interval}`
  order(): string[];
  // moves the clock in 1 s steps, a tick for each of these pairs at every step
  advance(ms: number, ticked?: number[]): void;
}

const backfills: CandleBackfill[] = [];
afterEach(async () => {
  for (const backfill of backfills.splice(0)) await backfill.stop();
});

const view = (pairs: BinaryPair[]): PairsCatalogView => ({
  pairs,
  fetchedAt: START,
  ageMs: 0,
  fresh: true,
});

function rowsFor(call: Call, chart: Chart): Candle[] {
  const intervalMs = SIGNAL_CHART_INTERVAL_MS[call.interval as ScanInterval];
  const boundary = Math.floor(call.at / intervalMs) * intervalMs;
  const rows: Candle[] = [];
  const first = chart.short ? call.startTime + intervalMs : call.startTime;
  for (let k = 0; rows.length < call.limit; k += 1) {
    const timestamp = first + k * intervalMs;
    if (timestamp > boundary) break;
    if (chart.omit.has(timestamp)) continue;
    rows.push({
      timestamp,
      open: REST_CLOSE,
      high: REST_CLOSE,
      low: REST_CLOSE,
      close: REST_CLOSE,
    });
  }
  return rows;
}

function harness(
  options: {
    pairs?: BinaryPair[];
    config?: Partial<CandleBackfillConfig>;
    // the backfill on a real pacer; without it every spare token is granted
    pacer?: { perMinute: number; capacity: number };
    streaming?: boolean;
  } = {},
): Harness {
  // the pacer starts a second earlier: its overflow holds a token at START
  const clock = { now: START - 1_000 };
  const ring = createCandleRing({
    capacity: 300,
    skewMarginMs: 2_000,
    intervals: SIGNAL_SCAN_INTERVALS,
  });
  const requests = createPendingRequests(288);
  const catalog = { view: view(options.pairs ?? [pair(1)]) as PairsCatalogView | undefined };
  const chart: Chart = { calls: [], omit: new Set(), short: false, next: [] };
  const pacer = createScanPacer({
    perMinute: options.pacer?.perMinute ?? 6_000_000,
    capacity: options.pacer?.capacity ?? 1,
    backoffMinMs: 15_000,
    backoffMaxMs: 120_000,
    now: () => clock.now,
  });
  const open: SpareTokenSource = {
    tryTakeSpare: () => true,
    onRateLimited: () => 0,
    onDecided: () => undefined,
  };
  clock.now = START;
  const stream = { on: options.streaming ?? true };
  const warns: Harness['warns'] = [];
  const errors: Harness['errors'] = [];
  const backfill = createCandleBackfill({
    ring,
    requests,
    catalog: { read: () => catalog.view },
    rest: {
      getChart: (request, callOptions) => {
        const call: Call = { ...request, at: clock.now, signal: callOptions?.signal };
        chart.calls.push(call);
        const answer = chart.next.shift();
        return answer === undefined ? Promise.resolve(rowsFor(call, chart)) : answer(call);
      },
    },
    pacer: options.pacer === undefined ? open : pacer,
    streaming: () => stream.on,
    logger: {
      warn: ((fields: Record<string, unknown>, msg: string) =>
        warns.push({ fields, msg })) as never,
      error: ((fields: Record<string, unknown>, msg: string) =>
        errors.push({ fields, msg })) as never,
    },
    now: () => clock.now,
    config: { ...CONFIG, ...options.config },
  });
  backfills.push(backfill);
  return {
    clock,
    ring,
    requests,
    catalog,
    chart,
    pacer,
    stream,
    warns,
    errors,
    backfill,
    order: () => chart.calls.map((call) => `${call.assetId}:${call.interval}`),
    advance(ms, ticked = []) {
      const end = clock.now + ms;
      while (clock.now < end) {
        clock.now = Math.min(end, clock.now + 1_000);
        for (const id of ticked) {
          ring.push(id, 5, { price: TICK_PRICE, timestamp: clock.now }, clock.now);
        }
      }
    },
  };
}

// ticks until nothing more is asked for
async function drain(h: Harness, rounds = 200): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    const before = h.chart.calls.length;
    await h.backfill.tick();
    if (h.chart.calls.length === before) return;
  }
  throw new Error('the backfill did not settle');
}

const gaps = (h: Harness, id: number, interval: ScanInterval) =>
  h.ring.read(id, interval, h.clock.now).gaps;

// resolves when the call's signal aborts, with the REST client's error for it
const hang = (call: Call) =>
  new Promise<Candle[]>((_, reject) => {
    call.signal?.addEventListener('abort', () => {
      reject(new BrokerRestError(BrokerRestErrorCode.Aborted));
    });
  });

// answers after a while unless the signal aborts first: a dropped signal shows as an answer
const slow = (ms: number) => (call: Call) =>
  Promise.race([hang(call), new Promise<Candle[]>((resolve) => setTimeout(() => resolve([]), ms))]);

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const unavailable = () => Promise.reject(new BrokerRestError(BrokerRestErrorCode.Unavailable));

describe('the candle backfill (#590)', () => {
  it('B1 warms a cold start pair by pair by payout, 15s before 5s, with one GET a window', async () => {
    const pairs = Array.from({ length: 45 }, (_, k) =>
      pair(100 + ((k * 7) % 45), { payout: 80 + (k % 9) }),
    );
    const h = harness({ pairs });
    await drain(h);

    const byPayout = [...pairs].sort((a, b) => b.payout - a.payout || a.id - b.id);
    expect(h.order()).toEqual(byPayout.flatMap((p) => [`${p.id}:15s`, `${p.id}:5s`]));
    for (const call of h.chart.calls) {
      const intervalMs = SIGNAL_CHART_INTERVAL_MS[call.interval as ScanInterval];
      const w = chartWindow(call.at, intervalMs, 300);
      expect({ startTime: call.startTime, limit: call.limit }).toEqual({
        startTime: w.startTime - intervalMs,
        limit: 301,
      });
    }
    for (const p of pairs) {
      for (const interval of SIGNAL_SCAN_INTERVALS) expect(gaps(h, p.id, interval)).toEqual([]);
    }
    expect(h.backfill.counters()).toMatchObject({ fetched: 90, failed: 0, queued: 0, spare: 90 });
  });

  it('B1b drops the first row of a short answer: the oldest bucket stays empty', async () => {
    const h = harness({ pairs: [pair(1, { maxTimeframe: 5 })] });
    h.chart.short = true;
    await h.backfill.tick();
    const { startTime } = chartWindow(START, 5_000, 300);
    expect(h.order()).toEqual(['1:5s']);
    expect(gaps(h, 1, '5s')).toEqual([startTime]);
  });

  it('B2 serves the requests first, in the order they came, then the cold pairs', async () => {
    const h = harness({
      pairs: [pair(1, { payout: 90 }), pair(2, { payout: 80 }), pair(3, { payout: 81 })],
      config: { concurrency: 1 },
    });
    h.requests.add(3, '5s');
    h.requests.add(2, '15s');
    await h.backfill.tick();
    await h.backfill.tick();
    await h.backfill.tick();
    expect(h.order()).toEqual(['3:5s', '2:15s', '1:15s']);
  });

  it('B2b keeps a request that came while a proactive GET was in flight', async () => {
    const h = harness({ pairs: [pair(1, { maxTimeframe: 5 })] });
    const answer = deferred();
    h.chart.next.push((call) => {
      const rows = rowsFor(call, h.chart);
      return answer.promise.then(() => rows);
    });
    const first = h.backfill.tick();
    expect(h.order()).toEqual(['1:5s']);
    h.stream.on = false;
    h.requests.add(1, '5s');
    const second = h.backfill.tick();
    h.clock.now += 5_000;
    answer.resolve();
    await Promise.all([first, second]);

    h.advance(15_000, [1]);
    await h.backfill.tick();
    expect(h.order()).toEqual(['1:5s', '1:5s']);
  });

  it('B2c keeps a second request that came while the GET of the first was in flight', async () => {
    const h = harness({ pairs: [pair(1, { maxTimeframe: 5 })], streaming: false });
    h.requests.add(1, '5s');
    const answer = deferred();
    h.chart.next.push((call) => {
      const rows = rowsFor(call, h.chart);
      return answer.promise.then(() => rows);
    });
    const first = h.backfill.tick();
    expect(h.order()).toEqual(['1:5s']);
    h.requests.add(1, '5s');
    const second = h.backfill.tick();
    h.clock.now += 5_000;
    answer.resolve();
    await Promise.all([first, second]);

    h.advance(15_000, [1]);
    await h.backfill.tick();
    expect(h.order()).toEqual(['1:5s', '1:5s']);
  });

  it('B2d keeps the request after a failed GET, and serves it after the hold-back', async () => {
    const h = harness({ pairs: [pair(1, { maxTimeframe: 5 })], streaming: false });
    h.requests.add(1, '5s');
    h.chart.next.push(unavailable);
    await h.backfill.tick();
    expect(h.backfill.counters()).toMatchObject({ failed: 1 });

    h.clock.now += 15_000;
    await h.backfill.tick();
    expect(h.order()).toEqual(['1:5s', '1:5s']);
    expect(gaps(h, 1, '5s')).toEqual([]);
  });

  it('B3 refills a hole and keeps the tick-built candles', async () => {
    const h = harness({ pairs: [pair(1, { maxTimeframe: 5 })] });
    h.clock.now = START - 60_000;
    h.advance(30_000, [1]);
    await drain(h);
    const built = h.ring.read(1, '5s', h.clock.now).candles.filter((c) => c.close === TICK_PRICE);
    expect(built.length).toBeGreaterThan(0);
    h.ring.onDrop();
    h.advance(10_000);
    h.advance(20_000, [1]);
    h.clock.now += 15_000;
    const hole = gaps(h, 1, '5s');
    expect(hole.length).toBeGreaterThan(0);
    const { filled } = h.backfill.counters();
    await drain(h);

    expect(gaps(h, 1, '5s')).toEqual([]);
    const after = h.ring.read(1, '5s', h.clock.now).candles;
    for (const candle of built) {
      if (candle.timestamp < chartWindow(h.clock.now, 5_000, 300).startTime) continue;
      expect(after.find((c) => c.timestamp === candle.timestamp)).toEqual(candle);
    }
    for (const bucket of hole) {
      expect(after.find((c) => c.timestamp === bucket)?.close).toBe(REST_CLOSE);
    }
    expect(h.backfill.counters().filled - filled).toBe(hole.length);
  });

  it('B3b asks again for a bucket that closed during the GET, not for one the broker left empty', async () => {
    const h = harness({ pairs: [pair(1, { maxTimeframe: 5 })] });
    const missing = chartWindow(START, 5_000, 300).startTime + 50 * 5_000;
    h.chart.omit.add(missing);
    const forming = Math.floor(START / 5_000) * 5_000;
    // the broker answers the forming bucket as a partial row; the ring has closed it by the answer
    h.chart.next.push((call) => {
      const rows = rowsFor(call, h.chart);
      h.clock.now += 5_000;
      return Promise.resolve(rows);
    });
    await h.backfill.tick();
    expect(gaps(h, 1, '5s')).toEqual([missing, forming]);

    h.advance(15_000, [1]);
    await h.backfill.tick();
    expect(h.order()).toEqual(['1:5s', '1:5s']);
    expect(gaps(h, 1, '5s')).toEqual([missing]);

    h.advance(15_000, [1]);
    await h.backfill.tick();
    expect(h.order()).toHaveLength(2);
  });

  it('B3c fills no bucket the watermark closed during the GET; the next GET does', async () => {
    const h = harness({ pairs: [pair(1, { maxTimeframe: 5 })] });
    const forming = Math.floor(START / 5_000) * 5_000;
    h.chart.next.push((call) => {
      const rows = rowsFor(call, h.chart);
      // the clock rule does not close the forming bucket yet, another pair's tick does
      h.clock.now = forming + 5_000 + 100;
      h.ring.push(2, 5, { price: TICK_PRICE, timestamp: forming + 5_000 + 50 }, h.clock.now);
      return Promise.resolve(rows);
    });
    await h.backfill.tick();
    expect(gaps(h, 1, '5s')).toEqual([forming]);
    const at = h.ring.read(1, '5s', h.clock.now).candles.find((c) => c.timestamp === forming);
    expect(at).toBeUndefined();

    // past the hold-back and out of the next boundary's slack
    h.advance(15_500, [1]);
    await h.backfill.tick();
    expect(h.order()).toEqual(['1:5s', '1:5s']);
    expect(gaps(h, 1, '5s')).toEqual([]);
    const filled = h.ring.read(1, '5s', h.clock.now).candles.find((c) => c.timestamp === forming);
    expect(filled?.close).toBe(REST_CLOSE);
  });

  it('B3d fills no bucket the ring had not closed when the GET was built, past the slack', async () => {
    const h = harness({ pairs: [pair(1, { maxTimeframe: 5 })] });
    const boundary = T0 + 5_000;
    // after the slack, inside the skew margin: no watermark, the clock rule closes up to T0 only
    h.clock.now = boundary + 800;
    h.chart.next.push((call) => {
      const rows = rowsFor(call, h.chart);
      h.clock.now += 2_000;
      return Promise.resolve(rows);
    });
    await h.backfill.tick();
    expect(gaps(h, 1, '5s')).toEqual([boundary - 5_000]);

    h.advance(15_000, [1]);
    await h.backfill.tick();
    expect(h.order()).toEqual(['1:5s', '1:5s']);
    expect(gaps(h, 1, '5s')).toEqual([]);
  });

  it('B3e fills no bucket past the boundary of the GET, though a tick ahead closed it', async () => {
    const h = harness({ pairs: [pair(1, { maxTimeframe: 5 })] });
    const forming = Math.floor(START / 5_000) * 5_000;
    // the broker's clock ahead, within TICK_MAX_SKEW_MS: the watermark closes the forming bucket
    h.ring.push(2, 5, { price: TICK_PRICE, timestamp: START + 10_000 }, START);
    h.chart.next.push((call) => {
      const rows = rowsFor(call, h.chart);
      h.clock.now += 1_000;
      return Promise.resolve(rows);
    });
    await h.backfill.tick();
    expect(gaps(h, 1, '5s')).toEqual([forming]);
  });

  it('B4 gets no token while the scanner takes every one, and one at most after an idle minute', async () => {
    const h = harness({ pacer: { perMinute: 100, capacity: 26 } });
    // the overflow of the second before the scanner started
    h.pacer.tryTakeSpare();
    let scanned = 0;
    for (let poll = 0; poll < 240; poll += 1) {
      while (h.pacer.tryTake()) scanned += 1;
      await h.backfill.tick();
      h.clock.now += 250;
    }
    expect(scanned).toBeGreaterThan(26);
    expect(h.chart.calls).toEqual([]);
    expect(h.backfill.counters().spare).toBe(0);

    h.clock.now += 60_000;
    await h.backfill.tick();
    expect(h.chart.calls).toHaveLength(1);
  });

  it('B4b orders the repeats by the age of their last attempt, not by payout', async () => {
    const h = harness({
      pairs: [pair(1, { payout: 90, maxTimeframe: 5 }), pair(2, { payout: 80, maxTimeframe: 5 })],
      config: { concurrency: 1 },
    });
    h.requests.add(2, '5s');
    await h.backfill.tick();
    h.clock.now += 1_000;
    await h.backfill.tick();
    expect(h.order()).toEqual(['2:5s', '1:5s']);

    h.clock.now += 20_000;
    await h.backfill.tick();
    await h.backfill.tick();
    expect(h.order()).toEqual(['2:5s', '1:5s', '2:5s', '1:5s']);
  });

  it('B5 pauses the pacer on a 429 and keeps the element first, without a failure; B11 the counters', async () => {
    const h = harness({
      pairs: [pair(1, { maxTimeframe: 5 }), pair(2, { payout: 80, maxTimeframe: 5 })],
      pacer: { perMinute: 6_000_000, capacity: 1 },
    });
    h.chart.next.push(() =>
      Promise.reject(new BrokerRestError(BrokerRestErrorCode.RateLimited, { retryAfterSec: 20 })),
    );
    await h.backfill.tick();
    expect(h.order()).toEqual(['1:5s']);
    expect(h.pacer.pausedUntil()).toBe(START + 20_000);

    h.clock.now += 10_000;
    await h.backfill.tick();
    expect(h.order()).toHaveLength(1);

    h.clock.now += 10_000;
    await h.backfill.tick();
    expect(h.order()).toEqual(['1:5s', '1:5s']);
    expect(h.backfill.counters()).toEqual({
      queued: 1,
      fetched: 1,
      filled: 299,
      failed: 0,
      rateLimited: 1,
      spare: 2,
    });
    expect(h.warns).toEqual([]);
  });

  it('B5b keeps the request after a 429: the next scan takes the element again', async () => {
    const h = harness({ pairs: [pair(1, { maxTimeframe: 5 })], streaming: false });
    h.requests.add(1, '5s');
    h.chart.next.push(() =>
      Promise.reject(new BrokerRestError(BrokerRestErrorCode.RateLimited, { retryAfterSec: 20 })),
    );
    await h.backfill.tick();
    expect(h.backfill.counters()).toMatchObject({ rateLimited: 1 });
    await h.backfill.tick();
    expect(h.order()).toEqual(['1:5s', '1:5s']);
  });

  it('B6 gives up after three failures in a row, warns with the code, and leaves the gaps alone', async () => {
    const h = harness({ pairs: [pair(1, { maxTimeframe: 5 })] });
    h.chart.next.push(unavailable, unavailable, unavailable);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await h.backfill.tick();
      h.advance(15_000, [1]);
    }
    expect(h.order()).toHaveLength(3);
    expect(h.warns).toEqual([
      {
        fields: { assetId: 1, interval: '5s', code: BrokerRestErrorCode.Unavailable, attempts: 3 },
        msg: 'market data backfill gave up',
      },
    ]);
    h.advance(15_000, [1]);
    await h.backfill.tick();
    expect(h.order()).toHaveLength(3);
    expect(h.backfill.counters()).toMatchObject({ failed: 3, fetched: 0 });
  });

  it('B6b a success resets the failures', async () => {
    const h = harness({ pairs: [pair(1, { maxTimeframe: 5 })] });
    const ok = (call: Call) => Promise.resolve(rowsFor(call, h.chart));
    h.chart.next.push(unavailable, unavailable, ok, unavailable, unavailable);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await h.backfill.tick();
      h.clock.now += 15_000;
    }
    expect(h.order()).toHaveLength(5);
    expect(h.warns).toEqual([]);
  });

  it('B6c after giving up, a new empty bucket makes the element due again', async () => {
    const h = harness({ pairs: [pair(1, { maxTimeframe: 5 })] });
    h.chart.next.push(unavailable, unavailable, unavailable);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await h.backfill.tick();
      h.advance(15_000, [1]);
    }
    expect(h.warns).toHaveLength(1);
    h.clock.now += 15_000;
    await h.backfill.tick();
    expect(h.order()).toHaveLength(4);
    expect(gaps(h, 1, '5s')).toEqual([]);
  });

  it('B6d logs a throw that is not a broker error by name, and counts it a failure', async () => {
    const h = harness({ pairs: [pair(1, { maxTimeframe: 5 })] });
    h.chart.next.push(() => Promise.reject(new TypeError('SECRET detail')));
    await h.backfill.tick();
    expect(h.warns).toHaveLength(1);
    expect(h.warns[0]).toMatchObject({
      fields: { assetId: 1, interval: '5s', err: { name: 'TypeError' } },
      msg: 'market data backfill threw',
    });
    expect(JSON.stringify(h.warns)).not.toContain('SECRET');
    expect(h.backfill.counters()).toMatchObject({ failed: 1 });
  });

  it('B7 ends a slow GET by its budget and counts a failure', async () => {
    const h = harness({ pairs: [pair(1, { maxTimeframe: 5 })], config: { budgetMs: 50 } });
    h.chart.next.push(slow(1_000));
    await h.backfill.tick();
    expect(h.backfill.counters()).toMatchObject({ failed: 1, fetched: 0 });
  });

  it('B8 stop() aborts the GETs in flight at once, and nothing starts after it', async () => {
    const h = harness({ pairs: [pair(1, { maxTimeframe: 5 })], config: { budgetMs: 10_000 } });
    // the answer the GET would get without the abort: stop() returning before it is the proof
    let answered = false;
    h.chart.next.push((call) =>
      Promise.race([
        hang(call),
        new Promise<Candle[]>((resolve) =>
          setTimeout(() => {
            answered = true;
            resolve([]);
          }, 1_000),
        ),
      ]),
    );
    const ticking = h.backfill.tick();
    expect(h.chart.calls).toHaveLength(1);
    await h.backfill.stop();
    expect(answered).toBe(false);
    expect(h.chart.calls[0]?.signal?.aborted).toBe(true);
    await ticking;
    h.requests.add(1, '5s');
    h.clock.now += 60_000;
    await h.backfill.tick();
    expect(h.chart.calls).toHaveLength(1);
    expect(h.backfill.counters()).toMatchObject({ failed: 0, fetched: 0 });
  });

  it('B9 starts no GET in the slack after a 5s boundary', async () => {
    const h = harness({ pairs: [pair(1, { maxTimeframe: 5 })] });
    h.clock.now = T0 + 5_000 + 100;
    await h.backfill.tick();
    expect(h.chart.calls).toEqual([]);
    h.clock.now = T0 + 5_000 + 500;
    await h.backfill.tick();
    expect(h.chart.calls).toHaveLength(1);
  });

  it('B10 holds an element back for 15 s after its GET', async () => {
    const h = harness({ pairs: [pair(1, { maxTimeframe: 5 })] });
    await h.backfill.tick();
    h.clock.now += 5_000;
    expect(gaps(h, 1, '5s')).toHaveLength(1);
    await h.backfill.tick();
    expect(h.chart.calls).toHaveLength(1);
    h.clock.now += 10_000;
    await h.backfill.tick();
    expect(h.chart.calls).toHaveLength(2);
  });

  it('B12 warms nothing proactively while the active is not ready, and still serves a request', async () => {
    const h = harness({ pairs: [pair(1), pair(2)], streaming: false });
    await h.backfill.tick();
    expect(h.chart.calls).toEqual([]);
    h.requests.add(2, '15s');
    await h.backfill.tick();
    expect(h.order()).toEqual(['2:15s']);
  });

  it('B13 warms a new catalog id before any repeat', async () => {
    const h = harness({
      pairs: [pair(1, { payout: 90, maxTimeframe: 5 })],
      config: { concurrency: 1 },
    });
    await h.backfill.tick();
    h.catalog.view = view([
      pair(1, { payout: 90, maxTimeframe: 5 }),
      pair(2, { payout: 80, maxTimeframe: 5 }),
    ]);
    h.clock.now += 15_000;
    await h.backfill.tick();
    await h.backfill.tick();
    expect(h.order()).toEqual(['1:5s', '2:5s', '1:5s']);
  });

  it('B14 warms a closed pair only on request, and drops a request with bad digits', async () => {
    const h = harness({
      pairs: [pair(1, { scheduledUntil: START + 3_600_000 }), pair(3, { digits: -1 })],
    });
    await h.backfill.tick();
    expect(h.chart.calls).toEqual([]);
    h.requests.add(3, '5s');
    h.requests.add(1, '5s');
    await drain(h);
    expect(h.order()).toEqual(['1:5s']);
  });

  // #631: the payout is no filter of the proactive set (#379 left a pair below 80 % out)
  it('B14b warms a pair paying below MIN_CYCLE_PAYOUT_PCT without a request', async () => {
    const h = harness({ pairs: [pair(2, { payout: 70 })] });
    await drain(h);
    expect(h.order()).toEqual(['2:15s', '2:5s']);
  });

  it('B15 takes no token and calls nothing with an empty queue', async () => {
    const h = harness({ streaming: false, pacer: { perMinute: 6_000_000, capacity: 1 } });
    await h.backfill.tick();
    expect(h.chart.calls).toEqual([]);
    expect(h.backfill.counters()).toEqual({
      queued: 0,
      fetched: 0,
      filled: 0,
      failed: 0,
      rateLimited: 0,
      spare: 0,
    });
    expect(h.pacer.tryTakeSpare()).toBe(true);
  });

  it('B16 keeps two GETs in flight, each on its own spare token', async () => {
    const h = harness({ pairs: [pair(1), pair(2)], config: { budgetMs: 10_000 } });
    const release: (() => void)[] = [];
    const held = (call: Call) =>
      new Promise<Candle[]>((resolve) => release.push(() => resolve(rowsFor(call, h.chart))));
    h.chart.next.push(held, held);
    const first = h.backfill.tick();
    expect(h.order()).toEqual(['1:15s', '1:5s']);
    expect(h.backfill.counters().spare).toBe(2);
    const second = h.backfill.tick();
    expect(h.chart.calls).toHaveLength(2);
    for (const done of release) done();
    await Promise.all([first, second]);
    await h.backfill.tick();
    expect(h.order()).toEqual(['1:15s', '1:5s', '2:15s', '2:5s']);
  });
});

// docs/market-data.md -> The log: the backfill's messages are rows of the table (M11 reads the
// manager's lines against the same table)
const DOCUMENTED = [
  ...readFileSync(
    fileURLToPath(new URL('../../../../docs/market-data.md', import.meta.url)),
    'utf8',
  ).matchAll(/^\| `(market data backfill[^`]*)` \|/gm),
].map((match) => match[1]);

describe('the candle backfill log (#590)', () => {
  it('B17 writes only documented messages; the backstop is the only row no case reaches', async () => {
    const h = harness({ pairs: [pair(1, { maxTimeframe: 5 })] });
    h.chart.next.push(() => Promise.reject(new TypeError('boom')), unavailable, unavailable);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await h.backfill.tick();
      h.advance(15_000, [1]);
    }
    const written = new Set([...h.warns, ...h.errors].map((entry) => entry.msg));
    expect([...written].sort()).toEqual(
      ['market data backfill gave up', 'market data backfill threw'].sort(),
    );
    expect([...DOCUMENTED].sort()).toEqual([...written, 'market data backfill tick failed'].sort());
  });
});
