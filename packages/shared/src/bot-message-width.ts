import { TELEGRAM_MESSAGE_LIMIT } from './telegram-html';

// The width spacer (#506, docs/bot-navigation.md → The width). Telegram sizes a message bubble to
// its longest line and the inline keyboard to the bubble, so a short text leaves narrow buttons.
// The Bot API has no width setting; a line of U+2800 BRAILLE PATTERN BLANK widens the bubble:
// the character is a symbol (So), not whitespace, so neither the Bot API's trim nor JS `\s`
// removes it, and N equal characters with no break opportunity form one unbreakable line.
// It goes on a line of its own after the text: the chat preview and the notification still open
// with the text, and the last word of the text never wraps onto the spacer's line.
// N = 26: U+2800 measured 0.684 em in the macOS system font, 26 × 0.684 × 17 pt ≈ 302 pt — the
// text width of an iPhone bubble (375-430 pt) at the default font size, so one empty-looking line
// at full width; on Telegram Desktop (13 px) about 230 px of 430. Windows and Android glyph widths
// were not measured; the owner tunes N here after looking at the clients.
export const BOT_MESSAGE_SPACER_LENGTH = 26;

export const BOT_MESSAGE_SPACER = '\n' + '⠀'.repeat(BOT_MESSAGE_SPACER_LENGTH);

// What a text message may hold after entities parsing: the seams append the spacer to every one.
export const BOT_TEXT_LIMIT = TELEGRAM_MESSAGE_LIMIT - BOT_MESSAGE_SPACER.length;
