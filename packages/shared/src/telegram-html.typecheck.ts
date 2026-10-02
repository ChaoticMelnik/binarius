// Compiled by `tsc -b` (include: src) and imported by nothing: the four directives below are
// the oracle that TelegramHtml stays nominal and module-local, and that the tag refuses a hole
// that is not text. If any of the four lines starts compiling, tsc reports TS2578 (unused
// directive) and `pnpm check` fails.
import { TelegramHtml, telegramHtml } from './telegram-html';
// @ts-expect-error the class is not exported under its own name (TS2724): a value export would reopen `new`
import { TelegramHtmlValue } from './telegram-html';

// @ts-expect-error a structural literal must not pass for TelegramHtml (TS2741)
export const viaLiteral: TelegramHtml = { value: '<b>', toString: () => '' };
export const viaNew: TelegramHtml = new TelegramHtmlValue('<b>');
// @ts-expect-error the public name is a type-only export (TS1362): it cannot be constructed
export const viaPublicName: TelegramHtml = new TelegramHtml('<b>');

// @ts-expect-error a number is not a hole (TS2345): tokens and money are strings in every view
export const viaNumber: TelegramHtml = telegramHtml`${1}`;
