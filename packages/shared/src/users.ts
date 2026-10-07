import * as z from 'zod';
import { decimalStringSchema } from './money';
import { telegramUserIdSchema } from './trading';

// Lives here rather than in packages/db, like BrokerAccountStatus: the bot types a user's status
// without depending on the database package, and the schema imports the same constant.
export const UserStatus = { Active: 'active', Blocked: 'blocked' } as const;
export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];
export const userStatusSchema = z.enum(UserStatus);

// How often the bot may mail a user without being asked (#120). It never governs replies to the
// user's commands and buttons, the push after a site login, or the results of the user's own
// trades. `reduced` is at most one mailing per REDUCED_LEVEL_WINDOW_HOURS (packages/db).
export const NotificationLevel = { All: 'all', Reduced: 'reduced', Off: 'off' } as const;
export type NotificationLevel = (typeof NotificationLevel)[keyof typeof NotificationLevel];
export const notificationLevelSchema = z.enum(NotificationLevel);

// Telegram: "Start parameter, up to 64 base64url characters" (core.telegram.org/api/links#bot-links).
// Anyone can compose a ?start=... link, so this is untrusted input at three places that must agree:
// the bot, the request schema below, and users_acquisition_source_check in packages/db.
export const START_PAYLOAD_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const startPayloadSchema = z.string().regex(START_PAYLOAD_PATTERN, {
  error: 'expected 1-64 base64url characters',
});

// Telegram sends an "IETF language tag of the user's language". This pattern is a deliberately
// narrow approximation of one, not a BCP 47 validator: a 2-3 letter primary subtag, then any
// number of `-` subtags of 1-8 letters or digits, at most 35 characters. Private-use (`x-…`)
// and grandfathered (`i-…`) tags are dropped and a lone singleton such as `en-a` passes; the
// field is optional, so the bot simply omits a tag the schema refuses.
export const LANGUAGE_CODE_PATTERN = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/;
export const languageCodeSchema = z.string().max(35).regex(LANGUAGE_CODE_PATTERN, {
  error: 'expected a language tag: 2-3 letters, then optional -subtags of 1-8 letters or digits',
});

// POST /users/start — the bot's first call on every /start
export const userStartRequestSchema = z.object({
  telegramUserId: telegramUserIdSchema,
  displayName: z.string().trim().min(1).max(256),
  languageCode: languageCodeSchema.optional(),
  startPayload: startPayloadSchema.optional(),
});
export type UserStartRequest = z.infer<typeof userStartRequestSchema>;

// A link waiting for the Telegram user to confirm it: only what the bot shows on the button.
// The broker user id, the status and the ciphertexts stay in the backend.
export const pendingBrokerAccountViewSchema = z.object({
  id: z.uuid(),
  email: z.string().nullable(),
});
export type PendingBrokerAccountView = z.infer<typeof pendingBrokerAccountViewSchema>;

// Allowlisted projection of the users row plus two facts about its accounts: the token balance,
// the internal id and the timestamps never leave the process.
export const userStartViewSchema = z.object({
  telegramUserId: z.string(),
  status: userStatusSchema,
  acquisitionSource: z.string().nullable(),
  acquiredAt: z.iso.datetime({ offset: true }).nullable(),
  hasActiveBrokerAccount: z.boolean(),
  // newest first
  pendingBrokerAccounts: z.array(pendingBrokerAccountViewSchema),
  notificationLevel: notificationLevelSchema,
  // the saved demo stake, canonical; null = the broker's minimum at each trade (#297)
  demoStake: decimalStringSchema.nullable(),
});
export type UserStartView = z.infer<typeof userStartViewSchema>;

export const userStartResponseSchema = z.object({ user: userStartViewSchema });
export type UserStartResponse = z.infer<typeof userStartResponseSchema>;

export const safeParseUserStartRequest = (input: unknown) =>
  userStartRequestSchema.safeParse(input);
export const safeParseUserStartResponse = (input: unknown) =>
  userStartResponseSchema.safeParse(input);

// The two private-chat statuses of the bot that matter for delivery, spelled as the Bot API
// spells them (ChatMemberBanned.status, ChatMemberMember.status): the bot forwards Telegram's
// own word, and the backend decides what it means (#119).
export const TelegramChatMemberStatus = { Kicked: 'kicked', Member: 'member' } as const;
export type TelegramChatMemberStatus =
  (typeof TelegramChatMemberStatus)[keyof typeof TelegramChatMemberStatus];
export const telegramChatMemberStatusSchema = z.enum(TelegramChatMemberStatus);

// POST /users/chat-member — the bot reports that a user blocked or unblocked it
export const chatMemberRequestSchema = z.object({
  telegramUserId: telegramUserIdSchema,
  status: telegramChatMemberStatusSchema,
});
export type ChatMemberRequest = z.infer<typeof chatMemberRequestSchema>;

// `recorded: false` — no users row for this id; nothing was written
export const chatMemberResponseSchema = z.object({ recorded: z.boolean() });
export type ChatMemberResponse = z.infer<typeof chatMemberResponseSchema>;

export const safeParseChatMemberRequest = (input: unknown) =>
  chatMemberRequestSchema.safeParse(input);
export const safeParseChatMemberResponse = (input: unknown) =>
  chatMemberResponseSchema.safeParse(input);

// POST /users/notification-level — the user picked a level in /settings
export const notificationLevelRequestSchema = z.object({
  telegramUserId: telegramUserIdSchema,
  level: notificationLevelSchema,
});
export type NotificationLevelRequest = z.infer<typeof notificationLevelRequestSchema>;

// demoStake: /settings re-renders its stake line from this answer (#297)
export const notificationLevelResponseSchema = z.object({
  level: notificationLevelSchema,
  demoStake: decimalStringSchema.nullable(),
});
export type NotificationLevelResponse = z.infer<typeof notificationLevelResponseSchema>;

export const safeParseNotificationLevelRequest = (input: unknown) =>
  notificationLevelRequestSchema.safeParse(input);
export const safeParseNotificationLevelResponse = (input: unknown) =>
  notificationLevelResponseSchema.safeParse(input);
