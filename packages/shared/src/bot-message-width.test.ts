import { describe, expect, it } from 'vitest';
import { BOT_MESSAGE_SPACER, BOT_MESSAGE_SPACER_LENGTH, BOT_TEXT_LIMIT } from './bot-message-width';
import { BOT_TEXT_MESSAGES } from './bot-text-messages';
import { BotTextKind } from './bot-text-template';
import { BOT_TEXT_CATALOG } from './bot-texts';
import { plainTextOf, TELEGRAM_MESSAGE_LIMIT, telegramHtmlProblems } from './telegram-html';
import { stripMessageSpacer } from './testing';

describe('BOT_MESSAGE_SPACER', () => {
  it('starts a line of its own', () => {
    expect(BOT_MESSAGE_SPACER.startsWith('\n')).toBe(true);
  });

  it('is 26 braille blanks after the line break and nothing else', () => {
    expect(BOT_MESSAGE_SPACER_LENGTH).toBe(26);
    expect(BOT_MESSAGE_SPACER.slice(1)).toBe('\u2800'.repeat(26));
  });

  it('ends with a character JS does not count as whitespace, so a trim keeps it', () => {
    expect(/\s$/u.test(BOT_MESSAGE_SPACER)).toBe(false);
    expect(BOT_MESSAGE_SPACER.trim()).toBe('\u2800'.repeat(26));
  });

  it('counts 27 code units after entities parsing and changes nothing about the HTML', () => {
    expect(plainTextOf(BOT_MESSAGE_SPACER)).toHaveLength(27);
    expect(telegramHtmlProblems('<b>x</b>' + BOT_MESSAGE_SPACER)).toEqual([]);
    expect(telegramHtmlProblems('<b>x' + BOT_MESSAGE_SPACER)).toEqual(telegramHtmlProblems('<b>x'));
  });
});

describe('BOT_TEXT_LIMIT', () => {
  it('the limit and the spacer add up to the Bot API’s', () => {
    expect(BOT_TEXT_LIMIT + BOT_MESSAGE_SPACER.length).toBe(TELEGRAM_MESSAGE_LIMIT);
  });

  it('no text limit is past BOT_TEXT_LIMIT', () => {
    const over = [
      ...Object.entries(BOT_TEXT_CATALOG)
        .filter(([, entry]) => entry.kind === BotTextKind.Html && entry.limit > BOT_TEXT_LIMIT)
        .map(([key]) => key),
      ...BOT_TEXT_MESSAGES.filter((message) => message.limit > BOT_TEXT_LIMIT).map(
        (message) => message.id,
      ),
    ];
    expect(over).toEqual([]);
  });
});

describe('stripMessageSpacer', () => {
  it('returns the text the seam was given', () => {
    expect(stripMessageSpacer('x' + BOT_MESSAGE_SPACER)).toBe('x');
    expect(stripMessageSpacer('\u2800x' + BOT_MESSAGE_SPACER)).toBe('\u2800x');
  });

  it('is undefined when the spacer is not at the end', () => {
    expect(stripMessageSpacer('x')).toBeUndefined();
    expect(stripMessageSpacer('')).toBeUndefined();
    expect(stripMessageSpacer(BOT_MESSAGE_SPACER + 'x')).toBeUndefined();
  });
});
