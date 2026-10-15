import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import {
  intervalForDuration,
  SignalKind,
  tradeActionSchema,
  type Candle,
  type TradeAction,
} from '@binarius/shared';
import { replaySignalJournalEntry, type StoredSignalJournalEntry } from '@binarius/signal';
import { z } from 'zod';
import { readPairs, readSeries, seriesPath, StandError } from './cache';
import {
  ATTEMPT_WINDOW_MS,
  CALIBRATE_MIN_ERA_TRADES,
  CALIBRATE_MIN_OUTCOME_MATCH_PCT,
  OPEN_DELAY_GRID_MS,
  PRICE_INTERVAL,
  PRICE_SHIFT_GRID_MS,
  TRADE_INTERVALS,
  V2_FIRST_CLEAN_AT,
  V2_MERGED_AT,
  type TradeInterval,
} from './config';
import { parseJournalLine } from './journal-line';
import { firstPrice, outcomeOf, priceIndex, type Outcome, type PriceAt } from './price';
import { calibrationPath } from './run';
import { compareRows, mergedRows, readSessionFiles } from './session-candles';
import { simulate, type Market } from './simulate';
import { addTrade, emptyTally, intervalOf, winRatePct, type Tally } from './stats';
import { V2_PRODUCTION_POINT, VARIANTS } from './variants';
import { lowerBound } from './window';

// the plan's export query (docs/signal-stand.md -> Calibration); money is compared by sign only
const liveTradeSchema = z.object({
  trading_session_id: z.string(),
  asset_id: z.int(),
  action: tradeActionSchema,
  duration_sec: z.int().positive(),
  created_at_ms: z.number(),
  open_timestamp_ms: z.number(),
  open_price: z.number(),
  close_timestamp_ms: z.number(),
  close_price: z.number(),
  profit: z.string().regex(/^-?\d+(\.\d+)?$/),
});
export type LiveTrade = z.infer<typeof liveTradeSchema>;

export type Era = 'v1' | 'ambiguous' | 'v2';
export const eraOf = (createdAtMs: number): Era =>
  createdAtMs < V2_MERGED_AT ? 'v1' : createdAtMs < V2_FIRST_CLEAN_AT ? 'ambiguous' : 'v2';

export function liveOutcome(profit: string): Outcome {
  if (/^-?0+(\.0+)?$/.test(profit)) return 'tie';
  return profit.startsWith('-') ? 'loss' : 'win';
}

export interface CalibrateOptions {
  dir: string;
  journal: string;
  trades: string;
  sessionCandles: string;
  io: { out: (line: string) => void; err: (line: string) => void };
  now?: () => number;
}

export interface Share {
  matched: number;
  priced: number;
}
export const share = (s: Share): number => (s.priced === 0 ? 0 : (100 * s.matched) / s.priced);
export const outcomeGatePasses = (s: Share): boolean => share(s) >= CALIBRATE_MIN_OUTCOME_MATCH_PCT;

// does the stand's pricing of this entry and exit give the live outcome; undefined = no price
function matches(trade: LiveTrade, price: PriceAt, entryAt: number, exitAt: number) {
  const entry = price(entryAt);
  const exit = price(exitAt);
  if (entry === undefined || exit === undefined) return undefined;
  return outcomeOf(trade.action as TradeAction, entry, exit) === liveOutcome(trade.profit);
}

// gate 2: at the trade's own open and close, both shifted by k
export const matchAtShift = (trade: LiveTrade, price: PriceAt, k: number) =>
  matches(trade, price, trade.open_timestamp_ms + k, trade.close_timestamp_ms + k);

// the headline delay: entry at created_at + delay, the stand's stand-in for the decision moment
export const matchAtDelay = (trade: LiveTrade, price: PriceAt, delay: number) =>
  matches(
    trade,
    price,
    trade.created_at_ms + delay,
    trade.created_at_ms + delay + trade.duration_sec * 1000,
  );

function count(shares: ReadonlyMap<number, Share>, key: number, matched: boolean | undefined) {
  if (matched === undefined) return;
  const s = shares.get(key)!;
  s.priced++;
  if (matched) s.matched++;
}

// gate 3 for one era x duration: gated from CALIBRATE_MIN_ERA_TRADES live trades
export function eraCheck(live: Tally, stand: Tally): { gated: boolean; inside: boolean } {
  const ci = intervalOf(stand);
  const rate = winRatePct(live);
  return {
    gated: live.trades >= CALIBRATE_MIN_ERA_TRADES,
    inside: rate !== undefined && rate >= ci.low && rate <= ci.high,
  };
}
const shareText = (s: Share) => `${s.matched}/${s.priced} = ${share(s).toFixed(1)} %`;

function quantiles(values: readonly number[]): string {
  if (values.length === 0) return 'n=0';
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return `n=${sorted.length} median ${at(0.5)} p95 ${at(0.95)} min ${sorted[0]} max ${sorted.at(-1)}`;
}

// the grid value with the highest share; a tie goes to the earlier (smaller) one
export function bestOf<T>(grid: readonly T[], shares: ReadonlyMap<T, Share>): T {
  let best = grid[0];
  for (const value of grid) {
    if (
      share(shares.get(value) ?? { matched: 0, priced: 0 }) >
      share(shares.get(best) ?? { matched: 0, priced: 0 })
    ) {
      best = value;
    }
  }
  return best;
}

function readJournal(file: string, counters: Record<string, number>) {
  if (!existsSync(file)) throw new StandError(`calibrate: ${file} does not exist`);
  const byKey = new Map<string, StoredSignalJournalEntry[]>();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    const parsed = parseJournalLine(line);
    if (parsed.kind !== 'entry') {
      counters[parsed.kind]++;
      continue;
    }
    const key = `${parsed.entry.assetId}|${parsed.entry.interval}`;
    const list = byKey.get(key) ?? [];
    list.push(parsed.entry);
    byKey.set(key, list);
  }
  for (const list of byKey.values()) list.sort((a, b) => a.nowMs - b.nowMs);
  return byKey;
}

// the latest line of the same pair and interval at most ATTEMPT_WINDOW_MS before the intent
function matchLine(
  lines: readonly StoredSignalJournalEntry[] | undefined,
  createdAtMs: number,
): StoredSignalJournalEntry | undefined {
  let found: StoredSignalJournalEntry | undefined;
  for (const entry of lines ?? []) {
    if (entry.nowMs > createdAtMs) break;
    if (createdAtMs - entry.nowMs <= ATTEMPT_WINDOW_MS) found = entry;
  }
  return found;
}

// The closed rows of the line against the cache. The forming row was not final when logged, and
// the first row of the feed's answer opens at its window (as compareRows' first row).
function seriesRevised(entry: StoredSignalJournalEntry, cache: readonly Candle[]) {
  let revised = false;
  let notInCache = 0;
  for (const [timestamp, open, high, low, close] of entry.series.slice(1)) {
    if (timestamp + entry.intervalMs > entry.nowMs) continue;
    const found = cache[lowerBound(cache, timestamp)] as Candle | undefined;
    if (found?.timestamp !== timestamp) {
      notInCache++;
      continue;
    }
    if (found.open !== open || found.high !== high || found.low !== low || found.close !== close) {
      revised = true;
    }
  }
  return { revised, notInCache };
}

interface EraRow {
  live: Tally;
  stand: Map<number, Tally>;
}

export function runCalibrate(options: CalibrateOptions): number {
  const { io } = options;
  if (!existsSync(options.trades))
    throw new StandError(`calibrate: ${options.trades} does not exist`);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(options.trades, 'utf8'));
  } catch {
    throw new StandError(`calibrate: ${options.trades} is not a trades export`);
  }
  const parsedTrades = z.array(liveTradeSchema).safeParse(value);
  if (!parsedTrades.success)
    throw new StandError(`calibrate: ${options.trades} is not a trades export`);
  const trades = parsedTrades.data;
  if (trades.length === 0) {
    io.err('calibrate: no trades');
    return 1;
  }

  const counters: Record<string, number> = {
    unmatched: 0,
    malformed_line: 0,
    version_mismatch: 0,
    ambiguous: 0,
    unpriced: 0,
    priced_from_session_file: 0,
    unsupported_version: 0,
    malformed_session_file: 0,
    replayed: 0,
    replay_mismatch: 0,
    series_match: 0,
    series_revised: 0,
    series_rows_not_in_cache: 0,
    price_series_match: 0,
    price_series_revised: 0,
    price_rows_not_in_cache: 0,
  };
  const firstRevisions: string[] = [];
  const journal = readJournal(options.journal, counters);
  const sessions = readSessionFiles(options.sessionCandles);
  counters.malformed_session_file = sessions.malformed.length;
  const digitsOf = new Map(readPairs(options.dir).map((pair) => [pair.id, pair.digits]));

  const outcomeShares = new Map<number, Share>(
    PRICE_SHIFT_GRID_MS.map((k) => [k, { matched: 0, priced: 0 }]),
  );
  const delayShares = new Map<number, Share>(
    OPEN_DELAY_GRID_MS.map((d) => [d, { matched: 0, priced: 0 }]),
  );
  const ticks = new Map<number, number[]>(PRICE_SHIFT_GRID_MS.map((k) => [k, []]));
  const openMinusCreated: number[] = [];
  const openMinusDecision: number[] = [];
  const eras = new Map<string, EraRow>();

  const assets = [...new Set(trades.map((trade) => trade.asset_id))].sort((a, b) => a - b);
  for (const assetId of assets) {
    const load = (interval: string) =>
      readSeries(seriesPath(options.dir, assetId, interval), io.err);
    const cachePrices = load(PRICE_INTERVAL);
    const files = sessions.files.filter((file) => file.assetId === assetId);
    for (const file of files) {
      const comparison = compareRows(file.candles, cachePrices);
      counters.price_rows_not_in_cache += comparison.notInCache;
      if (comparison.revised > 0) {
        counters.price_series_revised++;
        firstRevisions.push(
          `${file.name}: ${comparison.revised} rows, first ${new Date(comparison.firstRevisedAt ?? 0).toISOString()}`,
        );
      } else {
        counters.price_series_match++;
      }
    }
    const fromCache = priceIndex(cachePrices);
    const fromFiles = priceIndex(mergedRows(files));
    const price: PriceAt = firstPrice(fromCache, fromFiles);
    const intervalSeries = Object.fromEntries(
      Object.keys(TRADE_INTERVALS).map((interval) => [interval, load(interval)]),
    ) as Market['series'];
    const digits = digitsOf.get(assetId);
    const market: Market = { assetId, digits: digits ?? 0, series: intervalSeries, price };

    const own = trades.filter((trade) => trade.asset_id === assetId);
    for (const trade of own) {
      const era = eraOf(trade.created_at_ms);
      if (era === 'ambiguous') {
        counters.ambiguous++;
        continue;
      }
      const action = trade.action as TradeAction;
      const entry0 = price(trade.open_timestamp_ms);
      const exit0 = price(trade.close_timestamp_ms);
      if (entry0 === undefined || exit0 === undefined) counters.unpriced++;
      else if (
        fromCache(trade.open_timestamp_ms) === undefined ||
        fromCache(trade.close_timestamp_ms) === undefined
      ) {
        counters.priced_from_session_file++;
      }
      openMinusCreated.push(trade.open_timestamp_ms - trade.created_at_ms);
      for (const k of PRICE_SHIFT_GRID_MS) {
        count(outcomeShares, k, matchAtShift(trade, price, k));
        const entry = price(trade.open_timestamp_ms + k);
        if (entry !== undefined && digits !== undefined) {
          ticks.get(k)!.push(Math.round(Math.abs(trade.open_price - entry) * 10 ** digits));
        }
      }
      for (const delay of OPEN_DELAY_GRID_MS)
        count(delayShares, delay, matchAtDelay(trade, price, delay));

      const interval = intervalForDuration(trade.duration_sec);
      const line = matchLine(journal.get(`${assetId}|${interval}`), trade.created_at_ms);
      if (line === undefined) {
        counters.unmatched++;
      } else {
        if (line.version !== era) counters.version_mismatch++;
        const replay = replaySignalJournalEntry(line);
        const sameAction =
          line.decision.kind === SignalKind.Signal && line.decision.action === action;
        counters[
          isDeepStrictEqual(replay, line.decision) && sameAction ? 'replayed' : 'replay_mismatch'
        ]++;
        const cacheSeries = intervalSeries[interval as TradeInterval] ?? [];
        const check = seriesRevised(line, cacheSeries);
        counters.series_rows_not_in_cache += check.notInCache;
        counters[check.revised ? 'series_revised' : 'series_match']++;
        openMinusDecision.push(trade.open_timestamp_ms - line.nowMs);
      }

      const key = `${era}|${trade.duration_sec}`;
      const row = eras.get(key) ?? { live: emptyTally(), stand: new Map() };
      addTrade(row.live, { outcome: liveOutcome(trade.profit) }, 0);
      eras.set(key, row);
    }

    // the stand's same decider inside each session's own time window, per era and duration
    const windows = new Map<string, LiveTrade[]>();
    for (const trade of own) {
      const era = eraOf(trade.created_at_ms);
      if (era === 'ambiguous') continue;
      const key = `${era}|${trade.duration_sec}|${trade.trading_session_id}`;
      windows.set(key, [...(windows.get(key) ?? []), trade]);
    }
    for (const [key, list] of windows) {
      const [era, duration] = key.split('|');
      const interval = intervalForDuration(Number(duration)) as TradeInterval;
      if (TRADE_INTERVALS[interval]?.durationSec !== Number(duration) || digits === undefined)
        continue;
      const variant = VARIANTS.find((v) => v.name === era)!;
      const point = era === 'v2' ? V2_PRODUCTION_POINT : {};
      const row = eras.get(`${era}|${duration}`)!;
      for (const delay of OPEN_DELAY_GRID_MS) {
        const result = simulate(market, {
          variant,
          point,
          interval,
          pause: era === 'v2',
          openDelayMs: delay,
          from: Math.min(...list.map((t) => t.created_at_ms)),
          until: Math.max(...list.map((t) => t.close_timestamp_ms)),
        });
        const tally = row.stand.get(delay) ?? emptyTally();
        for (const trade of result.trades) addTrade(tally, trade, 0);
        row.stand.set(delay, tally);
      }
    }
  }

  const bestK = bestOf(PRICE_SHIFT_GRID_MS, outcomeShares);
  const headlineDelayMs = bestOf(OPEN_DELAY_GRID_MS, delayShares);
  const outcome = outcomeShares.get(bestK)!;
  const revisionsOk = counters.series_revised === 0 && counters.price_series_revised === 0;
  const outcomeOk = outcomeGatePasses(outcome);
  let erasOk = true;

  const out = io.out;
  out(
    `revisions: series_revised ${counters.series_revised} (series_match ${counters.series_match}), price_series_revised ${counters.price_series_revised} (price_series_match ${counters.price_series_match}) -> ${revisionsOk ? 'ok' : 'FAIL'}`,
  );
  for (const line of firstRevisions) out(`  revised: ${line}`);
  out(
    `outcome match at the trade's own timestamps, best k ${bestK} ms: ${shareText(outcome)} (floor ${CALIBRATE_MIN_OUTCOME_MATCH_PCT} %) -> ${outcomeOk ? 'ok' : 'FAIL'}`,
  );
  for (const k of PRICE_SHIFT_GRID_MS) out(`  k ${k} ms: ${shareText(outcomeShares.get(k)!)}`);
  out(
    `live against the stand per era (stand at openDelay ${headlineDelayMs} ms; gated with >= ${CALIBRATE_MIN_ERA_TRADES} live trades):`,
  );
  for (const [key, row] of [...eras].sort(([a], [b]) => a.localeCompare(b))) {
    const [era, duration] = key.split('|');
    const stand = row.stand.get(headlineDelayMs) ?? emptyTally();
    const ci = intervalOf(stand);
    const liveRate = winRatePct(row.live);
    const { gated, inside } = eraCheck(row.live, stand);
    if (gated && !inside) erasOk = false;
    out(
      `  ${era} ${duration} s: live ${row.live.trades} trades ${row.live.wins}W/${row.live.losses}L/${row.live.ties}T ${liveRate?.toFixed(1) ?? '-'} %; stand ${stand.trades} trades ${stand.wins}W/${stand.losses}L/${stand.ties}T ${winRatePct(stand)?.toFixed(1) ?? '-'} % [${ci.low.toFixed(1)}, ${ci.high.toFixed(1)}] -> ${gated ? (inside ? 'ok' : 'FAIL') : 'reported, not gated'}`,
    );
  }
  out(`headline openDelay (entry at created_at + delay): ${headlineDelayMs} ms`);
  for (const delay of OPEN_DELAY_GRID_MS)
    out(`  ${delay} ms: ${shareText(delayShares.get(delay)!)}`);
  out(`open_timestamp - created_at ms: ${quantiles(openMinusCreated)}`);
  out(`open_timestamp - journal nowMs ms (matched): ${quantiles(openMinusDecision)}`);
  for (const k of PRICE_SHIFT_GRID_MS)
    out(`open price error in ticks at k ${k} ms: ${quantiles(ticks.get(k)!)}`);
  out(
    `counters: ${Object.entries(counters)
      .map(([name, count]) => `${name} ${count}`)
      .join(', ')}`,
  );

  mkdirSync(options.dir, { recursive: true });
  writeFileSync(
    calibrationPath(options.dir),
    JSON.stringify(
      {
        headlineDelayMs,
        calibratedAt: (options.now ?? Date.now)(),
        bestK,
        outcomeMatchPct: share(outcome),
      },
      null,
      2,
    ) + '\n',
  );
  const pass = revisionsOk && outcomeOk && erasOk;
  out(`calibrate: ${pass ? 'PASS' : 'FAIL'}`);
  return pass ? 0 : 1;
}
