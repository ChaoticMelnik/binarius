import {
  NoSignalReason,
  SignalKind,
  TradeAction,
  type SignalDecision,
  type SignalDecisionV1,
  type SignalIndicators,
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

export type GridPoint = Readonly<Record<string, number | string>>;

// a trade, or the reason there is none
export type VariantDecision = { action: TradeAction } | { refusal: string };

// the decisions a variant may read at one moment, each made by a production decider
export interface DecisionContext {
  nowMs: number;
  v1(): SignalDecisionV1;
  v2(point?: V2Point): SignalDecision;
  // v2 at the default point on the 1m series, at the same nowMs
  v2OneMinute(): SignalDecision;
  // production's displayIndicators over the feed's 300-row fetch (#482), at the same nowMs
  indicators(): SignalIndicators | undefined;
}

export interface Variant {
  name: string;
  intervals: readonly TradeInterval[];
  grid: readonly GridPoint[];
  // the overlay production runs with (Rule 28): the headline rows use it
  headlinePause: boolean;
  decide(ctx: DecisionContext, point: GridPoint): VariantDecision;
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

const decisionOf = (decision: SignalDecision | SignalDecisionV1): VariantDecision =>
  decision.kind === SignalKind.Signal ? { action: decision.action } : { refusal: decision.reason };

function numberOf(point: GridPoint, key: string): number {
  const value = point[key];
  if (typeof value !== 'number') {
    throw new RangeError(`variant point: ${key}=${String(value)} is not a number`);
  }
  return value;
}

function oneOf<T extends string>(point: GridPoint, key: string, allowed: readonly T[]): T {
  const value = point[key];
  const found = allowed.find((candidate) => candidate === value);
  if (found === undefined) {
    throw new RangeError(
      `variant point: ${key}=${String(value)} is not one of ${allowed.join(', ')}`,
    );
  }
  return found;
}

const asV2Point = (point: GridPoint): V2Point => ({
  rsiExtremeBand: numberOf(point, 'rsiExtremeBand'),
  minAtrTicks: numberOf(point, 'minAtrTicks'),
});

export const MACD_MODES = ['cross', 'hist'] as const;
export const MA_MODES = ['200', '50', '50+200'] as const;
export const MACD_GRID: readonly GridPoint[] = MACD_MODES.map((macd) => ({ macd }));
export const MA_GRID: readonly GridPoint[] = MA_MODES.map((ma) => ({ ma }));
export const MACD_MA_GRID: readonly GridPoint[] = MACD_MODES.flatMap((macd) =>
  MA_MODES.map((ma) => ({ macd, ma })),
);

// a gate answers the refusal that holds the trade, or undefined to let it through
type Gate = (indicators: SignalIndicators, action: TradeAction) => string | undefined;

function macdGate(point: GridPoint): Gate {
  const mode = oneOf(point, 'macd', MACD_MODES);
  return ({ macd }, action) => {
    if (!macd.ok) return 'macd_no_data';
    if (mode === 'cross') return macd.cross === action ? undefined : 'macd_no_cross';
    // a zero histogram agrees with neither direction
    const agrees = action === TradeAction.Up ? macd.histogram > 0 : macd.histogram < 0;
    return agrees ? undefined : 'macd_hist_disagrees';
  };
}

// a close equal to the average is on neither side
function sideOf(
  average: SignalIndicators['ma50'],
  action: TradeAction,
  period: '50' | '200',
): string | undefined {
  if (!average.ok) return `ma${period}_no_data`;
  const agrees =
    action === TradeAction.Up
      ? average.lastClose > average.value
      : average.lastClose < average.value;
  return agrees ? undefined : `ma${period}_disagrees`;
}

function maGate(point: GridPoint): Gate {
  const mode = oneOf(point, 'ma', MA_MODES);
  return ({ ma50, ma200 }, action) => {
    if (mode === '200') return sideOf(ma200, action, '200');
    if (mode === '50') return sideOf(ma50, action, '50');
    return sideOf(ma200, action, '200') ?? sideOf(ma50, action, '50');
  };
}

// v2's production decision stands first; the gates only hold its trades back, in order
function gated(ctx: DecisionContext, gates: readonly Gate[]): VariantDecision {
  const decision = ctx.v2();
  if (decision.kind === SignalKind.NoSignal) return { refusal: decision.reason };
  const indicators = ctx.indicators();
  if (indicators === undefined) return { refusal: 'indicators_unavailable' };
  for (const gate of gates) {
    const refusal = gate(indicators, decision.action);
    if (refusal !== undefined) return { refusal };
  }
  return { action: decision.action };
}

// the variants table (h) compares with v2 at its production point
export const comparesWithV2 = (name: string): boolean => name.startsWith('v2+');

const VOLATILITY_REFUSALS: ReadonlySet<string> = new Set([
  NoSignalReason.VolatilityTooLow,
  NoSignalReason.VolatilityTooHigh,
  NoSignalReason.VolatilityBelowTickFloor,
]);

export const VARIANTS: readonly Variant[] = [
  {
    name: 'v1',
    intervals: ['5s', '15s', '1m'],
    grid: [{}],
    headlinePause: false,
    decide: (ctx) => decisionOf(ctx.v1()),
  },
  {
    name: 'v2',
    intervals: ['5s', '15s', '1m'],
    grid: V2_GRID,
    headlinePause: true,
    decide: (ctx, point) => decisionOf(ctx.v2(asV2Point(point))),
  },
  {
    // against the rush: v2's own data and volatility refusals stand, the EMA trend is ignored
    name: 'revert',
    intervals: ['5s', '15s'],
    grid: REVERT_GRID,
    headlinePause: true,
    decide(ctx, point) {
      const band = numberOf(point, 'band');
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
  {
    // #380's first variant: v2's action only when the 1m trend agrees (trend only)
    name: 'v2+1m',
    intervals: ['5s', '15s'],
    grid: [{}],
    headlinePause: true,
    decide(ctx) {
      const decision = ctx.v2();
      if (decision.kind === SignalKind.NoSignal) return { refusal: decision.reason };
      const minute = ctx.v2OneMinute();
      if (!('features' in minute)) return { refusal: '1m_no_data' };
      if (minute.features.trend !== decision.action) return { refusal: '1m_trend_disagrees' };
      return { action: decision.action };
    },
  },
  {
    name: 'v2+macd',
    intervals: ['5s', '15s'],
    grid: MACD_GRID,
    headlinePause: true,
    decide: (ctx, point) => gated(ctx, [macdGate(point)]),
  },
  {
    name: 'v2+ma',
    intervals: ['5s', '15s'],
    grid: MA_GRID,
    headlinePause: true,
    decide: (ctx, point) => gated(ctx, [maGate(point)]),
  },
  {
    name: 'v2+macd+ma',
    intervals: ['5s', '15s'],
    grid: MACD_MA_GRID,
    headlinePause: true,
    decide: (ctx, point) => gated(ctx, [macdGate(point), maGate(point)]),
  },
];

export const pointLabel = (point: GridPoint): string =>
  Object.keys(point).length === 0
    ? '-'
    : Object.entries(point)
        .map(([key, value]) => `${key}=${value}`)
        .join(' ');
