import { describe, expect, it } from 'vitest';
import { botTextMessageOverflows } from './bot-text-messages';
import { BotTextKind, parseBotTextTemplate } from './bot-text-template';
import {
  BOT_TEXT_CATALOG,
  BotTextGroup,
  botTextKeysOf,
  botTextProblems,
  createBotTexts,
  type BotHtmlKey,
  type BotPlainKey,
  type BotTextKey,
} from './bot-texts';
import {
  BOT_TEXT_SOURCES_EN,
  enBotTextSource,
  TRANSLATED_BEFORE_633,
  UNTRANSLATED_BOT_TEXT_KEYS,
} from './bot-texts-en';
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

  // the groups of #632 and #633 show their Russian defaults until those parts translate them, but
  // the keys translated ahead of them (#664, #686)
  it('E4 leaves untranslated exactly the groups of the later parts, but the keys translated before #633', () => {
    const translated: readonly BotTextKey[] = TRANSLATED_BEFORE_633;
    expect([...UNTRANSLATED_BOT_TEXT_KEYS].sort()).toEqual(
      botTextKeysOf(
        BotTextGroup.Demo,
        BotTextGroup.Analysis,
        BotTextGroup.Trade,
        BotTextGroup.Session,
        BotTextGroup.Stars,
        BotTextGroup.Mailing,
        BotTextGroup.Deposit,
      )
        .filter((key) => !translated.includes(key))
        .sort(),
    );
  });

  it('E7 the keys translated before #633 are exactly those of the later groups with an English text', () => {
    const later = botTextKeysOf(
      BotTextGroup.Demo,
      BotTextGroup.Analysis,
      BotTextGroup.Trade,
      BotTextGroup.Session,
      BotTextGroup.Stars,
      BotTextGroup.Mailing,
      BotTextGroup.Deposit,
    );
    expect([...TRANSLATED_BEFORE_633].sort()).toEqual(
      later.filter((key) => BOT_TEXT_SOURCES_EN[key] !== undefined).sort(),
    );
  });

  it('E6 falls back to the Russian default for an untranslated key, the English text otherwise', () => {
    const untranslated = UNTRANSLATED_BOT_TEXT_KEYS[0]!;
    expect(enBotTextSource.sourceOf(untranslated)).toBe(BOT_TEXT_CATALOG[untranslated].source);
    expect(enBotTextSource.sourceOf('welcome')).toBe(BOT_TEXT_SOURCES_EN.welcome);
    expect(enBotTextSource.sourceOf('welcome')).not.toBe(BOT_TEXT_CATALOG.welcome.source);
  });
});
