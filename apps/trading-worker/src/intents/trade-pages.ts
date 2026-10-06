import type { BrokerTrade } from '@binarius/shared';

// The one reader of the broker's trade list pages, for the reconciler and the settlement catch-up
// (#90). It never takes a page's length for the list's end: a capped `limit` or a default page
// would then hide every trade past it (review M1). The end is an empty page, or a trade the caller
// says it needs nothing beyond (`stopAt`). Each next page is requested at the previous offset plus
// the page's length minus one, so it must start with a trade already read; anything else is a
// contract violation, never a short list (docs/broker-rest.md -> Trades list: assumptions).

export const TradePagesViolation = {
  // open_timestamp grows inside a page
  Order: 'order',
  // the first unread trade of a page is newer than the last trade of the previous page
  Seam: 'seam',
  // a page does not start with a trade already read
  Continuity: 'continuity',
  // a page repeated what was read, wholly (the offset was ignored)
  NoProgress: 'no_progress',
} as const;
export type TradePagesViolation = (typeof TradePagesViolation)[keyof typeof TradePagesViolation];

export class TradePagesError extends Error {
  constructor(readonly violation: TradePagesViolation) {
    super(`broker trade pages are inconsistent: ${violation}`);
    this.name = 'TradePagesError';
  }
}

export interface TradePagesRead {
  // every trade read once, in list order
  trades: BrokerTrade[];
  // the list was read to its end or to a `stopAt` trade
  covered: boolean;
  pagesRead: number;
}

export async function readTradePages(
  fetchPage: (offset: number) => Promise<BrokerTrade[]>,
  { maxPages, stopAt }: { maxPages: number; stopAt: (trade: BrokerTrade) => boolean },
): Promise<TradePagesRead> {
  const trades: BrokerTrade[] = [];
  const seen = new Set<string>();
  let previous: { lastTs: number; length: number } | undefined;
  let offset = 0;
  for (let page = 1; page <= maxPages; page += 1) {
    const items = await fetchPage(offset);
    if (items.length === 0) return { trades, covered: true, pagesRead: page };
    for (let index = 1; index < items.length; index += 1) {
      if (items[index]!.openTimestamp > items[index - 1]!.openTimestamp) {
        throw new TradePagesError(TradePagesViolation.Order);
      }
    }
    const fresh = items.filter((trade) => !seen.has(trade.id));
    if (previous !== undefined) {
      // after a one-trade page there is no overlap: only an empty page may follow
      if (previous.length === 1 || !seen.has(items[0]!.id)) {
        throw new TradePagesError(TradePagesViolation.Continuity);
      }
      if (fresh.length > 0 && fresh[0]!.openTimestamp > previous.lastTs) {
        throw new TradePagesError(TradePagesViolation.Seam);
      }
    }
    if (fresh.length === 0) {
      // only the overlap came back: the list ended exactly on the previous page
      if (items.length === 1) return { trades, covered: true, pagesRead: page };
      throw new TradePagesError(TradePagesViolation.NoProgress);
    }
    for (const trade of fresh) {
      seen.add(trade.id);
      trades.push(trade);
    }
    if (items.some(stopAt)) return { trades, covered: true, pagesRead: page };
    previous = { lastTs: items.at(-1)!.openTimestamp, length: items.length };
    offset += items.length >= 2 ? items.length - 1 : 1;
  }
  return { trades, covered: false, pagesRead: maxPages };
}
