import { Composer, GrammyError, HttpError, InlineKeyboard, type Context } from 'grammy';
import {
  BotLanguage,
  botLanguageSchema,
  editRefusal,
  errorLogFields,
  LANGUAGE_CALLBACK_DATA,
  LANGUAGE_SET_PATTERN,
  languageSetCallbackData,
  telegramErrorFields,
  UserErrorCode,
  type BotLanguage as Language,
  type TelegramHtml,
} from '@binarius/shared';
import { answerCallback } from './answer-callback';
import { BackendError, backendErrorFields, type BackendClient } from './backend-client';
import { menuKeyboard, withMenu } from './keyboards';
import { currentLanguage, runWithLanguage, type UserLanguages } from './language';
import type { Logger } from './logging';
import { editMessageTextHtml, replyHtml } from './send';
import { settle } from './settled';
import { languageLabel, TEXTS } from './texts';

// The language screen (#508, docs/bot-navigation.md → The language screen): `lang` from the status
// card opens it as a new message; `lang:<language>` saves the choice — a write
// (WRITE_CALLBACK_PREFIXES), no «🔄 Повторить» carries it — and redraws the screen in place in the
// new language, so the user sees the choice took. The current language pressed is only answered.

export interface LanguageScreenDeps {
  backend: Pick<BackendClient, 'setLanguage'>;
  languages: UserLanguages;
  logger: Logger;
}

interface Screen {
  text: TelegramHtml;
  keyboard: InlineKeyboard;
}

const languageScreen = (current: Language): Screen => {
  const keyboard = new InlineKeyboard();
  for (const language of Object.values(BotLanguage)) {
    keyboard.text(languageLabel(language, language === current), languageSetCallbackData(language));
  }
  return { text: TEXTS.languageScreen, keyboard: withMenu(keyboard) };
};

export function createLanguageScreenComposer<C extends Context>({
  backend,
  languages,
  logger,
}: LanguageScreenDeps): Composer<C> {
  const composer = new Composer<C>();

  composer.callbackQuery(LANGUAGE_CALLBACK_DATA, async (ctx) => {
    await answerCallback(ctx, logger);
    const { text, keyboard } = languageScreen(currentLanguage());
    await replyHtml(ctx, text, { reply_markup: keyboard });
  });

  composer.callbackQuery(LANGUAGE_SET_PATTERN, async (ctx) => {
    // the pattern is built from BotLanguage, so a mismatch is a bug for bot.catch
    const language = botLanguageSchema.parse(ctx.match[1]);
    if (language === currentLanguage()) {
      await answerCallback(ctx, logger);
      return;
    }
    const [, set] = await Promise.all([
      answerCallback(ctx, logger),
      settle(backend.setLanguage(String(ctx.from.id), language)),
    ]);
    if (set.ok) {
      languages.set(ctx.from.id, set.value);
      await runWithLanguage(set.value, () => editOrReply(ctx, languageScreen(set.value)));
      return;
    }
    const { error } = set;
    const fields = { ...errorLogFields(error), ...backendErrorFields(error) };
    // no row yet: refused before any write, so the cached language still holds
    if (error instanceof BackendError && error.reason === UserErrorCode.UserNotFound) {
      logger.warn(fields, 'language not set');
      await editOrReply(ctx, { text: TEXTS.languageNeedsStart, keyboard: menuKeyboard() });
      return;
    }
    // the UPDATE may have committed: the next update reads the language again rather than
    // inferring it from the failure
    languages.delete(ctx.from.id);
    logger.warn(fields, 'language not set');
    await editOrReply(ctx, { text: TEXTS.unavailable, keyboard: menuKeyboard() });
  });

  // Every refusal of an edit is classified as in trading-mode.ts: already shown is done, gone gets
  // the screen anew, a transport failure sends nothing more, anything else goes to bot.catch.
  async function editOrReply(ctx: Context, { text, keyboard }: Screen): Promise<void> {
    try {
      await editMessageTextHtml(ctx, text, { reply_markup: keyboard });
    } catch (error) {
      const refusal = error instanceof GrammyError ? editRefusal(error) : undefined;
      if (refusal === 'shown') return;
      if (refusal === 'gone') {
        await replyHtml(ctx, text, { reply_markup: keyboard });
        return;
      }
      if (!(error instanceof HttpError)) throw error;
      logger.error(
        { ...errorLogFields(error), ...telegramErrorFields(error, 'editMessageText') },
        'the language screen edit failed in transport, sending nothing more',
      );
    }
  }

  return composer;
}
