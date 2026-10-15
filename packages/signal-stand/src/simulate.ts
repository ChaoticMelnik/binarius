import type { Candle, SignalDecision, SignalDecisionV1, TradeAction } from '@binarius/shared';
import { DECISION_SLACK_MS, SETTLE_TICK_MS, TRADE_INTERVALS, type TradeInterval } from './config';
import { outcomeOf, type Outcome, type PriceAt } from './price';
import {
  v1Decider,
  v2Decider,
  type DecisionContext,
  type GridPoint,
  type Variant,
} from './variants';
import { seriesAt } from './window';

export interface Market {
  assetId: number;
  digits: number;
  series: Partial<Record<TradeInterval, readonly Candle[]>>;
  price: PriceAt;
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
  outcome: Outcome | 'unpriced';
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
  const candles = () => seriesAt(market.series[interval] ?? [], intervalMs, nowMs);
  const { digits } = market;
  return {
    nowMs,
    v1: (): SignalDecisionV1 => v1Decider.decide({ candles: candles(), intervalMs, nowMs }),
    v2: (point): SignalDecision =>
      v2Decider(point).decide({ candles: candles(), intervalMs, nowMs, digits }),
  };
}

// production's pausedDirection over the priced trades: the last two lost in one direction
function pausedDirection(priced: readonly SimTrade[]): TradeAction | undefined {
  const [first, second] = priced.slice(-2);
  if (second === undefined) return undefined;
  return first.outcome === 'loss' && second.outcome === 'loss' && first.action === second.action
    ? second.action
    : undefined;
}

// The worker's cadence (docs/signal-stand.md -> The cadence model): ask at a boundary + slack;
// no trade -> the next boundary + slack; a trade -> after it settles. Trades never overlap.
export function simulate(market: Market, config: SimConfig): SimResult {
  const { intervalMs, durationSec } = TRADE_INTERVALS[config.interval];
  const nextAsk = (ms: number) => Math.ceil(ms / intervalMs) * intervalMs + DECISION_SLACK_MS;
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
        entry === undefined || exit === undefined ? 'unpriced' : outcomeOf(action, entry, exit),
    };
    result.trades.push(trade);
    if (trade.outcome !== 'unpriced') priced.push(trade);
    decidedAt = exitAt + SETTLE_TICK_MS;
  }
  return result;
}
