import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MIN_CYCLE_PAYOUT_PCT } from '@binarius/shared';
import { createH1Detector, DEFAULT_H1_PARAMS } from '@binarius/signal';
import {
  firstTimestamp,
  lastTimestamp,
  readPairs,
  readSeries,
  seriesPath,
  StandError,
} from './cache';
import {
  H1_ENTRY_DELAY_GRID_SEC,
  H1_EXPIRY_GRID_SEC,
  H1_THRESHOLD_GRID,
  IN_SAMPLE_SHARE,
  PRICE_INTERVAL,
  PRICE_STEP_MS,
} from './config';
import { closesBySecond, simulateH1 } from './h1-simulate';
import { buildH1Report, type H1Cell } from './h1-report';
import type { SeriesInfo } from './report';
import { rangeWarning, splitTrades } from './run';
import { splitAt } from './stats';

export interface H1RunOptions {
  dir: string;
  assets: readonly number[];
  out: string;
  // subsets of the grids; the whole grid when absent
  thresholds?: readonly number[];
  delays?: readonly number[];
  expiries?: readonly number[];
  io: { out: (line: string) => void; err: (line: string) => void };
}

export function runH1(options: H1RunOptions): number {
  const { dir, io } = options;
  const snapshot = readPairs(dir);
  const pairs = options.assets.map((id) => {
    const pair = snapshot.find((candidate) => candidate.id === id);
    if (pair === undefined) throw new StandError(`h1: asset ${id} is not in pairs.json; fetch it`);
    return pair;
  });

  const ranges = pairs.map((pair) => {
    const file = seriesPath(dir, pair.id, PRICE_INTERVAL);
    return { first: firstTimestamp(file), last: lastTimestamp(file) };
  });
  const firsts = ranges.map(({ first }) => first).filter((ms) => ms !== undefined);
  const lasts = ranges.map(({ last }) => last).filter((ms) => ms !== undefined);
  if (firsts.length === 0) throw new StandError(`h1: no ${PRICE_INTERVAL} series in ${dir}`);
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

  const thresholds = options.thresholds ?? H1_THRESHOLD_GRID;
  const delays = options.delays ?? H1_ENTRY_DELAY_GRID_SEC;
  const expiries = options.expiries ?? H1_EXPIRY_GRID_SEC;
  const detectors = thresholds.map((threshold) =>
    createH1Detector({ ...DEFAULT_H1_PARAMS, threshold }),
  );
  const cells: H1Cell[] = detectors.flatMap((detector) =>
    delays.flatMap((entryDelaySec) =>
      expiries.map((expirySec) => ({
        threshold: detector.params.threshold,
        entryDelaySec,
        expirySec,
        perAsset: {},
      })),
    ),
  );

  const series: SeriesInfo[] = [];
  for (const pair of pairs) {
    const rows = readSeries(seriesPath(dir, pair.id, PRICE_INTERVAL), io.err);
    series.push({
      assetId: pair.id,
      interval: PRICE_INTERVAL,
      rows: rows.length,
      first: rows[0]?.timestamp,
      last: rows.at(-1)?.timestamp,
    });
    const seconds = closesBySecond(rows);
    if (seconds === undefined) continue;
    for (const cell of cells) {
      const detector = detectors[thresholds.indexOf(cell.threshold)];
      const result = simulateH1(seconds, detector, cell);
      cell.perAsset[pair.id] = {
        ...splitTrades(result.trades, split, pair.payout),
        decisions: result.decisions,
        refusals: result.refusals,
      };
    }
    io.err(`h1: ${pair.symbol} (${pair.id}) done`);
  }

  const report = buildH1Report({
    since,
    split,
    until,
    thresholds,
    delays,
    expiries,
    pairs: pairs.map(({ id, symbol, type, payout, fetchedAt }) => ({
      id,
      symbol,
      type,
      payout,
      fetchedAt,
    })),
    series,
    cells,
  });
  mkdirSync(options.out, { recursive: true });
  writeFileSync(path.join(options.out, 'report-h1.md'), report.markdown);
  writeFileSync(
    path.join(options.out, 'report-h1.json'),
    JSON.stringify(report.json, null, 2) + '\n',
  );
  io.out(report.headline);
  io.out(`report: ${path.join(options.out, 'report-h1.md')}`);
  return 0;
}
