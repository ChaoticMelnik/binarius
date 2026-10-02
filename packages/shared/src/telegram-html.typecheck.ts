// Compiled by `tsc -b` (include: src) and imported by nothing: the three directives below are
// the oracle that TelegramHtml stays nominal and module-local, and that the tag refuses a hole
// that is not text. If any of the three lines starts compiling, tsc reports TS2578 (unused
// directive) and `pnpm check` fails.
import { telegramHtml, type TelegramHtml } from './telegram-html';
// @ts-expect-error the class is module-local (TS2459): exporting it would reopen `new`
import { TelegramHtmlValue } from './telegram-html';

// @ts-expect-error a structural literal must not pass for TelegramHtml (TS2741)
export const viaLiteral: TelegramHtml = { value: '<b>', toString: () => '' };
export const viaNew: TelegramHtml = new TelegramHtmlValue('<b>');

// @ts-expect-error a number is not a hole (TS2345): tokens and money are strings in every view
export const viaNumber: TelegramHtml = telegramHtml`${1}`;
