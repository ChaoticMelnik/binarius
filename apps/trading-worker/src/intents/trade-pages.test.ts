import { describe, expect, it } from 'vitest';
import type { BrokerTrade, DecimalString, UnixMs } from '@binarius/shared';
import { openTradeFor } from '@binarius/shared/testing';
import { readTradePages, TradePagesError, type TradePagesViolation } from './trade-pages';

const PAGE = 4;
const T0 = 1_791_000_000_000;

// newest first: index 0 is the newest
const trade = (id: string, ts: number): BrokerTrade =>
  openTradeFor(
    { mode: 'demo', assetId: 101, action: 'up', amount: '10' as DecimalString },
    { id, openTimestamp: ts as UnixMs },
  );
const list = (n: number) => Array.from({ length: n }, (_, i) => trade(`t${i}`, T0 - i * 1_000));

interface Broker {
  cap?: number;
  ignoreOffset?: boolean;
  // a page at offset > 0 starts one further (a 1-based offset)
  offsetSkew?: number;
  // changes the list after the given page was served
  mutate?: { afterPage: number; apply: (items: BrokerTrade[]) => BrokerTrade[] };
}

function broker(initial: BrokerTrade[], options: Broker = {}) {
  let items = initial;
  const offsets: number[] = [];
  const fetchPage = (offset: number) => {
    offsets.push(offset);
    const start = options.ignoreOffset ? 0 : offset + (offset > 0 ? (options.offsetSkew ?? 0) : 0);
    const page = items.slice(start, start + Math.min(PAGE, options.cap ?? PAGE));
    if (options.mutate !== undefined && offsets.length === options.mutate.afterPage) {
      items = options.mutate.apply(items);
    }
    return Promise.resolve(page);
  };
  return { fetchPage, offsets };
}

const read = (
  b: ReturnType<typeof broker>,
  maxPages = 10,
  stopAt: (trade: BrokerTrade) => boolean = () => false,
) =>
  readTradePages(b.fetchPage, { maxPages, stopAt });
const ids = (trades: BrokerTrade[]) => trades.map((t) => t.id);

async function violation(promise: Promise<unknown>): Promise<TradePagesViolation> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(TradePagesError);
  return (error as TradePagesError).violation;
}

describe('readTradePages (#90)', () => {
  it('T1 covers an empty list after one page', async () => {
    expect(await read(broker([]))).toEqual({ trades: [], covered: true, pagesRead: 1 });
  });

  it('T2 reads past a short page, with one trade of overlap, to the end', async () => {
    const b = broker(list(7));
    const result = await read(b);
    expect(b.offsets).toEqual([0, 3, 6]);
    expect(result).toMatchObject({ covered: true, pagesRead: 3 });
    expect(ids(result.trades)).toEqual(ids(list(7)));
  });

  it('T3 asks once more after a list exactly one page long', async () => {
    const b = broker(list(4));
    expect(await read(b)).toMatchObject({ covered: true, pagesRead: 2 });
    expect(b.offsets).toEqual([0, 3]);
  });

  it('T4 confirms a one-trade list with an empty page', async () => {
    const b = broker(list(1));
    const result = await read(b);
    expect(b.offsets).toEqual([0, 1]);
    expect(result).toMatchObject({ covered: true, pagesRead: 2 });
    expect(ids(result.trades)).toEqual(['t0']);
  });

  it('T5 stops on the page where stopAt holds and hands back the whole page', async () => {
    const b = broker(list(9));
    const result = await read(b, 10, (t) => t.id === 't1');
    expect(result).toMatchObject({ covered: true, pagesRead: 1 });
    expect(ids(result.trades)).toEqual(['t0', 't1', 't2', 't3']);
  });

  it('T6 walks a capped limit by the pages it gets, and is not covered when the cap runs out', async () => {
    const b = broker(list(5), { cap: 2 });
    const result = await read(b, 5);
    expect(b.offsets).toEqual([0, 1, 2, 3, 4]);
    expect(result).toMatchObject({ covered: true, pagesRead: 5 });
    expect(ids(result.trades)).toEqual(ids(list(5)));
    const short = await read(broker(list(5), { cap: 2 }), 2);
    expect(short).toMatchObject({ covered: false, pagesRead: 2 });
    expect(ids(short.trades)).toEqual(['t0', 't1', 't2']);
  });

  it('T7 walks a limit answered one short', async () => {
    const b = broker(list(5), { cap: PAGE - 1 });
    const result = await read(b);
    expect(b.offsets).toEqual([0, 2, 4]);
    expect(result).toMatchObject({ covered: true });
    expect(ids(result.trades)).toEqual(ids(list(5)));
  });

  it('T8 refuses a broker that ignores the offset', async () => {
    expect(await violation(read(broker(list(5), { ignoreOffset: true })))).toBe('no_progress');
    const flat = Array.from({ length: 5 }, (_, i) => trade(`f${i}`, T0));
    expect(await violation(read(broker(flat, { ignoreOffset: true })))).toBe('no_progress');
    expect(await violation(read(broker(list(1), { ignoreOffset: true })))).toBe('continuity');
  });

  it('T9 refuses a page that skips the overlap (a 1-based offset)', async () => {
    expect(await violation(read(broker(list(8), { offsetSkew: 1 })))).toBe('continuity');
  });

  it('T10 refuses a page after a trade vanished before the seam', async () => {
    const b = broker(list(8), {
      mutate: { afterPage: 1, apply: (items) => items.filter((_, i) => i !== 1) },
    });
    expect(await violation(read(b))).toBe('continuity');
  });

  it('T11 reads on when a new trade lands at the head between pages', async () => {
    const newest = trade('new', T0 + 5_000);
    const b = broker(list(6), { mutate: { afterPage: 1, apply: (items) => [newest, ...items] } });
    const result = await read(b);
    expect(result.covered).toBe(true);
    expect(ids(result.trades)).toEqual(ids(list(6)));
  });

  it('T12 refuses a page in ascending order', async () => {
    expect(await violation(read(broker([...list(3)].reverse())))).toBe('order');
  });

  it('T13 is not covered when maxPages runs out', async () => {
    expect(await read(broker(list(20)), 3)).toMatchObject({ covered: false, pagesRead: 3 });
  });

  it('T14 asks for exactly the offsets it advanced to', async () => {
    const b = broker(list(10));
    await read(b);
    expect(b.offsets).toEqual([0, 3, 6, 9]);
  });

  it('T15 refuses an unread trade newer than the previous page end', async () => {
    const [a, b0, c, d, e] = list(5);
    const between = trade('x', (c!.openTimestamp + d!.openTimestamp) / 2);
    const newest = trade('new', T0 + 5_000);
    const pages = broker([a!, b0!, c!, d!, e!], {
      mutate: { afterPage: 1, apply: () => [newest, a!, b0!, c!, between, d!, e!] },
    });
    expect(await violation(read(pages))).toBe('seam');
  });
});
