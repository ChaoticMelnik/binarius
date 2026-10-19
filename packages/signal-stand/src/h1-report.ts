import {
  breakEvenPct,
  H1_ENTRY_WINDOW_SEC,
  H1_EXPIRY_SEC,
  H1_MIN_PAYOUT_PCT,
  H1NoSignalReason,
  MIN_CYCLE_PAYOUT_PCT,
  PAIR_TYPE_GROUPS,
  pairTypeGroupOf,
} from '@binarius/shared';
import { DEFAULT_H1_PARAMS } from '@binarius/signal';
import { H1_POOLED_PAYOUTS } from './config';
import { table, type PairInfo, type SeriesInfo } from './report';
import {
  decided,
  emptyTally,
  intervalOf,
  mergeTally,
  tradesPerPairHour,
  verdictOf,
  winRatePct,
  type Tally,
} from './stats';

export interface H1Point {
  threshold: number;
  entryDelaySec: number;
  expirySec: number;
}

export interface H1AssetCell {
  inSample: Tally;
  outOfSample: Tally;
  decisions: number;
  refusals: Record<string, number>;
}

export interface H1Cell extends H1Point {
  perAsset: Record<number, H1AssetCell>;
}

export interface H1RunData {
  since: number;
  split: number;
  until: number;
  // the run's grid: the tables cover exactly these
  thresholds: readonly number[];
  delays: readonly number[];
  expiries: readonly number[];
  pairs: PairInfo[];
  series: SeriesInfo[];
  cells: H1Cell[];
}

type Part = 'inSample' | 'outOfSample' | 'both';

interface H1Row extends H1Point {
  scope: string;
  pairs: number;
  trades: number;
  wins: number;
  losses: number;
  ties: number;
  unpriced: number;
  winRate?: number;
  ciLow: number;
  ciHigh: number;
  breakEven: number;
  verdict: string;
  evPerTradePct?: number;
  tradesPerPairHour?: number;
}

const HOUR_MS = 3_600_000;
const iso = (ms: number | undefined) => (ms === undefined ? '-' : new Date(ms).toISOString());
const fixed2 = (value: number | undefined) => (value === undefined ? '-' : value.toFixed(2));

// the backtest's point when the run has it, else the run's first value
const prefer = (values: readonly number[], value: number) =>
  values.includes(value) ? value : values[0];

const rowHead = [
  'threshold',
  'delay s',
  'expiry s',
  'scope',
  'pairs',
  'trades',
  'W',
  'L',
  'T',
  'unpriced',
  'win %',
  '95 % CI',
  'break-even %',
  'verdict',
  'EV/trade %',
  'trades/pair-h',
];

const rowCells = (r: H1Row) => [
  r.threshold,
  r.entryDelaySec,
  r.expirySec,
  r.scope,
  r.pairs,
  r.trades,
  r.wins,
  r.losses,
  r.ties,
  r.unpriced,
  fixed2(r.winRate),
  `${fixed2(r.ciLow)}-${fixed2(r.ciHigh)}`,
  fixed2(r.breakEven),
  r.verdict,
  fixed2(r.evPerTradePct),
  fixed2(r.tradesPerPairHour),
];

export function buildH1Report(data: H1RunData): {
  markdown: string;
  json: unknown;
  headline: string;
} {
  const hours: Record<Part, number> = {
    inSample: (data.split - data.since) / HOUR_MS,
    outOfSample: (data.until - data.split) / HOUR_MS,
    both: (data.until - data.since) / HOUR_MS,
  };
  const pools = [
    {
      scope: `pay>=${H1_MIN_PAYOUT_PCT}`,
      ids: new Set(
        data.pairs.filter((pair) => pair.payout >= H1_MIN_PAYOUT_PCT).map((pair) => pair.id),
      ),
      breakEvenPayout: H1_POOLED_PAYOUTS.h1,
    },
    {
      scope: `pooled>=${MIN_CYCLE_PAYOUT_PCT}`,
      ids: new Set(
        data.pairs.filter((pair) => pair.payout >= MIN_CYCLE_PAYOUT_PCT).map((pair) => pair.id),
      ),
      breakEvenPayout: H1_POOLED_PAYOUTS.all,
    },
  ];
  const [h1Pool, allPool] = pools;

  const tallyOf = (cell: H1Cell, ids: ReadonlySet<number>, part: Part) => {
    const tally = emptyTally();
    let pairs = 0;
    for (const [id, asset] of Object.entries(cell.perAsset)) {
      if (!ids.has(Number(id))) continue;
      pairs++;
      if (part !== 'outOfSample') mergeTally(tally, asset.inSample);
      if (part !== 'inSample') mergeTally(tally, asset.outOfSample);
    }
    return { tally, pairs };
  };

  const row = (
    cell: H1Cell,
    scope: string,
    { tally, pairs }: { tally: Tally; pairs: number },
    breakEvenPayout: number,
    part: Part,
  ): H1Row => {
    const ci = intervalOf(tally);
    const breakEven = breakEvenPct(breakEvenPayout);
    return {
      threshold: cell.threshold,
      entryDelaySec: cell.entryDelaySec,
      expirySec: cell.expirySec,
      scope,
      pairs,
      trades: tally.trades,
      wins: tally.wins,
      losses: tally.losses,
      ties: tally.ties,
      unpriced: tally.unpriced,
      winRate: winRatePct(tally),
      ciLow: ci.low,
      ciHigh: ci.high,
      breakEven,
      verdict: decided(tally) === 0 ? 'no trades' : verdictOf(ci, breakEven),
      // the script's denominator: every priced trade, ties included
      evPerTradePct: tally.trades === 0 ? undefined : (100 * tally.pnl) / tally.trades,
      tradesPerPairHour: tradesPerPairHour(tally, pairs, hours[part]),
    };
  };

  const pooledRows = (part: Part) =>
    data.cells.flatMap((cell) =>
      pools.map((pool) =>
        row(cell, pool.scope, tallyOf(cell, pool.ids, part), pool.breakEvenPayout, part),
      ),
    );
  const outOfSample = pooledRows('outOfSample');
  const inSample = pooledRows('inSample');

  const headlinePoint: H1Point = {
    threshold: prefer(data.thresholds, DEFAULT_H1_PARAMS.threshold),
    entryDelaySec: prefer(data.delays, H1_ENTRY_WINDOW_SEC.to),
    expirySec: prefer(data.expiries, H1_EXPIRY_SEC),
  };

  const perType = data.cells
    .filter((cell) => cell.threshold === headlinePoint.threshold)
    .flatMap((cell) =>
      PAIR_TYPE_GROUPS.flatMap((group) => {
        const ids = new Set(
          data.pairs
            .filter((pair) => allPool.ids.has(pair.id) && pairTypeGroupOf(pair.type) === group)
            .map((pair) => pair.id),
        );
        const pooled = tallyOf(cell, ids, 'outOfSample');
        return pooled.pairs === 0
          ? []
          : [row(cell, group, pooled, H1_POOLED_PAYOUTS.all, 'outOfSample')];
      }),
    );

  const headlineCell = data.cells.find(
    (cell) =>
      cell.threshold === headlinePoint.threshold &&
      cell.entryDelaySec === headlinePoint.entryDelaySec &&
      cell.expirySec === headlinePoint.expirySec,
  );
  const perPair =
    headlineCell === undefined
      ? []
      : data.pairs.flatMap((pair) => {
          const asset = headlineCell.perAsset[pair.id];
          if (asset === undefined) return [];
          const whole = emptyTally();
          mergeTally(whole, asset.inSample);
          mergeTally(whole, asset.outOfSample);
          return [
            {
              ...row(
                headlineCell,
                `${pair.symbol} (${pair.id}) ${pair.type} ${pair.payout}`,
                { tally: asset.outOfSample, pairs: 1 },
                pair.payout,
                'outOfSample',
              ),
              wholeRangeTrades: whole.trades,
            },
          ];
        });

  const refusalReasons = Object.values(H1NoSignalReason);
  const refusals = data.cells.map((cell) => {
    let decisions = 0;
    let unpriced = 0;
    let signals = 0;
    const counts: Record<string, number> = {};
    for (const asset of Object.values(cell.perAsset)) {
      decisions += asset.decisions;
      unpriced += asset.inSample.unpriced + asset.outOfSample.unpriced;
      signals +=
        asset.inSample.trades +
        asset.outOfSample.trades +
        asset.inSample.unpriced +
        asset.outOfSample.unpriced;
      for (const [reason, count] of Object.entries(asset.refusals)) {
        counts[reason] = (counts[reason] ?? 0) + count;
      }
    }
    const share = (count: number) => (decisions === 0 ? undefined : (100 * count) / decisions);
    return {
      threshold: cell.threshold,
      entryDelaySec: cell.entryDelaySec,
      expirySec: cell.expirySec,
      decisions,
      shares: Object.fromEntries(
        refusalReasons.map((reason) => [reason, share(counts[reason] ?? 0)]),
      ),
      signalShare: share(signals),
      unpriced,
    };
  });

  const outTable = table(rowHead, outOfSample.map(rowCells));
  const excluded = data.pairs.filter((pair) => !allPool.ids.has(pair.id));
  const symbols = (ids: ReadonlySet<number>) =>
    data.pairs
      .filter((pair) => ids.has(pair.id))
      .map((pair) => `${pair.symbol} ${pair.payout}`)
      .join(', ') || 'none';
  const p = DEFAULT_H1_PARAMS;

  const markdown = [
    '# H1 stand report (#667)',
    '',
    `Range ${iso(data.since)} .. ${iso(data.until)}, split at ${iso(data.split)} (in-sample before it).`,
    `Detector: move over ${p.moveSec} s, sd = RMS of the ${p.moveSec}-s moves every ${p.sdStepSec} s over ${p.sdWindowSec} s; grid: thresholds ${data.thresholds.join(', ')}; entry delays ${data.delays.join(', ')} s; expiries ${data.expiries.join(', ')} s.`,
    `trades/pair-h: trades / (pairs x hours of the row's sample: in-sample ${hours.inSample.toFixed(1)} h, out-of-sample ${hours.outOfSample.toFixed(1)} h, whole range ${hours.both.toFixed(1)} h). EV/trade %: 100 x PnL at stake 1 and each pair's own payout / (W + L + T).`,
    `${h1Pool.scope} (break-even at ${H1_POOLED_PAYOUTS.h1} %): ${symbols(h1Pool.ids)}.`,
    `${allPool.scope} (break-even at ${H1_POOLED_PAYOUTS.all} %): ${allPool.ids.size} pairs. Excluded from pooling: ${excluded.map((pair) => `${pair.symbol} ${pair.payout}`).join(', ') || 'none'}.`,
    '',
    '## (a) Pooled, out-of-sample',
    '',
    outTable,
    '',
    '## (b) Pooled, in-sample',
    '',
    table(rowHead, inSample.map(rowCells)),
    '',
    `## (c) Per pair type, out-of-sample, threshold ${headlinePoint.threshold} (payout >= ${MIN_CYCLE_PAYOUT_PCT}, break-even ${H1_POOLED_PAYOUTS.all})`,
    '',
    table(rowHead, perType.map(rowCells)),
    '',
    `## (d) Per pair, out-of-sample, threshold ${headlinePoint.threshold}, +${headlinePoint.entryDelaySec} s, expiry ${headlinePoint.expirySec} s (own payout, own break-even)`,
    '',
    table(
      [...rowHead, 'whole-range trades'],
      perPair.map((r) => [...rowCells(r), r.wholeRangeTrades]),
    ),
    '',
    '## (e) Decisions, whole range, % of decisions',
    '',
    table(
      ['threshold', 'delay s', 'expiry s', 'decisions', ...refusalReasons, 'signal', 'unpriced'],
      refusals.map((r) => [
        r.threshold,
        r.entryDelaySec,
        r.expirySec,
        r.decisions,
        ...refusalReasons.map((reason) => fixed2(r.shares[reason])),
        fixed2(r.signalShare),
        r.unpriced,
      ]),
    ),
    '',
    '## (f) Data',
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
    hours,
    params: DEFAULT_H1_PARAMS,
    thresholds: data.thresholds,
    delays: data.delays,
    expiries: data.expiries,
    headlinePoint,
    pools: pools.map((pool) => ({
      scope: pool.scope,
      breakEvenPayout: pool.breakEvenPayout,
      pairs: [...pool.ids],
    })),
    outOfSample,
    inSample,
    perType,
    perPair,
    refusals,
    pairs: data.pairs,
    series: data.series,
  };
  return { markdown, json, headline: outTable };
}
