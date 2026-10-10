import { describe, expect, it } from 'vitest';
import { BOT_TEXT_KEY_PATTERN } from './bot-text-overrides';
import { BotTextKind, parseBotTextTemplate } from './bot-text-template';
import { BOT_TEXT_VARS, type BotTextVarFallbackKey } from './bot-text-vars';
import {
  BOT_TEXT_CATALOG,
  BOT_TEXT_GROUP_TITLES,
  BotTextGroup,
  botTextKeysOf,
  botTextProblems,
  createBotTexts,
  defaultBotTextSource,
  type BotHtmlKey,
  type BotPlainKey,
  type BotTextKey,
} from './bot-texts';
import { plainTextOf } from './telegram-html';

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

  it.each(ENTRIES)(
    'binds %s to registry variables, each once and apart from its fragments',
    (_key, entry) => {
      expect(new Set(entry.vars).size).toBe(entry.vars.length);
      expect(Object.keys(entry.variables)).toEqual(entry.vars);
      for (const name of entry.vars) {
        expect(entry.variables[name as never]).toBe(
          BOT_TEXT_VARS[name as keyof typeof BOT_TEXT_VARS],
        );
        expect(Object.keys(entry.fragments)).not.toContain(name);
      }
    },
  );

  // what the preview and the CLI show, and what the validator measures
  it.each(ENTRIES)('renders %s at its samples within its limit', (key, entry) => {
    const { samples } = createBotTexts(defaultBotTextSource);
    const shown =
      entry.kind === BotTextKind.Html
        ? plainTextOf(samples.html[key as BotHtmlKey])
        : samples.plain[key as BotPlainKey];
    expect(shown.trim()).not.toBe('');
    expect(shown.length).toBeLessThanOrEqual(entry.limit);
  });

  // #358 В1: the placeholder renamed to the registry's name, the text the same
  it.each([
    ['statusTokens', 'count', 'tokens'],
    ['statusReserved', 'count', 'reservedTokens'],
    ['cardBonusGranted', 'tokens', 'bonusTokens'],
    ['settings', 'current', 'level'],
    ['settingsStake', 'amount', 'stake'],
    ['stakeSaved', 'amount', 'stake'],
    ['stakePickerMinimum', 'amount', 'minStake'],
    ['stakeBelowMinimum', 'amount', 'minStake'],
    ['stakePickerAvailable', 'amount', 'demoAvailable'],
    ['stakeAboveAvailableAmount', 'amount', 'demoAvailable'],
    ['launchStake', 'amount', 'stake'],
    ['stakeSavedLine', 'amount', 'stake'],
  ] as const)(
    'renames the placeholder of %s from {%s} to {%s} in the default',
    (key, before, after) => {
      const names = parseBotTextTemplate(BOT_TEXT_CATALOG[key].source).names;
      expect(names).toContain(after);
      expect(names).not.toContain(before);
    },
  );

  // a formatter reads its stand-in through the plain view: a function there would print as code
  it.each<BotTextVarFallbackKey>([
    'accountUnknownAddress',
    'balanceUnavailable',
    'stakeMinimumLabel',
    'levelAll',
    'levelReduced',
    'levelOff',
  ])('keeps the stand-in %s a plain text without variables', (key) => {
    expect(BOT_TEXT_CATALOG[key].kind).toBe(BotTextKind.Plain);
    expect(BOT_TEXT_CATALOG[key].vars).toEqual([]);
  });

  // depth 1, so no cycle and no fragment of a fragment to re-render
  it.each(ENTRIES.filter(([, entry]) => Object.keys(entry.fragments).length > 0))(
    'points the fragments of %s at keys with no fragments and no variables',
    (_key, entry) => {
      for (const fragmentKey of Object.values(entry.fragments)) {
        expect(Object.keys(BOT_TEXT_CATALOG)).toContain(fragmentKey);
        const fragment = BOT_TEXT_CATALOG[fragmentKey as BotTextKey];
        expect(fragment.fragments, fragmentKey).toEqual({});
        expect(fragment.vars, fragmentKey).toEqual([]);
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

  it.each(ENTRIES)('uses in the default of %s only its variables and fragments', (_key, entry) => {
    const allowed = [...entry.vars, ...Object.keys(entry.fragments)];
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
        'analysisMoreButton',
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
        'stopCommand',
        'supportCommand',
      ].sort(),
    );
  });
});
