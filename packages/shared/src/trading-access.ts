import * as z from 'zod';
import { brokerBalanceUnavailableReasonSchema, brokerBalanceViewSchema } from './broker-balance';
import { decimalStringSchema } from './money';
import { StakeRefusal } from './stake';
import {
  telegramUserIdSchema,
  tokenCountSchema,
  tradeAmountSchema,
  tradeModeSchema,
} from './trading';
import { userStatusSchema } from './users';

// POST /trading/access — what a user may trade with right now: the token side (#136) and the
// broker's balance snapshot with its ages (#137). `brokerAccountId` picks one account when the
// user has several; without it the user's only active account is used.

export const tradingAccessRequestSchema = z.object({
  telegramUserId: telegramUserIdSchema,
  brokerAccountId: z.uuid().optional(),
});
export type TradingAccessRequest = z.infer<typeof tradingAccessRequestSchema>;

const isCount = (value: unknown): value is string => tokenCountSchema.safeParse(value).success;

// The backend computes `available`; this refine only lets the bot's parser refuse a body whose
// numbers disagree. Zod 4 runs an object-level refine even after a field failed, so it re-tests
// all three before handing them to BigInt().
export const tokenBalanceViewSchema = z
  .object({
    balance: tokenCountSchema,
    reserved: tokenCountSchema,
    available: tokenCountSchema,
  })
  .refine(
    ({ balance, reserved, available }) =>
      !isCount(balance) ||
      !isCount(reserved) ||
      !isCount(available) ||
      BigInt(balance) - BigInt(reserved) === BigInt(available),
    { error: 'available must equal balance - reserved' },
  );
export type TokenBalanceView = z.infer<typeof tokenBalanceViewSchema>;

// `broker` is null exactly when `brokerUnavailable` says why
export const tradingAccessResponseSchema = z
  .object({
    status: userStatusSchema,
    tokens: tokenBalanceViewSchema,
    broker: brokerBalanceViewSchema.nullable(),
    brokerUnavailable: brokerBalanceUnavailableReasonSchema.nullable(),
    // the global trading switch (#144, trading_switch), not a property of the user or the account
    tradingOpen: z.boolean(),
    // the user's saved demo stake, canonical; null = the broker's minimum (#297)
    demoStake: decimalStringSchema.nullable(),
    // the user's saved real stake, canonical; null = the broker's minimum (#326)
    realStake: decimalStringSchema.nullable(),
    // users.trading_mode (#121): the mode the user's next single trade goes in
    tradingMode: tradeModeSchema,
  })
  .refine(({ broker, brokerUnavailable }) => (broker === null) === (brokerUnavailable !== null), {
    error: 'broker is null exactly when brokerUnavailable is set',
  });
export type TradingAccessResponse = z.infer<typeof tradingAccessResponseSchema>;

export const safeParseTradingAccessRequest = (input: unknown) =>
  tradingAccessRequestSchema.safeParse(input);
export const safeParseTradingAccessResponse = (input: unknown) =>
  tradingAccessResponseSchema.safeParse(input);

// POST /trading/stake (#297 demo, #326 real): save the user's stake of one mode, checked against
// that mode's balance in the account's stored snapshot; null resets it to the broker's minimum
// and is never refused.
export const STAKE_PATH = '/trading/stake';

export const setStakeRequestSchema = z.strictObject({
  telegramUserId: telegramUserIdSchema,
  mode: tradeModeSchema,
  amount: tradeAmountSchema.nullable(),
});
export type SetStakeRequest = z.infer<typeof setStakeRequestSchema>;

export const setStakeResponseSchema = z.strictObject({
  mode: tradeModeSchema,
  stake: decimalStringSchema.nullable(),
});
export type SetStakeResponse = z.infer<typeof setStakeResponseSchema>;

export const StakeErrorCode = {
  ...StakeRefusal,
  UserNotFound: 'user_not_found',
  // no single account with a snapshot to check the stake against
  BalanceUnavailable: 'balance_unavailable',
} as const;
export type StakeErrorCode = (typeof StakeErrorCode)[keyof typeof StakeErrorCode];

// a bounds refusal carries the limits it was checked against, canonical, so the bot words it
// with no second request; available is the balance of the request's mode
export const stakeRefusalSchema = z.union([
  z.strictObject({
    error: z.enum(StakeRefusal),
    limits: z.strictObject({
      minTradeAmount: decimalStringSchema,
      available: decimalStringSchema,
      scale: z.int().min(0),
    }),
  }),
  z.strictObject({
    error: z.enum([StakeErrorCode.UserNotFound, StakeErrorCode.BalanceUnavailable]),
  }),
]);
export type StakeRefusalBody = z.infer<typeof stakeRefusalSchema>;

export const safeParseSetStakeRequest = (input: unknown) => setStakeRequestSchema.safeParse(input);
export const safeParseSetStakeResponse = (input: unknown) =>
  setStakeResponseSchema.safeParse(input);
export const safeParseStakeRefusal = (input: unknown) => stakeRefusalSchema.safeParse(input);
