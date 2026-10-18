import * as z from 'zod';
import type { BinaryPair } from './broker';
import { unixMsSchema } from './time';

// GET /trading/pairs — the broker's binary pairs as the backend's cache last saw them (#138)
export const TRADING_PAIRS_PATH = '/trading/pairs';

export const PairsCatalogErrorCode = { Unavailable: 'catalog_unavailable' } as const;
export type PairsCatalogErrorCode =
  (typeof PairsCatalogErrorCode)[keyof typeof PairsCatalogErrorCode];

// BinaryPair's fields, named one by one: a field the broker adds later reaches the bot only once
// it is added here. isOtc stays optional because the wire omits it.
export const pairViewSchema = z.object({
  id: z.int(),
  symbol: z.string(),
  isOtc: z.boolean().optional(),
  type: z.string(),
  digits: z.int(),
  payout: z.number(),
  maxPayout: z.number(),
  minTimeframe: z.int(),
  maxTimeframe: z.int(),
  // ms since the epoch, read as "not tradable until"; 0 = no restriction
  scheduledUntil: z.number().nonnegative(),
});
export type PairView = z.infer<typeof pairViewSchema>;

// The pair's label on every screen and in the backend's summary (#428): the broker's symbol, then
// " OTC" by isOtc. The live catalog keeps OTC out of the symbol and lists 22 symbols twice, a
// regular pair and an OTC one, so the symbol alone cannot tell them apart. The symbol is an
// unbounded wire string: it is cut before the suffix, so the suffix always survives.
export const PAIR_SYMBOL_LIMIT = 64;
export const PAIR_OTC_SUFFIX = ' OTC';
export const PAIR_LABEL_MAX_LENGTH = PAIR_SYMBOL_LIMIT + PAIR_OTC_SUFFIX.length;
declare const pairLabelBrand: unique symbol;
export type PairLabel = string & { readonly [pairLabelBrand]: true };

export const pairLabel = (pair: { symbol: string; isOtc?: boolean }): PairLabel => {
  const base = pair.symbol.slice(0, PAIR_SYMBOL_LIMIT);
  return (
    pair.isOtc === true && !pair.symbol.endsWith(PAIR_OTC_SUFFIX) ? base + PAIR_OTC_SUFFIX : base
  ) as PairLabel;
};

// The broker's five types and a bucket for any other, in the order the bot lists them. The
// scanner shares its pairs among these groups and the signals screen fills its places by them
// (#460). The broker's own string never enters callback data: a group is one of these.
export const PAIR_TYPE_GROUPS = [
  'currency',
  'commodity',
  'stock',
  'cryptocurrency',
  'index',
  'other',
] as const;
export type PairTypeGroup = (typeof PAIR_TYPE_GROUPS)[number];

export const pairTypeGroupOf = (type: string): PairTypeGroup =>
  PAIR_TYPE_GROUPS.find((group) => group !== 'other' && group === type) ?? 'other';

// the best pair first: payout desc, then id asc, so an order never depends on the catalog's
export const comparePairsByPayout = (
  a: { payout: number; id: number },
  b: { payout: number; id: number },
): number => b.payout - a.payout || a.id - b.id;

// The bot's offer and the session start route read a pair the same way (#283). scheduledUntil
// is the mock broker's reading, which refuses an order only while scheduled_until > now.
export const isPairOpen = (pair: { scheduledUntil: number }, nowMs: number): boolean =>
  pair.scheduledUntil === 0 || pair.scheduledUntil <= nowMs;

export const pairAcceptsDuration = (
  pair: { minTimeframe: number; maxTimeframe: number },
  durationSec: number,
): boolean => durationSec >= pair.minTimeframe && durationSec <= pair.maxTimeframe;

// The payout order key (docs/trading-session.md -> The payout order key): at 80 % a session
// breaks even at 55.6 % right forecasts. Since #631 it refuses nothing (#379 refused a cycle below
// it): it bounds the first part of the bot's signals list; the signal stand and the spike CLI
// measure the cycle's economy by it.
export const MIN_CYCLE_PAYOUT_PCT = 80;

export const pairPayoutAccepted = (pair: { payout: number }): boolean =>
  pair.payout >= MIN_CYCLE_PAYOUT_PCT;

// The share of right forecasts at which a fixed stake neither gains nor loses: a win pays
// stake x payout / 100, a loss costs the stake.
export const breakEvenPct = (payout: number): number => (100 * 100) / (100 + payout);

export const pairsCatalogResponseSchema = z.object({
  pairs: z.array(pairViewSchema),
  // process clock of the backend, taken after the broker's answer was parsed
  fetchedAt: unixMsSchema,
  ageMs: z.int().nonnegative(),
  // the cache's own verdict (ageMs within its TTL plus one broker request); required, so a
  // backend without it cannot be read as fresh
  fresh: z.boolean(),
});
export type PairsCatalogResponse = z.infer<typeof pairsCatalogResponseSchema>;

// What a pairs cache hands out (packages/broker-rest's createPairsCatalog). Declared here, not
// in broker-rest, so the response mapping below sits beside its schema without shared depending
// on broker-rest.
export interface PairsCatalogView {
  pairs: BinaryPair[];
  fetchedAt: number;
  ageMs: number;
  fresh: boolean;
}

export function toPairView(pair: BinaryPair): PairView {
  return {
    id: pair.id,
    symbol: pair.symbol,
    ...(pair.isOtc === undefined ? {} : { isOtc: pair.isOtc }),
    type: pair.type,
    digits: pair.digits,
    payout: pair.payout,
    maxPayout: pair.maxPayout,
    minTimeframe: pair.minTimeframe,
    maxTimeframe: pair.maxTimeframe,
    scheduledUntil: pair.scheduledUntil,
  };
}

export function toPairsCatalogResponse(view: PairsCatalogView): PairsCatalogResponse {
  return {
    pairs: view.pairs.map(toPairView),
    fetchedAt: view.fetchedAt,
    ageMs: view.ageMs,
    fresh: view.fresh,
  };
}

export const safeParsePairsCatalogResponse = (input: unknown) =>
  pairsCatalogResponseSchema.safeParse(input);
