import { describe, expect, it } from 'vitest';
import { botTextMessageOverflows } from './bot-text-messages';
import { BotTextKind, parseBotTextTemplate } from './bot-text-template';
import {
  BOT_TEXT_CATALOG,
  botTextProblems,
  createBotTexts,
  type BotHtmlKey,
  type BotPlainKey,
  type BotTextKey,
} from './bot-texts';
import { BOT_TEXT_SOURCES_EN, enBotTextSource } from './bot-texts-en';
import { plainTextOf } from './telegram-html';

const TRANSLATED = Object.entries(BOT_TEXT_SOURCES_EN) as [BotTextKey, string][];

describe('the English texts (#508)', () => {
  it.each(TRANSLATED)('E1 keeps the English text of %s free of problems', (key, source) => {
    expect(botTextProblems(key, source, enBotTextSource)).toEqual([]);
  });

  it.each(TRANSLATED)('E1 renders %s at its samples within its limit', (key) => {
    const { samples } = createBotTexts(enBotTextSource);
    const entry = BOT_TEXT_CATALOG[key];
    const shown =
      entry.kind === BotTextKind.Html
        ? plainTextOf(samples.html[key as BotHtmlKey])
        : samples.plain[key as BotPlainKey];
    expect(shown.trim()).not.toBe('');
    expect(shown.length).toBeLessThanOrEqual(entry.limit);
  });

  it('E2 keeps every assembled message within its limit on the English texts', () => {
    expect(botTextMessageOverflows(enBotTextSource)).toEqual([]);
  });

  it.each(TRANSLATED.filter(([key]) => Object.keys(BOT_TEXT_CATALOG[key].fragments).length > 0))(
    'E3 translates every fragment of %s',
    (key) => {
      for (const fragment of Object.values(BOT_TEXT_CATALOG[key].fragments)) {
        expect(BOT_TEXT_SOURCES_EN[fragment as BotTextKey], fragment).toBeDefined();
      }
    },
  );

  it.each(TRANSLATED)('E5 uses in %s the placeholders of the Russian default', (key, source) => {
    const names = (text: string) => [...new Set(parseBotTextTemplate(text).names)].sort();
    expect(names(source)).toEqual(names(BOT_TEXT_CATALOG[key].source));
  });

  // the type makes the table a full Record (#633); this pins it at run time too, against a cast
  it('E4 gives every key of the catalog an English text, and no other key', () => {
    expect(Object.keys(BOT_TEXT_SOURCES_EN).sort()).toEqual(Object.keys(BOT_TEXT_CATALOG).sort());
  });

  it.each(TRANSLATED)('E6 the English source reads %s from the English table', (key) => {
    expect(enBotTextSource.sourceOf(key)).toBe(BOT_TEXT_SOURCES_EN[key]);
  });

  // the Russian language's own name on its button is the one Cyrillic an English user sees
  it.each(TRANSLATED.filter(([key]) => key !== 'languageRuButton'))(
    'E10 writes %s with no Cyrillic',
    (_key, source) => {
      expect(source).not.toMatch(/[А-Яа-яЁё]/u);
    },
  );
});
