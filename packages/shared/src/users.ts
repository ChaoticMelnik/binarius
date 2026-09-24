import * as z from 'zod';
import { telegramUserIdSchema } from './trading';

// Lives here rather than in packages/db, like BrokerAccountStatus: the bot types a user's status
// without depending on the database package, and the schema imports the same constant.
export const UserStatus = { Active: 'active', Blocked: 'blocked' } as const;
export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];
export const userStatusSchema = z.enum(UserStatus);

// Telegram: "Start parameter, up to 64 base64url characters" (core.telegram.org/api/links#bot-links).
// Anyone can compose a ?start=... link, so this is untrusted input at three places that must agree:
// the bot, the request schema below, and users_acquisition_source_check in packages/db.
export const START_PAYLOAD_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const startPayloadSchema = z.string().regex(START_PAYLOAD_PATTERN, {
  error: 'expected 1-64 base64url characters',
});

// Telegram sends an "IETF language tag of the user's language": a BCP 47 primary subtag plus
// optional subtags. The length cap is what keeps an oversized tag out of the column.
export const LANGUAGE_CODE_PATTERN = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/;
export const languageCodeSchema = z
  .string()
  .max(35)
  .regex(LANGUAGE_CODE_PATTERN, { error: 'expected a BCP 47 language tag' });

// POST /users/start — the bot's first call on every /start
export const userStartRequestSchema = z.object({
  telegramUserId: telegramUserIdSchema,
  displayName: z.string().trim().min(1).max(256),
  languageCode: languageCodeSchema.optional(),
  startPayload: startPayloadSchema.optional(),
});
export type UserStartRequest = z.infer<typeof userStartRequestSchema>;

// Allowlisted projection of the users row plus one fact about the account: the token balance,
// the internal id and the timestamps never leave the process.
export const userStartViewSchema = z.object({
  telegramUserId: z.string(),
  status: userStatusSchema,
  acquisitionSource: z.string().nullable(),
  acquiredAt: z.iso.datetime({ offset: true }).nullable(),
  hasActiveBrokerAccount: z.boolean(),
});
export type UserStartView = z.infer<typeof userStartViewSchema>;

export const userStartResponseSchema = z.object({ user: userStartViewSchema });
export type UserStartResponse = z.infer<typeof userStartResponseSchema>;

export const safeParseUserStartRequest = (input: unknown) =>
  userStartRequestSchema.safeParse(input);
export const safeParseUserStartResponse = (input: unknown) =>
  userStartResponseSchema.safeParse(input);
