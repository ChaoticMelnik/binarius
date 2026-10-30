import { describe, expect, it } from 'vitest';
import { BotLanguage } from './bot-language';
import {
  BOT_MESSAGE_SPACER,
  BOT_MESSAGE_SPACER_LENGTH,
  BOT_TEXT_LIMIT,
  PRE_BLOCK_BLANKS,
  PRE_CHAR_BLANKS,
  PRE_EMOJI_BLANKS,
  preLineBlanks,
} from './bot-message-width';
import { BOT_TEXT_MESSAGES } from './bot-text-messages';
import { BotTextKind } from './bot-text-template';
import { BOT_TEXT_CATALOG, createBotTexts } from './bot-texts';
import { BOT_TEXT_DEFAULT_SOURCES } from './bot-texts-en';
import type { DecimalString } from './money';
import { SessionTradeResult } from './session-steps';
import { createSessionTexts } from './session-texts';
import { plainTextOf, TELEGRAM_MESSAGE_LIMIT, telegramHtmlProblems } from './telegram-html';
import { stripMessageSpacer } from './testing';
import { TradeAction } from './trading';

describe('BOT_MESSAGE_SPACER', () => {
  it('starts a line of its own', () => {
    expect(BOT_MESSAGE_SPACER.startsWith('\n')).toBe(true);
  });

  it('is N braille blanks after the line break and nothing else', () => {
    expect(BOT_MESSAGE_SPACER.slice(1)).toBe('\u2800'.repeat(BOT_MESSAGE_SPACER_LENGTH));
  });

  it('ends with a character JS does not count as whitespace, so a trim keeps it', () => {
    expect(/\s$/u.test(BOT_MESSAGE_SPACER)).toBe(false);
    expect(BOT_MESSAGE_SPACER.trim()).toBe('\u2800'.repeat(BOT_MESSAGE_SPACER_LENGTH));
  });

  it('counts N + 1 code units after entities parsing and changes nothing about the HTML', () => {
    expect(plainTextOf(BOT_MESSAGE_SPACER)).toHaveLength(BOT_MESSAGE_SPACER_LENGTH + 1);
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

// One spacer blank on the owner's iPhone screenshots (#896): 921 px wide, 24.3 px a blank.
const IPHONE_BLANK_PX = 24.3;

describe('preLineBlanks (#887, #896)', () => {
  it.each([
    ['$17.05 → +$33.418', 279 / IPHONE_BLANK_PX, 'iPhone'],
    ['🟢 ', 51 / IPHONE_BLANK_PX, 'iPhone'],
    ['$17.05 → +$33.418', 11.45, 'CoreText Menlo 13 pt'],
    ['🟢 $1 000.00 → +$1 960.00', 16.95, 'CoreText Menlo 13 pt'],
    ['⏳ $1 000.00 · ⬆️ Вверх', 15.72, 'CoreText Menlo 13 pt'],
  ])(
    'F1 the model of «%s» is no narrower than the measured %f blanks (%s) and at most a tenth wider',
    (line, measured) => {
      expect(preLineBlanks(line)).toBeGreaterThanOrEqual(measured);
      expect(preLineBlanks(line)).toBeLessThanOrEqual(measured * 1.1);
    },
  );

  it('F2 counts an emoji as an emoji, a character as a character, and the marks as nothing', () => {
    expect(preLineBlanks('a ж')).toBeCloseTo(3 * PRE_CHAR_BLANKS);
    expect(preLineBlanks('⏳')).toBeCloseTo(PRE_EMOJI_BLANKS);
    expect(preLineBlanks('↩\ufe0f')).toBeCloseTo(PRE_EMOJI_BLANKS);
    expect(preLineBlanks('👨\u200d👩')).toBeCloseTo(2 * PRE_EMOJI_BLANKS);
    expect(preLineBlanks('1\ufe0f\u20e3')).toBeCloseTo(PRE_CHAR_BLANKS);
  });
});

// The feed's code blocks at their widest realistic values (#887): a stake of $1 000.00 and its
// return, an 8-character price, cycle 720 step 28, both directions.
describe.each([BotLanguage.Ru, BotLanguage.En])(
  'the step blocks within the spacer, %s (#887)',
  (language) => {
    const texts = createSessionTexts({
      ...createBotTexts(BOT_TEXT_DEFAULT_SOURCES[language]),
      language,
    });
    const d = (value: string) => value as DecimalString;
    const settled = {
      amount: d('1000'),
      openPrice: 68123.45,
      closePrice: 68123.45,
      digits: 2,
      cycle: 720,
      step: 28,
      adaptiveLine: null,
    };
    const preLines = (html: string) =>
      [...html.matchAll(/<pre>([\s\S]*?)<\/pre>/gu)].map((block) => block[1]!.split('\n'));
    const result = (result: SessionTradeResult, outcome: string) =>
      preLines(texts.sessionCycleText([{ ...settled, result, outcome: d(outcome) }]).value)[0]!;
    const results = {
      won: result(SessionTradeResult.Won, '1960'),
      lost: result(SessionTradeResult.Lost, '-1000'),
      tied: result(SessionTradeResult.Tied, '0'),
    };
    const opens = Object.values(TradeAction).map(
      (action) =>
        preLines(
          texts.sessionCycleText([], {
            amount: d('1000'),
            action,
            openPrice: 68123.45,
            digits: 2,
            cycle: 720,
            step: 28,
            adaptiveLine: null,
          }).value,
        )[0]!,
    );
    const widest = (lines: readonly string[]) => Math.max(...lines.map(preLineBlanks));

    it('F3 no line of a block, with the block’s insets, is wider than the spacer', () => {
      const over = [...Object.values(results), ...opens]
        .flat()
        .filter((line) => preLineBlanks(line) + PRE_BLOCK_BLANKS > BOT_MESSAGE_SPACER_LENGTH);
      expect(over).toEqual([]);
    });

    it('F4 the open block is no wider than the result it is edited into', () => {
      expect(widest(opens.flat())).toBeLessThanOrEqual(widest(Object.values(results).flat()));
    });

    it('F5 the blocks carry no labels and no «trade open» tail', () => {
      const lines = [...Object.values(results), ...opens].flat();
      expect(
        lines.filter((line) => /Ставка:|Цена:|Stake:|Price:|сделка открыта|trade open/u.test(line)),
      ).toEqual([]);
    });

    it('F6 a tie says its stake returned on a line of its own', () => {
      expect(results.tied).toHaveLength(3);
      expect(results.tied[0]).not.toContain('↩️');
      expect(results.tied[1]!.startsWith('↩️ ')).toBe(true);
    });
  },
);
