import {
  NoSignalReason,
  SignalKind,
  TradeAction,
  type SignalDecision,
  type SignalDecisionV1,
} from '@binarius/shared';
import {
  assertSignalParams,
  createSignalDecider,
  createSignalDeciderV1,
  DEFAULT_SIGNAL_PARAMS,
  DEFAULT_SIGNAL_PARAMS_V1,
  type SignalDecider,
} from '@binarius/signal';
import type { TradeInterval } from './config';

export type GridPoint = Readonly<Record<string, number>>;

// a trade, or the reason there is none
export type Verdict = { action: TradeAction } | { refusal: string };

// the decisions a variant may read at one moment, each made by a production decider
export interface DecisionContext {
  nowMs: number;
  v1(): SignalDecisionV1;
  v2(point?: V2Point): SignalDecision;
}

export interface Variant {
  name: string;
  intervals: readonly TradeInterval[];
  grid: readonly GridPoint[];
  // the overlay production runs with (Rule 28): the headline rows use it
  headlinePause: boolean;
  decide(ctx: DecisionContext, point: GridPoint): Verdict;
}

export interface V2Point {
  rsiExtremeBand: number;
  minAtrTicks: number;
}

export const V2_GRID: readonly (GridPoint & V2Point)[] = [10, 15, 20].flatMap((rsiExtremeBand) =>
  [3, 5, 8].map((minAtrTicks) => ({ rsiExtremeBand, minAtrTicks })),
);
export const V2_PRODUCTION_POINT: GridPoint & V2Point = {
  rsiExtremeBand: DEFAULT_SIGNAL_PARAMS.rsiExtremeBand,
  minAtrTicks: DEFAULT_SIGNAL_PARAMS.minAtrTicks,
};
export const REVERT_GRID: readonly GridPoint[] = [10, 15, 20].map((band) => ({ band }));

for (const point of V2_GRID) assertSignalParams({ ...DEFAULT_SIGNAL_PARAMS, ...point });

const deciders = new Map<string, SignalDecider>();
export function v2Decider(point: V2Point = V2_PRODUCTION_POINT): SignalDecider {
  const key = `${point.rsiExtremeBand}/${point.minAtrTicks}`;
  let decider = deciders.get(key);
  if (decider === undefined) {
    decider = createSignalDecider({ ...DEFAULT_SIGNAL_PARAMS, ...point });
    deciders.set(key, decider);
  }
  return decider;
}
export const v1Decider = createSignalDeciderV1(DEFAULT_SIGNAL_PARAMS_V1);

const verdictOf = (decision: SignalDecision | SignalDecisionV1): Verdict =>
  decision.kind === SignalKind.Signal ? { action: decision.action } : { refusal: decision.reason };

const asV2Point = (point: GridPoint): V2Point => ({
  rsiExtremeBand: point.rsiExtremeBand,
  minAtrTicks: point.minAtrTicks,
});

const VOLATILITY_REFUSALS: ReadonlySet<string> = new Set([
  NoSignalReason.VolatilityTooLow,
  NoSignalReason.VolatilityTooHigh,
  NoSignalReason.VolatilityBelowTickFloor,
]);

export const VARIANTS: readonly Variant[] = [
  {
    name: 'v1',
    intervals: ['5s', '15s'],
    grid: [{}],
    headlinePause: false,
    decide: (ctx) => verdictOf(ctx.v1()),
  },
  {
    name: 'v2',
    intervals: ['5s', '15s'],
    grid: V2_GRID,
    headlinePause: true,
    decide: (ctx, point) => verdictOf(ctx.v2(asV2Point(point))),
  },
  {
    // against the rush: v2's own data and volatility refusals stand, the EMA trend is ignored
    name: 'revert',
    intervals: ['5s', '15s'],
    grid: REVERT_GRID,
    headlinePause: true,
    decide(ctx, { band }) {
      const decision = ctx.v2();
      if (!('features' in decision)) return { refusal: decision.reason };
      if (decision.kind === SignalKind.NoSignal && VOLATILITY_REFUSALS.has(decision.reason)) {
        return { refusal: decision.reason };
      }
      const { rsi } = decision.features;
      if (rsi >= 50 + band) return { action: TradeAction.Down };
      if (rsi <= 50 - band) return { action: TradeAction.Up };
      return { refusal: 'revert_rsi_inside_band' };
    },
  },
];

export const pointLabel = (point: GridPoint): string =>
  Object.keys(point).length === 0
    ? '-'
    : Object.entries(point)
        .map(([key, value]) => `${key}=${value}`)
        .join(' ');
