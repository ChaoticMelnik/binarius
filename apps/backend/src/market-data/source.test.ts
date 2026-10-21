import type { CandleWindow } from '@binarius/signal';
import { describe, expect, it } from 'vitest';
import { createCandleSource, createPendingRequests } from './source';

describe('the candle source requests (#404)', () => {
  it('S1 keeps one request per (pair, interval), in insertion order', () => {
    const requests = createPendingRequests(10);
    const source = createCandleSource({
      ring: {
        read: () => {
          throw new Error('not read');
        },
      },
      requests,
      streaming: () => true,
    });
    source.request(5, '5s');
    source.request(3, '5s');
    source.request(5, '5s');
    // #685: an interval the ring does not build is no request
    source.request(5, '15s');
    expect(requests.size).toBe(2);
    expect(requests.pending()).toEqual([
      { assetId: 5, interval: '5s' },
      { assetId: 3, interval: '5s' },
    ]);
  });

  it('S2 refuses a new request over the ceiling and still takes one already queued', () => {
    const requests = createPendingRequests(2);
    expect(requests.add(1, '5s')).toBe(true);
    expect(requests.add(2, '5s')).toBe(true);
    expect(requests.add(3, '5s')).toBe(false);
    expect(requests.add(1, '5s')).toBe(true);
    expect(requests.pending()).toEqual([
      { assetId: 1, interval: '5s' },
      { assetId: 2, interval: '5s' },
    ]);
  });

  it('S3 hands the requests over once and empties the set', () => {
    const requests = createPendingRequests(288);
    requests.add(1, '5s');
    expect(requests.pending()).toHaveLength(1);
    expect(requests.pending()).toEqual([]);
    expect(requests.size).toBe(0);
    expect(requests.add(1, '5s')).toBe(true);
  });
});

// #405: the port the signal feed reads (docs/market-data.md -> Components)
describe('createCandleSource (#405)', () => {
  const window: CandleWindow = { candles: [], closedUntil: 0, startTime: 0, gaps: [] };
  function adapter(streaming: boolean) {
    const reads: { assetId: number; interval: string; nowMs: number }[] = [];
    const requests = createPendingRequests(10);
    const source = createCandleSource({
      ring: {
        read: (assetId, interval, nowMs) => {
          reads.push({ assetId, interval, nowMs });
          return window;
        },
      },
      requests,
      streaming: () => streaming,
    });
    return { source, reads, requests };
  }

  it('S4 no window while the socket is not streaming, nor for an interval the ring does not build', () => {
    const down = adapter(false);
    expect(down.source.read(7, '5s', 1_000)).toBeUndefined();
    expect(down.reads).toEqual([]);
    const live = adapter(true);
    expect(live.source.read(7, '1m', 1_000)).toBeUndefined();
    // #685: a 15 s session of before the deploy reads its candles over REST
    expect(live.source.read(7, '15s', 1_000)).toBeUndefined();
    expect(live.reads).toEqual([]);
  });

  it('S5 a request for 1m leaves the set alone; one for 5s is in it', () => {
    const { source, requests } = adapter(true);
    source.request(7, '1m');
    expect(requests.size).toBe(0);
    source.request(7, '5s');
    expect(requests.pending()).toEqual([{ assetId: 7, interval: '5s' }]);
  });

  it("S6 a read while streaming is the ring's window for the same nowMs", () => {
    const { source, reads } = adapter(true);
    expect(source.read(7, '5s', 12_345)).toBe(window);
    expect(reads).toEqual([{ assetId: 7, interval: '5s', nowMs: 12_345 }]);
  });
});
