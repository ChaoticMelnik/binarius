import * as z from 'zod';
import { decimalStringSchema, normalizeDecimal, type DecimalString } from './money';
import { createTradeIntentRequestSchema, tradeAmountSchema } from './trading';

// trading_sessions.settings, version 1 (docs/trading-session.md -> Settings). The column is
// checked at read, not at write: a row written by hand is a boundary too.
export const TRADING_SESSION_SETTINGS_VERSION = 1;
export const MAX_SESSION_TRADES = 20;
// the CLI's and the start route's default; the schema itself requires the field
export const DEFAULT_SESSION_TRADES = 5;
const MAX_STAKE_SCALE = 8;

export const tradingSessionSettingsSchema = z.strictObject({
  version: z.literal(TRADING_SESSION_SETTINGS_VERSION),
  assetId: createTradeIntentRequestSchema.shape.assetId,
  durationSec: createTradeIntentRequestSchema.shape.durationSec,
  trades: z.int().min(1).max(MAX_SESSION_TRADES),
  // the fixed strategy only (Rule 23): the orchestrator builds { strategy: 'fixed', ...stake }
  stake: z.strictObject({
    baseStake: tradeAmountSchema,
    stakeScale: z.int().min(0).max(MAX_STAKE_SCALE),
  }),
});
export type TradingSessionSettings = z.infer<typeof tradingSessionSettingsSchema>;

export const safeParseTradingSessionSettings = (input: unknown) =>
  tradingSessionSettingsSchema.safeParse(input);

export const TradingSessionStopReason = {
  // settled trades reached settings.trades
  Completed: 'completed',
  // an intent of the session is in manual_review, or the account is halted
  ManualReview: 'manual_review',
  // the last two intents of the session are rejected
  RejectedTwice: 'rejected_twice',
  // started_at + the maximum duration passed, on the database clock
  Timeout: 'timeout',
  // the stake sizer answered stop; its code is in the log line
  StakeStop: 'stake_stop',
  // the intent creation refused for a durable reason; the code is in the log line
  AccountUnavailable: 'account_unavailable',
  // the pair left the catalog or refuses the duration
  PairUnavailable: 'pair_unavailable',
  // no balance snapshot row for the account
  BalanceUnavailable: 'balance_unavailable',
  // settings fail the schema or the sizer's parameter rules
  InvalidSettings: 'invalid_settings',
  // the stop route of #283; nothing in the worker writes it
  UserStopped: 'user_stopped',
  // the global trading switch is closed (#144, stopPausedSessions)
  KillSwitch: 'kill_switch',
} as const;
export type TradingSessionStopReason =
  (typeof TradingSessionStopReason)[keyof typeof TradingSessionStopReason];

export const tradingSessionStopReasonSchema = z.enum(TradingSessionStopReason);

// The fixed stake of a session from the account's min_trade_amount: the canonical spelling
// (normalizeDecimal) and its own fraction length as the scale, so every valid numeric(20,8)
// minimum passes assertStakeParams.
export function stakeSettingsFor(minTradeAmount: DecimalString): {
  baseStake: DecimalString;
  stakeScale: number;
} {
  const canonical = normalizeDecimal(minTradeAmount);
  const [, fraction = ''] = canonical.split('.');
  return { baseStake: decimalStringSchema.parse(canonical), stakeScale: fraction.length };
}
