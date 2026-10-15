import path from 'node:path';
import { parseArgs } from 'node:util';
import { createBrokerRestClient } from '@binarius/broker-rest';
import {
  BROKER_RATE_LIMIT_PER_MINUTE,
  parseBoundedIntegerEnv,
  parseLoopbackOrHttpsUrlEnv,
  readEnv,
  type EnvSource,
} from '@binarius/shared';
import { StandError } from './cache';
import { runCalibrate } from './calibrate';
import {
  FETCH_INTERVALS,
  OPEN_DELAY_GRID_MS,
  STAND_ASSET_IDS,
  STAND_DEFAULT_DAYS,
  STAND_DEFAULT_GETS_PER_MINUTE,
  STAND_MAX_DAYS,
} from './config';
import { fetchCandles, FETCH_STEP_MS } from './fetch';
import { createPacer, systemClock, type Clock } from './pacer';
import { runBacktest } from './run';

export const USAGE = `usage: stand <fetch|run|calibrate> [options]
  fetch      [--assets <id,...>] [--days <1-${STAND_MAX_DAYS}>] [--intervals <1s,5s,15s,1m>]
  run        [--assets <id,...>] [--out <dir>] [--headline-delay <${OPEN_DELAY_GRID_MS.join('|')}>]
  calibrate  [--journal <file>] [--trades <file>] [--session-candles <dir>]
env: STAND_DIR (required); BROKER_API_BASE_URL (fetch); STAND_MAX_GETS_PER_MINUTE (fetch, optional)`;

export interface MainIo {
  out: (line: string) => void;
  err: (line: string) => void;
  clock?: Clock;
}

class UsageError extends Error {}

function list(raw: string | undefined, fallback: readonly number[]): number[] {
  if (raw === undefined) return [...fallback];
  const ids = raw.split(',').map((item) => {
    if (!/^\d+$/.test(item)) throw new UsageError(`--assets: ${JSON.stringify(item)} is not an id`);
    return Number(item);
  });
  if (new Set(ids).size !== ids.length) throw new UsageError('--assets: an id is repeated');
  return ids;
}

function integer(
  raw: string | undefined,
  name: string,
  fallback: number,
  min: number,
  max: number,
) {
  if (raw === undefined) return fallback;
  const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!(value >= min && value <= max)) {
    throw new UsageError(`--${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

const OPTIONS = {
  assets: { type: 'string' },
  days: { type: 'string' },
  intervals: { type: 'string' },
  out: { type: 'string' },
  'headline-delay': { type: 'string' },
  journal: { type: 'string' },
  trades: { type: 'string' },
  'session-candles': { type: 'string' },
} as const;

const ALLOWED: Record<string, readonly (keyof typeof OPTIONS)[]> = {
  fetch: ['assets', 'days', 'intervals'],
  run: ['assets', 'out', 'headline-delay'],
  calibrate: ['journal', 'trades', 'session-candles'],
};

export async function main(argv: readonly string[], env: EnvSource, io: MainIo): Promise<number> {
  let command: string;
  let values: Partial<Record<keyof typeof OPTIONS, string>>;
  let dir: string;
  try {
    const parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true });
    if (parsed.positionals.length !== 1) throw new UsageError('one command expected');
    command = parsed.positionals[0];
    const allowed = ALLOWED[command] as readonly string[] | undefined;
    if (allowed === undefined) throw new UsageError(`unknown command ${command}`);
    values = parsed.values;
    const foreign = Object.keys(values).find((key) => !allowed.includes(key));
    if (foreign !== undefined) throw new UsageError(`--${foreign} is not an option of ${command}`);
    dir = path.resolve(readEnv(env, 'STAND_DIR'));
  } catch (error) {
    io.err(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }

  try {
    const clock = io.clock ?? systemClock;
    if (command === 'fetch') {
      const intervals = (values.intervals ?? FETCH_INTERVALS.join(',')).split(',');
      const unknown = intervals.find((interval) => !Object.hasOwn(FETCH_STEP_MS, interval));
      if (unknown !== undefined)
        throw new UsageError(`--intervals: ${unknown} is not a stand interval`);
      const assets = list(values.assets, STAND_ASSET_IDS);
      const days = integer(values.days, 'days', STAND_DEFAULT_DAYS, 1, STAND_MAX_DAYS);
      const baseUrl = parseLoopbackOrHttpsUrlEnv(
        readEnv(env, 'BROKER_API_BASE_URL'),
        'BROKER_API_BASE_URL',
      );
      const perMinute =
        env.STAND_MAX_GETS_PER_MINUTE === undefined
          ? STAND_DEFAULT_GETS_PER_MINUTE
          : parseBoundedIntegerEnv(
              env.STAND_MAX_GETS_PER_MINUTE,
              'STAND_MAX_GETS_PER_MINUTE',
              1,
              BROKER_RATE_LIMIT_PER_MINUTE,
            );
      await fetchCandles({
        dir,
        rest: createBrokerRestClient({ baseUrl }),
        assets,
        intervals,
        days,
        pacer: createPacer(perMinute, clock),
        clock,
        warn: io.err,
      });
      return 0;
    }
    if (command === 'run') {
      const delay = values['headline-delay'];
      if (delay !== undefined && !OPEN_DELAY_GRID_MS.some((ms) => String(ms) === delay)) {
        throw new UsageError(`--headline-delay must be one of ${OPEN_DELAY_GRID_MS.join(', ')}`);
      }
      return runBacktest({
        dir,
        assets: list(values.assets, STAND_ASSET_IDS),
        out:
          values.out ??
          path.join(dir, 'out', new Date(clock.now()).toISOString().replace(/[:.]/g, '-')),
        headlineDelayMs: delay === undefined ? undefined : Number(delay),
        io,
      });
    }
    return runCalibrate({
      dir,
      journal: values.journal ?? path.join(dir, 'live', 'journal-381.jsonl'),
      trades: values.trades ?? path.join(dir, 'live', 'trades-381.json'),
      sessionCandles: values['session-candles'] ?? path.join(dir, 'candles-sessions'),
      io,
    });
  } catch (error) {
    if (
      error instanceof UsageError ||
      (error instanceof Error && /^(Env |Missing required env )/.test(error.message))
    ) {
      io.err(`${error.message}\n${USAGE}`);
      return 2;
    }
    if (error instanceof StandError) {
      io.err(error.message);
      return 1;
    }
    throw error;
  }
}
