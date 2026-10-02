import * as z from 'zod';
import { BrokerAccountStatus } from './oauth';
import { telegramUserIdSchema } from './trading';
import { pendingBrokerAccountViewSchema, userStatusSchema } from './users';

// POST /users/account — what the bot's /account shows. One bound for the database query, the
// response schema and the texts test that proves the longest message still fits in Telegram.
export const USER_ACCOUNT_LIST_LIMIT = 10;

export const UserErrorCode = { UserNotFound: 'user_not_found' } as const;
export type UserErrorCode = (typeof UserErrorCode)[keyof typeof UserErrorCode];

export const userAccountRequestSchema = z.object({ telegramUserId: telegramUserIdSchema });
export type UserAccountRequest = z.infer<typeof userAccountRequestSchema>;

// The id is what a confirm button carries, so it exists on the pending member only: an active or
// revoked account's id cannot leave the backend by type, and z.object strips a stray one.
export const pendingLinkedAccountViewSchema = pendingBrokerAccountViewSchema.extend({
  status: z.literal(BrokerAccountStatus.Pending),
});
export type PendingLinkedAccountView = z.infer<typeof pendingLinkedAccountViewSchema>;

export const linkedAccountViewSchema = z.discriminatedUnion('status', [
  pendingLinkedAccountViewSchema,
  z.object({ status: z.literal(BrokerAccountStatus.Active), email: z.string().nullable() }),
  z.object({ status: z.literal(BrokerAccountStatus.Revoked), email: z.string().nullable() }),
]);
export type LinkedAccountView = z.infer<typeof linkedAccountViewSchema>;

export const userAccountViewSchema = z.object({
  status: userStatusSchema,
  // newest first
  accounts: z.array(linkedAccountViewSchema).max(USER_ACCOUNT_LIST_LIMIT),
});
export type UserAccountView = z.infer<typeof userAccountViewSchema>;

export const userAccountResponseSchema = z.object({ user: userAccountViewSchema });
export type UserAccountResponse = z.infer<typeof userAccountResponseSchema>;

export const safeParseUserAccountRequest = (input: unknown) =>
  userAccountRequestSchema.safeParse(input);
export const safeParseUserAccountResponse = (input: unknown) =>
  userAccountResponseSchema.safeParse(input);

export const isPendingLink = (account: LinkedAccountView): account is PendingLinkedAccountView =>
  account.status === BrokerAccountStatus.Pending;
