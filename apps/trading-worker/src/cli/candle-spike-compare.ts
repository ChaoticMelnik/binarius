import {
  SignalKind,
  type Candle,
  type SignalDecision,
  type SignalIndicators,
} from '@binarius/shared';
import {
  aggregateEndLabelled,
  atr,
  chartWindow,
  decisionRows,
  displayIndicators,
  SIGNAL_CHART_LIMIT,
  SIGNAL_FETCH_LIMIT,
  type SignalDecider,
} from '@binarius/signal';

// The comparisons of the candle spike (#392, docs/broker-socket.md -> The candle spike): candles
// built from ticks against the broker's REST candles of the same window, at the pair's digits, and
// the Signal decisions and display indicators each series gives at the same moments. Pure: the
// run feeds it, the report prints it. "rest" is the reference side, "ticks" the candidate.

export interface Span {
  fromMs: number;
  toMs: number;
}

// candle starts, both inclusive
export interface SeriesRange {
  firstMs: number;
  lastMs: number;
}

export interface CompareContext {
  range: SeriesRange;
  intervalMs: number;
  digits: number;
  holes: readonly Span[];
}

const ATR_PERIOD = 14;

// [start, end) against a hole [fromMs, toMs]: the markHole rule of the builder
const overlapsHole = (start: number, end: number, holes: readonly Span[]) =>
  holes.some((hole) => start <= hole.toMs && end > hole.fromMs);

export const cutToRange = (series: readonly Candle[], range: SeriesRange): Candle[] =>
  series.filter(({ timestamp }) => range.firstMs <= timestamp && timestamp <= range.lastMs);

export interface AlignedRow {
  timestamp: number;
  ticks?: Candle;
  rest?: Candle;
}

export interface Alignment {
  rows: AlignedRow[];
  both: number;
  restOnly: number;
  ticksOnly: number;
}

export function alignSeries(
  ticks: readonly Candle[],
  rest: readonly Candle[],
  range: SeriesRange,
): Alignment {
  const byTime = new Map<number, AlignedRow>();
  for (const candle of cutToRange(ticks, range)) {
    byTime.set(candle.timestamp, { timestamp: candle.timestamp, ticks: candle });
  }
  for (const candle of cutToRange(rest, range)) {
    const row = byTime.get(candle.timestamp) ?? { timestamp: candle.timestamp };
    row.rest = candle;
    byTime.set(candle.timestamp, row);
  }
  const rows = [...byTime.values()].sort((a, b) => a.timestamp - b.timestamp);
  return {
    rows,
    both: rows.filter((row) => row.ticks !== undefined && row.rest !== undefined).length,
    restOnly: rows.filter((row) => row.ticks === undefined).length,
    ticksOnly: rows.filter((row) => row.rest === undefined).length,
  };
}

// the difference in quote steps; the broker's float artifacts round away
export const stepsBetween = (a: number, b: number, digits: number): number =>
  Math.round((a - b) * 10 ** digits);

// rows by |difference in steps|: 0, 1, 2, 3 and more
export type StepHistogram = [number, number, number, number];

export interface CandleComparison {
  // rows with both sides, outside every hole
  compared: number;
  openEq: number;
  closeEq: number;
  // open, high, low and close all equal
  allEq: number;
  high: StepHistogram;
  low: StepHistogram;
  restOnly: number;
  ticksOnly: number;
  // rows of any kind that overlap a hole, left out of everything above
  inHole: number;
  // ATR(14) of the two sides over the compared rows, relative to the REST side
  atr?: { meanPct: number; maxPct: number };
}

const bucketOf = (steps: number) => Math.min(Math.abs(steps), 3);

function atrDifference(ticks: readonly Candle[], rest: readonly Candle[]): CandleComparison['atr'] {
  if (rest.length < ATR_PERIOD + 1) return undefined;
  const a = atr(ticks, ATR_PERIOD);
  const b = atr(rest, ATR_PERIOD);
  const relative = b.map((value, i) => (value > 0 ? (Math.abs(a[i] - value) / value) * 100 : 0));
  return {
    meanPct: relative.reduce((sum, value) => sum + value, 0) / relative.length,
    maxPct: Math.max(...relative),
  };
}

export function compareSeries(
  ticks: readonly Candle[],
  rest: readonly Candle[],
  context: CompareContext,
): CandleComparison {
  const { intervalMs, digits, holes } = context;
  const result: CandleComparison = {
    compared: 0,
    openEq: 0,
    closeEq: 0,
    allEq: 0,
    high: [0, 0, 0, 0],
    low: [0, 0, 0, 0],
    restOnly: 0,
    ticksOnly: 0,
    inHole: 0,
  };
  const pairedTicks: Candle[] = [];
  const pairedRest: Candle[] = [];
  for (const row of alignSeries(ticks, rest, context.range).rows) {
    if (overlapsHole(row.timestamp, row.timestamp + intervalMs, holes)) {
      result.inHole += 1;
      continue;
    }
    if (row.ticks === undefined) {
      result.restOnly += 1;
      continue;
    }
    if (row.rest === undefined) {
      result.ticksOnly += 1;
      continue;
    }
    const t = row.ticks;
    const r = row.rest;
    const open = stepsBetween(t.open, r.open, digits);
    const close = stepsBetween(t.close, r.close, digits);
    const high = stepsBetween(t.high, r.high, digits);
    const low = stepsBetween(t.low, r.low, digits);
    result.compared += 1;
    if (open === 0) result.openEq += 1;
    if (close === 0) result.closeEq += 1;
    if (open === 0 && close === 0 && high === 0 && low === 0) result.allEq += 1;
    result.high[bucketOf(high)] += 1;
    result.low[bucketOf(low)] += 1;
    pairedTicks.push(t);
    pairedRest.push(r);
  }
  const atrDiff = atrDifference(pairedTicks, pairedRest);
  return atrDiff === undefined ? result : { ...result, atr: atrDiff };
}

// The broker's `1s` rows are labelled by their end (docs/broker-socket.md -> The candle spike);
// their aggregate against the native series of the same interval.
export const PRICE_STEP_MS = 1_000;

export const compareAggregation = (
  rows: readonly Candle[],
  native: readonly Candle[],
  context: CompareContext,
): CandleComparison =>
  compareSeries(aggregateEndLabelled(rows, PRICE_STEP_MS, context.intervalMs), native, context);

export const DecisionCategory = {
  SignalToNoSignal: 'signal_to_no_signal',
  NoSignalToSignal: 'no_signal_to_signal',
  UpDown: 'up_down',
  ReasonChanged: 'reason_changed',
} as const;
export type DecisionCategory = (typeof DecisionCategory)[keyof typeof DecisionCategory];

// from the REST side's decision to the tick side's
export function decisionCategory(
  rest: SignalDecision,
  ticks: SignalDecision,
): DecisionCategory | undefined {
  if (rest.kind === SignalKind.Signal && ticks.kind === SignalKind.Signal) {
    return rest.action === ticks.action ? undefined : DecisionCategory.UpDown;
  }
  if (rest.kind === SignalKind.Signal) return DecisionCategory.SignalToNoSignal;
  if (ticks.kind === SignalKind.Signal) return DecisionCategory.NoSignalToSignal;
  return rest.reason === ticks.reason ? undefined : DecisionCategory.ReasonChanged;
}

export interface MacdCounts {
  compared: number;
  crossDiffer: number;
  signDiffer: number;
  okDiffer: number;
}

export interface SideCounts {
  compared: number;
  sideDiffer: number;
  okDiffer: number;
}

export interface DisplayComparison {
  macd: MacdCounts;
  ma50: SideCounts;
  ma200: SideCounts;
}

const emptyDisplay = (): DisplayComparison => ({
  macd: { compared: 0, crossDiffer: 0, signDiffer: 0, okDiffer: 0 },
  ma50: { compared: 0, sideDiffer: 0, okDiffer: 0 },
  ma200: { compared: 0, sideDiffer: 0, okDiffer: 0 },
});

// the bot's "price above/below the average" reading
const sideOf = (ma: { value: number; lastClose: number }) => Math.sign(ma.lastClose - ma.value);

function compareAverage(
  counts: SideCounts,
  rest: SignalIndicators['ma50'] | undefined,
  ticks: SignalIndicators['ma50'] | undefined,
) {
  const restOk = rest?.ok === true;
  const ticksOk = ticks?.ok === true;
  if (restOk !== ticksOk) counts.okDiffer += 1;
  if (rest?.ok !== true || ticks?.ok !== true) return;
  counts.compared += 1;
  if (sideOf(rest) !== sideOf(ticks)) counts.sideDiffer += 1;
}

// One moment: an indicator is compared only when both sides have it; `ok` on one side only is
// okDiffer (a hole shortens the tick tail). An indicator short on both sides counts nowhere, and
// one never compared prints «не измерено».
export function compareDisplay(
  rest: SignalIndicators | undefined,
  ticks: SignalIndicators | undefined,
  into: DisplayComparison = emptyDisplay(),
): DisplayComparison {
  const restMacd = rest?.macd;
  const ticksMacd = ticks?.macd;
  if ((restMacd?.ok === true) !== (ticksMacd?.ok === true)) into.macd.okDiffer += 1;
  if (restMacd?.ok === true && ticksMacd?.ok === true) {
    into.macd.compared += 1;
    if (restMacd.cross !== ticksMacd.cross) into.macd.crossDiffer += 1;
    if (Math.sign(restMacd.histogram) !== Math.sign(ticksMacd.histogram)) {
      into.macd.signDiffer += 1;
    }
  }
  compareAverage(into.ma50, rest?.ma50, ticks?.ma50);
  compareAverage(into.ma200, rest?.ma200, ticks?.ma200);
  return into;
}

export interface DecisionComparison {
  compared: number;
  differ: number;
  categories: Record<DecisionCategory, number>;
  // moments where both decisions carry features
  tickFloorCompared: number;
  // atrTicks >= minAtrTicks on one side only
  tickFloorDiffer: number;
  // moments whose decision window overlaps a hole: left out of the shares, decisions and display
  inHole: { compared: number; differ: number };
  display: DisplayComparison;
}

export interface DecisionContext extends CompareContext {
  decider: SignalDecider;
}

// the rows the production fetch would give the decider at nowMs: cut by time (#482)
export const decideAt = (
  series: readonly Candle[],
  nowMs: number,
  context: Pick<DecisionContext, 'intervalMs' | 'digits' | 'decider'>,
): SignalDecision =>
  context.decider.decide({
    candles: decisionRows(series, nowMs, context.intervalMs),
    intervalMs: context.intervalMs,
    nowMs,
    digits: context.digits,
  });

// the rows of the production display fetch (chartWindow of SIGNAL_FETCH_LIMIT) at nowMs
function displayAt(series: readonly Candle[], nowMs: number, context: DecisionContext) {
  const { startTime, limit } = chartWindow(nowMs, context.intervalMs, SIGNAL_FETCH_LIMIT);
  const boundary = startTime + (limit - 1) * context.intervalMs;
  const cut = series.filter(({ timestamp }) => startTime <= timestamp && timestamp <= boundary);
  return displayIndicators(cut, context.intervalMs, nowMs, context.decider.params);
}

const hasFeatures = (decision: SignalDecision) =>
  'features' in decision ? decision.features : undefined;

// A moment is the close of the candle at ts: nowMs = ts + I + 1. Moments run from the first one
// whose decision window lies wholly inside the range. Both series are cut to the range first, so
// neither side sees a row the other could not have.
export function compareDecisions(
  ticks: readonly Candle[],
  rest: readonly Candle[],
  context: DecisionContext,
): DecisionComparison {
  const { range, intervalMs, holes, decider } = context;
  const ticksInRange = cutToRange(ticks, range);
  const restInRange = cutToRange(rest, range);
  const result: DecisionComparison = {
    compared: 0,
    differ: 0,
    categories: {
      [DecisionCategory.SignalToNoSignal]: 0,
      [DecisionCategory.NoSignalToSignal]: 0,
      [DecisionCategory.UpDown]: 0,
      [DecisionCategory.ReasonChanged]: 0,
    },
    tickFloorCompared: 0,
    tickFloorDiffer: 0,
    inHole: { compared: 0, differ: 0 },
    display: emptyDisplay(),
  };
  const minAtrTicks = decider.params.minAtrTicks;
  // the window's last start is the forming candle at ts + I
  const firstMoment = range.firstMs + (SIGNAL_CHART_LIMIT - 2) * intervalMs;
  for (let ts = firstMoment; ts <= range.lastMs; ts += intervalMs) {
    const nowMs = ts + intervalMs + 1;
    const restDecision = decideAt(restInRange, nowMs, context);
    const ticksDecision = decideAt(ticksInRange, nowMs, context);
    const category = decisionCategory(restDecision, ticksDecision);
    const windowStart = chartWindow(nowMs, intervalMs, SIGNAL_CHART_LIMIT).startTime;
    if (overlapsHole(windowStart, ts + intervalMs, holes)) {
      result.inHole.compared += 1;
      if (category !== undefined) result.inHole.differ += 1;
      continue;
    }
    result.compared += 1;
    if (category !== undefined) {
      result.differ += 1;
      result.categories[category] += 1;
    }
    const restFeatures = hasFeatures(restDecision);
    const ticksFeatures = hasFeatures(ticksDecision);
    if (restFeatures !== undefined && ticksFeatures !== undefined) {
      result.tickFloorCompared += 1;
      if (restFeatures.atrTicks >= minAtrTicks !== ticksFeatures.atrTicks >= minAtrTicks) {
        result.tickFloorDiffer += 1;
      }
    }
    compareDisplay(
      displayAt(restInRange, nowMs, context),
      displayAt(ticksInRange, nowMs, context),
      result.display,
    );
  }
  return result;
}
