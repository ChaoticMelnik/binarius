import {
  breakEvenPct,
  markdownTable,
  MIN_CYCLE_PAYOUT_PCT,
  PAIR_TYPE_GROUPS,
  pairTypeGroupOf,
  verdictOf,
} from '@binarius/shared';
import {
  MIN_IN_SAMPLE_TRADES,
  MIN_KEPT_SHARE_PCT,
  OPEN_DELAY_GRID_MS,
  POOLED_BREAK_EVEN_PAYOUT,
  TRADE_INTERVALS,
  type TradeInterval,
} from './config';
import {
  againstV2,
  betterOnAllIntervals,
  decided,
  emptyTally,
  intervalOf,
  mergeTally,
  selectPoint,
  tradesPerPairHour,
  winRatePct,
  type AgainstV2,
  type Tally,
} from './stats';
import {
  comparesWithV2,
  pointLabel,
  V2_PRODUCTION_POINT,
  VARIANTS,
  type GridPoint,
} from './variants';

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
  // the run's filters: the tables cover exactly these
  variants: readonly string[];
  intervals: readonly TradeInterval[];
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
  tradesPerPairHour?: number;
}

type Part = 'inSample' | 'outOfSample' | 'both';

interface AgainstV2Row extends AgainstV2 {
  interval: TradeInterval;
  variant: string;
  params: string;
  selected: boolean;
  trades: number;
  wins: number;
  losses: number;
  ties: number;
  winRate?: number;
  ciLow: number;
  ciHigh: number;
  v2WinRate?: number;
  tradesPerPairHour?: number;
  pnlPerTrade?: number;
}

const iso = (ms: number | undefined) => (ms === undefined ? '-' : new Date(ms).toISOString());
const pct = (value: number | undefined) => (value === undefined ? '-' : value.toFixed(1));
const rate2 = (value: number | undefined) => (value === undefined ? '-' : value.toFixed(2));
const HOUR_MS = 3_600_000;

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
  'trades/pair-h',
];

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

  const runVariants = VARIANTS.filter((variant) => data.variants.includes(variant.name));
  const hours: Record<Part, number> = {
    inSample: (data.split - data.since) / HOUR_MS,
    outOfSample: (data.until - data.split) / HOUR_MS,
    both: (data.until - data.since) / HOUR_MS,
  };
  const pooledPairs = (cell: Cell) =>
    Object.keys(cell.perAsset).filter((id) => pooledIds.has(Number(id))).length;

  const pooled = (cell: Cell, part: Part): Tally => {
    const tally = emptyTally();
    for (const [id, asset] of Object.entries(cell.perAsset)) {
      if (!pooledIds.has(Number(id))) continue;
      if (part !== 'outOfSample') mergeTally(tally, asset.inSample);
      if (part !== 'inSample') mergeTally(tally, asset.outOfSample);
    }
    return tally;
  };

  const row = (
    cell: Cell,
    scope: string,
    tally: Tally,
    payout: number,
    pairs: number,
    part: Part,
  ): Row => {
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
      tradesPerPairHour: tradesPerPairHour(tally, pairs, hours[part]),
    };
  };
  const pooledRow = (cell: Cell, scope: string, part: Part) =>
    row(cell, scope, pooled(cell, part), POOLED_BREAK_EVEN_PAYOUT, pooledPairs(cell), part);

  const intervals = (Object.keys(TRADE_INTERVALS) as TradeInterval[]).filter((interval) =>
    data.intervals.includes(interval),
  );
  const selectedOf = new Map<string, GridPoint | undefined>();
  const headline: Row[] = [];
  // table (a) in order: a headline row, or the line of a variant with no point to show
  const headlineLines: (Row | readonly (string | number)[])[] = [];
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
  const selections: {
    variant: string;
    interval: string;
    selected: string;
    bestInSampleTrades: number;
  }[] = [];

  for (const interval of intervals) {
    for (const variant of runVariants.filter((v) => v.intervals.includes(interval))) {
      const base = { variant: variant.name, interval, pause: variant.headlinePause };
      const candidates = variant.grid.flatMap((point) => {
        const cell = find({ ...base, point, openDelayMs: data.headlineDelayMs });
        return cell === undefined ? [] : [{ point, cell, tally: pooled(cell, 'inSample') }];
      });
      for (const { cell, tally } of candidates) {
        grid.push(
          row(
            cell,
            'in-sample, pooled',
            tally,
            POOLED_BREAK_EVEN_PAYOUT,
            pooledPairs(cell),
            'inSample',
          ),
        );
      }
      const selected = selectPoint(candidates, MIN_IN_SAMPLE_TRADES);
      selectedOf.set(`${variant.name}|${interval}`, selected);
      const best = Math.max(0, ...candidates.map(({ tally }) => tally.trades));
      selections.push({
        variant: variant.name,
        interval,
        selected: selected === undefined ? 'none' : pointLabel(selected),
        bestInSampleTrades: best,
      });
      const none = `no point with >= ${MIN_IN_SAMPLE_TRADES} in-sample trades (best: ${best})`;
      const shown: { point: GridPoint; scope: string }[] = [];
      if (selected !== undefined) shown.push({ point: selected, scope: 'selected' });
      else if (variant.grid.length === 1)
        shown.push({ point: variant.grid[0], scope: `only point, ${none}` });
      else {
        headlineLines.push([
          interval,
          variant.name,
          '-',
          variant.headlinePause ? 'on' : 'off',
          data.headlineDelayMs,
          none,
          ...Array<string>(rowHead.length - 6).fill('-'),
        ]);
      }
      if (
        variant.name === 'v2' &&
        !shown.some(({ point }) => pointLabel(point) === pointLabel(V2_PRODUCTION_POINT))
      ) {
        shown.push({ point: V2_PRODUCTION_POINT, scope: 'production' });
      }
      for (const { point, scope } of shown) {
        const at = (pause: boolean, openDelayMs: number) =>
          find({ ...base, point, pause, openDelayMs });
        const main = at(variant.headlinePause, data.headlineDelayMs);
        if (main === undefined) continue;
        const headlineRow = pooledRow(main, `${scope}, out-of-sample, pooled`, 'outOfSample');
        headline.push(headlineRow);
        headlineLines.push(headlineRow);
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
              1,
              'outOfSample',
            ),
          );
        }
        for (const openDelayMs of OPEN_DELAY_GRID_MS) {
          const cell = at(variant.headlinePause, openDelayMs);
          if (cell !== undefined) {
            delays.push(pooledRow(cell, `${scope}, out-of-sample, pooled`, 'outOfSample'));
          }
        }
        for (const pause of [false, true]) {
          const cell = at(pause, data.headlineDelayMs);
          if (cell !== undefined) {
            pauses.push(pooledRow(cell, `${scope}, out-of-sample, pooled`, 'outOfSample'));
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

  // (h) and (i) read v2 at the production point with its own pause and the headline delay
  const v2Variant = runVariants.find((variant) => variant.name === 'v2');
  const v2Production = (interval: TradeInterval) =>
    v2Variant === undefined
      ? undefined
      : find({
          variant: 'v2',
          interval,
          point: V2_PRODUCTION_POINT,
          pause: v2Variant.headlinePause,
          openDelayMs: data.headlineDelayMs,
        });
  const comparedVariants = runVariants.filter((variant) => comparesWithV2(variant.name));
  const against: AgainstV2Row[] = [];
  const perType: Row[] = [];
  for (const interval of intervals) {
    const reference = v2Production(interval);
    if (reference === undefined) continue;
    const v2Samples = {
      inSample: pooled(reference, 'inSample'),
      outOfSample: pooled(reference, 'outOfSample'),
    };
    const typePoints: { cell: Cell; scope: string }[] = [{ cell: reference, scope: 'production' }];
    for (const variant of comparedVariants.filter((v) => v.intervals.includes(interval))) {
      const selected = selectedOf.get(`${variant.name}|${interval}`);
      for (const point of variant.grid) {
        const cell = find({
          variant: variant.name,
          interval,
          point,
          pause: variant.headlinePause,
          openDelayMs: data.headlineDelayMs,
        });
        if (cell === undefined) continue;
        const isSelected = selected !== undefined && pointLabel(selected) === pointLabel(point);
        if (isSelected) typePoints.push({ cell, scope: 'selected' });
        const outOfSample = pooled(cell, 'outOfSample');
        const ci = intervalOf(outOfSample);
        against.push({
          interval,
          variant: variant.name,
          params: pointLabel(point),
          selected: isSelected,
          trades: outOfSample.trades,
          wins: outOfSample.wins,
          losses: outOfSample.losses,
          ties: outOfSample.ties,
          winRate: winRatePct(outOfSample),
          ciLow: ci.low,
          ciHigh: ci.high,
          v2WinRate: winRatePct(v2Samples.outOfSample),
          tradesPerPairHour: tradesPerPairHour(outOfSample, pooledPairs(cell), hours.outOfSample),
          pnlPerTrade: outOfSample.trades === 0 ? undefined : outOfSample.pnl / outOfSample.trades,
          ...againstV2({
            variant: { inSample: pooled(cell, 'inSample'), outOfSample },
            v2: v2Samples,
          }),
        });
      }
    }
    for (const { cell, scope } of typePoints) {
      for (const group of PAIR_TYPE_GROUPS) {
        const ids = data.pairs
          .filter((pair) => pooledIds.has(pair.id) && pairTypeGroupOf(pair.type) === group)
          .map((pair) => pair.id);
        const inType = ids.filter((id) => cell.perAsset[id] !== undefined);
        if (inType.length === 0) continue;
        const tally = emptyTally();
        for (const id of inType) mergeTally(tally, cell.perAsset[id].outOfSample);
        perType.push(
          row(
            cell,
            `${group}, ${scope}, out-of-sample, pooled within the type`,
            tally,
            POOLED_BREAK_EVEN_PAYOUT,
            inType.length,
            'outOfSample',
          ),
        );
      }
    }
  }
  const better = betterOnAllIntervals(against);
  const againstLines =
    against.length === 0
      ? ['no variant against v2 in this run']
      : [
          `Points better on every interval of this run (${better.intervals.join(', ')}): ${better.points.join(', ') || 'none'}. An indicator is added only if one point is better on 5s and on 15s.`,
          '',
          markdownTable(
            [
              'interval',
              'variant',
              'params',
              'trades',
              'kept %',
              'W',
              'L',
              'T',
              'win %',
              '95 % CI',
              'v2 win %',
              'Δ pp',
              'in-sample Δ pp',
              'trades/pair-h',
              'PnL/trade',
              'verdict',
            ],
            against.map((r) => [
              r.interval,
              r.variant,
              r.selected ? `${r.params} (selected)` : r.params,
              r.trades,
              pct(r.keptPct),
              r.wins,
              r.losses,
              r.ties,
              pct(r.winRate),
              `${pct(r.ciLow)}-${pct(r.ciHigh)}`,
              pct(r.v2WinRate),
              pct(r.deltaPct),
              pct(r.inSampleDeltaPct),
              rate2(r.tradesPerPairHour),
              rate2(r.pnlPerTrade),
              r.verdict,
            ]),
          ),
        ];

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
    rate2(r.tradesPerPairHour),
  ];
  const headlineTable = markdownTable(
    rowHead,
    headlineLines.map((line) => ('variant' in line ? cells(line) : line)),
  );
  const excluded = data.pairs.filter((pair) => !pooledIds.has(pair.id));

  const markdown = [
    '# Signal stand report',
    '',
    `Range ${iso(data.since)} .. ${iso(data.until)}, split at ${iso(data.split)} (in-sample before it).`,
    `Headline openDelay ${data.headlineDelayMs} ms (${data.headlineDelaySource}).`,
    `Variants: ${data.variants.join(', ')}; intervals: ${intervals.join(', ')}.`,
    `trades/pair-h: trades / (pairs x hours of the row's sample: in-sample ${hours.inSample.toFixed(1)} h, out-of-sample ${hours.outOfSample.toFixed(1)} h, whole range ${hours.both.toFixed(1)} h).`,
    `Pooled rows: pairs paying >= ${MIN_CYCLE_PAYOUT_PCT} %, break-even at ${POOLED_BREAK_EVEN_PAYOUT} %. Excluded from pooling: ${excluded.map((pair) => `${pair.symbol} ${pair.payout}`).join(', ') || 'none'}.`,
    '',
    '## (a) Headline: selected points, out-of-sample',
    '',
    headlineTable,
    '',
    '## (b) Per pair, out-of-sample, by pair type (own payout, own break-even)',
    '',
    markdownTable(rowHead, perPair.map(cells)),
    '',
    '## (c) openDelay sensitivity',
    '',
    markdownTable(rowHead, delays.map(cells)),
    '',
    '## (d) The pause after two losses: off against on',
    '',
    markdownTable(rowHead, pauses.map(cells)),
    '',
    '## (e) Refusal shares, whole range, % of decisions',
    '',
    markdownTable(
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
    markdownTable(rowHead, grid.map(cells)),
    '',
    '## (g) Data',
    '',
    markdownTable(
      ['pair', 'symbol', 'type', 'payout', 'fetchedAt'],
      data.pairs.map((pair) => [pair.id, pair.symbol, pair.type, pair.payout, iso(pair.fetchedAt)]),
    ),
    '',
    markdownTable(
      ['pair', 'interval', 'rows', 'first', 'last'],
      data.series.map((s) => [s.assetId, s.interval, s.rows, iso(s.first), iso(s.last)]),
    ),
    '',
    `## (h) Against v2 production, out-of-sample, pooled (kept % floor ${MIN_KEPT_SHARE_PCT})`,
    '',
    ...againstLines,
    '',
    `## (i) Per pair type, out-of-sample, pooled within the type (payout >= ${MIN_CYCLE_PAYOUT_PCT}, break-even ${POOLED_BREAK_EVEN_PAYOUT})`,
    '',
    markdownTable(rowHead, perType.map(cells)),
    '',
  ].join('\n');

  const json = {
    since: data.since,
    split: data.split,
    until: data.until,
    headlineDelayMs: data.headlineDelayMs,
    headlineDelaySource: data.headlineDelaySource,
    variants: data.variants,
    intervals,
    pooledPairs: [...pooledIds],
    selections,
    headline,
    perPair,
    delays,
    pauses,
    refusals,
    grid,
    againstV2: against,
    betterOnAllIntervals: better,
    perType,
    pairs: data.pairs,
    series: data.series,
  };
  return { markdown, json, headline: headlineTable };
}
