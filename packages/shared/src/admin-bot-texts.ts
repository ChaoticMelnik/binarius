import * as z from 'zod';
import { adminMeSchema } from './admin';
import { BotTextKind, type BotTextSource } from './bot-text-template';
import {
  BOT_PROFILE_METHODS,
  BOT_TEXT_KEY_PATTERN,
  BOT_TEXT_OVERRIDES_MAX,
  BOT_TEXT_SOURCE_MAX,
  botTextRejectionMessage,
  type BotTextChangeProblem,
  type BotTextRejection,
} from './bot-text-overrides';
import {
  BOT_TEXT_CATALOG,
  BotTextGroup,
  createBotTexts,
  type BotHtmlKey,
  type BotPlainKey,
  type BotTextKey,
} from './bot-texts';
import { telegramHtmlProblems } from './telegram-html';

// The admin section «Тексты бота» (#300, docs/admin-pages.md → Bot texts): its wire shapes and
// the few rules web and the backend must agree on.

// Read-only in the admin until it republishes the commands and the profile on a change (#361);
// its own fence: the writer, the CLI and the loaders take these groups (#301).
export const ADMIN_BOT_TEXT_READ_ONLY_GROUPS: readonly BotTextGroup[] = [
  BotTextGroup.Commands,
  BotTextGroup.Profile,
];
export const isAdminBotTextEditable = (key: BotTextKey): boolean =>
  !ADMIN_BOT_TEXT_READ_ONLY_GROUPS.includes(BOT_TEXT_CATALOG[key].group);

// a rejection worded in Russian; adminBotTextReason cuts a longer one
export const ADMIN_BOT_TEXT_REASON_MAX = 512;
// fragments of one key; the test holds the catalog under it
export const ADMIN_BOT_TEXT_FRAGMENTS_MAX = 16;
// JSON of a BOT_TEXT_SOURCE_MAX source takes at most 6 bytes a code point (\uXXXX) plus the
// envelope
export const ADMIN_BOT_TEXT_BODY_LIMIT_BYTES = 128 * 1024;
// a host holds at most three fragments, each of them up to a source's length
const RENDERED_MAX = 4 * BOT_TEXT_SOURCE_MAX;

const isoDateTime = z.iso.datetime({ offset: true });
const strictMe = z.strictObject(adminMeSchema.shape);
const keySchema = z.string().regex(BOT_TEXT_KEY_PATTERN);
const version = z.int().min(1).max(Number.MAX_SAFE_INTEGER);
const reason = z.string().max(ADMIN_BOT_TEXT_REASON_MAX);

// empty allowed: the validator answers «Пустой текст»; max() counts code points, as the CHECK
export const adminBotTextSourceSchema = z.string().max(BOT_TEXT_SOURCE_MAX);
// 0 = no override
export const adminBotTextVersionSchema = z.int().min(0).max(Number.MAX_SAFE_INTEGER);

export const adminBotTextOverrideViewSchema = z.strictObject({
  key: keySchema,
  version,
  updatedAt: isoDateTime,
  // null: written by the CLI
  updatedByLogin: z.string().nullable(),
  // why the loaders show the default instead; null while it is in effect
  rejection: reason.nullable(),
});
export type AdminBotTextOverrideView = z.infer<typeof adminBotTextOverrideViewSchema>;

export const adminBotTextsResponseSchema = z.strictObject({
  me: strictMe,
  overrides: z.array(adminBotTextOverrideViewSchema).max(BOT_TEXT_OVERRIDES_MAX),
});
export type AdminBotTextsResponse = z.infer<typeof adminBotTextsResponseSchema>;

export const adminBotTextFragmentViewSchema = z.strictObject({
  placeholder: z.string().regex(/^[a-z][a-zA-Z0-9]*$/),
  key: keySchema,
  // the text in effect
  source: adminBotTextSourceSchema,
  overridden: z.boolean(),
});
export type AdminBotTextFragmentView = z.infer<typeof adminBotTextFragmentViewSchema>;

export const adminBotTextViewSchema = z.strictObject({
  key: keySchema,
  override: z
    .strictObject({
      source: adminBotTextSourceSchema,
      version,
      updatedAt: isoDateTime,
      updatedByLogin: z.string().nullable(),
    })
    .nullable(),
  rejection: reason.nullable(),
  fragments: z.array(adminBotTextFragmentViewSchema).max(ADMIN_BOT_TEXT_FRAGMENTS_MAX),
});
export type AdminBotTextView = z.infer<typeof adminBotTextViewSchema>;

export const adminBotTextResponseSchema = z.strictObject({
  me: strictMe,
  text: adminBotTextViewSchema,
});
export type AdminBotTextResponse = z.infer<typeof adminBotTextResponseSchema>;

export const adminBotTextPreviewRequestSchema = z.strictObject({
  source: adminBotTextSourceSchema,
});
export type AdminBotTextPreviewRequest = z.infer<typeof adminBotTextPreviewRequestSchema>;
export const adminBotTextSaveRequestSchema = z.strictObject({
  source: adminBotTextSourceSchema,
  expectedVersion: adminBotTextVersionSchema,
});
export type AdminBotTextSaveRequest = z.infer<typeof adminBotTextSaveRequestSchema>;
export const adminBotTextResetRequestSchema = z.strictObject({
  expectedVersion: adminBotTextVersionSchema,
});
export type AdminBotTextResetRequest = z.infer<typeof adminBotTextResetRequestSchema>;

const problemsSchema = z
  .array(z.strictObject({ key: keySchema, reason }))
  .min(1)
  .max(BOT_TEXT_OVERRIDES_MAX);
export type AdminBotTextProblem = z.infer<typeof problemsSchema>[number];

export const adminBotTextRenderedSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal(BotTextKind.Html),
    // web turns it into browser HTML only once Telegram would take it
    telegramHtml: z
      .string()
      .max(RENDERED_MAX)
      .refine((value) => telegramHtmlProblems(value).length === 0),
  }),
  z.strictObject({ kind: z.literal(BotTextKind.Plain), text: z.string().max(RENDERED_MAX) }),
]);
export type AdminBotTextRendered = z.infer<typeof adminBotTextRenderedSchema>;

const outcome = <
  O extends string,
  T extends z.ZodType<AdminBotTextView | null>,
  S extends z.ZodRawShape,
>(
  name: O,
  text: T,
  shape: S,
) => z.strictObject({ me: strictMe, text, outcome: z.literal(name), ...shape });

const view = adminBotTextViewSchema;
const conflict = {
  currentVersion: adminBotTextVersionSchema,
  currentSource: adminBotTextSourceSchema,
};

export const adminBotTextPreviewResponseSchema = z.discriminatedUnion('outcome', [
  outcome('rendered', view, { rendered: adminBotTextRenderedSchema }),
  outcome('refused', view, { problems: problemsSchema }),
  outcome('read_only', view, {}),
]);
export type AdminBotTextPreviewResponse = z.infer<typeof adminBotTextPreviewResponseSchema>;

export const adminBotTextSaveResponseSchema = z.discriminatedUnion('outcome', [
  outcome('saved', view, { version }),
  outcome('unchanged', view, {}),
  outcome('version_conflict', view, conflict),
  outcome('refused', view, { problems: problemsSchema }),
  outcome('read_only', view, {}),
]);
export type AdminBotTextSaveResponse = z.infer<typeof adminBotTextSaveResponseSchema>;

// text is null for a key outside the catalog: a row left behind by a renamed key
const nullableView = adminBotTextViewSchema.nullable();
export const adminBotTextResetResponseSchema = z.discriminatedUnion('outcome', [
  outcome('reset', nullableView, {}),
  outcome('already_default', nullableView, {}),
  outcome('version_conflict', nullableView, conflict),
  outcome('refused', nullableView, { problems: problemsSchema }),
  outcome('read_only', nullableView, {}),
]);
export type AdminBotTextResetResponse = z.infer<typeof adminBotTextResetResponseSchema>;

// An error's name or code the result carries; adminBotProfileIdentity holds one to it.
export const ADMIN_BOT_PROFILE_IDENTITY_MAX = 128;
const identity = z.strictObject({
  name: z.string().min(1).max(ADMIN_BOT_PROFILE_IDENTITY_MAX),
  code: z.string().min(1).max(ADMIN_BOT_PROFILE_IDENTITY_MAX).optional(),
});
type Identity = z.infer<typeof identity>;

// The outcome of one Bot API call of a publish (#361): identity only (rule 8), no description.
export const adminBotProfileMethodResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ method: z.enum(BOT_PROFILE_METHODS), ok: z.literal(true) }),
  z.strictObject({
    method: z.enum(BOT_PROFILE_METHODS),
    ok: z.literal(false),
    err: identity,
    cause: identity.optional(),
    telegramErrorCode: z.int().min(100).max(599).optional(),
  }),
]);
export type AdminBotProfileMethodResult = z.infer<typeof adminBotProfileMethodResultSchema>;
// [] when the key publishes nothing; at most one result a method
export const adminBotProfilePublishedSchema = z
  .array(adminBotProfileMethodResultSchema)
  .max(BOT_PROFILE_METHODS.length);

export const adminBotProfilePublishResponseSchema = z.strictObject({
  me: strictMe,
  published: adminBotProfilePublishedSchema,
});
export type AdminBotProfilePublishResponse = z.infer<typeof adminBotProfilePublishResponseSchema>;

const clipIdentity = (value: string) => value.slice(0, ADMIN_BOT_PROFILE_IDENTITY_MAX);

/**
 * An error identity as the wire takes it: errorIdentity puts no bound on a name or a code, and
 * one the schema refuses would make web report a saved text's publish as unknown. The log keeps
 * the identity as it was.
 */
export function adminBotProfileIdentity(value: { name: string; code?: string }): Identity {
  const name = value.name === '' ? 'Error' : clipIdentity(value.name);
  return value.code === undefined || value.code === ''
    ? { name }
    : { name, code: clipIdentity(value.code) };
}

export const safeParseAdminBotTextsResponse = (input: unknown) =>
  adminBotTextsResponseSchema.safeParse(input);
export const safeParseAdminBotTextResponse = (input: unknown) =>
  adminBotTextResponseSchema.safeParse(input);
export const safeParseAdminBotTextPreviewRequest = (input: unknown) =>
  adminBotTextPreviewRequestSchema.safeParse(input);
export const safeParseAdminBotTextSaveRequest = (input: unknown) =>
  adminBotTextSaveRequestSchema.safeParse(input);
export const safeParseAdminBotTextResetRequest = (input: unknown) =>
  adminBotTextResetRequestSchema.safeParse(input);
export const safeParseAdminBotTextPreviewResponse = (input: unknown) =>
  adminBotTextPreviewResponseSchema.safeParse(input);
export const safeParseAdminBotTextSaveResponse = (input: unknown) =>
  adminBotTextSaveResponseSchema.safeParse(input);
export const safeParseAdminBotTextResetResponse = (input: unknown) =>
  adminBotTextResetResponseSchema.safeParse(input);
export const safeParseAdminBotProfilePublishResponse = (input: unknown) =>
  adminBotProfilePublishResponseSchema.safeParse(input);

// An outcome the operation cannot give for this request (already_default from a save): ours to
// fix, a 500. Only `name`, as every error here (rule 8).
export class UnexpectedBotTextOutcome extends Error {
  override readonly name = 'UnexpectedBotTextOutcome';
}

/** A rejection in Russian, cut to what the wire carries. */
export function adminBotTextReason(rejection: BotTextRejection, key: string): string {
  const message = botTextRejectionMessage(rejection, key);
  return message.length <= ADMIN_BOT_TEXT_REASON_MAX
    ? message
    : `${message.slice(0, ADMIN_BOT_TEXT_REASON_MAX - 1)}…`;
}

export const adminBotTextProblems = (
  problems: readonly BotTextChangeProblem[],
): AdminBotTextProblem[] =>
  problems.map(({ key, rejection }) => ({ key, reason: adminBotTextReason(rejection, key) }));

/**
 * What the bot would send for `key` with the texts of `source`: through the same views the bot
 * renders with, each variable at its registry sample (bot-text-vars.ts). Throws for a text the
 * validator has not passed (InvalidBotText, InvalidTelegramTemplate).
 */
export function renderBotTextPreview(
  key: BotTextKey,
  source: BotTextSource<BotTextKey>,
): AdminBotTextRendered {
  const { samples } = createBotTexts(source);
  return BOT_TEXT_CATALOG[key].kind === BotTextKind.Html
    ? { kind: BotTextKind.Html, telegramHtml: String(samples.html[key as BotHtmlKey]) }
    : { kind: BotTextKind.Plain, text: samples.plain[key as BotPlainKey] };
}
