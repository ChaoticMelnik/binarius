// Compiled by `tsc -b` (include: src) and imported by nothing: the directives below are the
// oracle that a raw string reaches neither the send seam nor a message constant, and that a
// caller cannot hand the seam entities in place of parse_mode. If any of them starts compiling,
// tsc reports TS2578 (unused directive) and `pnpm check` fails.
import type { Api, Context } from 'grammy';
import type { TelegramHtml } from '@binarius/shared';
import {
  editMessageTextByIdHtml,
  editMessageTextHtml,
  replyHtml,
  replyHtmlWithoutNextStep,
  replyWithPhotoHtml,
  replyWithVideoHtml,
} from './send';

declare const ctx: Context;
declare const api: Api;
declare const text: TelegramHtml;
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
