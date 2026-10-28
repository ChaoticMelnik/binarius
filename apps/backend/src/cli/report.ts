import { parseInstant, UsageError } from './trade-log';

// What the reports of the CLIs share (#502): the window parser of `trade-log report` (and of
// `h1 shadow report` until #830), and the labels of its cells.

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const RELATIVE_SINCE = /^([1-9]\d{0,3})([hd])$/;

export type Since = { at: Date } | { hours: number } | { days: number };

export function parseSince(raw: string, flag: string): Since {
  const relative = RELATIVE_SINCE.exec(raw);
  if (relative !== null) {
    const n = Number(relative[1]);
    return relative[2] === 'h' ? { hours: n } : { days: n };
  }
  try {
    return { at: parseInstant(raw, flag) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new UsageError(`${message}; или N часов/дней до --until: 24h, 7d (N от 1 до 9999)`);
  }
}

export interface Window {
  since: Date;
  until: Date;
}

// a relative --since counts back from until, the database's clock by default: one clock with the
// rows the report reads
export function resolveWindow(args: { since: Since; until: Date | undefined }, end: Date): Window {
  const until = args.until ?? end;
  const { since } = args;
  if ('at' in since) return { since: since.at, until };
  const back = 'hours' in since ? since.hours * HOUR_MS : since.days * DAY_MS;
  return { since: new Date(until.getTime() - back), until };
}

export const NO_TRADES = 'нет сделок';
export const NO_PAYOUT = 'нет выплаты';
export const ALL_PAIRS = 'все пары';
