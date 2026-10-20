import { describe, expect, it } from 'vitest';
import { H1_R1_PARAMS } from '@binarius/shared';
import { DEFAULT_H1_PARAMS } from '@binarius/signal';
import {
  H1_DEFAULT_SHAPES,
  H1_ENTRY_DELAY_GRID_SEC,
  H1_EXPIRY_GRID_SEC,
  H1_THRESHOLD_GRID,
} from './config';
import { buildH1Report, type H1AssetCell, type H1Cell, type H1RunData } from './h1-report';
import type { PairInfo } from './report';
import { emptyTally, type Tally } from './stats';
import { T0 } from './testing';

const HOUR = 3_600_000;

const pair = (id: number, symbol: string, type: string, payout: number): PairInfo => ({
  id,
  symbol,
  type,
  payout,
  fetchedAt: T0,
});
const EURUSD = pair(1, 'EUR/USD', 'currency', 94);
const GBPUSD = pair(2, 'GBP/USD', 'currency', 85);
const APPLE = pair(3, 'Apple', 'stock', 79);

const tally = (wins: number, losses: number, ties: number, payout: number): Tally => ({
  trades: wins + losses + ties,
  wins,
  losses,
  ties,
  unpriced: 1,
  pnl: (wins * payout) / 100 - losses,
});

const asset = (outOfSample: Tally, inSample: Tally = emptyTally()): H1AssetCell => ({
  inSample,
  outOfSample,
  decisions: 1_000,
  refusals: { no_price: 10, no_volatility: 20, below_threshold: 900 },
});

function data(
  perAsset: () => Record<number, H1AssetCell>,
  shapes: H1RunData['shapes'] = H1_DEFAULT_SHAPES,
): H1RunData {
  const cells: H1Cell[] = [];
  for (const shape of shapes) {
    for (const threshold of H1_THRESHOLD_GRID) {
      for (const entryDelaySec of H1_ENTRY_DELAY_GRID_SEC) {
        for (const expirySec of H1_EXPIRY_GRID_SEC) {
          cells.push({ ...shape, threshold, entryDelaySec, expirySec, perAsset: perAsset() });
        }
      }
    }
  }
  return {
    since: T0,
    split: T0 + 5 * HOUR,
    until: T0 + 7 * HOUR,
    shapes,
    thresholds: H1_THRESHOLD_GRID,
    delays: H1_ENTRY_DELAY_GRID_SEC,
    expiries: H1_EXPIRY_GRID_SEC,
    pairs: [EURUSD, GBPUSD, APPLE],
    series: [{ assetId: 1, interval: '1s', rows: 25_200, first: T0, last: T0 + 7 * HOUR - 1_000 }],
    cells,
  };
}

const standard = () =>
  data(() => ({
    [EURUSD.id]: asset(tally(6, 3, 1, 94), tally(1, 1, 0, 94)),
    [GBPUSD.id]: asset(tally(10, 10, 0, 85)),
    [APPLE.id]: asset(tally(90, 10, 0, 79)),
  }));

// a run of the (3, 3) shape alone: neither R1 nor the reference H1 is in it
const standard3x3 = () =>
  data(() => ({ [EURUSD.id]: asset(tally(6, 3, 1, 94)) }), [{ moveSec: 3, sdStepSec: 3 }]);

interface JsonRow {
  moveSec: number;
  sdStepSec: number;
  threshold: number;
  entryDelaySec: number;
  expirySec: number;
  scope: string;
  pairs: number;
  trades: number;
  verdict: string;
  evPerTradePct?: number;
  tradesPerPairHour?: number;
}

const report = (input: H1RunData) => {
  const built = buildH1Report(input);
  return {
    ...built,
    json: built.json as {
      outOfSample: JsonRow[];
      inSample: JsonRow[];
      perType: JsonRow[];
      perPair: (JsonRow & { wholeRangeTrades: number })[];
      refusals: { decisions: number }[];
      headlinePoint: Omit<JsonRow, 'scope' | 'pairs' | 'trades' | 'verdict'>;
    },
  };
};

describe('the H1 report (#667)', () => {
  it('H-R1: tables (a) to (f), (a) a row per grid point and pool', () => {
    const { markdown, json, headline } = report(standard());
    for (const heading of ['(a) Pooled, out-of-sample', '(b)', '(c)', '(d)', '(e)', '(f) Data']) {
      expect(markdown).toContain(`## ${heading}`);
    }
    const points =
      H1_DEFAULT_SHAPES.length *
      H1_THRESHOLD_GRID.length *
      H1_ENTRY_DELAY_GRID_SEC.length *
      H1_EXPIRY_GRID_SEC.length;
    expect(json.outOfSample).toHaveLength(points * 2);
    expect(json.inSample).toHaveLength(points * 2);
    // the headline: R1 and the reference H1, each in both pools
    expect(headline.split('\n')).toHaveLength(2 * 2 + 2);
  });

  it('H-R2: pay>=94 pools the pairs at 94 and above, pooled>=80 those at 80, a pair below only per pair', () => {
    const { json } = report(standard());
    const first = json.outOfSample.slice(0, 2);
    expect(first.map((r) => [r.scope, r.pairs, r.trades])).toEqual([
      ['pay>=94', 1, 10],
      ['pooled>=80', 2, 30],
    ]);
    expect(json.perType.map((r) => [r.scope, r.pairs, r.trades])).toEqual(
      Array(H1_ENTRY_DELAY_GRID_SEC.length * H1_EXPIRY_GRID_SEC.length).fill(['currency', 2, 30]),
    );
    expect(json.perPair.map((r) => [r.scope, r.trades, r.wholeRangeTrades])).toEqual([
      ['EUR/USD (1) currency 94', 10, 12],
      ['GBP/USD (2) currency 85', 20, 20],
      ['Apple (3) stock 79', 100, 100],
    ]);
  });

  it('H-R3: EV/trade counts ties in its denominator, trades/pair-h is trades per pair and hour', () => {
    const { json } = report(standard());
    const row = json.outOfSample[1];
    expect(row.scope).toBe('pooled>=80');
    // each pair at its own payout: 6 x 0.94 - 3 and 10 x 0.85 - 10, over 6 + 3 + 1 and 10 + 10
    expect(row.evPerTradePct).toBeCloseTo((100 * (6 * 0.94 - 3 + 10 * 0.85 - 10)) / 30, 10);
    // 30 trades, 2 pairs, 2 out-of-sample hours
    expect(row.tradesPerPairHour).toBe(7.5);
  });

  it('H-R4: a row without a decided trade says no trades', () => {
    const { json } = report(
      data(() => ({
        [EURUSD.id]: asset({ ...emptyTally(), trades: 2, ties: 2 }),
        [GBPUSD.id]: asset(emptyTally()),
      })),
    );
    for (const row of [...json.outOfSample, ...json.perType, ...json.perPair]) {
      expect(row.verdict).toBe('no trades');
    }
  });

  it('H-R5: report-h1.json carries the numbers the tables print', () => {
    const { markdown, json } = report(standard());
    for (const row of [...json.outOfSample, ...json.inSample, ...json.perType, ...json.perPair]) {
      expect(markdown).toContain(
        `| ${row.moveSec} | ${row.sdStepSec} | ${row.threshold} | ${row.entryDelaySec} | ${row.expirySec} | ${row.scope} | ${row.pairs} | ${row.trades} |`,
      );
    }
    for (const row of json.refusals) expect(markdown).toContain(`| ${row.decisions} |`);
  });

  it('H-R6: R1 heads the report, the reference H1 is its second line, (c) and (d) follow R1 (#669)', () => {
    const { markdown, json, headline } = report(standard());
    const lines = headline.split('\n').slice(2);
    const r1 = `| R1 | ${H1_R1_PARAMS.moveSec} | ${H1_R1_PARAMS.sdStepSec} | ${H1_R1_PARAMS.threshold} | 1 | 5 |`;
    const h1 = `| H1 | ${DEFAULT_H1_PARAMS.moveSec} | ${DEFAULT_H1_PARAMS.sdStepSec} | ${DEFAULT_H1_PARAMS.threshold} | 2 | 5 |`;
    expect(lines.map((line) => line.slice(0, r1.length))).toEqual([r1, r1, h1, h1]);
    expect(json.headlinePoint).toEqual({
      moveSec: H1_R1_PARAMS.moveSec,
      sdStepSec: H1_R1_PARAMS.sdStepSec,
      threshold: H1_R1_PARAMS.threshold,
      entryDelaySec: 1,
      expirySec: 5,
    });
    for (const row of [...json.perType, ...json.perPair]) {
      expect([row.moveSec, row.sdStepSec, row.threshold]).toEqual([
        H1_R1_PARAMS.moveSec,
        H1_R1_PARAMS.sdStepSec,
        H1_R1_PARAMS.threshold,
      ]);
    }
    expect(markdown).toContain(
      `## (d) Per pair, out-of-sample, move ${H1_R1_PARAMS.moveSec} s, sd step ${H1_R1_PARAMS.sdStepSec} s, threshold ${H1_R1_PARAMS.threshold}, +1 s, expiry 5 s`,
    );
  });

  it('H-R7: a run without either live point prints table (a) and follows its first cell', () => {
    const { json, headline } = report(standard3x3());
    expect(headline.split('\n')).toHaveLength(json.outOfSample.length + 2);
    expect(json.headlinePoint).toEqual({
      moveSec: 3,
      sdStepSec: 3,
      threshold: H1_THRESHOLD_GRID[0],
      entryDelaySec: H1_ENTRY_DELAY_GRID_SEC[0],
      expirySec: H1_EXPIRY_GRID_SEC[0],
    });
  });
});
