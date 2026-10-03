import * as z from 'zod';
import { telegramUserIdSchema, tokenCountSchema } from './trading';
import { userStatusSchema } from './users';

// POST /trading/access — what a user may trade with right now. #136 answers the token side;
// #137 adds a `broker` section (the balance snapshot and its age) to the response and an
// optional `brokerAccountId` to the request.

export const tradingAccessRequestSchema = z.object({ telegramUserId: telegramUserIdSchema });
export type TradingAccessRequest = z.infer<typeof tradingAccessRequestSchema>;

const COUNT = /^\d+$/;

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
      !COUNT.test(balance) ||
      !COUNT.test(reserved) ||
      !COUNT.test(available) ||
      BigInt(balance) - BigInt(reserved) === BigInt(available),
    { error: 'available must equal balance - reserved' },
  );
export type TokenBalanceView = z.infer<typeof tokenBalanceViewSchema>;

export const tradingAccessResponseSchema = z.object({
  status: userStatusSchema,
  tokens: tokenBalanceViewSchema,
});
export type TradingAccessResponse = z.infer<typeof tradingAccessResponseSchema>;

export const safeParseTradingAccessRequest = (input: unknown) =>
  tradingAccessRequestSchema.safeParse(input);
export const safeParseTradingAccessResponse = (input: unknown) =>
  tradingAccessResponseSchema.safeParse(input);
