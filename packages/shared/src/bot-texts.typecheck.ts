// Compiled by `tsc -b` (include: src) and imported by nothing, like telegram-html.typecheck.ts:
// the directives below are the oracle that the views' types follow each entry's kind and
// argument. If any of them starts compiling, tsc reports TS2578 and `pnpm check` fails.
import { createBotTexts, defaultBotTextSource } from './bot-texts';
import { telegramHtml, type TelegramHtml } from './telegram-html';

const { html, plain } = createBotTexts(defaultBotTextSource);

export const staticHtml: TelegramHtml = html.welcome;
export const htmlWithString: TelegramHtml = html.codeSent('ada@example.com');
export const htmlWithHtml: TelegramHtml = html.accountLineActive(telegramHtml`адрес`);
export const staticPlain: string = plain.connectButton;
export const plainWithString: string = plain.confirmButton('ada@example.com');

// @ts-expect-error a text without an argument is not a function (TS2349)
export const callStatic = html.welcome('x');
// @ts-expect-error a plain key is not on the html view (TS2339)
export const plainOnHtml = html.connectButton;
// @ts-expect-error an argument is text, never null: the caller decides what null reads as (TS2345)
export const nullArgument = html.codeSent(null);
// @ts-expect-error a plain text is never parsed, so it takes no TelegramHtml (TS2345)
export const htmlIntoPlain = plain.confirmButton(telegramHtml`x`);
