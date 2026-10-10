import type { Api, Context, InlineKeyboard } from 'grammy';
import type { InlineKeyboardMarkup } from 'grammy/types';
import type { TelegramHtml } from '@binarius/shared';

// The bot's one send seam for user texts (the backend's is auth/client-push.ts): the only place
// that sets parse_mode HTML and unwraps TelegramHtml, so a raw string cannot reach the user as
// markup. ESLint forbids grammY's send methods everywhere else in apps/bot/src outside tests and
// names this file. A caller's extra cannot override parse_mode or the caption of the video or the
// photo, nor pass entities, which the Bot API takes instead of parse_mode.
//
// Every message carries an inline keyboard, the user's next step (#350, docs/bot-navigation.md):
// `reply_markup` is required and only an inline one counts. A message without one goes through a
// `…WithoutNextStep` function, which names its reason from NO_NEXT_STEP_REASONS.

export const NO_NEXT_STEP_REASONS = {
  // a screen in place while the bot waits for an answer; the next screen replaces it with a
  // keyboard, and none on it keeps the same button from being pressed twice («⏳ Анализирую…»)
  InProgress: 'in_progress',
} as const;
export type NoNextStepReason = (typeof NO_NEXT_STEP_REASONS)[keyof typeof NO_NEXT_STEP_REASONS];

type NextStep = { reply_markup: InlineKeyboard | InlineKeyboardMarkup };
type WithNextStep<T> = Omit<T, 'reply_markup'> & NextStep;

type ReplyExtra = Omit<NonNullable<Parameters<Context['reply']>[1]>, 'parse_mode' | 'entities'>;
type EditExtra = Omit<
  NonNullable<Parameters<Context['editMessageText']>[1]>,
  'parse_mode' | 'entities'
>;
type EditByIdExtra = Omit<
  NonNullable<Parameters<Api['editMessageText']>[3]>,
  'parse_mode' | 'entities'
>;
type VideoExtra = Omit<
  NonNullable<Parameters<Context['replyWithVideo']>[1]>,
  'parse_mode' | 'caption' | 'caption_entities'
>;
type PhotoExtra = Omit<
  NonNullable<Parameters<Context['replyWithPhoto']>[1]>,
  'parse_mode' | 'caption' | 'caption_entities'
>;
type PhotoByIdExtra = Omit<
  NonNullable<Parameters<Api['sendPhoto']>[2]>,
  'parse_mode' | 'caption' | 'caption_entities'
>;

export const replyHtml = (ctx: Context, text: TelegramHtml, extra: WithNextStep<ReplyExtra>) =>
  ctx.reply(text.value, { ...extra, parse_mode: 'HTML' });

// A message without a keyboard. `reason` is not sent: its type makes each such call name an entry
// of NO_NEXT_STEP_REASONS, which docs/bot-navigation.md lists.
export const replyHtmlWithoutNextStep = (
  ctx: Context,
  text: TelegramHtml,
  reason: NoNextStepReason,
) => {
  void reason;
  return ctx.reply(text.value, { parse_mode: 'HTML' });
};

// On a callback query, grammY edits the message the pressed button is under.
export const editMessageTextHtml = (
  ctx: Context,
  text: TelegramHtml,
  extra: WithNextStep<EditExtra>,
) => ctx.editMessageText(text.value, { ...extra, parse_mode: 'HTML' });

// An edit that removes the keyboard on screen on purpose; `reason` as above.
export const editMessageTextHtmlWithoutNextStep = (
  ctx: Context,
  text: TelegramHtml,
  reason: NoNextStepReason,
) => {
  void reason;
  return ctx.editMessageText(text.value, { parse_mode: 'HTML' });
};

// Outside an update (the intent tracker, #127): the message named by its chat and id.
export const editMessageTextByIdHtml = (
  api: Pick<Api, 'editMessageText'>,
  chatId: number,
  messageId: number,
  text: TelegramHtml,
  extra: WithNextStep<EditByIdExtra>,
) => api.editMessageText(chatId, messageId, text.value, { ...extra, parse_mode: 'HTML' });

export const replyWithVideoHtml = (
  ctx: Context,
  video: Parameters<Context['replyWithVideo']>[0],
  caption: TelegramHtml,
  extra: WithNextStep<VideoExtra>,
) => ctx.replyWithVideo(video, { ...extra, caption: caption.value, parse_mode: 'HTML' });

export const replyWithPhotoHtml = (
  ctx: Context,
  photo: Parameters<Context['replyWithPhoto']>[0],
  caption: TelegramHtml,
  extra: WithNextStep<PhotoExtra>,
) => ctx.replyWithPhoto(photo, { ...extra, caption: caption.value, parse_mode: 'HTML' });

// Outside an update (the session tracker's summary card, #318): a photo to the chat named by id.
export const sendPhotoByIdHtml = (
  api: Pick<Api, 'sendPhoto'>,
  chatId: number,
  photo: Parameters<Api['sendPhoto']>[1],
  caption: TelegramHtml,
  extra: WithNextStep<PhotoByIdExtra>,
) => api.sendPhoto(chatId, photo, { ...extra, caption: caption.value, parse_mode: 'HTML' });
