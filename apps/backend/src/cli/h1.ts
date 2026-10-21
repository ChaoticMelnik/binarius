import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { Pool } from 'pg';
import {
  breakEvenPct,
  DATABASE_URL_RULES,
  H1_MIN_PAYOUT_PCT,
  H1ShadowSet,
  INT4_MAX,
  markdownTable,
  MAX_H1_LOSS_MULTIPLIER,
  MAX_SESSION_SUMMARY_TRADES,
  parseUrlEnv,
  readEnv,
  verdictOf,
  wilson,
  type Interval95,
} from '@binarius/shared';
import {
  createDb,
  readH1ShadowStats,
  readTradeLogEnd,
  type H1ShadowPairStats,
  type H1ShadowSetStats,
  type H1ShadowStats,
} from '@binarius/db';
import * as z from 'zod';
import { runH1MarkCommand, type H1MarkCommand } from './h1-mark';
import { runH1SessionCommand, type H1SessionCommand, type H1SessionDeps } from './h1-session';
import { formatFailure } from './kill-switch';
import { parseInstant, UsageError } from './trade-log';

// The H1 shadow report (#681, docs/h1.md → The report): win rate, 95 % CI and verdict per set,
// pair and entry delay over the shadow rows of a window. Reads only; one source of Wilson and the
// verdict with the stand (packages/shared/src/wilson.ts).
// 0 the report is printed, 1 no decisions in the window (an empty sample is not a pass) or a
// failure, 2 not understood.
// The entry point of the H1 sessions' commands too (#670, docs/h1.md → Sessions): the mark in
// h1-mark.ts, the session in h1-session.ts; this file parses every subcommand and owns the
// connection.
const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const RELATIVE_SINCE = /^([1-9]\d{0,3})([hd])$/;

const USAGE = `H1: отчёт теневой торговли (docs/h1.md → The report) и сессии H1 (docs/h1.md → Sessions).

  h1 shadow report --since <ISO 8601 | Nh | Nd> [--until <ISO 8601>]
  h1 mark <accountId>
  h1 unmark <accountId>
  h1 list
  h1 session start --account <accountId> --asset <id> --trades <N> --max-loss <k>
  h1 session stop --account <accountId>
  h1 session status --account <accountId>

--since — начало периода (включительно): дата ISO 8601 с зоной или N часов (h) / дней (d) до
--until, N от 1 до 9999; --until — конец (не включительно, по умолчанию — сейчас по часам базы);
по времени записи решения. Отчёт — в stdout, итог — в stderr. Код выхода: 0 — отчёт напечатан,
1 — нет решений за период или ошибка, 2 — не понято.
mark / unmark — пометить аккаунт брокера (uuid) для сессий H1 или снять метку; снять нельзя, пока у
аккаунта активная сессия H1. list — помеченные аккаунты (stdout, по строке на аккаунт). Код выхода:
0 — сделано или уже так, 1 — аккаунт не найден, метку не снять или ошибка, 2 — не понято.
session start — сессия H1 помеченного аккаунта: пара --asset (открыта, берёт 5 с, выплата не ниже
94 %), --trades сделок (1…720), потолок потерь --max-loss × ставка (k 1…1000); ставка — сохранённая
ставка режима пользователя или минимум брокера. В stdout — id сессии. session stop — остановить
активную сессию H1 аккаунта; session status — последняя сессия H1 аккаунта. Код выхода: 0 —
сделано, 1 — отказ (строка в stderr), нет сессии или ошибка, 2 — не понято.`;

export type H1Since = { at: Date } | { hours: number } | { days: number };

export interface H1Args {
  since: H1Since;
  // undefined: the database's clock when the report starts, the clock recorded_at is written by
  until: Date | undefined;
}

function parseSince(raw: string): H1Since {
  const relative = RELATIVE_SINCE.exec(raw);
  if (relative !== null) {
    const n = Number(relative[1]);
    return relative[2] === 'h' ? { hours: n } : { days: n };
  }
  try {
    return { at: parseInstant(raw, '--since') };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new UsageError(`${message}; или N часов/дней до --until: 24h, 7d (N от 1 до 9999)`);
  }
}

export function parseH1Args(argv: readonly string[]): H1Args {
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
  const [command, subcommand] = positionals;
  if (command === undefined) throw new UsageError('нет команды');
  if (command !== 'shadow') throw new UsageError(`неизвестная команда: ${command}`);
  if (subcommand === undefined) throw new UsageError('нужна команда shadow report');
  if (subcommand !== 'report') throw new UsageError(`неизвестная команда: shadow ${subcommand}`);
  if (positionals.length > 2) throw new UsageError('лишние аргументы');
  if (values.since === undefined) throw new UsageError('нужен --since');
  const since = parseSince(values.since);
  const until = values.until === undefined ? undefined : parseInstant(values.until, '--until');
  if ('at' in since && until !== undefined && until.getTime() <= since.at.getTime()) {
    throw new UsageError('--until должен быть позже --since');
  }
  return { since, until };
}

// Every subcommand of the h1 CLI (#670): the shadow report keeps parseH1Args, the others take
// only their own positionals and no options.
export type H1Command = { kind: 'shadow_report'; args: H1Args } | H1MarkCommand | H1SessionCommand;

const accountIdSchema = z.uuid();

function parseAccountId(raw: string | undefined): string {
  if (raw === undefined) throw new UsageError('нужен id аккаунта брокера (uuid)');
  if (!accountIdSchema.safeParse(raw).success) {
    throw new UsageError('id аккаунта брокера — uuid');
  }
  return raw;
}

function parsePositionalsOnly(argv: readonly string[]): string[] {
  try {
    return parseArgs({ args: [...argv], allowPositionals: true, strict: true, options: {} })
      .positionals;
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

const POSITIVE_INTEGER = /^[1-9]\d{0,9}$/;

function parseBoundedInt(raw: string | undefined, flag: string, max: number): number {
  if (raw === undefined) throw new UsageError(`нужен ${flag}`);
  const value = POSITIVE_INTEGER.test(raw) ? Number(raw) : Number.NaN;
  if (!(value <= max)) throw new UsageError(`${flag}: целое от 1 до ${max}`);
  return value;
}

function parseSessionCommand(argv: readonly string[]): H1SessionCommand {
  let values: { account?: string; asset?: string; trades?: string; 'max-loss'?: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        account: { type: 'string' },
        asset: { type: 'string' },
        trades: { type: 'string' },
        'max-loss': { type: 'string' },
      },
    }));
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const [, subcommand, ...rest] = positionals;
  if (rest.length > 0) throw new UsageError('лишние аргументы');
  if (subcommand === 'start') {
    return {
      kind: 'session_start',
      accountId: parseAccountId(values.account),
      assetId: parseBoundedInt(values.asset, '--asset', INT4_MAX),
      trades: parseBoundedInt(values.trades, '--trades', MAX_SESSION_SUMMARY_TRADES),
      maxLossMultiplier: parseBoundedInt(values['max-loss'], '--max-loss', MAX_H1_LOSS_MULTIPLIER),
    };
  }
  if (subcommand !== 'stop' && subcommand !== 'status') {
    throw new UsageError(
      subcommand === undefined
        ? 'нужна команда session start, stop или status'
        : `неизвестная команда: session ${subcommand}`,
    );
  }
  if (
    values.asset !== undefined ||
    values.trades !== undefined ||
    values['max-loss'] !== undefined
  ) {
    throw new UsageError(`session ${subcommand} принимает только --account`);
  }
  return {
    kind: subcommand === 'stop' ? 'session_stop' : 'session_status',
    accountId: parseAccountId(values.account),
  };
}

export function parseH1Command(argv: readonly string[]): H1Command {
  const [command] = argv;
  if (command === 'session') return parseSessionCommand(argv);
  if (command === 'mark' || command === 'unmark' || command === 'list') {
    const [, ...rest] = parsePositionalsOnly(argv);
    if (command === 'list') {
      if (rest.length > 0) throw new UsageError('лишние аргументы');
      return { kind: 'list' };
    }
    if (rest.length > 1) throw new UsageError('лишние аргументы');
    return { kind: command, accountId: parseAccountId(rest[0]) };
  }
  return { kind: 'shadow_report', args: parseH1Args(argv) };
}

export interface H1Window {
  since: Date;
  until: Date;
}

// a relative --since counts back from until, the database's clock by default: one clock with
// recorded_at and the export
export function resolveWindow(args: H1Args, end: Date): H1Window {
  const until = args.until ?? end;
  const { since } = args;
  if ('at' in since) return { since: since.at, until };
  const back = 'hours' in since ? since.hours * HOUR_MS : since.days * DAY_MS;
  return { since: new Date(until.getTime() - back), until };
}

// one row of a set's table: a pair (or all pairs, assetId null) at one entry delay
export interface H1ReportCell {
  set: string | null;
  pair: string;
  assetId: number | null;
  decisions: number;
  entryDelaySec: number;
  // the set's own entry (params.entryDelaySec), the cadence of one trade at a time
  own: boolean;
  wins: number;
  losses: number;
  ties: number;
  unpriced: number;
  winPct: number | undefined;
  ci: Interval95 | undefined;
  evPct: number | undefined;
  payout: string;
  breakEven: number | undefined;
  verdict: string;
}

export const NO_TRADES = 'нет сделок';
export const NO_PAYOUT = 'нет выплаты';
export const ALL_PAIRS = 'все пары';
export const NO_SET = '(без набора)';

const TABLE_HEAD = [
  'пара',
  'решений',
  'g',
  'W',
  'L',
  'T',
  'unpriced',
  'win %',
  '95 % CI',
  'EV/trade %',
  'выплата, средн. (min-max)',
  'безубыточность %',
  'вердикт',
];

interface Tally {
  wins: number;
  losses: number;
  ties: number;
  unpriced: number;
  pnl: number;
  winsWithoutPayout: number;
}

const emptyTally = (): Tally => ({
  wins: 0,
  losses: 0,
  ties: 0,
  unpriced: 0,
  pnl: 0,
  winsWithoutPayout: 0,
});

function addCell(into: Tally | undefined, cell: Tally | undefined): void {
  if (into === undefined || cell === undefined) return;
  into.wins += cell.wins;
  into.losses += cell.losses;
  into.ties += cell.ties;
  into.unpriced += cell.unpriced;
  into.pnl += cell.pnl;
  into.winsWithoutPayout += cell.winsWithoutPayout;
}

// no cell without evidence beats break-even: no decided trade -> no trades, no payout -> no payout
function judged(tally: Tally, breakEven: number | undefined) {
  const decided = tally.wins + tally.losses;
  const priced = decided + tally.ties;
  if (decided === 0) {
    return { winPct: undefined, ci: undefined, evPct: undefined, verdict: NO_TRADES };
  }
  const ci = wilson(tally.wins, decided);
  return {
    winPct: (100 * tally.wins) / decided,
    ci,
    evPct: tally.winsWithoutPayout > 0 ? undefined : (100 * tally.pnl) / priced,
    verdict: breakEven === undefined ? NO_PAYOUT : verdictOf(ci, breakEven),
  };
}

const setLabel = (set: string | null) => set ?? NO_SET;
const pairLabel = (pair: H1ShadowPairStats) =>
  pair.symbol === null ? String(pair.assetId) : `${pair.symbol} (${pair.assetId})`;

function setOrder(sets: readonly (string | null)[]): (string | null)[] {
  const known: readonly string[] = Object.values(H1ShadowSet);
  const named = sets.filter((set): set is string => set !== null);
  return [
    ...known.filter((set) => named.includes(set)),
    ...named.filter((set) => !known.includes(set)).sort(),
    ...(sets.includes(null) ? [null] : []),
  ];
}

// by decisions, most first; a tie by symbol, the pairs without one last, by asset id
function comparePairs(a: H1ShadowPairStats, b: H1ShadowPairStats): number {
  if (a.decisions !== b.decisions) return b.decisions - a.decisions;
  if (a.symbol !== null && b.symbol !== null && a.symbol !== b.symbol) {
    return a.symbol < b.symbol ? -1 : 1;
  }
  if ((a.symbol === null) !== (b.symbol === null)) return a.symbol === null ? 1 : -1;
  return a.assetId - b.assetId;
}

const fixed = (value: number | undefined) => (value === undefined ? '-' : value.toFixed(2));
const signed = (value: number | undefined) =>
  value === undefined ? '-' : `${value >= 0 ? '+' : ''}${value.toFixed(2)}`;

function rowOf(cell: H1ReportCell): (string | number)[] {
  return [
    cell.pair,
    cell.decisions,
    cell.own ? `${cell.entryDelaySec}*` : String(cell.entryDelaySec),
    cell.wins,
    cell.losses,
    cell.ties,
    cell.unpriced,
    fixed(cell.winPct),
    cell.ci === undefined ? '-' : `${cell.ci.low.toFixed(2)}-${cell.ci.high.toFixed(2)}`,
    signed(cell.evPct),
    cell.payout,
    fixed(cell.breakEven),
    cell.verdict,
  ];
}

export interface H1Report {
  markdown: string;
  cells: H1ReportCell[];
  // for stderr: data outside the row's shape is counted, never dropped silently
  warnings: string[];
}

export function renderH1ShadowReport(stats: H1ShadowStats, window: H1Window): H1Report {
  const cells: H1ReportCell[] = [];
  const warnings: string[] = [];
  const order = setOrder(stats.sets.map((set) => set.set));
  const setStats = new Map<string | null, H1ShadowSetStats>(
    stats.sets.map((set) => [set.set, set]),
  );
  const perSet = order.map((set) => `${setLabel(set)} ${setStats.get(set)?.decisions ?? 0}`);
  const lines = [
    '# h1 shadow report',
    '',
    `Период: ${window.since.toISOString()} .. ${window.until.toISOString()} (по recorded_at, часы базы); решений: ${stats.decisions} (${perSet.join(', ')})`,
  ];

  for (const set of order) {
    const own = setStats.get(set)?.ownEntryDelaySecs ?? null;
    const ownDelay = own !== null && own.length === 1 ? Number(own[0]) : undefined;
    if (ownDelay === undefined) {
      warnings.push(
        `набор ${setLabel(set)}: вход набора не один (${own === null ? 'нет' : own.join(', ')})`,
      );
    }
    const entries = stats.entries.filter((cell) => cell.set === set);
    const delays = [
      ...new Set(
        entries.flatMap((cell) => (cell.entryDelaySec === null ? [] : [cell.entryDelaySec])),
      ),
    ].sort((a, b) => a - b);
    const pairs = stats.pairs.filter((pair) => pair.set === set).sort(comparePairs);
    const setCells: H1ReportCell[] = [];
    const all = new Map(delays.map((g) => [g, emptyTally()]));

    for (const pair of pairs) {
      const breakEven =
        pair.pricedRows > 0 && pair.payoutMean !== null ? breakEvenPct(pair.payoutMean) : undefined;
      const payout =
        pair.pricedRows > 0 && pair.payoutMean !== null
          ? `${pair.payoutMean.toFixed(2)} (${pair.payoutMin}-${pair.payoutMax})`
          : '-';
      for (const g of delays) {
        const tally = emptyTally();
        addCell(
          tally,
          entries.find((cell) => cell.assetId === pair.assetId && cell.entryDelaySec === g),
        );
        addCell(all.get(g), tally);
        setCells.push({
          set,
          pair: pairLabel(pair),
          assetId: pair.assetId,
          decisions: pair.decisions,
          entryDelaySec: g,
          own: g === ownDelay,
          wins: tally.wins,
          losses: tally.losses,
          ties: tally.ties,
          unpriced: tally.unpriced,
          ...judged(tally, breakEven),
          payout,
          breakEven,
        });
      }
    }
    // the pool at the plan's payout floor, as the stand's pay>=94 pool
    const poolBreakEven = breakEvenPct(H1_MIN_PAYOUT_PCT);
    for (const g of delays) {
      const tally = all.get(g) ?? emptyTally();
      setCells.push({
        set,
        pair: ALL_PAIRS,
        assetId: null,
        decisions: setStats.get(set)?.decisions ?? 0,
        entryDelaySec: g,
        own: g === ownDelay,
        wins: tally.wins,
        losses: tally.losses,
        ties: tally.ties,
        unpriced: tally.unpriced,
        ...judged(tally, poolBreakEven),
        payout: `>= ${H1_MIN_PAYOUT_PCT} (по плану)`,
        breakEven: poolBreakEven,
      });
    }

    const lag = setStats.get(set);
    lines.push(
      '',
      set === null ? `## ${NO_SET}` : `## Набор ${set}`,
      '',
      markdownTable(TABLE_HEAD, setCells.map(rowOf)),
      '',
    );
    if (setCells.some((cell) => cell.own)) {
      lines.push(
        '* — вход набора (params.entryDelaySec): по нему идёт каденция «одна сделка за раз»',
      );
    }
    if (lag !== undefined) {
      lines.push(
        `Задержка taken_at_ms − decided_at_ms (f), мс: медиана ${Math.round(lag.lagMsP50)}, p95 ${Math.round(lag.lagMsP95)}`,
      );
    }
    cells.push(...setCells);
  }

  const withoutEntries = stats.pairs.reduce((sum, pair) => sum + pair.rowsWithoutEntries, 0);
  if (withoutEntries > 0) warnings.push(`строк без записей исходов: ${withoutEntries}`);
  const outside = stats.entries.reduce(
    (sum, cell) => sum + (cell.entryDelaySec === null ? cell.records : cell.other),
    0,
  );
  if (outside > 0) warnings.push(`записей вне формы: ${outside}`);
  return { markdown: lines.join('\n'), cells, warnings };
}

export async function runH1Cli(
  argv: readonly string[],
  source: NodeJS.ProcessEnv,
  out: (text: string) => void,
  err: (line: string) => void,
  deps: H1SessionDeps = {},
): Promise<number> {
  let command: H1Command;
  try {
    command = parseH1Command(argv);
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    err(USAGE);
    return EXIT_USAGE;
  }

  let databaseUrl: string;
  try {
    databaseUrl = parseUrlEnv(readEnv(source, 'DATABASE_URL'), 'DATABASE_URL', DATABASE_URL_RULES);
  } catch (error) {
    // our own env messages name the variable, never its value
    err(error instanceof Error ? error.message : String(error));
    return EXIT_FAILED;
  }

  const pool = new Pool({ connectionString: databaseUrl });
  const db = createDb(pool);
  if (command.kind !== 'shadow_report') {
    try {
      if (
        command.kind === 'session_start' ||
        command.kind === 'session_stop' ||
        command.kind === 'session_status'
      ) {
        return await runH1SessionCommand(db, command, source, out, err, deps);
      }
      return await runH1MarkCommand(db, command, out, err);
    } catch (error) {
      // name and code only (Rule 8)
      err(`Не удалось выполнить команду: ${formatFailure(error)}.`);
      return EXIT_FAILED;
    } finally {
      await pool.end().catch(() => undefined);
    }
  }
  const { args } = command;
  try {
    const window = resolveWindow(args, args.until ?? (await readTradeLogEnd(db)));
    if (window.since.getTime() >= window.until.getTime()) {
      err('--since должен быть раньше конца периода');
      err(USAGE);
      return EXIT_USAGE;
    }
    const stats = await readH1ShadowStats(db, { from: window.since, to: window.until });
    if (stats.decisions === 0) {
      err('нет решений за период');
      return EXIT_FAILED;
    }
    const report = renderH1ShadowReport(stats, window);
    out(`${report.markdown}\n`);
    for (const warning of report.warnings) err(warning);
    err(`решений: ${stats.decisions}`);
    return EXIT_OK;
  } catch (error) {
    // name and code only (Rule 8)
    err(`Не удалось построить отчёт: ${formatFailure(error)}.`);
    return EXIT_FAILED;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

// The module is imported by its test, so the command only runs when this file is what node was
// started with. exitCode, not exit(): a piped stdout is written asynchronously.
const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  process.exitCode = await runH1Cli(
    process.argv.slice(2),
    process.env,
    (text) => void process.stdout.write(text),
    (line) => void process.stderr.write(`${line}\n`),
  );
}
