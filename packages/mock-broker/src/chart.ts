import type { BinaryPairWire } from '@binarius/shared';
import { FIXTURE_MESSAGES, LIVE_MESSAGES } from './messages';
import { rawPriceAt, roundTo, wickAt } from './price';

export type Candle5 = [number, number, number, number, number];

const UNIT_MS = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
  // the broker's month length is not known; 30 days is the fixture's choice
  M: 2_592_000_000,
} satisfies Record<string, number>;

const INTERVAL = /^(\d+)(ms|s|m|h|d|w|M)$/;

// observed: 500ms and 0m answer [], 5s answers data; the exact threshold is an approximation
export const MIN_CANDLE_STEP_MS = 5_000;
// below this a start_time is in seconds, which the live broker answers with []
const MS_EPOCH_THRESHOLD = 1e11;
export const DEFAULT_CHART_LIMIT = 100;
// limit=5000 returned 4999 rows live; whether that is a cap or the data window is not known
export const MAX_CHART_LIMIT = 5_000;

export type ChartQuery =
  | { ok: true; empty: true }
  | {
      ok: true;
      empty: false;
      pair: BinaryPairWire;
      stepMs: number;
      startTime: number;
      limit: number;
    }
  | { ok: false; message: string };

export function parseIntervalMs(raw: string): number | undefined {
  const match = INTERVAL.exec(raw);
  if (match === null) return undefined;
  const [, count = '0', unitName = 'ms'] = match;
  return Number(count) * UNIT_MS[unitName as keyof typeof UNIT_MS];
}

function stringParam(query: Record<string, unknown>, key: string): string | undefined {
  const value = query[key];
  return typeof value === 'string' ? value : undefined;
}

// validation order is the live broker's: interval, then asset, then start_time
export function validateChartQuery(
  query: Record<string, unknown>,
  findPair: (id: number) => BinaryPairWire | undefined,
): ChartQuery {
  const interval = stringParam(query, 'interval');
  if (interval === undefined) return { ok: false, message: FIXTURE_MESSAGES.required('interval') };
  const stepMs = parseIntervalMs(interval);
  if (stepMs === undefined)
    return { ok: false, message: LIVE_MESSAGES.unsupportedInterval(interval) };

  const assetId = stringParam(query, 'asset_id');
  const pair =
    assetId !== undefined && /^\d+$/.test(assetId) ? findPair(Number(assetId)) : undefined;
  if (pair === undefined) return { ok: false, message: LIVE_MESSAGES.unknownAsset };

  const startRaw = stringParam(query, 'start_time');
  if (startRaw === undefined || !/^\d+$/.test(startRaw)) {
    return { ok: false, message: LIVE_MESSAGES.startTimeRequired };
  }
  const startTime = Number(startRaw);

  if (stepMs < MIN_CANDLE_STEP_MS || startTime < MS_EPOCH_THRESHOLD)
    return { ok: true, empty: true };

  const limitRaw = stringParam(query, 'limit');
  const requested = limitRaw !== undefined && /^\d+$/.test(limitRaw) ? Number(limitRaw) : 0;
  const limit = requested <= 0 ? DEFAULT_CHART_LIMIT : Math.min(requested, MAX_CHART_LIMIT);
  return { ok: true, empty: false, pair, stepMs, startTime, limit };
}

export function candleAt(pair: BinaryPairWire, ts: number, stepMs: number): Candle5 {
  const open = roundTo(rawPriceAt(pair.id, ts), pair.digits);
  const close = roundTo(rawPriceAt(pair.id, ts + stepMs), pair.digits);
  const wick = wickAt(pair.id, ts);
  // open and close are already rounded, so rounding the widened bounds cannot cross them
  const high = roundTo(Math.max(open, close) + wick, pair.digits);
  const low = roundTo(Math.min(open, close) - wick, pair.digits);
  return [ts, open, high, low, close];
}

export function buildCandles(
  pair: BinaryPairWire,
  stepMs: number,
  startTime: number,
  limit: number,
  nowMs: number,
): Candle5[] {
  const candles: Candle5[] = [];
  for (
    let ts = Math.floor(startTime / stepMs) * stepMs;
    ts <= nowMs && candles.length < limit;
    ts += stepMs
  ) {
    candles.push(candleAt(pair, ts, stepMs));
  }
  return candles;
}
