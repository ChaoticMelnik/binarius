import { describe, expect, it } from 'vitest';
import {
  BOT_TEXT_ARG_WIDTHS,
  BOT_TEXT_MESSAGES,
  botTextMessageKeys,
  botTextMessageOverflows,
  estimateBotTextMessage,
} from './bot-text-messages';
import { BotTextKind } from './bot-text-template';
import { BOT_TEXT_CATALOG, defaultBotTextSource, type BotTextKey } from './bot-texts';

const message = (id: string) => {
  const found = BOT_TEXT_MESSAGES.find((m) => m.id === id);
  if (found === undefined) throw new Error(id);
  return found;
};
const withTexts = (texts: Partial<Record<BotTextKey, string>>) => ({
  sourceOf: (key: BotTextKey) => texts[key] ?? BOT_TEXT_CATALOG[key].source,
});

describe('the assembled messages', () => {
  it('G1 gives every html key with an argument a width, and only those', () => {
    const argKeys = (Object.keys(BOT_TEXT_CATALOG) as BotTextKey[]).filter(
      (key) =>
        BOT_TEXT_CATALOG[key].kind === BotTextKind.Html && BOT_TEXT_CATALOG[key].arg !== undefined,
    );
    expect(Object.keys(BOT_TEXT_ARG_WIDTHS).sort()).toEqual(argKeys.sort());
  });

  it('G1 makes every key with an argument part of some message', () => {
    const covered = new Set(BOT_TEXT_MESSAGES.flatMap((m) => [...botTextMessageKeys(m)]));
    for (const key of Object.keys(BOT_TEXT_ARG_WIDTHS)) expect(covered, key).toContain(key);
  });

  it('keeps every message within its limit on the defaults', () => {
    expect(botTextMessageOverflows(defaultBotTextSource)).toEqual([]);
  });

  it('G2 takes the longest option of a oneOf', () => {
    const card = message('accountCard');
    const base = estimateBotTextMessage(card, defaultBotTextSource);
    const longer = BOT_TEXT_CATALOG.cardBonusAlready.source + 'я'.repeat(200);
    expect(estimateBotTextMessage(card, withTexts({ cardBonusAlready: longer }))).toBeGreaterThan(
      base,
    );
    expect(estimateBotTextMessage(card, withTexts({ cardBonusAlready: 'ℹ️' }))).toBe(base);
  });

  it('G3 counts a repeated line as many times as it repeats, with its separators', () => {
    const account = message('account');
    const line = `${BOT_TEXT_CATALOG.accountLineRevoked.source} я`;
    expect(
      estimateBotTextMessage(account, withTexts({ accountLineRevoked: line })) -
        estimateBotTextMessage(account, defaultBotTextSource),
    ).toBe(10 * 2);
  });

  it('G4 widens a composite argument with a longer label', () => {
    const intent = message('intentStatus');
    const actionUp = 'я'.repeat(64);
    expect(
      estimateBotTextMessage(intent, withTexts({ actionUp })) -
        estimateBotTextMessage(intent, defaultBotTextSource),
    ).toBe(
      64 -
        Math.max(
          BOT_TEXT_CATALOG.actionUp.source.length,
          BOT_TEXT_CATALOG.actionDown.source.length,
        ),
    );
  });

  it('reads the labels a width is made of as keys of the message', () => {
    expect(botTextMessageKeys(message('intentStatus'))).toContain('actionUp');
    expect(botTextMessageKeys(message('settings'))).toEqual(
      new Set(['settings', 'levelAll', 'levelReduced', 'levelOff']),
    );
  });
});
