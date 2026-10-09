import { DEFAULT_SIGNAL_PARAMS } from '@binarius/signal';
import {
  BrokerRestErrorCode,
  MomentumDirection,
  NoSignalReason,
  SIGNAL_ALGORITHM_VERSION,
  SignalFeedOutcome,
  SignalKind,
  TrendDirection,
  type PairView,
  type TradeAction,
  type TradingSignalResponse,
} from '@binarius/shared';

// Fixtures of the two backend answers, valid by their shared schemas; the suites of the clients
// and of the orchestrator use the same ones.

const features = {
  emaFast: 1.1,
  emaSlow: 1.09,
  emaSlowSlope: 0.001,
  rsi: 62,
  atr: 0.002,
  atrPct: 0.18,
  lastClose: 1.1,
  lastCandleTimestamp: 1_760_000_000_000,
  closedCandles: 60,
  trend: TrendDirection.Up,
  momentum: MomentumDirection.Up,
  atrTicks: 200,
};

export const signalAnswer = (action: TradeAction): TradingSignalResponse => ({
  outcome: SignalFeedOutcome.Decided,
  params: DEFAULT_SIGNAL_PARAMS,
  decision: { kind: SignalKind.Signal, version: SIGNAL_ALGORITHM_VERSION, action, features },
});

export const noSignalAnswer = (): TradingSignalResponse => ({
  outcome: SignalFeedOutcome.Decided,
  params: DEFAULT_SIGNAL_PARAMS,
  decision: {
    kind: SignalKind.NoSignal,
    version: SIGNAL_ALGORITHM_VERSION,
    reason: NoSignalReason.TrendFlat,
    features: { ...features, trend: TrendDirection.Flat },
  },
});

export const fetchFailedAnswer = (retryAfterSec?: number): TradingSignalResponse => ({
  outcome: SignalFeedOutcome.FetchFailed,
  code: BrokerRestErrorCode.RateLimited,
  ...(retryAfterSec === undefined ? {} : { retryAfterSec }),
});

// the mock broker's EUR/USD as GET /trading/pairs shows it
export const eurUsd = (patch: Partial<PairView> = {}): PairView => ({
  id: 101,
  symbol: 'EUR/USD',
  isOtc: false,
  type: 'currency',
  digits: 5,
  payout: 85,
  maxPayout: 90,
  minTimeframe: 60,
  maxTimeframe: 3600,
  scheduledUntil: 0,
  ...patch,
});
