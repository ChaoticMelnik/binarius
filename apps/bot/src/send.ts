import { InlineKeyboard, type Api, type Context, type InputFile } from 'grammy';
import type { InlineKeyboardMarkup } from 'grammy/types';
import { BOT_MESSAGE_SPACER, STARS_CURRENCY, type TelegramHtml } from '@binarius/shared';

// The bot's one send seam for user texts (the backend's is auth/client-push.ts): the only place
// that sets parse_mode HTML and unwraps TelegramHtml, so a raw string cannot reach the user as
// markup. ESLint forbids grammY's send methods everywhere else in apps/bot/src outside tests and
// names this file. A caller's extra cannot override parse_mode or the caption of the video or the
// photo, nor pass entities, which the Bot API takes instead of parse_mode.
//
// Every message carries an inline keyboard, the user's next step (#350, docs/bot-navigation.md):
// `reply_markup` is required and only an inline one counts. A message without one goes through a
// `…WithoutNextStep` function, which names its reason from NO_NEXT_STEP_REASONS.
//
// Every text message ends with the width spacer (#506, docs/bot-navigation.md → The width): a line
// of braille blanks that makes each bubble, and so its keyboard, as wide as the longest. Captions,
// inline answers and the invoice go without it: a picture sets their width.

export const NO_NEXT_STEP_REASONS = {
  // a screen in place while the bot waits for an answer; the next screen replaces it with a
  // keyboard, or goes as a photo and deletes it (the analysis card, #482), and none on it keeps
  // the same button from being pressed twice («⏳ Анализирую…»)
  InProgress: 'in_progress',
  // the session message (#536, #568, docs/bot-session.md → The session message): its head, the
  // session's pair and settings above its trades, the caption of the signal's picture or a text;
  // the next step stands under the backend's waiting message (its «⏹») and under the summary and
  // its card once the session ended
  SessionStatus: 'session_status',
} as const;
export type NoNextStepReason = (typeof NO_NEXT_STEP_REASONS)[keyof typeof NO_NEXT_STEP_REASONS];

const sent = (text: TelegramHtml) => text.value + BOT_MESSAGE_SPACER;

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
// the caption, its parse_mode and entities travel in the media, which the seam builds
type MediaEditExtra = NonNullable<Parameters<Api['editMessageMedia']>[3]>;

export const replyHtml = (ctx: Context, text: TelegramHtml, extra: WithNextStep<ReplyExtra>) =>
  ctx.reply(sent(text), { ...extra, parse_mode: 'HTML' });

// A message without a keyboard. `reason` is not sent: its type makes each such call name an entry
// of NO_NEXT_STEP_REASONS, which docs/bot-navigation.md lists.
export const replyHtmlWithoutNextStep = (
  ctx: Context,
  text: TelegramHtml,
  reason: NoNextStepReason,
) => {
  void reason;
  return ctx.reply(sent(text), { parse_mode: 'HTML' });
};

// On a callback query, grammY edits the message the pressed button is under.
export const editMessageTextHtml = (
  ctx: Context,
  text: TelegramHtml,
  extra: WithNextStep<EditExtra>,
) => ctx.editMessageText(sent(text), { ...extra, parse_mode: 'HTML' });

// An edit that removes the keyboard on screen on purpose; `reason` as above.
export const editMessageTextHtmlWithoutNextStep = (
  ctx: Context,
  text: TelegramHtml,
  reason: NoNextStepReason,
) => {
  void reason;
  return ctx.editMessageText(sent(text), { parse_mode: 'HTML' });
};

// Outside an update (the intent tracker, #127): the message named by its chat and id.
export const editMessageTextByIdHtml = (
  api: Pick<Api, 'editMessageText'>,
  chatId: number,
  messageId: number,
  text: TelegramHtml,
  extra: WithNextStep<EditByIdExtra>,
) => api.editMessageText(chatId, messageId, sent(text), { ...extra, parse_mode: 'HTML' });

// The same without a keyboard: an edit without reply_markup removes the inline keyboard on
// screen. `reason` as above.
export const editMessageTextByIdHtmlWithoutNextStep = (
  api: Pick<Api, 'editMessageText'>,
  chatId: number,
  messageId: number,
  text: TelegramHtml,
  reason: NoNextStepReason,
) => {
  void reason;
  return api.editMessageText(chatId, messageId, sent(text), { parse_mode: 'HTML' });
};

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

// A photo without a keyboard (the session message, #568); `reason` as above.
export const replyWithPhotoHtmlWithoutNextStep = (
  ctx: Context,
  photo: Parameters<Context['replyWithPhoto']>[0],
  caption: TelegramHtml,
  reason: NoNextStepReason,
) => {
  void reason;
  return ctx.replyWithPhoto(photo, { caption: caption.value, parse_mode: 'HTML' });
};

// Outside an update (the session tracker, #568): the message named by its chat and id becomes this
// photo with this caption, whether it was a photo or a text (Bot API editMessageMedia).
export const editMessagePhotoByIdHtml = (
  api: Pick<Api, 'editMessageMedia'>,
  chatId: number,
  messageId: number,
  photo: string | InputFile,
  caption: TelegramHtml,
  extra: WithNextStep<MediaEditExtra>,
) =>
  api.editMessageMedia(
    chatId,
    messageId,
    { type: 'photo', media: photo, caption: caption.value, parse_mode: 'HTML' },
    extra,
  );

// The same without a keyboard: an edit without reply_markup removes the inline keyboard on
// screen. `reason` as above.
export const editMessagePhotoByIdHtmlWithoutNextStep = (
  api: Pick<Api, 'editMessageMedia'>,
  chatId: number,
  messageId: number,
  photo: string | InputFile,
  caption: TelegramHtml,
  reason: NoNextStepReason,
) => {
  void reason;
  return api.editMessageMedia(chatId, messageId, {
    type: 'photo',
    media: photo,
    caption: caption.value,
    parse_mode: 'HTML',
  });
};

// Outside an update (the session tracker's summary card, #318): a photo to the chat named by id.
export const sendPhotoByIdHtml = (
  api: Pick<Api, 'sendPhoto'>,
  chatId: number,
  photo: Parameters<Api['sendPhoto']>[1],
  caption: TelegramHtml,
  extra: WithNextStep<PhotoByIdExtra>,
) => api.sendPhoto(chatId, photo, { ...extra, caption: caption.value, parse_mode: 'HTML' });

// The promo card's post to the private storage channel (#538, session-share.ts): not a message to
// a user, so no caption and no keyboard by type, an exception (docs/bot-navigation.md → Exceptions).
// It exists for the photo's file id, which the inline answer then names; without sound, since the
// channel's members are the owner's staff.
export const sendPhotoToStorage = (api: Pick<Api, 'sendPhoto'>, chatId: number, photo: InputFile) =>
  api.sendPhoto(chatId, photo, { disable_notification: true });

// A Telegram Stars invoice (#117, docs/stars.md): currency XTR, no provider token, one price.
// Telegram parses none of its texts. The keyboard is required like every message's, and the Bot
// API wants the pay button first: `pay` is that button's label and leads the keyboard; `then` is
// what follows it. No start_parameter: a forwarded copy keeps its Pay button, which is why the
// credit checks the payer (docs/stars.md → Payer).
export const replyWithInvoiceStars = (
  ctx: Context,
  invoice: { title: string; description: string; payload: string; label: string; stars: number },
  { pay, then }: { pay: string; then: InlineKeyboard },
) =>
  ctx.replyWithInvoice(
    invoice.title,
    invoice.description,
    invoice.payload,
    STARS_CURRENCY,
    [{ label: invoice.label, amount: invoice.stars }],
    {
      reply_markup: new InlineKeyboard([
        [InlineKeyboard.pay(pay)],
        ...then.inline_keyboard.filter((row) => row.length > 0),
      ]),
    },
  );

// The inline answers (#321, session-share.ts): the shared summary card, posted «via @bot» into a
// chat the user picked. No keyboard by type, an exception to the rule above
// (docs/bot-navigation.md → Exceptions): the bot's buttons there would act for whoever presses
// them. The found answer is personal; the empty one is not cached, so a passing failure does not
// hide the card from the owner for Telegram's default 300 s.
export const answerInlineQueryPhotoHtml = (
  ctx: Context,
  result: { id: string; fileId: string },
  caption: TelegramHtml,
) =>
  ctx.answerInlineQuery(
    [
      {
        type: 'photo',
        id: result.id,
        photo_file_id: result.fileId,
        caption: caption.value,
        parse_mode: 'HTML',
      },
    ],
    { is_personal: true },
  );

export const answerInlineQueryEmpty = (ctx: Context) =>
  ctx.answerInlineQuery([], { cache_time: 0, is_personal: true });
