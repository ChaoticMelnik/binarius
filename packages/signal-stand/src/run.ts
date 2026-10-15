import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MIN_CYCLE_PAYOUT_PCT } from '@binarius/shared';
import { z } from 'zod';
import {
  firstTimestamp,
  lastTimestamp,
  readPairs,
  readSeries,
  seriesPath,
  StandError,
} from './cache';
import {
  FALLBACK_HEADLINE_DELAY_MS,
  IN_SAMPLE_SHARE,
  OPEN_DELAY_GRID_MS,
  PRICE_INTERVAL,
  PRICE_STEP_MS,
  TRADE_INTERVALS,
} from './config';
import { priceIndex } from './price';
import { buildReport, type AssetCell, type Cell, type RunData, type SeriesInfo } from './report';
import { simulate, type Market, type SimTrade } from './simulate';
import { addTrade, emptyTally, splitAt } from './stats';
import { pointLabel, VARIANTS } from './variants';

export const calibrationPath = (dir: string): string => path.join(dir, 'calibration.json');

const calibrationSchema = z.object({
  headlineDelayMs: z.int(),
  calibratedAt: z.number(),
});

// a trade belongs to the sample its decision fell in
export function splitTrades(trades: readonly SimTrade[], split: number, payout: number) {
  const inSample = emptyTally();
  const outOfSample = emptyTally();
  for (const trade of trades)
    addTrade(trade.decidedAt < split ? inSample : outOfSample, trade, payout);
  return { inSample, outOfSample };
}

const DAY_MS = 86_400_000;

export interface SeriesRange {
  label: string;
  first: number;
  last: number;
}

// `fetch --days` bounds only a series' first fetch, so pooled pairs can cover different ranges
export function rangeWarning(ranges: readonly SeriesRange[]): string | undefined {
  const days = (range: SeriesRange) => (range.last - range.first) / DAY_MS;
  const longest = Math.max(...ranges.map(days));
  const short = ranges.filter((range) => longest - days(range) > 1);
  if (short.length === 0) return undefined;
  const listed = short.map((range) => `${range.label} ${days(range).toFixed(1)} d`).join(', ');
  return `run: pooled ${PRICE_INTERVAL} ranges differ by more than a day: ${listed}, against ${longest.toFixed(1)} d`;
}

export interface RunOptions {
  dir: string;
  assets: readonly number[];
  out: string;
  headlineDelayMs?: number;
  io: { out: (line: string) => void; err: (line: string) => void };
}

// the flag first, then calibrate's choice, then the plan's fallback; the report names which
function headlineDelay(options: RunOptions): { ms: number; source: string } {
  if (options.headlineDelayMs !== undefined) {
    return { ms: options.headlineDelayMs, source: '--headline-delay' };
  }
  const file = calibrationPath(options.dir);
  if (existsSync(file)) {
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      throw new StandError(`${file}: not a calibration result`);
    }
    const parsed = calibrationSchema.safeParse(value);
    if (!parsed.success || !OPEN_DELAY_GRID_MS.some((ms) => ms === parsed.data.headlineDelayMs)) {
      throw new StandError(`${file}: not a calibration result`);
    }
    return {
      ms: parsed.data.headlineDelayMs,
      source: `calibrate, ${new Date(parsed.data.calibratedAt).toISOString()}`,
    };
  }
  return { ms: FALLBACK_HEADLINE_DELAY_MS, source: 'fallback: calibrate has not run' };
}

export function runBacktest(options: RunOptions): number {
  const { dir, io } = options;
  const delay = headlineDelay(options);
  const snapshot = readPairs(dir);
  const pairs = options.assets.map((id) => {
    const pair = snapshot.find((candidate) => candidate.id === id);
    if (pair === undefined) throw new StandError(`run: asset ${id} is not in pairs.json; fetch it`);
    return pair;
  });

  const ranges = options.assets.map((id) => {
    const file = seriesPath(dir, id, PRICE_INTERVAL);
    return { first: firstTimestamp(file), last: lastTimestamp(file) };
  });
  const firsts = ranges.map(({ first }) => first).filter((ms) => ms !== undefined);
  const lasts = ranges.map(({ last }) => last).filter((ms) => ms !== undefined);
  if (firsts.length === 0) throw new StandError(`run: no ${PRICE_INTERVAL} series in ${dir}`);
  const since = Math.min(...firsts);
  const until = Math.max(...lasts) + PRICE_STEP_MS;
  const split = splitAt(since, until, IN_SAMPLE_SHARE);
  const warning = rangeWarning(
    pairs.flatMap((pair, i) => {
      const { first, last } = ranges[i];
      return pair.payout < MIN_CYCLE_PAYOUT_PCT || first === undefined || last === undefined
        ? []
        : [{ label: `${pair.symbol} (${pair.id})`, first, last }];
    }),
  );
  if (warning !== undefined) io.err(warning);

  const cells = new Map<string, Cell>();
  const series: SeriesInfo[] = [];
  for (const pair of pairs) {
    const load = (interval: string) => {
      const rows = readSeries(seriesPath(dir, pair.id, interval), io.err);
      series.push({
        assetId: pair.id,
        interval,
        rows: rows.length,
        first: rows[0]?.timestamp,
        last: rows.at(-1)?.timestamp,
      });
      return rows;
    };
    const market: Market = {
      assetId: pair.id,
      digits: pair.digits,
      price: priceIndex(load(PRICE_INTERVAL)),
      series: Object.fromEntries(
        Object.keys(TRADE_INTERVALS).map((interval) => [interval, load(interval)]),
      ),
    };
    for (const variant of VARIANTS) {
      for (const interval of variant.intervals) {
        for (const point of variant.grid) {
          for (const pause of [false, true]) {
            for (const openDelayMs of OPEN_DELAY_GRID_MS) {
              const result = simulate(market, {
                variant,
                point,
                interval,
                pause,
                openDelayMs,
                from: since,
                until,
              });
              const asset: AssetCell = {
                ...splitTrades(result.trades, split, pair.payout),
                decisions: result.decisions,
                refusals: result.refusals,
              };
              const key = [variant.name, interval, pointLabel(point), pause, openDelayMs].join('|');
              const cell = cells.get(key) ?? {
                variant: variant.name,
                interval,
                point,
                pause,
                openDelayMs,
                perAsset: {},
              };
              cell.perAsset[pair.id] = asset;
              cells.set(key, cell);
            }
          }
        }
      }
    }
    io.err(`run: ${pair.symbol} (${pair.id}) done`);
  }

  const data: RunData = {
    since,
    split,
    until,
    headlineDelayMs: delay.ms,
    headlineDelaySource: delay.source,
    pairs: pairs.map(({ id, symbol, type, payout, fetchedAt }) => ({
      id,
      symbol,
      type,
      payout,
      fetchedAt,
    })),
    series,
    cells: [...cells.values()],
  };
  const report = buildReport(data);
  mkdirSync(options.out, { recursive: true });
  writeFileSync(path.join(options.out, 'report.md'), report.markdown);
  writeFileSync(path.join(options.out, 'report.json'), JSON.stringify(report.json, null, 2) + '\n');
  io.out(report.headline);
  io.out(`report: ${path.join(options.out, 'report.md')}`);
  return 0;
}
