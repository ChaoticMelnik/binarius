import { MIN_CYCLE_PAYOUT_PCT, PAIR_TYPE_GROUPS, pairTypeGroupOf } from '@binarius/shared';
import { MIN_IN_SAMPLE_TRADES, OPEN_DELAY_GRID_MS, POOLED_BREAK_EVEN_PAYOUT } from './config';
import {
  breakEvenPct,
  decided,
  emptyTally,
  intervalOf,
  mergeTally,
  selectPoint,
  verdictOf,
  winRatePct,
  type Tally,
} from './stats';
import { pointLabel, V2_PRODUCTION_POINT, VARIANTS, type GridPoint } from './variants';
import type { TradeInterval } from './config';

export interface PairInfo {
  id: number;
  symbol: string;
  type: string;
  payout: number;
  fetchedAt: number;
}

export interface AssetCell {
  inSample: Tally;
  outOfSample: Tally;
  decisions: number;
  refusals: Record<string, number>;
}

export interface Cell {
  variant: string;
  interval: TradeInterval;
  point: GridPoint;
  pause: boolean;
  openDelayMs: number;
  perAsset: Record<number, AssetCell>;
}

export interface SeriesInfo {
  assetId: number;
  interval: string;
  rows: number;
  first?: number;
  last?: number;
}

export interface RunData {
  since: number;
  split: number;
  until: number;
  headlineDelayMs: number;
  headlineDelaySource: string;
  pairs: PairInfo[];
  series: SeriesInfo[];
  cells: Cell[];
}

interface Row {
  variant: string;
  interval: TradeInterval;
  params: string;
  pause: boolean;
  openDelayMs: number;
  scope: string;
  payout: number;
  breakEven: number;
  trades: number;
  wins: number;
  losses: number;
  ties: number;
  unpriced: number;
  winRate?: number;
  ciLow: number;
  ciHigh: number;
  verdict: string;
  pnl: number;
}

const iso = (ms: number | undefined) => (ms === undefined ? '-' : new Date(ms).toISOString());
const pct = (value: number | undefined) => (value === undefined ? '-' : value.toFixed(1));

function table(head: readonly string[], rows: readonly (readonly (string | number)[])[]): string {
  const line = (cells: readonly (string | number)[]) => `| ${cells.join(' | ')} |`;
  return [line(head), line(head.map(() => '---')), ...rows.map(line)].join('\n');
}

const sameCell = (a: Cell, b: Omit<Cell, 'perAsset'>) =>
  a.variant === b.variant &&
  a.interval === b.interval &&
  pointLabel(a.point) === pointLabel(b.point) &&
  a.pause === b.pause &&
  a.openDelayMs === b.openDelayMs;

export function buildReport(data: RunData): { markdown: string; json: unknown; headline: string } {
  const pooledIds = new Set(
    data.pairs.filter((pair) => pair.payout >= MIN_CYCLE_PAYOUT_PCT).map((pair) => pair.id),
  );
  const pairOf = new Map(data.pairs.map((pair) => [pair.id, pair]));
  const find = (key: Omit<Cell, 'perAsset'>) => data.cells.find((cell) => sameCell(cell, key));

  const pooled = (cell: Cell, part: 'inSample' | 'outOfSample' | 'both'): Tally => {
    const tally = emptyTally();
    for (const [id, asset] of Object.entries(cell.perAsset)) {
      if (!pooledIds.has(Number(id))) continue;
      if (part !== 'outOfSample') mergeTally(tally, asset.inSample);
      if (part !== 'inSample') mergeTally(tally, asset.outOfSample);
    }
    return tally;
  };

  const row = (cell: Cell, scope: string, tally: Tally, payout: number): Row => {
    const ci = intervalOf(tally);
    const breakEven = breakEvenPct(payout);
    return {
      variant: cell.variant,
      interval: cell.interval,
      params: pointLabel(cell.point),
      pause: cell.pause,
      openDelayMs: cell.openDelayMs,
      scope,
      payout,
      breakEven,
      trades: tally.trades,
      wins: tally.wins,
      losses: tally.losses,
      ties: tally.ties,
      unpriced: tally.unpriced,
      winRate: winRatePct(tally),
      ciLow: ci.low,
      ciHigh: ci.high,
      verdict: decided(tally) === 0 ? 'no trades' : verdictOf(ci, breakEven),
      pnl: tally.pnl,
    };
  };

  const intervals = [...new Set(data.cells.map((cell) => cell.interval))];
  const headline: Row[] = [];
  const perPair: Row[] = [];
  const delays: Row[] = [];
  const pauses: Row[] = [];
  const grid: Row[] = [];
  const refusals: {
    variant: string;
    interval: string;
    params: string;
    decisions: number;
    shares: Record<string, number>;
  }[] = [];
  const selections: { variant: string; interval: string; selected: string }[] = [];

  for (const interval of intervals) {
    for (const variant of VARIANTS.filter((v) => v.intervals.includes(interval))) {
      const base = { variant: variant.name, interval, pause: variant.headlinePause };
      const candidates = variant.grid.flatMap((point) => {
        const cell = find({ ...base, point, openDelayMs: data.headlineDelayMs });
        return cell === undefined ? [] : [{ point, cell, tally: pooled(cell, 'inSample') }];
      });
      for (const { cell, tally } of candidates) {
        grid.push(row(cell, 'in-sample, pooled', tally, POOLED_BREAK_EVEN_PAYOUT));
      }
      const selected = selectPoint(candidates, MIN_IN_SAMPLE_TRADES);
      selections.push({
        variant: variant.name,
        interval,
        selected: selected === undefined ? 'none' : pointLabel(selected),
      });
      const shown = [...(selected === undefined ? [] : [selected])];
      if (
        variant.name === 'v2' &&
        !shown.some((point) => pointLabel(point) === pointLabel(V2_PRODUCTION_POINT))
      ) {
        shown.push(V2_PRODUCTION_POINT);
      }
      for (const point of shown) {
        const scope = point === selected ? 'selected' : 'production';
        const at = (pause: boolean, openDelayMs: number) =>
          find({ ...base, point, pause, openDelayMs });
        const main = at(variant.headlinePause, data.headlineDelayMs);
        if (main === undefined) continue;
        headline.push(
          row(
            main,
            `${scope}, out-of-sample, pooled`,
            pooled(main, 'outOfSample'),
            POOLED_BREAK_EVEN_PAYOUT,
          ),
        );
        for (const [id, asset] of Object.entries(main.perAsset)) {
          const pair = pairOf.get(Number(id));
          if (pair === undefined) continue;
          const whole = emptyTally();
          mergeTally(whole, asset.inSample);
          mergeTally(whole, asset.outOfSample);
          perPair.push(
            row(
              main,
              `${pairTypeGroupOf(pair.type)} ${pair.symbol} (${id}), ${scope}; whole range ${whole.trades} trades`,
              asset.outOfSample,
              pair.payout,
            ),
          );
        }
        for (const openDelayMs of OPEN_DELAY_GRID_MS) {
          const cell = at(variant.headlinePause, openDelayMs);
          if (cell !== undefined) {
            delays.push(
              row(
                cell,
                `${scope}, out-of-sample, pooled`,
                pooled(cell, 'outOfSample'),
                POOLED_BREAK_EVEN_PAYOUT,
              ),
            );
          }
        }
        for (const pause of [false, true]) {
          const cell = at(pause, data.headlineDelayMs);
          if (cell !== undefined) {
            pauses.push(
              row(
                cell,
                `${scope}, out-of-sample, pooled`,
                pooled(cell, 'outOfSample'),
                POOLED_BREAK_EVEN_PAYOUT,
              ),
            );
          }
        }
        let decisions = 0;
        const counts: Record<string, number> = {};
        for (const asset of Object.values(main.perAsset)) {
          decisions += asset.decisions;
          for (const [reason, count] of Object.entries(asset.refusals)) {
            counts[reason] = (counts[reason] ?? 0) + count;
          }
        }
        refusals.push({
          variant: variant.name,
          interval,
          params: pointLabel(point),
          decisions,
          shares: Object.fromEntries(
            Object.entries(counts).map(([reason, count]) => [reason, (100 * count) / decisions]),
          ),
        });
      }
    }
  }

  const groupRank = (scope: string) =>
    PAIR_TYPE_GROUPS.findIndex((group) => scope.startsWith(`${group} `));
  perPair.sort(
    (a, b) =>
      a.interval.localeCompare(b.interval) ||
      a.variant.localeCompare(b.variant) ||
      a.params.localeCompare(b.params) ||
      groupRank(a.scope) - groupRank(b.scope) ||
      a.scope.localeCompare(b.scope),
  );

  const rowHead = [
    'interval',
    'variant',
    'params',
    'pause',
    'delay ms',
    'scope',
    'trades',
    'W',
    'L',
    'T',
    'win %',
    '95 % CI',
    'break-even %',
    'verdict',
    'PnL',
  ];
  const cells = (r: Row) => [
    r.interval,
    r.variant,
    r.params,
    r.pause ? 'on' : 'off',
    r.openDelayMs,
    r.scope,
    r.trades,
    r.wins,
    r.losses,
    r.ties,
    pct(r.winRate),
    `${pct(r.ciLow)}-${pct(r.ciHigh)}`,
    pct(r.breakEven),
    r.verdict,
    r.pnl.toFixed(2),
  ];
  const headlineTable = table(rowHead, headline.map(cells));
  const excluded = data.pairs.filter((pair) => !pooledIds.has(pair.id));

  const markdown = [
    '# Signal stand report',
    '',
    `Range ${iso(data.since)} .. ${iso(data.until)}, split at ${iso(data.split)} (in-sample before it).`,
    `Headline openDelay ${data.headlineDelayMs} ms (${data.headlineDelaySource}).`,
    `Pooled rows: pairs paying >= ${MIN_CYCLE_PAYOUT_PCT} %, break-even at ${POOLED_BREAK_EVEN_PAYOUT} %. Excluded from pooling: ${excluded.map((pair) => `${pair.symbol} ${pair.payout}`).join(', ') || 'none'}.`,
    '',
    '## (a) Headline: selected points, out-of-sample',
    '',
    headlineTable,
    '',
    '## (b) Per pair, out-of-sample, by pair type (own payout, own break-even)',
    '',
    table(rowHead, perPair.map(cells)),
    '',
    '## (c) openDelay sensitivity',
    '',
    table(rowHead, delays.map(cells)),
    '',
    '## (d) The pause after two losses: off against on',
    '',
    table(rowHead, pauses.map(cells)),
    '',
    '## (e) Refusal shares, whole range, % of decisions',
    '',
    table(
      ['interval', 'variant', 'params', 'decisions', 'shares'],
      refusals.map((r) => [
        r.interval,
        r.variant,
        r.params,
        r.decisions,
        Object.entries(r.shares)
          .sort(([, a], [, b]) => b - a)
          .map(([reason, share]) => `${reason} ${share.toFixed(1)}`)
          .join(', '),
      ]),
    ),
    '',
    '## (f) In-sample grid, pooled',
    '',
    table(rowHead, grid.map(cells)),
    '',
    '## (g) Data',
    '',
    table(
      ['pair', 'symbol', 'type', 'payout', 'fetchedAt'],
      data.pairs.map((pair) => [pair.id, pair.symbol, pair.type, pair.payout, iso(pair.fetchedAt)]),
    ),
    '',
    table(
      ['pair', 'interval', 'rows', 'first', 'last'],
      data.series.map((s) => [s.assetId, s.interval, s.rows, iso(s.first), iso(s.last)]),
    ),
    '',
  ].join('\n');

  const json = {
    since: data.since,
    split: data.split,
    until: data.until,
    headlineDelayMs: data.headlineDelayMs,
    headlineDelaySource: data.headlineDelaySource,
    pooledPairs: [...pooledIds],
    selections,
    headline,
    perPair,
    delays,
    pauses,
    refusals,
    grid,
    pairs: data.pairs,
    series: data.series,
  };
  return { markdown, json, headline: headlineTable };
}
