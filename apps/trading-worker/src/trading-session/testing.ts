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
  type SignalDecision,
  type SignalRecord,
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

// The decision's record as the backend answers it to a session (#666): a 1m socket entry decided
// at `nowMs` on `rows` candles, and the pair's last tick
export const RECORD_NOW_MS = 1_760_000_030_000;
export const signalRecordOf = (
  decision: SignalDecision,
  { nowMs = RECORD_NOW_MS, rows = 2 }: { nowMs?: number; rows?: number } = {},
): SignalRecord => {
  const boundary = Math.floor(nowMs / 60_000) * 60_000;
  return {
    entry: {
      assetId: 101,
      interval: '1m',
      digits: 5,
      intervalMs: 60_000,
      nowMs,
      source: {
        kind: 'socket',
        startTime: boundary - rows * 60_000,
        closedUntil: boundary,
        gaps: 0,
      },
      version: SIGNAL_ALGORITHM_VERSION,
      params: DEFAULT_SIGNAL_PARAMS,
      series: Array.from(
        { length: rows },
        (_, index) => [boundary - (rows - index) * 60_000, 1.1001, 1.1012, 1.0993, 1.1004] as const,
      ),
      decision,
    },
    lastTick: { price: 1.1004, timestamp: nowMs - 200, receivedAtMs: nowMs - 180 },
  };
};

// `record: false` is the answer of a backend before #666
export const signalAnswer = (
  action: TradeAction,
  { record = true }: { record?: boolean } = {},
): TradingSignalResponse => {
  const decision: SignalDecision = {
    kind: SignalKind.Signal,
    version: SIGNAL_ALGORITHM_VERSION,
    action,
    features,
  };
  return {
    outcome: SignalFeedOutcome.Decided,
    params: DEFAULT_SIGNAL_PARAMS,
    decision,
    ...(record ? { record: signalRecordOf(decision) } : {}),
    // the H1 field (#828): the worker's v3 step reads the candle decision only
    h1: null,
  };
};

export const noSignalAnswer = ({
  record = true,
}: { record?: boolean } = {}): TradingSignalResponse => {
  const decision: SignalDecision = {
    kind: SignalKind.NoSignal,
    version: SIGNAL_ALGORITHM_VERSION,
    reason: NoSignalReason.TrendFlat,
    features: { ...features, trend: TrendDirection.Flat },
  };
  return {
    outcome: SignalFeedOutcome.Decided,
    params: DEFAULT_SIGNAL_PARAMS,
    decision,
    ...(record ? { record: signalRecordOf(decision) } : {}),
    h1: null,
  };
};

export const fetchFailedAnswer = (retryAfterSec?: number): TradingSignalResponse => ({
  outcome: SignalFeedOutcome.FetchFailed,
  code: BrokerRestErrorCode.RateLimited,
  ...(retryAfterSec === undefined ? {} : { retryAfterSec }),
  h1: null,
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
