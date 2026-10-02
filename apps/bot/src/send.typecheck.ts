// Compiled by `tsc -b` (include: src) and imported by nothing: the directives below are the
// oracle that a raw string reaches neither the send seam nor a message constant, and that a
// caller cannot hand the seam entities in place of parse_mode. If any of them starts compiling,
// tsc reports TS2578 (unused directive) and `pnpm check` fails.
import type { Context } from 'grammy';
import type { TelegramHtml } from '@binarius/shared';
import { replyHtml, replyWithPhotoHtml, replyWithVideoHtml } from './send';

declare const ctx: Context;
declare const text: TelegramHtml;
// @ts-expect-error the seam takes TelegramHtml, not a string (TS2345)
export const viaSeam = replyHtml(ctx, 'raw');
// @ts-expect-error entities replace parse_mode, so the seam does not take them (TS2353)
export const viaEntities = replyHtml(ctx, text, { entities: [] });
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
