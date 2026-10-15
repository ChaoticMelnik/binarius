import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { candlesWireSchema, toCandle, type Candle } from '@binarius/shared';
import { z } from 'zod';
import { PRICE_INTERVAL } from './config';
import { lowerBound } from './window';

// the owner's per-session export: the raw broker 1s rows around one session's trades
const sessionFileSchema = z.object({
  session: z.string(),
  asset_id: z.int(),
  interval: z.literal(PRICE_INTERVAL),
  rows: candlesWireSchema,
});

interface SessionFile {
  name: string;
  assetId: number;
  candles: Candle[];
}

interface SessionFiles {
  files: SessionFile[];
  malformed: string[];
}

export function readSessionFiles(dir: string): SessionFiles {
  const result: SessionFiles = { files: [], malformed: [] };
  if (!existsSync(dir)) return result;
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    let parsed;
    try {
      parsed = sessionFileSchema.safeParse(JSON.parse(readFileSync(path.join(dir, name), 'utf8')));
    } catch {
      parsed = undefined;
    }
    if (parsed?.success !== true) {
      result.malformed.push(name);
      continue;
    }
    const candles = parsed.data.rows
      .map(toCandle)
      .sort((a, b) => a.timestamp - b.timestamp)
      .filter((candle, i, all) => i === 0 || candle.timestamp !== all[i - 1].timestamp);
    result.files.push({ name, assetId: parsed.data.asset_id, candles });
  }
  return result;
}

// one asset's rows from every file of it, ascending, the first file's row kept on a duplicate
export function mergedRows(files: readonly SessionFile[]): Candle[] {
  const byTimestamp = new Map<number, Candle>();
  for (const file of files) {
    for (const candle of file.candles) {
      if (!byTimestamp.has(candle.timestamp)) byTimestamp.set(candle.timestamp, candle);
    }
  }
  return [...byTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp);
}

interface SeriesComparison {
  compared: number;
  notInCache: number;
  revised: number;
  firstRevisedAt?: number;
}

const sameOhlc = (a: Candle, b: Candle): boolean =>
  a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close;

// The one revision rule of calibrate's gate 1, for session files and journal lines alike. Rows
// the cache lacks are not revisions; any OHLC difference on a shared timestamp is. The first row
// is skipped: an answer's first row opens at the requested window's first tick
// (docs/signal-stand.md -> The cache), so its open is not the candle's.
export function compareRows(rows: readonly Candle[], cache: readonly Candle[]): SeriesComparison {
  const result: SeriesComparison = { compared: 0, notInCache: 0, revised: 0 };
  for (const row of rows.slice(1)) {
    const found = cache[lowerBound(cache, row.timestamp)] as Candle | undefined;
    if (found?.timestamp !== row.timestamp) {
      result.notInCache++;
      continue;
    }
    result.compared++;
    if (!sameOhlc(found, row)) {
      result.revised++;
      result.firstRevisedAt ??= row.timestamp;
    }
  }
  return result;
}
