import { describe, expect, it } from 'vitest';
import { createCandleSource, createPendingRequests } from './source';

describe('the candle source requests (#404)', () => {
  it('S1 keeps one request per (pair, interval), in insertion order', () => {
    const requests = createPendingRequests(10);
    const source = createCandleSource({
      read: () => {
        throw new Error('not read');
      },
      requests,
    });
    expect(source.request(5, '15s')).toEqual({ queued: true });
    expect(source.request(3, '5s')).toEqual({ queued: true });
    expect(source.request(5, '15s')).toEqual({ queued: true });
    expect(source.request(5, '5s')).toEqual({ queued: true });
    expect(requests.size).toBe(3);
    expect(requests.pending()).toEqual([
      { assetId: 5, interval: '15s' },
      { assetId: 3, interval: '5s' },
      { assetId: 5, interval: '5s' },
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
    requests.add(1, '15s');
    expect(requests.pending()).toHaveLength(1);
    expect(requests.pending()).toEqual([]);
    expect(requests.size).toBe(0);
    expect(requests.add(1, '15s')).toBe(true);
  });
});
