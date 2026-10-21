import { describe, expect, it, vi } from 'vitest';
import {
  BOT_TEXT_SOURCES_EN,
  BotLanguage,
  LANGUAGE_CALLBACK_DATA,
  languageSetCallbackData,
  MENU_CALLBACK_DATA,
  UserErrorCode,
} from '@binarius/shared';
import type { ApiError } from 'grammy/types';
import { BackendError, BackendErrorCode, type BackendClient } from './backend-client';
import { createBot } from './bot';
import { createUserLanguages, runWithLanguage } from './language';
import {
  BOT_INFO,
  TEXT_CARD_MESSAGE_ID,
  USER,
  callbackUpdate,
  captureApi,
  fakeBackend,
  fakeLogger,
  messageAnswer,
  stubSessionResumer,
  stubSignalWaiter,
  stubSessionTracker,
  stubTracker,
  textUpdate,
  type ApiCall,
} from './testing';
import { LABELS, TEXTS } from './texts';

const EDIT_GONE: ApiError = {
  ok: false,
  error_code: 400,
  description: 'Bad Request: message to edit not found',
};

function setup({
  language = BotLanguage.Ru,
  setLanguage = (_id, chosen) => Promise.resolve(chosen),
}: {
  language?: BotLanguage;
  setLanguage?: BackendClient['setLanguage'];
} = {}) {
  const languages = createUserLanguages();
  languages.set(USER.id, language);
  const set = vi.fn<BackendClient['setLanguage']>(setLanguage);
  const readLanguage = vi.fn<BackendClient['readLanguage']>(() => Promise.resolve(language));
  const logger = fakeLogger();
  const bot = createBot({
    token: '123456:AA-bot-token',
    backend: fakeBackend({ setLanguage: set, readLanguage }),
    logger,
    botInfo: BOT_INFO,
    intentTracker: stubTracker(),
    sessionTracker: stubSessionTracker(),
    sessionResumer: stubSessionResumer(),
    signalWaiter: stubSignalWaiter(),
    languages,
  });
  const api = captureApi(bot);
  api.answers.set('sendMessage', messageAnswer(TEXT_CARD_MESSAGE_ID));
  const press = (data: string) => bot.handleUpdate(callbackUpdate(data));
  return { bot, press, set, readLanguage, languages, logger, ...api };
}

const methods = (calls: readonly ApiCall[]) => calls.map((call) => call.method);
const last = (calls: readonly ApiCall[]) => calls.at(-1)?.payload;
const rows = (payload: Record<string, unknown> | undefined) =>
  (payload?.reply_markup as { inline_keyboard: { text: string; callback_data?: string }[][] })
    .inline_keyboard;
const screenRows = (language: BotLanguage) =>
  runWithLanguage(language, () => [
    [
      {
        text: `${language === BotLanguage.Ru ? '🇷🇺 Русский ✅' : '🇷🇺 Русский'}`,
        callback_data: languageSetCallbackData(BotLanguage.Ru),
      },
      {
        text: `${language === BotLanguage.En ? '🇬🇧 English ✅' : '🇬🇧 English'}`,
        callback_data: languageSetCallbackData(BotLanguage.En),
      },
    ],
    [{ text: LABELS.menuButton, callback_data: MENU_CALLBACK_DATA }],
  ]);

describe('the language screen (#508)', () => {
  it('LS1 opens as a new message in the current language, the current one marked', async () => {
    const { press, calls, set } = setup({ language: BotLanguage.En });
    await press(LANGUAGE_CALLBACK_DATA);

    expect(methods(calls)).toEqual(['answerCallbackQuery', 'sendMessage']);
    expect(last(calls)?.text).toBe(BOT_TEXT_SOURCES_EN.languageScreen);
    expect(rows(last(calls))).toEqual(screenRows(BotLanguage.En));
    expect(set).not.toHaveBeenCalled();
  });

  it('LS2 a press saves the language, caches it and redraws the screen in place in it', async () => {
    const { bot, press, calls, set, languages, readLanguage } = setup();
    await press(languageSetCallbackData(BotLanguage.En));

    expect(set.mock.calls).toEqual([[String(USER.id), BotLanguage.En]]);
    expect(languages.get(USER.id)).toBe(BotLanguage.En);
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText']);
    expect(last(calls)?.text).toBe(BOT_TEXT_SOURCES_EN.languageScreen);
    expect(rows(last(calls))).toEqual(screenRows(BotLanguage.En));

    // the next update is in the new language with no read
    await bot.handleUpdate(textUpdate('/help'));
    expect(String(last(calls)?.text)).toContain('What Binarius can do');
    expect(readLanguage).not.toHaveBeenCalled();
  });

  it('LS3 a screen gone sends the redrawn one anew', async () => {
    const { press, calls, apiErrors } = setup({ language: BotLanguage.En });
    apiErrors.set('editMessageText', EDIT_GONE);
    await press(languageSetCallbackData(BotLanguage.Ru));

    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText', 'sendMessage']);
    expect(last(calls)?.text).toBe(
      runWithLanguage(BotLanguage.Ru, () => TEXTS.languageScreen).value,
    );
    expect(rows(last(calls))).toEqual(screenRows(BotLanguage.Ru));
  });

  it('LS4 a user with no row is sent to /start, the cache kept', async () => {
    const { press, calls, languages } = setup({
      setLanguage: () =>
        Promise.reject(
          new BackendError(BackendErrorCode.HttpStatus, {
            status: 404,
            reason: UserErrorCode.UserNotFound,
          }),
        ),
    });
    await press(languageSetCallbackData(BotLanguage.En));

    expect(last(calls)?.text).toBe(TEXTS.languageNeedsStart.value);
    expect(rows(last(calls))).toEqual([
      [{ text: LABELS.menuButton, callback_data: MENU_CALLBACK_DATA }],
    ]);
    expect(languages.get(USER.id)).toBe(BotLanguage.Ru);
  });

  it.each([
    ['a 5xx', new BackendError(BackendErrorCode.HttpStatus, { status: 502 })],
    ['no answer', new BackendError(BackendErrorCode.Unreachable)],
  ])(
    'LS5 %s: the unavailable line under the menu, the cache dropped, the next update reads again',
    async (_label, error) => {
      const { bot, press, calls, languages, readLanguage, logger } = setup({
        setLanguage: () => Promise.reject(error),
      });
      await press(languageSetCallbackData(BotLanguage.En));

      expect(last(calls)?.text).toBe(TEXTS.unavailable.value);
      expect(rows(last(calls))).toEqual([
        [{ text: LABELS.menuButton, callback_data: MENU_CALLBACK_DATA }],
      ]);
      expect(languages.get(USER.id)).toBeUndefined();
      expect(logger.warn.mock.calls.map((call) => call[1])).toEqual(['language not set']);

      await bot.handleUpdate(textUpdate('/help'));
      expect(readLanguage).toHaveBeenCalledTimes(1);
    },
  );

  it('LS6 the current language pressed is only answered', async () => {
    const { press, calls, set } = setup({ language: BotLanguage.En });
    await press(languageSetCallbackData(BotLanguage.En));

    expect(methods(calls)).toEqual(['answerCallbackQuery']);
    expect(set).not.toHaveBeenCalled();
  });
});
