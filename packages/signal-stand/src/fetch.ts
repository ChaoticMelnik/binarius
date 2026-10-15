import { BrokerRestError, type BrokerRestClient } from '@binarius/broker-rest';
import { BrokerRestErrorCode, errorIdentity } from '@binarius/shared';
import {
  appendRows,
  lastTimestamp,
  seriesPath,
  StandError,
  writePairs,
  type PairSnapshot,
  type Warn,
} from './cache';
import { STAND_PAGE_LIMIT } from './config';
import type { Clock, Pacer } from './pacer';

export const FETCH_STEP_MS: Readonly<Record<string, number>> = {
  '1s': 1_000,
  '5s': 5_000,
  '15s': 15_000,
  '1m': 60_000,
};

const DAY_MS = 86_400_000;
const DEFAULT_RETRY_MS = 60_000;

export interface FetchOptions {
  dir: string;
  rest: Pick<BrokerRestClient, 'getChart' | 'listPairs'>;
  assets: readonly number[];
  intervals: readonly string[];
  days: number;
  pacer: Pacer;
  clock: Clock;
  warn: Warn;
  pageLimit?: number;
}

// The code and the numbers only: the broker's detail string is never printed (Rule 8).
function describe(error: BrokerRestError): string {
  const { name, code } = errorIdentity(error);
  const status = error.status === undefined ? '' : ` status ${error.status}`;
  const retry = error.retryAfterSec === undefined ? '' : ` retryAfterSec ${error.retryAfterSec}`;
  return `${name}/${code ?? '?'}${status}${retry}`;
}

// one public GET; a 429 waits as told (60 s without a Retry-After) and asks again
async function paced<T>(options: FetchOptions, what: string, call: () => Promise<T>): Promise<T> {
  for (;;) {
    await options.pacer.take();
    try {
      return await call();
    } catch (error) {
      if (!(error instanceof BrokerRestError)) throw error;
      if (error.code !== BrokerRestErrorCode.RateLimited) {
        throw new StandError(`fetch ${what}: ${describe(error)}`);
      }
      const waitMs =
        error.retryAfterSec === undefined ? DEFAULT_RETRY_MS : error.retryAfterSec * 1000;
      options.warn(`fetch ${what}: rate limited, waiting ${waitMs / 1000} s`);
      await options.clock.sleep(waitMs);
    }
  }
}

async function fetchSeries(options: FetchOptions, assetId: number, interval: string) {
  const stepMs = FETCH_STEP_MS[interval];
  const file = seriesPath(options.dir, assetId, interval);
  const what = `${assetId} ${interval}`;
  const limit = options.pageLimit ?? STAND_PAGE_LIMIT;
  const until = options.clock.now();
  let last = lastTimestamp(file);
  let startTime = Math.max(last === undefined ? 0 : last + stepMs, until - options.days * DAY_MS);
  let pages = 0;
  let rows = 0;
  // ask only while the window can hold a closed candle
  while (startTime + stepMs <= until) {
    // The first row of every answer opens at the window's first tick, not at the previous close
    // (observed 2026-10-15: every difference between the broker's answers was the `open` of an
    // answer's first row). Each request starts one step early, and its first row is not kept.
    const requestStart = startTime - stepMs;
    const page = await paced(options, what, () =>
      options.rest.getChart({ assetId, interval, startTime: requestStart, limit }),
    );
    pages++;
    // the forming candle is not stored: its close is not final, and a stored row is never redone
    const closedBefore = options.clock.now();
    const fresh = page
      .slice(1)
      .filter(
        (candle) =>
          (last === undefined || candle.timestamp > last) &&
          candle.timestamp + stepMs <= closedBefore,
      );
    appendRows(file, fresh, options.warn);
    rows += fresh.length;
    last = fresh.at(-1)?.timestamp ?? last;
    // The broker answers the time window [start, start + limit x step): a gap shortens the page,
    // and a gap longer than the window answers [] (observed 2026-10-15). The next window starts
    // after the page's last row, or after the whole window when it was empty.
    const pageLast = page.at(-1)?.timestamp;
    startTime =
      pageLast === undefined
        ? requestStart + limit * stepMs + stepMs
        : Math.max(pageLast + stepMs, startTime + stepMs);
  }
  const lastIso = last === undefined ? 'none' : new Date(last).toISOString();
  options.warn(`fetch ${what}: ${rows} new rows in ${pages} pages, last ${lastIso}`);
}

export async function fetchCandles(options: FetchOptions): Promise<void> {
  for (const interval of options.intervals) {
    if (!Object.hasOwn(FETCH_STEP_MS, interval)) {
      throw new StandError(`fetch: interval ${interval} is not one of the stand's`);
    }
  }
  const catalog = await paced(options, 'pairs', () => options.rest.listPairs());
  const fetchedAt = options.clock.now();
  const snapshots: PairSnapshot[] = options.assets.map((assetId) => {
    const pair = catalog.find((candidate) => candidate.id === assetId);
    if (pair === undefined) throw new StandError(`fetch: asset ${assetId} is not in the catalog`);
    const { id, symbol, type, digits, payout, minTimeframe } = pair;
    return { id, symbol, type, digits, payout, minTimeframe, fetchedAt };
  });
  writePairs(options.dir, snapshots);
  for (const assetId of options.assets) {
    for (const interval of options.intervals) await fetchSeries(options, assetId, interval);
  }
}
