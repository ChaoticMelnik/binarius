import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
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
  type TradeInterval,
} from './config';
import { priceIndex } from './price';
import { buildReport, type AssetCell, type Cell, type RunData, type SeriesInfo } from './report';
import { simulate, type Market, type SimTrade } from './simulate';
import { addTrade, emptyTally, splitAt } from './stats';
import { pointLabel, VARIANTS } from './variants';

// a trade belongs to the sample its decision fell in
export function splitTrades(trades: readonly SimTrade[], split: number, payout: number) {
  const inSample = emptyTally();
  const outOfSample = emptyTally();
  for (const trade of trades)
    addTrade(trade.decidedAt < split ? inSample : outOfSample, trade, payout);
  return { inSample, outOfSample };
}

export interface RunOptions {
  dir: string;
  assets: readonly number[];
  out: string;
  headlineDelayMs?: number;
  io: { out: (line: string) => void; err: (line: string) => void };
}

// the flag, else the plan's fallback; the report names which
function headlineDelay(options: RunOptions): { ms: number; source: string } {
  if (options.headlineDelayMs !== undefined) {
    return { ms: options.headlineDelayMs, source: '--headline-delay' };
  }
  return { ms: FALLBACK_HEADLINE_DELAY_MS, source: 'fallback: no --headline-delay' };
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

  const priceFiles = options.assets.map((id) => seriesPath(dir, id, PRICE_INTERVAL));
  const firsts = priceFiles.map(firstTimestamp).filter((ms) => ms !== undefined);
  const lasts = priceFiles.map(lastTimestamp).filter((ms) => ms !== undefined);
  if (firsts.length === 0) throw new StandError(`run: no ${PRICE_INTERVAL} series in ${dir}`);
  const since = Math.min(...firsts);
  const until = Math.max(...lasts) + PRICE_STEP_MS;
  const split = splitAt(since, until, IN_SAMPLE_SHARE);

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
      for (const interval of variant.intervals as readonly TradeInterval[]) {
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
