import {
  CANDLE_CLOSE_SLACK_MS,
  tradeOutcomeOf,
  type Candle,
  type SignalDecision,
  type SignalDecisionV1,
  type SignalIndicators,
  type TradeAction,
  type TradeOutcome,
} from '@binarius/shared';
import { DEFAULT_SIGNAL_PARAMS, displayIndicators, SIGNAL_FETCH_LIMIT } from '@binarius/signal';
import { SETTLE_TICK_MS, TRADE_INTERVALS, type TradeInterval } from './config';
import type { PriceAt } from './price';
import {
  v1Decider,
  v2Decider,
  type DecisionContext,
  type GridPoint,
  type Variant,
} from './variants';
import { seriesAt } from './window';

// Pure functions of (interval, nowMs), so a repeated boundary is a lookup and the result is the
// same (docs/signal-stand.md -> The cadence model): v2 at the production point and the indicators.
export interface IntervalMemo {
  v2: Map<number, SignalDecision>;
  indicators: Map<number, SignalIndicators | undefined>;
}
export type DecisionMemo = Partial<Record<TradeInterval, IntervalMemo>>;
export const createDecisionMemo = (): DecisionMemo => ({});

export interface Market {
  assetId: number;
  digits: number;
  series: Partial<Record<TradeInterval, readonly Candle[]>>;
  price: PriceAt;
  memo?: DecisionMemo;
}

export interface SimConfig {
  variant: Variant;
  point: GridPoint;
  interval: TradeInterval;
  pause: boolean;
  openDelayMs: number;
  // decisions start at the first boundary + slack at or after `from`; no trade exits after `until`
  from: number;
  until: number;
}

export interface SimTrade {
  decidedAt: number;
  action: TradeAction;
  entryAt: number;
  exitAt: number;
  outcome: TradeOutcome | 'unpriced';
}

export interface SimResult {
  decisions: number;
  trades: SimTrade[];
  refusals: Record<string, number>;
}

export const PAUSE_REFUSAL = 'pause_after_two_losses';

export function decisionContext(
  market: Market,
  interval: TradeInterval,
  nowMs: number,
): DecisionContext {
  const { intervalMs } = TRADE_INTERVALS[interval];
  const series = market.series[interval] ?? [];
  const candles = () => seriesAt(series, intervalMs, nowMs);
  const { digits } = market;
  const memo =
    market.memo === undefined
      ? undefined
      : (market.memo[interval] ??= { v2: new Map(), indicators: new Map() });
  return {
    nowMs,
    v1: (): SignalDecisionV1 => v1Decider.decide({ candles: candles(), intervalMs, nowMs }),
    v2: (point): SignalDecision => {
      const decide = () =>
        v2Decider(point).decide({ candles: candles(), intervalMs, nowMs, digits });
      if (point !== undefined || memo === undefined) return decide();
      let decision = memo.v2.get(nowMs);
      if (decision === undefined) {
        decision = decide();
        memo.v2.set(nowMs, decision);
      }
      return decision;
    },
    indicators: (): SignalIndicators | undefined => {
      const compute = () =>
        displayIndicators(
          seriesAt(series, intervalMs, nowMs, SIGNAL_FETCH_LIMIT),
          intervalMs,
          nowMs,
          DEFAULT_SIGNAL_PARAMS,
        );
      if (memo === undefined) return compute();
      if (memo.indicators.has(nowMs)) return memo.indicators.get(nowMs);
      const indicators = compute();
      memo.indicators.set(nowMs, indicators);
      return indicators;
    },
    v2OneMinute: (): SignalDecision => {
      const minuteMs = TRADE_INTERVALS['1m'].intervalMs;
      const minute = seriesAt(market.series['1m'] ?? [], minuteMs, nowMs);
      return v2Decider().decide({ candles: minute, intervalMs: minuteMs, nowMs, digits });
    },
  };
}

// the orchestrator's rule from #379 to #698, kept as the comparison overlay (table (d)): the last
// two priced trades lost in one direction
function pausedDirection(priced: readonly SimTrade[]): TradeAction | undefined {
  const [first, second] = priced.slice(-2);
  if (second === undefined) return undefined;
  return first.outcome === 'loss' && second.outcome === 'loss' && first.action === second.action
    ? second.action
    : undefined;
}

// The worker's cadence (docs/signal-stand.md -> The cadence model): ask at a boundary + slack
// (CANDLE_CLOSE_SLACK_MS, shared with the worker and the scanner);
// no trade -> the next boundary + slack; a trade -> after it settles. Trades never overlap.
export function simulate(market: Market, config: SimConfig): SimResult {
  const { intervalMs, durationSec } = TRADE_INTERVALS[config.interval];
  const nextAsk = (ms: number) => Math.ceil(ms / intervalMs) * intervalMs + CANDLE_CLOSE_SLACK_MS;
  const result: SimResult = { decisions: 0, trades: [], refusals: {} };
  const refuse = (reason: string) => {
    result.refusals[reason] = (result.refusals[reason] ?? 0) + 1;
  };
  const priced: SimTrade[] = [];
  let lastSignal: TradeAction | undefined;
  let decidedAt = nextAsk(config.from);
  while (decidedAt + config.openDelayMs + durationSec * 1000 <= config.until) {
    result.decisions++;
    const decision = config.variant.decide(
      decisionContext(market, config.interval, decidedAt),
      config.point,
    );
    const next = nextAsk(decidedAt + 1);
    if ('refusal' in decision) {
      refuse(decision.refusal);
      lastSignal = undefined;
      decidedAt = next;
      continue;
    }
    const { action } = decision;
    if (config.pause && lastSignal === action && pausedDirection(priced) === action) {
      refuse(PAUSE_REFUSAL);
      decidedAt = next;
      continue;
    }
    lastSignal = action;
    const entryAt = decidedAt + config.openDelayMs;
    const exitAt = entryAt + durationSec * 1000;
    const entry = market.price(entryAt);
    const exit = market.price(exitAt);
    const trade: SimTrade = {
      decidedAt,
      action,
      entryAt,
      exitAt,
      outcome:
        entry === undefined || exit === undefined
          ? 'unpriced'
          : tradeOutcomeOf(action, entry, exit),
    };
    result.trades.push(trade);
    if (trade.outcome !== 'unpriced') priced.push(trade);
    decidedAt = exitAt + SETTLE_TICK_MS;
  }
  return result;
}
