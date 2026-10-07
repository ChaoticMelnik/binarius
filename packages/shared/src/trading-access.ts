import * as z from 'zod';
import { brokerBalanceUnavailableReasonSchema, brokerBalanceViewSchema } from './broker-balance';
import { DemoStakeRefusal } from './demo-stake';
import { decimalStringSchema } from './money';
import { telegramUserIdSchema, tokenCountSchema, tradeAmountSchema } from './trading';
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
  })
  .refine(({ broker, brokerUnavailable }) => (broker === null) === (brokerUnavailable !== null), {
    error: 'broker is null exactly when brokerUnavailable is set',
  });
export type TradingAccessResponse = z.infer<typeof tradingAccessResponseSchema>;

export const safeParseTradingAccessRequest = (input: unknown) =>
  tradingAccessRequestSchema.safeParse(input);
export const safeParseTradingAccessResponse = (input: unknown) =>
  tradingAccessResponseSchema.safeParse(input);

// POST /trading/demo-stake (#297): save the user's demo stake, checked against the account's
// stored balance snapshot; null resets it to the broker's minimum and is never refused.
export const DEMO_STAKE_PATH = '/trading/demo-stake';

export const setDemoStakeRequestSchema = z.strictObject({
  telegramUserId: telegramUserIdSchema,
  amount: tradeAmountSchema.nullable(),
});
export type SetDemoStakeRequest = z.infer<typeof setDemoStakeRequestSchema>;

export const setDemoStakeResponseSchema = z.strictObject({
  demoStake: decimalStringSchema.nullable(),
});
export type SetDemoStakeResponse = z.infer<typeof setDemoStakeResponseSchema>;

export const DemoStakeErrorCode = {
  ...DemoStakeRefusal,
  UserNotFound: 'user_not_found',
  // no single account with a snapshot to check the stake against
  BalanceUnavailable: 'balance_unavailable',
} as const;
export type DemoStakeErrorCode = (typeof DemoStakeErrorCode)[keyof typeof DemoStakeErrorCode];

// a bounds refusal carries the limits it was checked against, canonical, so the bot words it
// with no second request
export const demoStakeRefusalSchema = z.union([
  z.strictObject({
    error: z.enum(DemoStakeRefusal),
    limits: z.strictObject({
      minTradeAmount: decimalStringSchema,
      demoAvailable: decimalStringSchema,
      scale: z.int().min(0),
    }),
  }),
  z.strictObject({
    error: z.enum([DemoStakeErrorCode.UserNotFound, DemoStakeErrorCode.BalanceUnavailable]),
  }),
]);
export type DemoStakeRefusalBody = z.infer<typeof demoStakeRefusalSchema>;

export const safeParseSetDemoStakeRequest = (input: unknown) =>
  setDemoStakeRequestSchema.safeParse(input);
export const safeParseSetDemoStakeResponse = (input: unknown) =>
  setDemoStakeResponseSchema.safeParse(input);
export const safeParseDemoStakeRefusal = (input: unknown) =>
  demoStakeRefusalSchema.safeParse(input);
