import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import {
  intervalForDuration,
  SignalKind,
  toCandle,
  tradeLogTradeJsonSchema,
  tradeOutcomeOf,
  type Candle,
  type TradeLogTradeJson,
  type TradeAction,
  type TradeOutcome,
} from '@binarius/shared';
import { replaySignalJournalEntry, type StoredSignalJournalEntry } from '@binarius/signal';
import { z } from 'zod';
import { firstTimestamp, readPairs, readSeries, seriesPath, StandError } from './cache';
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
import { firstPrice, priceIndex, type PriceAt } from './price';
import { calibrationPath } from './run';
import { compareRows, mergedRows, readSessionFiles } from './session-candles';
import { simulate, type Market } from './simulate';
import { addTrade, emptyTally, intervalOf, winRatePct, type Tally } from './stats';
import { V2_PRODUCTION_POINT, VARIANTS } from './variants';

// trade-log export --format trades-json (#666, docs/trade-log.md), or the #381 export query's
// file: the shared schema reads both; money is compared by sign only
export type LiveTrade = TradeLogTradeJson;

type Era = 'v1' | 'ambiguous' | 'v2';
const eraOf = (createdAtMs: number): Era =>
  createdAtMs < V2_MERGED_AT ? 'v1' : createdAtMs < V2_FIRST_CLEAN_AT ? 'ambiguous' : 'v2';

function liveOutcome(profit: string): TradeOutcome {
  if (/^-?0+(\.0+)?$/.test(profit)) return 'tie';
  return profit.startsWith('-') ? 'loss' : 'win';
}

interface CalibrateOptions {
  dir: string;
  journal: string;
  trades: string;
  sessionCandles: string;
  io: { out: (line: string) => void; err: (line: string) => void };
  now?: () => number;
}

interface Share {
  matched: number;
  priced: number;
}
const share = (s: Share): number => (s.priced === 0 ? 0 : (100 * s.matched) / s.priced);
export const outcomeGatePasses = (s: Share): boolean => share(s) >= CALIBRATE_MIN_OUTCOME_MATCH_PCT;

// does the stand's pricing of this entry and exit give the live outcome; undefined = no price
function matches(trade: LiveTrade, price: PriceAt, entryAt: number, exitAt: number) {
  const entry = price(entryAt);
  const exit = price(exitAt);
  if (entry === undefined || exit === undefined) return undefined;
  return tradeOutcomeOf(trade.action as TradeAction, entry, exit) === liveOutcome(trade.profit);
}

// gate 2: at the trade's own open and close, both shifted by k
const matchAtShift = (trade: LiveTrade, price: PriceAt, k: number) =>
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

// Gate 3 for one era x duration, gated from CALIBRATE_MIN_ERA_TRADES live trades. A stand with no
// decided trade is no evidence: its interval would be [0, 100] and hold any live rate.
type EraStatus = 'inside' | 'outside' | 'no_stand_evidence';
export function eraCheck(live: Tally, stand: Tally): { gated: boolean; status: EraStatus } {
  const gated = live.trades >= CALIBRATE_MIN_ERA_TRADES;
  if (stand.wins + stand.losses === 0) return { gated, status: 'no_stand_evidence' };
  const ci = intervalOf(stand);
  const rate = winRatePct(live);
  const inside = rate !== undefined && rate >= ci.low && rate <= ci.high;
  return { gated, status: inside ? 'inside' : 'outside' };
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
    if (share(shares.get(value)!) > share(shares.get(best)!)) best = value;
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
      // calibrate compares candle decisions with session trades: a shadow row is not one
      counters[parsed.kind === 'h1' ? 'h1_shadow' : parsed.kind]++;
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

// the latest line of the same pair and interval at most ATTEMPT_WINDOW_MS before the intent;
// the list is sorted by nowMs (readJournal)
function matchLine(
  lines: readonly StoredSignalJournalEntry[] | undefined,
  createdAtMs: number,
): StoredSignalJournalEntry | undefined {
  if (lines === undefined) return undefined;
  let lo = 0;
  let hi = lines.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (lines[mid].nowMs <= createdAtMs) lo = mid + 1;
    else hi = mid;
  }
  const found = lines[lo - 1] as StoredSignalJournalEntry | undefined;
  return found !== undefined && createdAtMs - found.nowMs <= ATTEMPT_WINDOW_MS ? found : undefined;
}

// the closed rows of the line; the forming row was not final when logged
const closedRows = (entry: StoredSignalJournalEntry): Candle[] =>
  entry.series
    .filter(([timestamp]) => timestamp + entry.intervalMs <= entry.nowMs)
    .map(([timestamp, open, high, low, close]) => toCandle([timestamp, open, high, low, close]));

const supportedInterval = (durationSec: number): TradeInterval | undefined => {
  const interval = intervalForDuration(durationSec) as TradeInterval;
  return TRADE_INTERVALS[interval]?.durationSec === durationSec ? interval : undefined;
};

// Before any gate: every traded asset needs its pairs.json entry and cached series, or the
// comparisons below would count nothing and pass on no evidence.
function refuseMissing(dir: string, trades: readonly LiveTrade[]): void {
  const pairs = new Set(readPairs(dir).map((pair) => pair.id));
  const needed = new Map<number, Set<string>>();
  for (const trade of trades) {
    if (eraOf(trade.created_at_ms) === 'ambiguous') continue;
    const intervals = needed.get(trade.asset_id) ?? new Set([PRICE_INTERVAL]);
    const interval = supportedInterval(trade.duration_sec);
    if (interval !== undefined) intervals.add(interval);
    needed.set(trade.asset_id, intervals);
  }
  const missing: string[] = [];
  for (const [assetId, intervals] of [...needed].sort(([a], [b]) => a - b)) {
    if (!pairs.has(assetId)) missing.push(`${assetId}: not in pairs.json`);
    for (const interval of intervals) {
      if (firstTimestamp(seriesPath(dir, assetId, interval)) === undefined)
        missing.push(`${assetId}: no ${interval} series`);
    }
  }
  if (missing.length > 0) throw new StandError(`calibrate: ${missing.join('; ')} - fetch it first`);
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
  const parsedTrades = z.array(tradeLogTradeJsonSchema).safeParse(value);
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
    unsupported_duration: 0,
    unpriced: 0,
    priced_from_session_file: 0,
    unsupported_version: 0,
    h1_shadow: 0,
    malformed_session_file: 0,
    replayed: 0,
    replay_mismatch: 0,
    series_match: 0,
    series_revised: 0,
    series_lines_not_compared: 0,
    series_rows_not_in_cache: 0,
    price_series_match: 0,
    price_series_revised: 0,
    price_files_not_compared: 0,
    price_rows_not_in_cache: 0,
  };
  refuseMissing(options.dir, trades);
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
      if (comparison.compared === 0) {
        counters.price_files_not_compared++;
      } else if (comparison.revised > 0) {
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
    const digits = digitsOf.get(assetId)!;
    const market: Market = { assetId, digits, series: intervalSeries, price };

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
        if (entry !== undefined) {
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
        const check = compareRows(closedRows(line), cacheSeries);
        counters.series_rows_not_in_cache += check.notInCache;
        if (check.compared === 0) counters.series_lines_not_compared++;
        else counters[check.revised > 0 ? 'series_revised' : 'series_match']++;
        openMinusDecision.push(trade.open_timestamp_ms - line.nowMs);
      }

      if (supportedInterval(trade.duration_sec) === undefined) {
        counters.unsupported_duration++;
        continue;
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
      if (era === 'ambiguous' || supportedInterval(trade.duration_sec) === undefined) continue;
      const key = `${era}|${trade.duration_sec}|${trade.trading_session_id}`;
      const list = windows.get(key);
      if (list === undefined) windows.set(key, [trade]);
      else list.push(trade);
    }
    for (const [key, list] of windows) {
      const [era, duration] = key.split('|');
      const interval = supportedInterval(Number(duration))!;
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
  // gate 1 needs something compared on both sources: 0 revisions among 0 rows is no evidence
  const revisionEvidence =
    counters.series_match + counters.series_revised > 0 &&
    counters.price_series_match + counters.price_series_revised > 0;
  const revisionsOk =
    revisionEvidence && counters.series_revised === 0 && counters.price_series_revised === 0;
  const outcomeOk = outcomeGatePasses(outcome);
  let erasOk = true;

  const out = io.out;
  out(
    `revisions: series_revised ${counters.series_revised} (series_match ${counters.series_match}), price_series_revised ${counters.price_series_revised} (price_series_match ${counters.price_series_match}) -> ${revisionsOk ? 'ok' : revisionEvidence ? 'FAIL' : 'FAIL no revision evidence'}`,
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
    const { gated, status } = eraCheck(row.live, stand);
    if (gated && status !== 'inside') erasOk = false;
    const verdict = !gated
      ? 'reported, not gated'
      : status === 'inside'
        ? 'ok'
        : status === 'outside'
          ? 'FAIL'
          : 'FAIL no stand evidence';
    out(
      `  ${era} ${duration} s: live ${row.live.trades} trades ${row.live.wins}W/${row.live.losses}L/${row.live.ties}T ${liveRate?.toFixed(1) ?? '-'} %; stand ${stand.trades} trades ${stand.wins}W/${stand.losses}L/${stand.ties}T ${winRatePct(stand)?.toFixed(1) ?? '-'} % [${ci.low.toFixed(1)}, ${ci.high.toFixed(1)}] -> ${verdict}`,
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

  const pass = revisionsOk && outcomeOk && erasOk;
  // a FAIL saves nothing: run would otherwise report the delay as calibrate's
  if (pass) {
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
  }
  out(`calibrate: ${pass ? 'PASS' : 'FAIL'}`);
  return pass ? 0 : 1;
}
