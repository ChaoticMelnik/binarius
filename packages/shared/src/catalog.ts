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

// The bot's offer and the session start route read a pair the same way (#283). scheduledUntil
// is the mock broker's reading, which refuses an order only while scheduled_until > now.
export const isPairOpen = (pair: { scheduledUntil: number }, nowMs: number): boolean =>
  pair.scheduledUntil === 0 || pair.scheduledUntil <= nowMs;

export const pairAcceptsDuration = (
  pair: { minTimeframe: number; maxTimeframe: number },
  durationSec: number,
): boolean => durationSec >= pair.minTimeframe && durationSec <= pair.maxTimeframe;

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
