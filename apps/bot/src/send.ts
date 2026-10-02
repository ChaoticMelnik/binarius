import type { Context } from 'grammy';
import type { TelegramHtml } from '@binarius/shared';

// The bot's one send seam for user texts (the backend's is auth/link-notifier.ts): the only place
// that sets parse_mode HTML and unwraps TelegramHtml, so a raw string cannot reach the user as
// markup. ESLint forbids grammY's send methods everywhere else in apps/bot/src and names this
// file. A caller's extra cannot override parse_mode, nor the caption of the video.

type ReplyExtra = Omit<NonNullable<Parameters<Context['reply']>[1]>, 'parse_mode'>;
type VideoExtra = Omit<
  NonNullable<Parameters<Context['replyWithVideo']>[1]>,
  'parse_mode' | 'caption'
>;

export const replyHtml = (ctx: Context, text: TelegramHtml, extra?: ReplyExtra) =>
  ctx.reply(text.value, { ...extra, parse_mode: 'HTML' });

export const replyWithVideoHtml = (
  ctx: Context,
  video: Parameters<Context['replyWithVideo']>[0],
  caption: TelegramHtml,
  extra?: VideoExtra,
) => ctx.replyWithVideo(video, { ...extra, caption: caption.value, parse_mode: 'HTML' });
