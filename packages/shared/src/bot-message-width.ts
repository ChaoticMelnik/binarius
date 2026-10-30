import { TELEGRAM_MESSAGE_LIMIT } from './telegram-html';

// The width spacer (#506, docs/bot-navigation.md → The width). Telegram sizes a message bubble to
// its longest line and the inline keyboard to the bubble, so a short text leaves narrow buttons.
// The Bot API has no width setting; a line of U+2800 BRAILLE PATTERN BLANK widens the bubble:
// the character is a symbol (So), not whitespace, so neither the Bot API's trim nor JS `\s`
// removes it, and N equal characters with no break opportunity form one unbreakable line.
// It goes on a line of its own after the text: the chat preview and the notification still open
// with the text, and the last word of the text never wraps onto the spacer's line.
// N = 21 (#887, #896): the bubble's width is the client's media bubble, not its widest text bubble,
// so the session's feed - cards and the scanner's animation next to text - is one width. iOS draws
// a photo or an animation about 300 pt wide whatever the picture's size or proportion, so the text
// comes down to the media. Measured on the owner's iPhone screenshots (921 px wide, 2026-10-29):
// the media bubble 630 px; the step messages 746 px at N = 26 and 673 px at N = 23, so one U+2800
// is 24.3 px = 11.6 pt (CoreText, SF 17 pt: 11.62 pt) and the text bubble's padding about 114 px
// ≈ 55 pt. At N = 21 the text bubble is about 624 px, 3 pt narrower than the media; N = 22 would
// be 9 pt wider. The spacer line is 21 × 11.62 ≈ 244 pt and never wraps on a 375-pt screen up to a
// 20 pt font. On Telegram Desktop (13 px) about 187 px, narrower than its photos; Windows and
// Android were not measured. The owner tunes N here by ±1 (11.6 pt on an iPhone).
export const BOT_MESSAGE_SPACER_LENGTH = 21;

export const BOT_MESSAGE_SPACER = '\n' + '\u2800'.repeat(BOT_MESSAGE_SPACER_LENGTH);

// What a text message may hold after entities parsing: the seams append the spacer to every one.
export const BOT_TEXT_LIMIT = TELEGRAM_MESSAGE_LIMIT - BOT_MESSAGE_SPACER.length;

// The width of a `<pre>` line counted in spacer blanks (#887, #896), so a test can hold the feed's
// code blocks inside the spacer. iOS draws `<pre>` in 13 pt next to a 17 pt body: on the owner's
// screenshot a monospace character is 16.4 px (Menlo 13 pt, 0.602 em) and an emoji with its space
// about 51 px. CoreText on macOS, Menlo 13 pt: a character 0.673 blank, an emoji 1.463 blanks; the
// constants keep about 7 % over that. The block's own insets are about 38 px = 1.6 blanks. A
// variation selector, a joiner and the keycap mark draw nothing of their own.
export const PRE_CHAR_BLANKS = 0.72;
export const PRE_EMOJI_BLANKS = 1.55;
export const PRE_BLOCK_BLANKS = 1.6;
const PRE_ZERO_WIDTH = new Set(['\ufe0f', '\u200d', '\u20e3']);

export const preLineBlanks = (line: string): number => {
  let blanks = 0;
  for (const char of line) {
    if (PRE_ZERO_WIDTH.has(char)) continue;
    blanks += /\p{Extended_Pictographic}/u.test(char) ? PRE_EMOJI_BLANKS : PRE_CHAR_BLANKS;
  }
  return blanks;
};
