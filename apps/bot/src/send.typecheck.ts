// Compiled by `tsc -b` (include: src) and imported by nothing: the two directives below are the
// oracle that a raw string reaches neither the send seam nor a message constant. If either line
// starts compiling, tsc reports TS2578 (unused directive) and `pnpm check` fails.
import type { Context } from 'grammy';
import type { TelegramHtml } from '@binarius/shared';
import { replyHtml } from './send';

declare const ctx: Context;
// @ts-expect-error the seam takes TelegramHtml, not a string (TS2345)
export const viaSeam = replyHtml(ctx, 'raw');

export const viaConstant = {
  // @ts-expect-error a message constant holds TelegramHtml, not a string (TS1360)
  text: 'raw',
} as const satisfies Record<string, TelegramHtml | ((value: string) => TelegramHtml)>;
