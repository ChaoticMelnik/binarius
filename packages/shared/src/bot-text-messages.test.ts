import { describe, expect, it } from 'vitest';
import {
  BOT_TEXT_MESSAGES,
  BOT_TEXT_VAR_WIDTHS,
  BOT_TEXT_WIDTHS,
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
  it('G1 narrows a width only for a variable of that key', () => {
    for (const [key, widths] of Object.entries(BOT_TEXT_VAR_WIDTHS)) {
      for (const name of Object.keys(widths)) {
        expect(BOT_TEXT_CATALOG[key as BotTextKey].vars, `${key}.${name}`).toContain(name);
      }
    }
  });

  it('G1 makes every html key with variables part of some message', () => {
    const covered = new Set(BOT_TEXT_MESSAGES.flatMap((m) => [...botTextMessageKeys(m)]));
    const keys = (Object.keys(BOT_TEXT_CATALOG) as BotTextKey[]).filter(
      (key) =>
        BOT_TEXT_CATALOG[key].kind === BotTextKind.Html && BOT_TEXT_CATALOG[key].vars.length > 0,
    );
    for (const key of keys) expect(covered, key).toContain(key);
  });

  // #358: a variable a staff member adds to a key is measured at its widest
  it('G6 widens a message by each variable an override adds, at its own width', () => {
    const card = message('statusCard');
    const base = estimateBotTextMessage(card, defaultBotTextSource);
    const tokens = BOT_TEXT_CATALOG.statusTokens.source;
    expect(
      estimateBotTextMessage(card, withTexts({ statusTokens: `${tokens} {firstName}` })) - base,
    ).toBe(1 + BOT_TEXT_WIDTHS.firstName);
    expect(
      estimateBotTextMessage(card, withTexts({ statusTokens: `${tokens} {demoBalance}` })) - base,
    ).toBe(1 + BOT_TEXT_WIDTHS.usd);
    const stale = 'я'.repeat(40);
    expect(
      estimateBotTextMessage(
        card,
        withTexts({ statusTokens: `${tokens} {demoBalance}`, balanceUnavailable: stale }),
      ) - base,
    ).toBe(1 + stale.length);
  });

  it('reads a stand-in text only for a message whose texts hold its variable', () => {
    expect(botTextMessageKeys(message('statusCard'))).not.toContain('balanceUnavailable');
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

  // a plain text is escaped and shown as written: markup and entities count as characters
  it('G5 measures a plain label at the length it is shown', () => {
    const intent = message('intentStatus');
    const base = estimateBotTextMessage(intent, defaultBotTextSource);
    const widest = Math.max(
      BOT_TEXT_CATALOG.actionUp.source.length,
      BOT_TEXT_CATALOG.actionDown.source.length,
    );
    const tags = withTexts({ actionUp: '<b></b>'.repeat(9) });
    const entities = withTexts({ actionDown: '&amp;'.repeat(12) });
    expect(estimateBotTextMessage(intent, tags) - base).toBe(63 - widest);
    expect(estimateBotTextMessage(intent, entities) - base).toBe(60 - widest);
  });

  it('reads the labels a width is made of as keys of the message', () => {
    expect(botTextMessageKeys(message('intentStatus'))).toContain('actionUp');
    expect(botTextMessageKeys(message('settings'))).toEqual(
      new Set([
        'settings',
        'levelAll',
        'levelReduced',
        'levelOff',
        'settingsStake',
        'stakeMinimumLabel',
      ]),
    );
  });
});
