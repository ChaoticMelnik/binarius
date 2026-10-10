import * as z from 'zod';
import { telegramUserIdSchema, tradeModeSchema } from './trading';

// POST /trading/mode (#121, docs/trading-mode.md): switch the user's trading mode. `demo` is
// never refused but for a missing user; `real` needs the account's stored balance snapshot with
// real.available at least the broker's minimum, and is refused on a DEMO_ONLY process.
export const TRADING_MODE_PATH = '/trading/mode';

export const setTradingModeRequestSchema = z.strictObject({
  telegramUserId: telegramUserIdSchema,
  mode: tradeModeSchema,
});

export const setTradingModeResponseSchema = z.strictObject({
  tradingMode: tradeModeSchema,
  // false: the user was in that mode already, nothing was written
  changed: z.boolean(),
});

export const TradingModeErrorCode = {
  UserNotFound: 'user_not_found',
  // no single active account with a balance snapshot to check the real balance against
  BalanceUnavailable: 'balance_unavailable',
  RealBalanceBelowMinimum: 'real_balance_below_minimum',
  // the process runs DEMO_ONLY (#396): real cannot be switched on
  DemoOnly: 'demo_only',
} as const;
export type TradingModeErrorCode = (typeof TradingModeErrorCode)[keyof typeof TradingModeErrorCode];

export const tradingModeRefusalSchema = z.strictObject({
  error: z.enum(TradingModeErrorCode),
});

export const safeParseSetTradingModeRequest = (input: unknown) =>
  setTradingModeRequestSchema.safeParse(input);
export const safeParseSetTradingModeResponse = (input: unknown) =>
  setTradingModeResponseSchema.safeParse(input);
export const safeParseTradingModeRefusal = (input: unknown) =>
  tradingModeRefusalSchema.safeParse(input);
