// The codes live apart from size.ts because config.ts and the test fixtures need them too, and
// size.ts imports config.ts.

export const StakeKind = { Stake: 'stake', Stop: 'stop' } as const;
export type StakeKind = (typeof StakeKind)[keyof typeof StakeKind];

export const StakeStrategy = { Fixed: 'fixed', Martingale: 'martingale' } as const;
export type StakeStrategy = (typeof StakeStrategy)[keyof typeof StakeStrategy];

export const SessionTradeKind = {
  Settled: 'settled',
  Rejected: 'rejected',
  Unresolved: 'unresolved',
} as const;
export type SessionTradeKind = (typeof SessionTradeKind)[keyof typeof SessionTradeKind];

export const StopReason = {
  UnresolvedTrade: 'unresolved_trade',
  InvalidTrade: 'invalid_trade',
  InvalidAmount: 'invalid_amount',
  InvalidPayout: 'invalid_payout',
  SessionDurationExceeded: 'session_duration_exceeded',
  MaxStepsExceeded: 'max_steps_exceeded',
  MaxStakeExceeded: 'max_stake_exceeded',
  MaxSessionLossExceeded: 'max_session_loss_exceeded',
  BelowMinTradeAmount: 'below_min_trade_amount',
  InsufficientBalance: 'insufficient_balance',
} as const;
export type StopReason = (typeof StopReason)[keyof typeof StopReason];

export type DataStopReason =
  | typeof StopReason.UnresolvedTrade
  | typeof StopReason.InvalidTrade
  | typeof StopReason.InvalidAmount
  | typeof StopReason.InvalidPayout;
export type LimitStopReason = Exclude<StopReason, DataStopReason>;

export const TradeProblem = {
  NonPositiveStake: 'non_positive_stake',
  LossExceedsStake: 'loss_exceeds_stake',
} as const;
export type TradeProblem = (typeof TradeProblem)[keyof typeof TradeProblem];

export const AmountField = {
  HistoryStake: 'history.stake',
  HistoryProfit: 'history.profit',
  MinTradeAmount: 'minTradeAmount',
  Available: 'available',
} as const;
export type AmountField = (typeof AmountField)[keyof typeof AmountField];
