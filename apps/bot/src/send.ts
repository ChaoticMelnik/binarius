import type { Context } from 'grammy';
import type { TelegramHtml } from '@binarius/shared';

// The bot's one send seam for user texts (the backend's is auth/link-notifier.ts): the only place
// that sets parse_mode HTML and unwraps TelegramHtml, so a raw string cannot reach the user as
// markup. ESLint forbids grammY's send methods everywhere else in apps/bot/src outside tests and
// names this file. A caller's extra cannot override parse_mode or the caption of the video or the
// photo, nor pass entities, which the Bot API takes instead of parse_mode.

type ReplyExtra = Omit<NonNullable<Parameters<Context['reply']>[1]>, 'parse_mode' | 'entities'>;
type EditExtra = Omit<
  NonNullable<Parameters<Context['editMessageText']>[1]>,
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

export const replyHtml = (ctx: Context, text: TelegramHtml, extra?: ReplyExtra) =>
  ctx.reply(text.value, { ...extra, parse_mode: 'HTML' });

// On a callback query, grammY edits the message the pressed button is under.
export const editMessageTextHtml = (ctx: Context, text: TelegramHtml, extra?: EditExtra) =>
  ctx.editMessageText(text.value, { ...extra, parse_mode: 'HTML' });

export const replyWithVideoHtml = (
  ctx: Context,
  video: Parameters<Context['replyWithVideo']>[0],
  caption: TelegramHtml,
  extra?: VideoExtra,
) => ctx.replyWithVideo(video, { ...extra, caption: caption.value, parse_mode: 'HTML' });

export const replyWithPhotoHtml = (
  ctx: Context,
  photo: Parameters<Context['replyWithPhoto']>[0],
  caption: TelegramHtml,
  extra?: PhotoExtra,
) => ctx.replyWithPhoto(photo, { ...extra, caption: caption.value, parse_mode: 'HTML' });
