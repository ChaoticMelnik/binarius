import {
  PairsCatalogErrorCode,
  isPairOpen,
  intervalForDuration,
  pairAcceptsDuration,
  pairPayoutAccepted,
  pairTypeGroupOf,
  SIGNAL_SCAN_INTERVALS,
  type PairsCatalogResponse,
  type PairTypeGroup,
  type PairView,
} from '@binarius/shared';
import { BackendError, BackendErrorCode, type BackendClient } from './backend-client';

// The demo's choice of a pair and a duration, checked against a catalog read at the press
// (#125). No Telegram and no texts here: #126 checks before it shows the stake button and #127
// before it creates the intent, through readDemoTrade, and neither re-implements a check.

// 5 and 15 s only (owner, 2026-10-07, #313), filtered per pair by its own range; each is analysed
// on its own sub-minute candle (intervalForDuration).
export const DEMO_DURATIONS_SEC = [5, 15] as const;
export type DemoDurationSec = (typeof DEMO_DURATIONS_SEC)[number];
// The durations of the main path (#382), in its button order (owner: 15 s first). Each trades on
// the candle one of the backend's scanners decides, element by element with SIGNAL_SCAN_INTERVALS,
// so a listed signal is about the trade it starts; and together they are the demo's durations.
export const SIGNALS_DURATIONS_SEC = [15, 5] as const satisfies readonly DemoDurationSec[];
if (
  SIGNALS_DURATIONS_SEC.length !== SIGNAL_SCAN_INTERVALS.length ||
  SIGNALS_DURATIONS_SEC.some((sec, i) => intervalForDuration(sec) !== SIGNAL_SCAN_INTERVALS[i]) ||
  DEMO_DURATIONS_SEC.length !== SIGNALS_DURATIONS_SEC.length ||
  DEMO_DURATIONS_SEC.some((sec) => !(SIGNALS_DURATIONS_SEC as readonly number[]).includes(sec))
) {
  throw new Error("the signals screens trade the scanners' candles (see demo-catalog.ts)");
}
// the set before #313: only to recognise a button drawn with one (demo.ts, the legacy handler)
export const LEGACY_DEMO_DURATIONS_SEC = [60, 300, 900, 1800, 3600] as const;

export const DEMO_PAGE_SIZE = 12;

// the session start route reads a pair the same way (#283)
export const isOpen: (pair: PairView, nowMs: number) => boolean = isPairOpen;

export const durationOptions = (pair: PairView): DemoDurationSec[] =>
  DEMO_DURATIONS_SEC.filter((sec) => pairAcceptsDuration(pair, sec));

// only the pairs that accept a demo duration (#313): a type, a page and a count never show a pair
// the user could not trade
export const pairsOf = (catalog: PairsCatalogResponse, group: PairTypeGroup): PairView[] =>
  catalog.pairs.filter(
    (pair) => pairTypeGroupOf(pair.type) === group && durationOptions(pair).length > 0,
  );

// sorted by symbol in code-unit order, ties by id, so a page holds the same pairs on every read
// of the same catalog
export const openPairsOf = (
  catalog: PairsCatalogResponse,
  group: PairTypeGroup,
  nowMs: number,
): PairView[] =>
  pairsOf(catalog, group)
    .filter((pair) => isOpen(pair, nowMs))
    .sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : a.id - b.id));

export interface DemoPage {
  pairs: PairView[];
  // 0-based, clamped to the last page
  page: number;
  pageCount: number;
}

export function pageOf(pairs: readonly PairView[], page: number): DemoPage {
  const pageCount = Math.max(1, Math.ceil(pairs.length / DEMO_PAGE_SIZE));
  const clamped = Math.min(Math.max(0, page), pageCount - 1);
  return {
    pairs: pairs.slice(clamped * DEMO_PAGE_SIZE, (clamped + 1) * DEMO_PAGE_SIZE),
    page: clamped,
    pageCount,
  };
}

// the page a pair is listed on, 0 when it is not listed (closed or gone)
export function pageIndexOf(pairs: readonly PairView[], assetId: number): number {
  const index = pairs.findIndex((pair) => pair.id === assetId);
  return index === -1 ? 0 : Math.floor(index / DEMO_PAGE_SIZE);
}

export type DemoPairCheck =
  | { ok: true; pair: PairView }
  | { ok: false; reason: 'pair_missing' }
  | { ok: false; reason: 'pair_closed'; pair: PairView };

export function checkDemoPair(
  catalog: PairsCatalogResponse,
  assetId: number,
  nowMs: number,
): DemoPairCheck {
  const pair = catalog.pairs.find((candidate) => candidate.id === assetId);
  if (pair === undefined) return { ok: false, reason: 'pair_missing' };
  if (!isOpen(pair, nowMs)) return { ok: false, reason: 'pair_closed', pair };
  return { ok: true, pair };
}

export type DemoTradeCheck =
  | { ok: true; pair: PairView; durationSec: DemoDurationSec }
  | { ok: false; reason: 'pair_missing' }
  | { ok: false; reason: 'pair_closed' | 'duration_unsupported'; pair: PairView };

export function checkDemoTrade(
  catalog: PairsCatalogResponse,
  assetId: number,
  durationSec: number,
  nowMs: number,
): DemoTradeCheck {
  const checked = checkDemoPair(catalog, assetId, nowMs);
  if (!checked.ok) return checked;
  const { pair } = checked;
  // the duration arrives from callback data: one outside the table is refused even where the
  // pair's range would admit it (#125 review m5)
  const demoDuration = DEMO_DURATIONS_SEC.find((sec) => sec === durationSec);
  if (demoDuration === undefined || !pairAcceptsDuration(pair, demoDuration)) {
    return { ok: false, reason: 'duration_unsupported', pair };
  }
  return { ok: true, pair, durationSec: demoDuration };
}

export type DemoCatalogRead =
  | { ok: true; catalog: PairsCatalogResponse }
  | { ok: false; reason: 'catalog_unavailable' | 'catalog_stale' }
  | { ok: false; reason: 'backend_failed'; error: unknown };

// catalog_unavailable is the route's 503, told by its reason, never by the status: the route
// has no snapshot (not warmed yet, or the broker failing for longer than the cache serves one).
// catalog_stale is a snapshot the cache itself no longer calls fresh. Anything else — any other
// refusal, a 5xx, no answer, a broken body — is backend_failed and carries the error to log.
export async function readDemoCatalog(
  backend: Pick<BackendClient, 'readPairs'>,
): Promise<DemoCatalogRead> {
  let catalog;
  try {
    catalog = await backend.readPairs();
  } catch (error) {
    if (
      error instanceof BackendError &&
      error.code === BackendErrorCode.HttpStatus &&
      error.reason === PairsCatalogErrorCode.Unavailable
    ) {
      return { ok: false, reason: 'catalog_unavailable' };
    }
    return { ok: false, reason: 'backend_failed', error };
  }
  if (!catalog.fresh) return { ok: false, reason: 'catalog_stale' };
  return { ok: true, catalog };
}

// A pair-level outcome carries the catalog it was checked against, so a screen can find the
// pair's page in it without a second read.
export type DemoTradeRead =
  Exclude<DemoCatalogRead, { ok: true }> | (DemoTradeCheck & { catalog: PairsCatalogResponse });

// The read, then the check on the clock taken after it: a stale or missing catalog never reaches
// the pair check.
export async function readDemoTrade(
  backend: Pick<BackendClient, 'readPairs'>,
  assetId: number,
  durationSec: number,
  now: () => number,
): Promise<DemoTradeRead> {
  const read = await readDemoCatalog(backend);
  if (!read.ok) return read;
  return { ...checkDemoTrade(read.catalog, assetId, durationSec, now()), catalog: read.catalog };
}

// A cycle of trades (the signals screen's list, the launch, the analysis's session button) also
// needs the payout floor (#379); the manual path's single trade keeps checkDemoTrade.
export type DemoCycleCheck =
  DemoTradeCheck | { ok: false; reason: 'payout_too_low'; pair: PairView };

export function checkDemoCycle(
  catalog: PairsCatalogResponse,
  assetId: number,
  durationSec: number,
  nowMs: number,
): DemoCycleCheck {
  const checked = checkDemoTrade(catalog, assetId, durationSec, nowMs);
  if (!checked.ok) return checked;
  if (!pairPayoutAccepted(checked.pair)) {
    return { ok: false, reason: 'payout_too_low', pair: checked.pair };
  }
  return checked;
}

export type DemoCycleRead =
  Exclude<DemoCatalogRead, { ok: true }> | (DemoCycleCheck & { catalog: PairsCatalogResponse });

export async function readDemoCycle(
  backend: Pick<BackendClient, 'readPairs'>,
  assetId: number,
  durationSec: number,
  now: () => number,
): Promise<DemoCycleRead> {
  const read = await readDemoCatalog(backend);
  if (!read.ok) return read;
  return { ...checkDemoCycle(read.catalog, assetId, durationSec, now()), catalog: read.catalog };
}
