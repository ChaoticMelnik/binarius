// Compiled by `tsc -b` (include: src) and imported by nothing: the directives below are the
// oracle that a raw string reaches neither the send seam nor a message constant, and that a
// caller cannot hand the seam entities in place of parse_mode. If any of them starts compiling,
// tsc reports TS2578 (unused directive) and `pnpm check` fails.
import type { Api, Context, InlineKeyboard, InputFile } from 'grammy';
import type { TelegramHtml } from '@binarius/shared';
import {
  answerInlineQueryEmpty,
  answerInlineQueryPhotoHtml,
  editMessagePhotoByIdHtml,
  editMessagePhotoByIdHtmlWithoutNextStep,
  editMessageTextByIdHtml,
  editMessageTextByIdHtmlWithoutNextStep,
  editMessageTextHtml,
  replyHtml,
  replyHtmlWithoutNextStep,
  replyWithInvoiceStars,
  replyWithPhotoHtml,
  replyWithPhotoHtmlWithoutNextStep,
  replyWithVideoHtml,
  sendHtmlById,
  sendPhotoByIdHtml,
  sendPhotoToStorage,
} from './send';

declare const ctx: Context;
declare const api: Api;
declare const text: TelegramHtml;
declare const keyboard: InlineKeyboard;
declare const png: InputFile;
// @ts-expect-error the seam takes TelegramHtml, not a string (TS2345)
export const viaSeam = replyHtml(ctx, 'raw');
// @ts-expect-error entities replace parse_mode, so the seam does not take them (TS2353)
export const viaEntities = replyHtml(ctx, text, { entities: [] });
// @ts-expect-error the edit takes TelegramHtml, not a string (TS2345)
export const viaEdit = editMessageTextHtml(ctx, 'raw');
// @ts-expect-error nor entities in place of parse_mode (TS2353)
export const viaEditEntities = editMessageTextHtml(ctx, text, { entities: [] });
// @ts-expect-error the edit by id takes TelegramHtml, not a string (TS2345)
export const viaEditById = editMessageTextByIdHtml(api, 1, 2, 'raw');
// @ts-expect-error nor entities in place of parse_mode (TS2353)
export const viaEditByIdEntities = editMessageTextByIdHtml(api, 1, 2, text, { entities: [] });
// @ts-expect-error caption_entities replace parse_mode for the caption (TS2353)
export const viaCaptionEntities = replyWithVideoHtml(ctx, 'id', text, { caption_entities: [] });
export const viaPhotoCaptionEntities = replyWithPhotoHtml(ctx, 'id', text, {
  // @ts-expect-error the same for the photo's caption (TS2353)
  caption_entities: [],
});
// @ts-expect-error the photo by id takes TelegramHtml as its caption, not a string (TS2345)
export const viaPhotoById = sendPhotoByIdHtml(api, 1, 'id', 'raw', { reply_markup: keyboard });
export const viaPhotoByIdEntities = sendPhotoByIdHtml(api, 1, 'id', text, {
  reply_markup: keyboard,
  // @ts-expect-error nor caption_entities in place of parse_mode (TS2353)
  caption_entities: [],
});

export const viaConstant = {
  // @ts-expect-error a message constant holds TelegramHtml, not a string (TS2322)
  text: 'raw',
} as const satisfies Record<string, TelegramHtml | ((value: string) => TelegramHtml)>;

// #350: every message carries an inline keyboard, its next step
// @ts-expect-error a message without reply_markup does not compile (TS2554)
export const viaNoKeyboard = replyHtml(ctx, text);
// @ts-expect-error nor with reply_markup left undefined (TS2322)
export const viaUndefinedKeyboard = replyHtml(ctx, text, { reply_markup: undefined });
export const viaReplyKeyboard = replyHtml(ctx, text, {
  // @ts-expect-error a reply keyboard is not a next step: only an inline one counts (TS2353)
  reply_markup: { keyboard: [] },
});
// @ts-expect-error the edit needs one too (TS2554)
export const viaEditNoKeyboard = editMessageTextHtml(ctx, text);
// @ts-expect-error the edit by id too (TS2554)
export const viaEditByIdNoKeyboard = editMessageTextByIdHtml(api, 1, 2, text);
// @ts-expect-error a reason outside NO_NEXT_STEP_REASONS does not compile (TS2345)
export const viaUnlistedReason = replyHtmlWithoutNextStep(ctx, text, 'because');
// #536: the session message's edit without a keyboard names its reason
// @ts-expect-error the edit by id without a keyboard needs its reason (TS2554)
export const viaEditByIdNoReason = editMessageTextByIdHtmlWithoutNextStep(api, 1, 2, text);
// @ts-expect-error nor a reason outside NO_NEXT_STEP_REASONS (TS2345)
export const viaEditByIdUnlisted = editMessageTextByIdHtmlWithoutNextStep(api, 1, 2, text, 'x');
export const viaEditByIdRaw = editMessageTextByIdHtmlWithoutNextStep(
  api,
  1,
  2,
  // @ts-expect-error nor a raw string (TS2345)
  'raw',
  'session_status',
);
// @ts-expect-error the photo by id needs one too (TS2554)
export const viaPhotoByIdNoKeyboard = sendPhotoByIdHtml(api, 1, 'id', text);
export const viaPhotoByIdUndefinedKeyboard = sendPhotoByIdHtml(api, 1, 'id', text, {
  // @ts-expect-error nor with reply_markup left undefined (TS2322)
  reply_markup: undefined,
});
export const viaPhotoByIdReplyKeyboard = sendPhotoByIdHtml(api, 1, 'id', text, {
  // @ts-expect-error nor a reply keyboard (TS2353)
  reply_markup: { keyboard: [] },
});

// #537: the summary's text by id
// @ts-expect-error the text by id needs a keyboard (TS2554)
export const viaTextByIdNoKeyboard = sendHtmlById(api, 1, text);
export const viaTextByIdReplyKeyboard = sendHtmlById(api, 1, text, {
  // @ts-expect-error nor a reply keyboard (TS2353)
  reply_markup: { keyboard: [] },
});
// @ts-expect-error nor a raw string (TS2345)
export const viaTextByIdRaw = sendHtmlById(api, 1, 'raw', { reply_markup: keyboard });
export const viaTextByIdEntities = sendHtmlById(api, 1, text, {
  reply_markup: keyboard,
  // @ts-expect-error nor entities in place of parse_mode (TS2353)
  entities: [],
});

// #568: the session message as a photo, sent and edited without a keyboard under its reason
// @ts-expect-error the photo without a keyboard needs its reason (TS2554)
export const viaPhotoNoReason = replyWithPhotoHtmlWithoutNextStep(ctx, 'id', text);
// @ts-expect-error nor a reason outside NO_NEXT_STEP_REASONS (TS2345)
export const viaPhotoUnlisted = replyWithPhotoHtmlWithoutNextStep(ctx, 'id', text, 'x');
// @ts-expect-error nor a raw caption (TS2345)
export const viaPhotoRaw = replyWithPhotoHtmlWithoutNextStep(ctx, 'id', 'raw', 'session_status');
export const viaPhotoExtra = replyWithPhotoHtmlWithoutNextStep(
  ctx,
  'id',
  text,
  'session_status',
  // @ts-expect-error nor a fifth argument with caption_entities (TS2554)
  { caption_entities: [] },
);
// @ts-expect-error the photo edit by id needs a keyboard (TS2554)
export const viaMediaNoKeyboard = editMessagePhotoByIdHtml(api, 1, 2, 'id', text);
export const viaMediaReplyKeyboard = editMessagePhotoByIdHtml(api, 1, 2, 'id', text, {
  // @ts-expect-error nor a reply keyboard (TS2353)
  reply_markup: { keyboard: [] },
});
export const viaMediaRaw = editMessagePhotoByIdHtml(
  api,
  1,
  2,
  'id',
  // @ts-expect-error nor a raw caption (TS2345)
  'raw',
  { reply_markup: keyboard },
);
// @ts-expect-error the photo edit by id without a keyboard needs its reason (TS2554)
export const viaMediaNoReason = editMessagePhotoByIdHtmlWithoutNextStep(api, 1, 2, 'id', text);
export const viaMediaUnlisted = editMessagePhotoByIdHtmlWithoutNextStep(
  api,
  1,
  2,
  'id',
  text,
  // @ts-expect-error nor a reason outside NO_NEXT_STEP_REASONS (TS2345)
  'x',
);
export const viaMediaWithoutRaw = editMessagePhotoByIdHtmlWithoutNextStep(
  api,
  1,
  2,
  'id',
  // @ts-expect-error nor a raw caption (TS2345)
  'raw',
  'session_status',
);

// #321: the inline share answer takes TelegramHtml as its caption, and no keyboard at all
// @ts-expect-error a raw string caption does not compile (TS2345)
export const viaInlineRaw = answerInlineQueryPhotoHtml(ctx, { id: 'a', fileId: 'b' }, 'raw');
// @ts-expect-error nor a fourth argument with a keyboard (TS2554)
export const viaInlineKeyboard = answerInlineQueryPhotoHtml(ctx, { id: 'a', fileId: 'b' }, text, {
  reply_markup: keyboard,
});
export const viaInlineResultKeyboard = answerInlineQueryPhotoHtml(
  ctx,
  // @ts-expect-error nor a keyboard on the result (TS2353)
  { id: 'a', fileId: 'b', reply_markup: keyboard },
  text,
);
// @ts-expect-error the empty answer takes nothing to send (TS2554)
export const viaInlineEmptyResults = answerInlineQueryEmpty(ctx, []);

// #117: the invoice carries its next step after the pay button, like every message
const invoice = { title: 't', description: 'd', payload: 'p', label: 'l', stars: 1 };
// @ts-expect-error an invoice without the keyboard does not compile (TS2554)
export const viaInvoiceNoKeyboard = replyWithInvoiceStars(ctx, invoice);
// @ts-expect-error nor without what follows the pay button (TS2741)
export const viaInvoiceNoNextStep = replyWithInvoiceStars(ctx, invoice, { pay: 'pay' });

// #538: the storage post takes no caption and no keyboard, so a fourth argument does not compile
// @ts-expect-error a caption or reply_markup cannot reach the storage post (TS2554)
export const viaStorageExtra = sendPhotoToStorage(api, 1, png, { reply_markup: keyboard });
