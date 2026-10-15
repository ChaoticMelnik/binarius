import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { candleWireSchema, toCandle, type Candle, type CandleWire } from '@binarius/shared';
import { z } from 'zod';

// a refusal the CLI ends with exit 1; its message names files and counts, never a URL or a body
export class StandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StandError';
  }
}

export type Warn = (line: string) => void;

export const seriesPath = (dir: string, assetId: number, interval: string): string =>
  path.join(dir, 'candles', String(assetId), `${interval}.jsonl`);

const toRow = (candle: Candle): CandleWire => [
  candle.timestamp,
  candle.open,
  candle.high,
  candle.low,
  candle.close,
];

function parseRow(line: string): Candle | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  const parsed = candleWireSchema.safeParse(value);
  return parsed.success ? toCandle(parsed.data) : undefined;
}

// Every line is checked against the wire's own shape. Only the last one may be broken - a crash
// mid-append - and it is dropped; a broken line anywhere else is a damaged cache. A row at or
// before the previous one is skipped, so the series is strictly ascending whatever was appended.
export function readSeries(file: string, warn: Warn): Candle[] {
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const candles: Candle[] = [];
  let skipped = 0;
  for (let i = 0; i < lines.length; i++) {
    const candle = parseRow(lines[i]);
    if (candle === undefined) {
      if (i === lines.length - 1) {
        warn(`${file}: the last line is not a candle row, dropped`);
        break;
      }
      throw new StandError(`${file}: line ${i + 1} is not a candle row`);
    }
    const previous = candles.at(-1);
    if (previous !== undefined && candle.timestamp <= previous.timestamp) {
      skipped++;
      continue;
    }
    candles.push(candle);
  }
  if (skipped > 0) warn(`${file}: ${skipped} rows not after their predecessor, skipped`);
  return candles;
}

const TAIL_BYTES = 4_096;

// the timestamp of the last complete row, without reading a 50 MB file to find it
export function lastTimestamp(file: string): number | undefined {
  if (!existsSync(file)) return undefined;
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const candle = parseRow(lines[i]);
      if (candle !== undefined) return candle.timestamp;
    }
    return undefined;
  } finally {
    closeSync(fd);
  }
}

export function firstTimestamp(file: string): number | undefined {
  if (!existsSync(file)) return undefined;
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(TAIL_BYTES);
    const read = readSync(fd, buffer, 0, TAIL_BYTES, 0);
    const line = buffer.toString('utf8', 0, read).split('\n')[0];
    return parseRow(line)?.timestamp;
  } finally {
    closeSync(fd);
  }
}

// cuts a partial last line, so the next append starts on a line of its own
function repairTail(file: string, warn: Warn): void {
  if (!existsSync(file)) return;
  const text = readFileSync(file, 'utf8');
  if (text === '' || text.endsWith('\n')) return;
  truncateSync(file, Buffer.byteLength(text.slice(0, text.lastIndexOf('\n') + 1)));
  warn(`${file}: a partial last line was cut before appending`);
}

export function appendRows(file: string, candles: readonly Candle[], warn: Warn): void {
  if (candles.length === 0) return;
  mkdirSync(path.dirname(file), { recursive: true });
  repairTail(file, warn);
  appendFileSync(file, candles.map((candle) => JSON.stringify(toRow(candle))).join('\n') + '\n');
}

const pairSnapshotSchema = z.strictObject({
  id: z.int(),
  symbol: z.string(),
  type: z.string(),
  digits: z.int().nonnegative(),
  payout: z.number(),
  minTimeframe: z.int(),
  fetchedAt: z.number(),
});
export type PairSnapshot = z.infer<typeof pairSnapshotSchema>;
const pairsFileSchema = z.array(pairSnapshotSchema);

export const pairsPath = (dir: string): string => path.join(dir, 'pairs.json');

export function readPairs(dir: string): PairSnapshot[] {
  const file = pairsPath(dir);
  if (!existsSync(file)) return [];
  const parsed = pairsFileSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  if (!parsed.success) throw new StandError(`${file}: not a pairs snapshot`);
  return parsed.data;
}

// a fetch of some pairs keeps the snapshot of the others
export function writePairs(dir: string, pairs: readonly PairSnapshot[]): void {
  const kept = readPairs(dir).filter((old) => !pairs.some((pair) => pair.id === old.id));
  const all = [...kept, ...pairs].sort((a, b) => a.id - b.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(pairsPath(dir), JSON.stringify(all, null, 2) + '\n');
}
