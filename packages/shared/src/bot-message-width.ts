import { TELEGRAM_MESSAGE_LIMIT } from './telegram-html';

// The width spacer (#506, docs/bot-navigation.md → The width). Telegram sizes a message bubble to
// its longest line and the inline keyboard to the bubble, so a short text leaves narrow buttons.
// The Bot API has no width setting; a line of U+2800 BRAILLE PATTERN BLANK widens the bubble:
// the character is a symbol (So), not whitespace, so neither the Bot API's trim nor JS `\s`
// removes it, and N equal characters with no break opportunity form one unbreakable line.
// It goes on a line of its own after the text: the chat preview and the notification still open
// with the text, and the last word of the text never wraps onto the spacer's line.
// N = 23 (#887): the bubble's width is the client's media bubble, not its widest text bubble, so
// the session's feed - cards and the scanner's animation next to text - is one width. iOS draws a
// photo or an animation about 300 pt wide whatever the picture's size or proportion (the owner's
// iPhone: 630 of 921 px, the widest text bubble 810), so no picture reaches the text maximum and
// the text comes down to the media instead. U+2800 measured 0.684 em in the macOS system font
// (CoreText, SF 17 pt, 11.62 pt): 23 × 11.62 ≈ 267 pt, plus the bubble's padding ≈ 291 pt at the
// default 17 pt and ≈ 312 pt at 18 pt; never wraps on a 375-pt screen up to 19 pt. On Telegram
// Desktop (13 px) about 204 px, narrower than its photos; Windows and Android were not measured.
// The owner tunes N here by ±1 (11.6 pt on an iPhone) after looking at the clients.
export const BOT_MESSAGE_SPACER_LENGTH = 23;

export const BOT_MESSAGE_SPACER = '\n' + '\u2800'.repeat(BOT_MESSAGE_SPACER_LENGTH);

// What a text message may hold after entities parsing: the seams append the spacer to every one.
export const BOT_TEXT_LIMIT = TELEGRAM_MESSAGE_LIMIT - BOT_MESSAGE_SPACER.length;

// The width of a `<pre>` line counted in spacer blanks (#887), so a test can hold the feed's code
// blocks inside the spacer. Measured with CoreText on macOS, 17 pt, 2026-10-29: a Menlo character
// 10.23 pt (0.602 em) = 0.88 blank, an emoji in the monospace run 22.0 pt = 1.9 blanks; a variation
// selector, a joiner and the keycap mark draw nothing of their own.
export const PRE_CHAR_BLANKS = 0.88;
export const PRE_EMOJI_BLANKS = 1.9;
const PRE_ZERO_WIDTH = new Set(['\ufe0f', '\u200d', '\u20e3']);

export const preLineBlanks = (line: string): number => {
  let blanks = 0;
  for (const char of line) {
    if (PRE_ZERO_WIDTH.has(char)) continue;
    blanks += /\p{Extended_Pictographic}/u.test(char) ? PRE_EMOJI_BLANKS : PRE_CHAR_BLANKS;
  }
  return blanks;
};
