import { describe, expect, it, vi } from 'vitest';
import {
  BOT_TEXT_SOURCES_EN,
  BotLanguage,
  UserErrorCode,
  type BotLanguage as Language,
} from '@binarius/shared';
import type { User } from 'grammy/types';
import { BackendError, BackendErrorCode, type BackendClient } from './backend-client';
import { createBot } from './bot';
import {
  createUserLanguages,
  currentLanguage,
  missingLanguageReads,
  runWithLanguage,
  type UserLanguages,
} from './language';
import { TEXTS } from './texts';
import {
  BOT_INFO,
  USER,
  captureApi,
  chosenInlineResultUpdate,
  fakeBackend,
  fakeLogger,
  inlineQueryUpdate,
  preCheckoutUpdate,
  stubSessionResumer,
  stubSignalWaiter,
  stubSessionTracker,
  stubTracker,
  textUpdate,
  userLanguagesWith,
  userView,
  stubShownSignals,
} from './testing';

const EN_USER: User = { ...USER, language_code: 'en' };
const HELP_EN_HEADER = 'What Binarius can do';
const HELP_RU_HEADER = 'Что умеет Binarius';

const setup = (
  patch: Partial<BackendClient> = {},
  languages: UserLanguages = createUserLanguages(),
) => {
  const readLanguage = vi.fn<BackendClient['readLanguage']>(() => Promise.resolve(BotLanguage.Ru));
  const backend = fakeBackend({ readLanguage, ...patch });
  const logger = fakeLogger();
  const bot = createBot({
    token: '123456:AA-bot-token',
    backend,
    logger,
    botInfo: BOT_INFO,
    intentTracker: stubTracker(),
    sessionTracker: stubSessionTracker(),
    sessionResumer: stubSessionResumer(),
    signalWaiter: stubSignalWaiter(),
    shownSignals: stubShownSignals(),
    languages,
  });
  const api = captureApi(bot);
  return { bot, api, backend, logger, languages };
};

// the last message sent
const helpText = (api: ReturnType<typeof captureApi>): string =>
  String(api.calls.filter((call) => call.method === 'sendMessage').at(-1)?.payload.text);

describe('the language of an update (#508)', () => {
  it('M1 a cached language reaches the handler with no read', async () => {
    const readLanguage = vi.fn<BackendClient['readLanguage']>();
    const { bot, api } = setup({ readLanguage }, userLanguagesWith(USER.id, BotLanguage.En));

    await bot.handleUpdate(textUpdate('/help'));

    expect(helpText(api)).toContain(HELP_EN_HEADER);
    expect(readLanguage).not.toHaveBeenCalled();
  });

  it('M2 a user not cached is read once, and the answer is kept', async () => {
    const readLanguage = vi.fn<BackendClient['readLanguage']>(() =>
      Promise.resolve(BotLanguage.En),
    );
    const { bot, api, languages } = setup({ readLanguage });

    await bot.handleUpdate(textUpdate('/help'));
    await bot.handleUpdate(textUpdate('/help'));

    expect(helpText(api)).toContain(HELP_EN_HEADER);
    expect(readLanguage).toHaveBeenCalledTimes(1);
    expect(readLanguage).toHaveBeenCalledWith(String(USER.id));
    expect(languages.get(USER.id)).toBe(BotLanguage.En);
  });

  it('M3 a user with no row yet gets the language of the Telegram client, not cached, no warning', async () => {
    const readLanguage = vi.fn<BackendClient['readLanguage']>(() =>
      Promise.reject(
        new BackendError(BackendErrorCode.HttpStatus, {
          status: 404,
          reason: UserErrorCode.UserNotFound,
        }),
      ),
    );
    const { bot, api, languages, logger } = setup({ readLanguage });

    await bot.handleUpdate(textUpdate('/help', 'private', EN_USER));
    await bot.handleUpdate(textUpdate('/help', 'private', EN_USER));

    expect(helpText(api)).toContain(HELP_EN_HEADER);
    expect(readLanguage).toHaveBeenCalledTimes(2);
    expect(languages.get(USER.id)).toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('M4 a failed read falls back to the Telegram client, warns with the identity and reads again next time', async () => {
    const readLanguage = vi.fn<BackendClient['readLanguage']>(() =>
      Promise.reject(new BackendError(BackendErrorCode.Unreachable)),
    );
    const { bot, api, languages, logger } = setup({ readLanguage });

    await bot.handleUpdate(textUpdate('/help'));
    expect(helpText(api)).toContain(HELP_RU_HEADER);
    await bot.handleUpdate(textUpdate('/help', 'private', EN_USER));

    expect(helpText(api)).toContain(HELP_EN_HEADER);
    expect(readLanguage).toHaveBeenCalledTimes(2);
    expect(languages.get(USER.id)).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: { name: 'BackendError', code: 'unreachable' } }),
      'user language not read',
    );
  });

  it('M5 the cache drops its oldest entry past its size, a read making an entry the newest', () => {
    const languages = createUserLanguages({ maxEntries: 2 });
    languages.set(1, BotLanguage.En);
    languages.set(2, BotLanguage.Ru);
    expect(languages.get(1)).toBe(BotLanguage.En);
    languages.set(3, BotLanguage.En);

    expect(languages.get(2)).toBeUndefined();
    expect(languages.get(1)).toBe(BotLanguage.En);
    expect(languages.get(3)).toBe(BotLanguage.En);
    languages.delete(3);
    expect(languages.get(3)).toBeUndefined();
  });

  it('M6 outside any update a text is Russian and the read is counted', async () => {
    const before = missingLanguageReads();
    expect(currentLanguage()).toBe(BotLanguage.Ru);
    expect(missingLanguageReads()).toBe(before + 1);

    const inside = await runWithLanguage(BotLanguage.En, async () => {
      await Promise.resolve();
      return currentLanguage();
    });
    expect(inside).toBe(BotLanguage.En);
    expect(runWithLanguage(BotLanguage.En, () => TEXTS.helpCommands)).toBe(
      runWithLanguage(BotLanguage.En, () => TEXTS.helpCommands),
    );
    expect(String(runWithLanguage(BotLanguage.En, () => TEXTS.helpCommands))).toBe(
      BOT_TEXT_SOURCES_EN.helpCommands,
    );
    expect(missingLanguageReads()).toBe(before + 1);
  });

  it('M7 /start writes the language of its answer to the cache: the next update reads nothing', async () => {
    const readLanguage = vi.fn<BackendClient['readLanguage']>(() =>
      Promise.resolve(BotLanguage.Ru),
    );
    const recordStart = vi.fn<BackendClient['recordStart']>(() =>
      Promise.resolve(userView({ language: BotLanguage.En })),
    );
    const { bot, api, languages } = setup({ readLanguage, recordStart });
    languages.set(USER.id, BotLanguage.Ru);

    await bot.handleUpdate(textUpdate('/start'));
    expect(languages.get(USER.id)).toBe(BotLanguage.En);
    await bot.handleUpdate(textUpdate('/help'));

    expect(readLanguage).not.toHaveBeenCalled();
    expect(helpText(api)).toContain(HELP_EN_HEADER);
  });

  it.each<[string, () => ReturnType<typeof textUpdate>, boolean]>([
    ['an inline query', () => inlineQueryUpdate('', { from: EN_USER }), true],
    ['a pre-checkout query', () => preCheckoutUpdate({ from: EN_USER }), true],
    ['a group message', () => textUpdate('/help', 'group', EN_USER), false],
    ['a chosen inline result', () => chosenInlineResultUpdate('r', ''), false],
  ])('M8 %s is read: %s', async (_label, update, read) => {
    const readLanguage = vi.fn<BackendClient['readLanguage']>(() =>
      Promise.resolve(BotLanguage.En),
    );
    const { bot } = setup({
      readLanguage,
      readSessionShare: () => Promise.reject(new BackendError(BackendErrorCode.Unreachable)),
      checkStarsPreCheckout: () => Promise.reject(new BackendError(BackendErrorCode.Unreachable)),
    });
    const before = missingLanguageReads();

    await bot.handleUpdate(update());

    expect(readLanguage).toHaveBeenCalledTimes(read ? 1 : 0);
    expect(missingLanguageReads()).toBe(before);
  });

  it('M9 a language read stays inside its update: two updates of two users do not mix', async () => {
    const other: User = { ...USER, id: USER.id + 1 };
    const languages = createUserLanguages();
    languages.set(USER.id, BotLanguage.En);
    languages.set(other.id, BotLanguage.Ru);
    const { bot, api } = setup({}, languages);

    await Promise.all([
      bot.handleUpdate(textUpdate('/help')),
      bot.handleUpdate(textUpdate('/help', 'private', other)),
    ]);

    const texts = api.calls
      .filter((call) => call.method === 'sendMessage')
      .map((call) => ({ chat: call.payload.chat_id, text: String(call.payload.text) }));
    const languageOf = (chat: number): Language =>
      texts.find((sent) => sent.chat === chat)?.text.includes(HELP_EN_HEADER) === true
        ? BotLanguage.En
        : BotLanguage.Ru;
    expect([languageOf(USER.id), languageOf(other.id)]).toEqual([BotLanguage.En, BotLanguage.Ru]);
  });
});
