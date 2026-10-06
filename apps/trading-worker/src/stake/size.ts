import type { DecimalString } from '@binarius/shared';
import {
  AmountField,
  SessionTradeKind,
  StakeKind,
  StakeStrategy,
  StopReason,
  TradeProblem,
} from './codes';
import {
  assertStakeParams,
  DEFAULT_STAKE_PARAMS,
  STAKE_ALGORITHM_VERSION,
  type StakeParams,
} from './config';
import {
  ceilToScale,
  divCeil,
  expectedProfit,
  formatAmount,
  formatStake,
  parseAmount,
  parsePayout,
  PERCENT_DIVISOR,
} from './money';

// #130 maps trade_intents/broker_trades into this shape; the module does not know their statuses
export type SessionTrade =
  // profit is signed: < 0 a loss, 0 a tie, > 0 a win
  | { kind: typeof SessionTradeKind.Settled; stake: DecimalString; profit: DecimalString }
  // the order certainly never opened
  | { kind: typeof SessionTradeKind.Rejected }
  // anything without a result yet
  | { kind: typeof SessionTradeKind.Unresolved };

export interface StakeInput {
  // the session's trades in creation order
  history: readonly SessionTrade[];
  // BinaryPair.payout of the pair about to be traded; the fixed strategy does not read it
  payout: number;
  // broker_balance_snapshots.min_trade_amount of the account
  minTradeAmount: DecimalString;
  // broker_balance_snapshots.<mode>_available
  available: DecimalString;
  sessionStartedAtMs: number;
  nowMs: number;
}

export interface StakeFeatures {
  strategy: StakeStrategy;
  step: number;
  consecutiveLosses: number;
  streakLoss: DecimalString;
  realizedSessionLoss: DecimalString;
  settledTrades: number;
  sessionElapsedMs: number;
  baseStake: DecimalString;
}

type Version = typeof STAKE_ALGORITHM_VERSION;

type LimitStop =
  | {
      reason: typeof StopReason.SessionDurationExceeded;
      detail: { sessionElapsedMs: number; maxSessionDurationMs: number };
    }
  | { reason: typeof StopReason.MaxStepsExceeded; detail: { step: number; maxSteps: number } }
  | {
      reason: typeof StopReason.MaxStakeExceeded;
      detail: { amount: DecimalString; maxStake: DecimalString };
    }
  | {
      reason: typeof StopReason.MaxSessionLossExceeded;
      detail: {
        amount: DecimalString;
        realizedSessionLoss: DecimalString;
        maxSessionLoss: DecimalString;
      };
    }
  | {
      reason: typeof StopReason.BelowMinTradeAmount;
      detail: { amount: DecimalString; minTradeAmount: DecimalString };
    }
  | {
      reason: typeof StopReason.InsufficientBalance;
      detail: { amount: DecimalString; available: DecimalString };
    };

type DataStop =
  | { reason: typeof StopReason.UnresolvedTrade; detail: { index: number } }
  | {
      reason: typeof StopReason.InvalidAmount;
      detail:
        | {
            field: typeof AmountField.HistoryStake | typeof AmountField.HistoryProfit;
            index: number;
          }
        | { field: typeof AmountField.MinTradeAmount | typeof AmountField.Available };
    }
  | { reason: typeof StopReason.InvalidTrade; detail: { index: number; problem: TradeProblem } }
  // String(payout): NaN and Infinity would not survive JSON as numbers
  | { reason: typeof StopReason.InvalidPayout; detail: { payout: string } };

export type StakeDecision =
  | {
      kind: typeof StakeKind.Stake;
      version: Version;
      amount: DecimalString;
      features: StakeFeatures;
    }
  | ({ kind: typeof StakeKind.Stop; version: Version; features: StakeFeatures } & LimitStop)
  | ({ kind: typeof StakeKind.Stop; version: Version } & DataStop);

export interface StakeSizer {
  version: Version;
  params: Readonly<StakeParams>;
  next(input: StakeInput): StakeDecision;
}

function assertClock(sessionStartedAtMs: number, nowMs: number): void {
  for (const [name, value] of [
    ['sessionStartedAtMs', sessionStartedAtMs],
    ['nowMs', nowMs],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`stake clock: ${name} must be finite and >= 0, got ${value}`);
    }
  }
  if (nowMs < sessionStartedAtMs) {
    throw new RangeError(
      `stake clock: nowMs (${nowMs}) must be >= sessionStartedAtMs (${sessionStartedAtMs})`,
    );
  }
}

interface Ledger {
  settledTrades: number;
  consecutiveLosses: number;
  streakLoss: bigint;
  realizedSessionLoss: bigint;
}

// the first unusable trade in creation order, or the session's ledger
function readHistory(history: readonly SessionTrade[]): DataStop | Ledger {
  let settledTrades = 0;
  let consecutiveLosses = 0;
  let streakLoss = 0n;
  let net = 0n;
  for (const [index, trade] of history.entries()) {
    if (trade.kind === SessionTradeKind.Rejected) continue;
    // any kind but settled and rejected has no result: the next stake and the stop-loss need it
    if (trade.kind !== SessionTradeKind.Settled) {
      return { reason: StopReason.UnresolvedTrade, detail: { index } };
    }
    const stake = parseAmount(trade.stake);
    if (stake === undefined) {
      return {
        reason: StopReason.InvalidAmount,
        detail: { field: AmountField.HistoryStake, index },
      };
    }
    const profit = parseAmount(trade.profit);
    if (profit === undefined) {
      return {
        reason: StopReason.InvalidAmount,
        detail: { field: AmountField.HistoryProfit, index },
      };
    }
    if (stake <= 0n) {
      return {
        reason: StopReason.InvalidTrade,
        detail: { index, problem: TradeProblem.NonPositiveStake },
      };
    }
    if (profit < -stake) {
      return {
        reason: StopReason.InvalidTrade,
        detail: { index, problem: TradeProblem.LossExceedsStake },
      };
    }
    settledTrades += 1;
    net += profit;
    // ties and rejected orders neither extend nor end the streak; a win of any size ends it
    if (profit > 0n) {
      consecutiveLosses = 0;
      streakLoss = 0n;
    } else if (profit < 0n) {
      consecutiveLosses += 1;
      streakLoss -= profit;
    }
  }
  return {
    settledTrades,
    consecutiveLosses,
    streakLoss,
    realizedSessionLoss: net < 0n ? -net : 0n,
  };
}

function readBalance(input: StakeInput): DataStop | { minTradeAmount: bigint; available: bigint } {
  const minTradeAmount = parseAmount(input.minTradeAmount);
  if (minTradeAmount === undefined || minTradeAmount < 0n) {
    return { reason: StopReason.InvalidAmount, detail: { field: AmountField.MinTradeAmount } };
  }
  const available = parseAmount(input.available);
  if (available === undefined || available < 0n) {
    return { reason: StopReason.InvalidAmount, detail: { field: AmountField.Available } };
  }
  return { minTradeAmount, available };
}

// the smallest stake on the stakeScale grid whose floored profit covers the streak loss rounded up
// to the grid plus the base stake's profit (docs/stake.md -> Formula)
function martingaleStake(
  streakLoss: bigint,
  base: bigint,
  payoutScaled: bigint,
  scale: number,
): bigint {
  const target = ceilToScale(streakLoss + expectedProfit(base, payoutScaled, scale), scale);
  return ceilToScale(divCeil(target * PERCENT_DIVISOR, payoutScaled), scale);
}

// assertStakeParams has already proven every amount of the params parses
function requireAmount(text: DecimalString): bigint {
  const value = parseAmount(text);
  if (value === undefined) throw new RangeError(`stake params: unparsable amount ${text}`);
  return value;
}

function freezeParams(params: StakeParams): Readonly<StakeParams> {
  if (params.strategy === StakeStrategy.Martingale) {
    return Object.freeze({ ...params, limits: Object.freeze({ ...params.limits }) });
  }
  return Object.freeze({ ...params });
}

export function createStakeSizer(params: StakeParams = DEFAULT_STAKE_PARAMS): StakeSizer {
  assertStakeParams(params);
  const frozen = freezeParams(params);
  const version = STAKE_ALGORITHM_VERSION;
  const base = requireAmount(frozen.baseStake);
  const martingale =
    frozen.strategy === StakeStrategy.Martingale
      ? {
          limits: frozen.limits,
          maxStake: requireAmount(frozen.limits.maxStake),
          maxSessionLoss: requireAmount(frozen.limits.maxSessionLoss),
        }
      : undefined;

  return {
    version,
    params: frozen,
    next(input) {
      assertClock(input.sessionStartedAtMs, input.nowMs);
      const ledger = readHistory(input.history);
      if ('reason' in ledger) return { kind: StakeKind.Stop, version, ...ledger };
      const balance = readBalance(input);
      if ('reason' in balance) return { kind: StakeKind.Stop, version, ...balance };

      const sessionElapsedMs = input.nowMs - input.sessionStartedAtMs;
      const step = martingale === undefined ? 1 : ledger.consecutiveLosses + 1;
      const features: StakeFeatures = {
        strategy: frozen.strategy,
        step,
        consecutiveLosses: ledger.consecutiveLosses,
        streakLoss: formatAmount(ledger.streakLoss),
        realizedSessionLoss: formatAmount(ledger.realizedSessionLoss),
        settledTrades: ledger.settledTrades,
        sessionElapsedMs,
        baseStake: frozen.baseStake,
      };
      const stop = (limitStop: LimitStop): StakeDecision => ({
        kind: StakeKind.Stop,
        version,
        features,
        ...limitStop,
      });

      let candidate = base;
      if (martingale !== undefined) {
        const { limits, maxStake, maxSessionLoss } = martingale;
        if (sessionElapsedMs > limits.maxSessionDurationMs) {
          return stop({
            reason: StopReason.SessionDurationExceeded,
            detail: { sessionElapsedMs, maxSessionDurationMs: limits.maxSessionDurationMs },
          });
        }
        if (step > limits.maxSteps) {
          return stop({
            reason: StopReason.MaxStepsExceeded,
            detail: { step, maxSteps: limits.maxSteps },
          });
        }
        // checked on step 1 too: a series that could not be continued is not started
        const payoutScaled = parsePayout(input.payout);
        if (payoutScaled === undefined) {
          return {
            kind: StakeKind.Stop,
            version,
            reason: StopReason.InvalidPayout,
            detail: { payout: String(input.payout) },
          };
        }
        if (step > 1) {
          candidate = martingaleStake(ledger.streakLoss, base, payoutScaled, frozen.stakeScale);
        }
        if (candidate > maxStake) {
          return stop({
            reason: StopReason.MaxStakeExceeded,
            detail: { amount: formatAmount(candidate), maxStake: limits.maxStake },
          });
        }
        if (ledger.realizedSessionLoss + candidate > maxSessionLoss) {
          return stop({
            reason: StopReason.MaxSessionLossExceeded,
            detail: {
              amount: formatAmount(candidate),
              realizedSessionLoss: features.realizedSessionLoss,
              maxSessionLoss: limits.maxSessionLoss,
            },
          });
        }
      }
      if (candidate < balance.minTradeAmount) {
        return stop({
          reason: StopReason.BelowMinTradeAmount,
          detail: { amount: formatAmount(candidate), minTradeAmount: input.minTradeAmount },
        });
      }
      if (candidate > balance.available) {
        return stop({
          reason: StopReason.InsufficientBalance,
          detail: { amount: formatAmount(candidate), available: input.available },
        });
      }
      return {
        kind: StakeKind.Stake,
        version,
        amount: formatStake(candidate, frozen.stakeScale),
        features,
      };
    },
  };
}
