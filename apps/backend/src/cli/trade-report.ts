import { parseArgs } from 'node:util';
import {
  breakEvenPct,
  formatSignedUsd,
  formatUsd,
  markdownTable,
  SIGNAL_INTERVALS,
  TradeMode,
  verdictOf,
  wilson,
  type Interval95,
  type SignalInterval,
} from '@binarius/shared';
import {
  readTradeLogEnd,
  readTradeReportStats,
  TradeReportOrigin,
  type Db,
  type TradeReportCell,
  type TradeReportStats,
} from '@binarius/db';
import { formatFailure } from './kill-switch';
import {
  ALL_PAIRS,
  NO_PAYOUT,
  NO_TRADES,
  parseSince,
  resolveWindow,
  type Since,
  type Window,
} from './report';
import { parseInstant, UsageError } from './trade-log';

// The trade report (#502, docs/trade-log.md → The report): win rate, 95 % CI, break-even and P&L
// of the closed trades of a window, per mode, by version × params fingerprint × pair × interval ×
// duration, and the trades without a decision row apart. Reads only; counts and money come summed
// from SQL (readTradeReportStats), this file lays them out. trade-log.ts parses the command and
// owns the connection.
// 0 the report is printed, 1 no closed trade in the window (an empty sample is not a pass) or a
// failure, 2 not understood.
const EXIT_OK = 0;
const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

export interface TradeReportArgs {
  since: Since;
  // undefined: the database's clock when the report starts, the clock created_at is written by
  until: Date | undefined;
}

// argv after `trade-log`: `report` and its options
export function parseTradeReportArgs(argv: readonly string[]): TradeReportArgs {
  let values: { since?: string; until?: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: { since: { type: 'string' }, until: { type: 'string' } },
    }));
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  if (positionals.length > 1) throw new UsageError('лишние аргументы');
  if (values.since === undefined) throw new UsageError('нужен --since');
  const since = parseSince(values.since, '--since');
  const until = values.until === undefined ? undefined : parseInstant(values.until, '--until');
  if ('at' in since && until !== undefined && until.getTime() <= since.at.getTime()) {
    throw new UsageError('--until должен быть позже --since');
  }
  return { since, until };
}

export const MANUAL_LABEL = 'разовые сделки (без решения)';
export const UNLINKED_LABEL = 'сессия без записи решения';
const NONE = '—';

const TABLE_HEAD = [
  'версия',
  'параметры',
  'пара',
  'интервал',
  'длит., с',
  'сделок',
  'не закрыто',
  'W',
  'L',
  'T',
  'win %',
  '95 % CI',
  'выплата, средн. (min-max)',
  'безубыточность %',
  'вердикт',
  'ставок',
  'P&L',
  'ROI %',
];

const VERSIONS_HEAD = [
  'версия',
  'отпечаток',
  'сделок',
  'первая сделка',
  'последняя сделка',
  'params',
];

// one printed row of a mode's table
export interface TradeReportRow {
  mode: TradeMode;
  origin: TradeReportOrigin;
  version: string;
  params: string;
  pair: string;
  interval: string;
  durationSec: number;
  trades: number;
  notClosed: number;
  wins: number;
  losses: number;
  ties: number;
  winPct: number | undefined;
  ci: Interval95 | undefined;
  payout: string;
  breakEven: number | undefined;
  verdict: string;
  staked: string;
  pnl: string;
  roiPct: string;
}

export interface TradeReport {
  markdown: string;
  rows: TradeReportRow[];
  // for stderr: the intents of the window without a closed trade, by status
  warnings: string[];
}

const ORIGIN_ORDER: readonly TradeReportOrigin[] = [
  TradeReportOrigin.Signal,
  TradeReportOrigin.Manual,
  TradeReportOrigin.Unlinked,
];
const MODE_ORDER: readonly TradeMode[] = [TradeMode.Demo, TradeMode.Real];

const intervalRank = (interval: SignalInterval | null) =>
  interval === null ? SIGNAL_INTERVALS.length : SIGNAL_INTERVALS.indexOf(interval);
const textOrder = (a: string | null, b: string | null) =>
  a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1;

// the group a pair row and its pooled row share
const groupKey = (cell: TradeReportCell) =>
  JSON.stringify([cell.origin, cell.version, cell.paramsHash, cell.interval, cell.durationSec]);

function compareGroups(a: TradeReportCell, b: TradeReportCell): number {
  return (
    ORIGIN_ORDER.indexOf(a.origin) - ORIGIN_ORDER.indexOf(b.origin) ||
    textOrder(a.version, b.version) ||
    textOrder(a.paramsHash, b.paramsHash) ||
    intervalRank(a.interval) - intervalRank(b.interval) ||
    a.durationSec - b.durationSec
  );
}

// by trades, most first, then by asset id
const comparePairs = (a: TradeReportCell, b: TradeReportCell) =>
  b.trades - a.trades || (a.assetId ?? 0) - (b.assetId ?? 0);

const fixed = (value: number | undefined) => (value === undefined ? '-' : value.toFixed(2));
// SQL's rounded text with a sign for a gain; a zero keeps none
const signedPct = (text: string) =>
  text.startsWith('-') || /^0(\.0*)?$/.test(text) ? text : `+${text}`;

function versionLabel(cell: TradeReportCell): string {
  if (cell.origin === TradeReportOrigin.Manual) return MANUAL_LABEL;
  if (cell.origin === TradeReportOrigin.Unlinked) return UNLINKED_LABEL;
  return cell.version ?? NONE;
}

function pairLabel(cell: TradeReportCell): string {
  if (cell.pooled) return ALL_PAIRS;
  return cell.symbol === null ? String(cell.assetId) : `${cell.symbol} (${cell.assetId})`;
}

// no cell without evidence beats break-even: no decided trade -> no trades, no payout -> no payout
function judged(cell: TradeReportCell) {
  const decided = cell.wins + cell.losses;
  const mean = cell.priced > 0 ? cell.payoutMean : null;
  const breakEven = mean === null ? undefined : breakEvenPct(mean);
  const payout = mean === null ? '-' : `${mean.toFixed(2)} (${cell.payoutMin}-${cell.payoutMax})`;
  if (decided === 0) {
    return { winPct: undefined, ci: undefined, payout, breakEven, verdict: NO_TRADES };
  }
  const ci = wilson(cell.wins, decided);
  return {
    winPct: (100 * cell.wins) / decided,
    ci,
    payout,
    breakEven,
    verdict: breakEven === undefined ? NO_PAYOUT : verdictOf(ci, breakEven),
  };
}

function rowOf(cell: TradeReportCell): TradeReportRow {
  return {
    mode: cell.mode,
    origin: cell.origin,
    version: versionLabel(cell),
    params: cell.paramsHash === null ? NONE : cell.paramsHash.slice(0, 8),
    pair: pairLabel(cell),
    interval: cell.interval ?? NONE,
    durationSec: cell.durationSec,
    trades: cell.trades,
    notClosed: cell.notClosed,
    wins: cell.wins,
    losses: cell.losses,
    ties: cell.ties,
    ...judged(cell),
    staked: cell.staked === null ? '-' : formatUsd(cell.staked),
    pnl: cell.pnl === null ? '-' : formatSignedUsd(cell.pnl),
    roiPct: cell.roiPct === null ? '-' : signedPct(cell.roiPct),
  };
}

const lineOf = (row: TradeReportRow): (string | number)[] => [
  row.version,
  row.params,
  row.pair,
  row.interval,
  row.durationSec,
  row.trades,
  row.notClosed,
  row.wins,
  row.losses,
  row.ties,
  fixed(row.winPct),
  row.ci === undefined ? '-' : `${row.ci.low.toFixed(2)}-${row.ci.high.toFixed(2)}`,
  row.payout,
  fixed(row.breakEven),
  row.verdict,
  row.staked,
  row.pnl,
  row.roiPct,
];

// one mode's rows: each group's pairs, then (for decisions) its pooled row
function modeRows(cells: readonly TradeReportCell[]): TradeReportRow[] {
  const pairs = new Map<string, TradeReportCell[]>();
  for (const cell of cells) {
    if (cell.pooled) continue;
    const key = groupKey(cell);
    pairs.set(key, [...(pairs.get(key) ?? []), cell]);
  }
  // every group has exactly one pooled row (the grouping set without the pair)
  return cells
    .filter((cell) => cell.pooled)
    .sort(compareGroups)
    .flatMap((pooled) => [
      ...(pairs.get(groupKey(pooled)) ?? []).sort(comparePairs).map(rowOf),
      ...(pooled.origin === TradeReportOrigin.Signal ? [rowOf(pooled)] : []),
    ]);
}

export function renderTradeReport(stats: TradeReportStats, window: Window): TradeReport {
  const rows: TradeReportRow[] = [];
  const lines = [
    '# trade-log report',
    '',
    `Период: ${window.since.toISOString()} .. ${window.until.toISOString()} (по trade_intents.created_at, часы базы); intent'ов: ${stats.intents}, закрытых сделок: ${stats.trades}`,
  ];
  for (const mode of MODE_ORDER) {
    const cells = stats.cells.filter((cell) => cell.mode === mode);
    if (cells.length === 0) continue;
    const sectionRows = modeRows(cells);
    lines.push('', `## ${mode}`, '', markdownTable(TABLE_HEAD, sectionRows.map(lineOf)));
    rows.push(...sectionRows);
  }
  const versions = [...stats.versions].sort(
    (a, b) => textOrder(a.version, b.version) || textOrder(a.paramsHash, b.paramsHash),
  );
  lines.push(
    '',
    '### Параметры',
    '',
    versions.length === 0
      ? 'Нет закрытых сделок по записанным решениям.'
      : markdownTable(
          VERSIONS_HEAD,
          versions.map((row) => [
            row.version,
            row.paramsHash,
            row.trades,
            row.firstAt,
            row.lastAt,
            row.params,
          ]),
        ),
  );
  const warnings: string[] = [];
  const notClosed = [...stats.notClosed].sort((a, b) => textOrder(a.status, b.status));
  const total = notClosed.reduce((sum, row) => sum + row.count, 0);
  if (total > 0) {
    const parts = notClosed.map((row) => `${row.status}: ${row.count}`).join(', ');
    warnings.push(`intent'ов без закрытой сделки: ${total} (${parts})`);
  }
  return { markdown: lines.join('\n'), rows, warnings };
}

// EXIT_USAGE: the window is empty or reversed; the caller prints the usage
export async function runTradeReport(
  db: Db,
  args: TradeReportArgs,
  out: (text: string) => void,
  err: (line: string) => void,
): Promise<number> {
  try {
    const window = resolveWindow(args, args.until ?? (await readTradeLogEnd(db)));
    if (window.since.getTime() >= window.until.getTime()) {
      err('--since должен быть раньше конца периода');
      return EXIT_USAGE;
    }
    const stats = await readTradeReportStats(db, { from: window.since, to: window.until });
    const report = renderTradeReport(stats, window);
    if (stats.trades === 0) {
      for (const warning of report.warnings) err(warning);
      err('нет закрытых сделок за период');
      return EXIT_FAILED;
    }
    out(`${report.markdown}\n`);
    for (const warning of report.warnings) err(warning);
    err(`сделок: ${stats.trades}`);
    return EXIT_OK;
  } catch (error) {
    // name and code only (Rule 8)
    err(`Не удалось построить отчёт: ${formatFailure(error)}.`);
    return EXIT_FAILED;
  }
}
