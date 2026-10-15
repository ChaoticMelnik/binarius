import {
  BrokerRestError,
  createBrokerRestClient,
  type BrokerRestClient,
} from '@binarius/broker-rest';
import { startMockBroker } from '@binarius/mock-broker';
import {
  BrokerRestErrorCode,
  type BinaryPair,
  type Candle,
  type ChartRequest,
} from '@binarius/shared';
import { describe, expect, it, vi } from 'vitest';
import { readPairs, readSeries, seriesPath, StandError } from './cache';
import { fetchCandles, type FetchOptions } from './fetch';
import { createPacer, systemClock, type Clock } from './pacer';
import { PAIR, T0, tempDir } from './testing';

const MINUTE = 60_000;
const DAY = 86_400_000;

const catalogPair: BinaryPair = {
  id: PAIR.id,
  symbol: PAIR.symbol,
  type: PAIR.type,
  digits: PAIR.digits,
  payout: PAIR.payout,
  maxPayout: 96,
  minTimeframe: 5,
  maxTimeframe: 3600,
  scheduledUntil: 0,
};

function fixedClock(now: number): Clock & { sleeps: number[] } {
  const sleeps: number[] = [];
  return { sleeps, now: () => now, sleep: (ms) => (sleeps.push(ms), Promise.resolve()) };
}

const minute = (timestamp: number): Candle => ({
  timestamp,
  open: 1,
  high: 1.1,
  low: 0.9,
  close: 1,
});

// the live broker's reading: the time window [start, start + limit x step), forming candle included
function windowRest(rows: readonly Candle[], clock: Clock) {
  const calls: ChartRequest[] = [];
  const rest: Pick<BrokerRestClient, 'getChart' | 'listPairs'> = {
    listPairs: () => Promise.resolve([catalogPair]),
    getChart: (request) => {
      calls.push(request);
      const start = Math.floor(request.startTime / MINUTE) * MINUTE;
      return Promise.resolve(
        rows.filter(
          (row) =>
            row.timestamp >= start &&
            row.timestamp < start + request.limit * MINUTE &&
            row.timestamp <= clock.now(),
        ),
      );
    },
  };
  return { rest, calls };
}

const options = (
  over: Partial<FetchOptions> & Pick<FetchOptions, 'rest' | 'clock'>,
): FetchOptions => ({
  dir: tempDir(),
  assets: [PAIR.id],
  intervals: ['1m'],
  days: 1,
  pacer: createPacer(600, over.clock),
  warn: vi.fn(),
  pageLimit: 500,
  ...over,
});

describe('fetch', () => {
  it('F1 on the mock broker: the cache holds the mock rows, ascending, one step apart, no forming row', async () => {
    const broker = await startMockBroker();
    try {
      const rest = createBrokerRestClient({ baseUrl: broker.url });
      const [pair] = await rest.listPairs();
      const o = options({ rest, clock: systemClock, assets: [pair.id] });
      await fetchCandles(o);
      const cached = readSeries(seriesPath(o.dir, pair.id, '1m'), vi.fn());
      const last = cached.at(-1)!.timestamp;
      expect(last + MINUTE).toBeLessThanOrEqual(Date.now());
      expect(last + 2 * MINUTE).toBeGreaterThan(Date.now() - 1_000);
      expect(cached.length).toBeGreaterThanOrEqual(1_438);
      expect(
        cached.every((row, i) => i === 0 || row.timestamp - cached[i - 1].timestamp === MINUTE),
      ).toBe(true);
      const truth = await rest.getChart({
        assetId: pair.id,
        interval: '1m',
        startTime: cached[0].timestamp,
        limit: 5_000,
      });
      expect(cached).toEqual(truth.filter((row) => row.timestamp <= last));
      expect(readPairs(o.dir)).toEqual([
        expect.objectContaining({ id: pair.id, digits: pair.digits, payout: pair.payout }),
      ]);
    } finally {
      await broker.close();
    }
  });

  it('F1b a window longer than a page with no rows is stepped over, not taken as the end', async () => {
    const now = T0 + 30 * MINUTE + 10_000;
    const clock = fixedClock(now);
    const since = now - DAY;
    const all = Array.from({ length: 1_441 }, (_, i) =>
      minute(Math.floor(since / MINUTE) * MINUTE + i * MINUTE),
    );
    const rows = all.filter((_, i) => i < 100 || i > 700);
    const { rest } = windowRest(rows, clock);
    const o = options({ rest, clock });
    await fetchCandles(o);
    const cached = readSeries(seriesPath(o.dir, PAIR.id, '1m'), vi.fn());
    expect(cached).toEqual(rows.filter((row) => row.timestamp + MINUTE <= now));
  });

  it('F2 a second fetch of a complete range asks for no candles', async () => {
    const now = T0 + 10_000;
    const clock = fixedClock(now);
    const rows = Array.from({ length: 1_500 }, (_, i) => minute(T0 - 1_400 * MINUTE + i * MINUTE));
    const { rest, calls } = windowRest(rows, clock);
    const o = options({ rest, clock });
    await fetchCandles(o);
    expect(calls.length).toBeGreaterThan(0);
    calls.length = 0;
    await fetchCandles(o);
    expect(calls).toEqual([]);
  });

  it('F3 a 429 waits as told, 60 s without Retry-After, and asks for the same page again', async () => {
    const clock = fixedClock(T0 + 10_000);
    const { rest: inner, calls } = windowRest([minute(T0 - MINUTE)], clock);
    const failures = [
      new BrokerRestError(BrokerRestErrorCode.RateLimited, { status: 429, retryAfterSec: 2 }),
      new BrokerRestError(BrokerRestErrorCode.RateLimited, { status: 429 }),
    ];
    const rest = {
      ...inner,
      getChart: (request: ChartRequest) => {
        const failure = failures.shift();
        if (failure === undefined) return inner.getChart(request);
        calls.push(request);
        return Promise.reject(failure);
      },
    };
    const o = options({ rest, clock });
    await fetchCandles(o);
    expect(clock.sleeps).toEqual([2_000, 60_000]);
    expect(new Set(calls.slice(0, 3).map((call) => call.startTime)).size).toBe(1);
    expect(readSeries(seriesPath(o.dir, PAIR.id, '1m'), vi.fn())).toHaveLength(1);
  });

  it('F4 any other refusal stops with its code; the complete pages stay', async () => {
    const now = T0 + 10_000;
    const clock = fixedClock(now);
    const rows = Array.from({ length: 1_441 }, (_, i) =>
      minute(Math.floor((now - DAY) / MINUTE) * MINUTE + i * MINUTE),
    );
    const { rest: inner } = windowRest(rows, clock);
    let n = 0;
    const rest = {
      ...inner,
      getChart: (request: ChartRequest) =>
        ++n === 2
          ? Promise.reject(
              new BrokerRestError(BrokerRestErrorCode.Unavailable, {
                status: 503,
                detail: 'secret body',
              }),
            )
          : inner.getChart(request),
    };
    const o = options({ rest, clock });
    const failure = fetchCandles(o);
    await expect(failure).rejects.toThrow(StandError);
    await expect(failure).rejects.toThrow(
      `fetch ${PAIR.id} 1m: BrokerRestError/unavailable status 503`,
    );
    await expect(failure).rejects.not.toThrow(/secret/);
    expect(readSeries(seriesPath(o.dir, PAIR.id, '1m'), vi.fn())).toEqual(rows.slice(0, 500));
  });
});
