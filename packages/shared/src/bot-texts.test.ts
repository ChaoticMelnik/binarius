import { describe, expect, it } from 'vitest';
import { BOT_TEXT_KEY_PATTERN } from './bot-text-overrides';
import { BotTextKind, parseBotTextTemplate } from './bot-text-template';
import {
  BOT_TEXT_CATALOG,
  BOT_TEXT_GROUP_TITLES,
  BotTextGroup,
  botTextKeysOf,
  botTextProblems,
  type BotTextKey,
} from './bot-texts';

const ENTRIES = Object.entries(BOT_TEXT_CATALOG) as [
  BotTextKey,
  (typeof BOT_TEXT_CATALOG)[BotTextKey],
][];

describe('the bot texts catalog', () => {
  it.each(ENTRIES)('keeps the default of %s free of problems', (key, entry) => {
    expect(botTextProblems(key, entry.source)).toEqual([]);
  });

  // a key is a permanent id: part 2 stores overrides under it
  it.each(ENTRIES)('spells the key %s as an id', (key) => {
    expect(key).toMatch(BOT_TEXT_KEY_PATTERN);
  });

  it.each(ENTRIES)('gives %s a sample exactly when it takes an argument', (_key, entry) => {
    expect(entry.sample === undefined).toBe(entry.arg === undefined);
  });

  // depth 1, so no cycle and no fragment of a fragment to re-render
  it.each(ENTRIES.filter(([, entry]) => Object.keys(entry.fragments).length > 0))(
    'points the fragments of %s at keys with no fragments and no argument',
    (_key, entry) => {
      for (const fragmentKey of Object.values(entry.fragments)) {
        expect(Object.keys(BOT_TEXT_CATALOG)).toContain(fragmentKey);
        const fragment = BOT_TEXT_CATALOG[fragmentKey as BotTextKey];
        expect(fragment.fragments, fragmentKey).toEqual({});
        expect(fragment.arg, fragmentKey).toBeUndefined();
      }
    },
  );

  it.each(ENTRIES.filter(([, entry]) => entry.kind === BotTextKind.Plain))(
    'gives the plain %s plain fragments only',
    (_key, entry) => {
      for (const fragmentKey of Object.values(entry.fragments)) {
        expect(BOT_TEXT_CATALOG[fragmentKey as BotTextKey].kind, fragmentKey).toBe(
          BotTextKind.Plain,
        );
      }
    },
  );

  it.each(ENTRIES)('uses in the default of %s only its argument and fragments', (_key, entry) => {
    const allowed = [
      ...(entry.arg === undefined ? [] : [entry.arg]),
      ...Object.keys(entry.fragments),
    ];
    for (const name of parseBotTextTemplate(entry.source).names) expect(allowed).toContain(name);
  });

  it.each(ENTRIES)('describes %s in at most 200 characters', (_key, entry) => {
    expect(entry.description.trim()).not.toBe('');
    expect(entry.description.length).toBeLessThanOrEqual(200);
  });

  it.each(ENTRIES)('puts %s into a known group', (_key, entry) => {
    expect(Object.values(BotTextGroup)).toContain(entry.group);
  });

  // #314 hid the site sign-in; the three entries it used stay as override keys, never shown
  const HIDDEN_SITE_SIGN_IN: readonly BotTextKey[] = ['oauthButton', 'loginButton', 'loginLink'];
  it.each(ENTRIES.filter(([key]) => !HIDDEN_SITE_SIGN_IN.includes(key)))(
    'keeps the default of %s free of the site sign-in',
    (_key, entry) => {
      expect(entry.source).not.toMatch(/сайт|браузер/i);
    },
  );

  it('titles every group', () => {
    expect(Object.keys(BOT_TEXT_GROUP_TITLES).sort()).toEqual(Object.values(BotTextGroup).sort());
  });

  // Bot API limits: setMyDescription 512, setMyShortDescription 120, a command description 256
  it('holds the profile and the command descriptions to the Bot API limits', () => {
    expect(BOT_TEXT_CATALOG.profileDescription.limit).toBe(512);
    expect(BOT_TEXT_CATALOG.profileShortDescription.limit).toBe(120);
    for (const key of botTextKeysOf(BotTextGroup.Commands)) {
      expect(BOT_TEXT_CATALOG[key].limit, key).toBe(256);
    }
  });

  // The bot's LABELS is these two groups but confirmButtonNoEmail, so a key moved into `buttons`
  // would add a label the bot never had (Plan Update, #240).
  it('keeps `buttons` the bot labels of today and `commands` the command descriptions', () => {
    expect(botTextKeysOf(BotTextGroup.Buttons).sort()).toEqual(
      [
        'backToListButton',
        'demoManualButton',
        'demoSignalsRefreshButton',
        'launchCycleButton',
        'sessionAgainButton',
        'stakeBackLaunchButton',
        'stakeChangeButton',
        'changeEmailButton',
        'confirmButton',
        'confirmButtonNoEmail',
        'connectButton',
        'demoAnalysisButton',
        'demoBackDurationsButton',
        'demoBackGroupsButton',
        'demoBackPairsButton',
        'demoButton',
        'demoNextButton',
        'demoPrevButton',
        'demoRetryButton',
        'loginButton',
        'menuButton',
        'newAnalysisButton',
        'oauthButton',
        'refreshIntentButton',
        'repeatAnalysisButton',
        'resendButton',
        'sessionRefreshButton',
        'sessionStopButton',
        'settingsStakeButton',
        'stakeBackAnalysisButton',
        'stakeBackButton',
        'stakeBackSettingsButton',
        'stakeCustomButton',
        'stakeMenuButton',
        'stakeResetButton',
        'supportButton',
        'toSignalsButton',
      ].sort(),
    );
    expect(botTextKeysOf(BotTextGroup.Commands).sort()).toEqual(
      [
        'accountCommand',
        'helpCommand',
        'menuCommand',
        'settingsCommand',
        'startCommand',
        'supportCommand',
      ].sort(),
    );
  });
});
