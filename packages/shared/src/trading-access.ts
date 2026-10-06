import * as z from 'zod';
import { brokerBalanceUnavailableReasonSchema, brokerBalanceViewSchema } from './broker-balance';
import { telegramUserIdSchema, tokenCountSchema } from './trading';
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
    // REAL_TRADING_ENABLED of the answering backend, not a property of the user or the account
    realTradingAllowed: z.boolean(),
  })
  .refine(({ broker, brokerUnavailable }) => (broker === null) === (brokerUnavailable !== null), {
    error: 'broker is null exactly when brokerUnavailable is set',
  });
export type TradingAccessResponse = z.infer<typeof tradingAccessResponseSchema>;

export const safeParseTradingAccessRequest = (input: unknown) =>
  tradingAccessRequestSchema.safeParse(input);
export const safeParseTradingAccessResponse = (input: unknown) =>
  tradingAccessResponseSchema.safeParse(input);
