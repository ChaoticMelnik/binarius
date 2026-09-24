import { Bot, InlineKeyboard, type Context } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import {
  errorLogFields,
  LANGUAGE_CODE_PATTERN,
  OAuthErrorCode,
  START_PAYLOAD_PATTERN,
  UserStatus,
  type UserStartRequest,
} from '@binarius/shared';
import { BackendError, type BackendClient } from './backend-client';
import { telegramErrorFields, type Logger } from './logging';
import { TEXTS } from './texts';
import { TELEGRAM_API_TIMEOUT_MS } from './timing';

// the callback data of the CTA button; Bot API allows 1-64 bytes
export const CONNECT_CALLBACK_DATA = 'connect';

export interface CreateBotOptions {
  token: string;
  backend: BackendClient;
  logger: Logger;
  welcomeVideoFileId?: string;
  // the two seams the tests need: a bot that must not call getMe, and a client pointed at a
  // local server so the configured timeout can be observed rather than assumed
  botInfo?: UserFromGetMe;
  apiRoot?: string;
  telegramApiTimeoutMs?: number;
}

export function createBot({
  token,
  backend,
  logger,
  welcomeVideoFileId,
  botInfo,
  apiRoot,
  telegramApiTimeoutMs = TELEGRAM_API_TIMEOUT_MS,
}: CreateBotOptions): Bot {
  const bot = new Bot(token, {
    ...(botInfo === undefined ? {} : { botInfo }),
    client: {
      ...(apiRoot === undefined ? {} : { apiRoot }),
      // grammY's own default is 500 s, which would leave every call above bounded by nothing
      timeoutSeconds: telegramApiTimeoutMs / 1000,
    },
  });

  const connectKeyboard = () =>
    new InlineKeyboard().text(TEXTS.connectButton, CONNECT_CALLBACK_DATA);

  // Groups and channels are ignored entirely: this bot only ever talks to one person, and a
  // /start in a group would attribute a whole chat to one member's payload.
  const privateChats = bot.chatType('private');

  privateChats.command('start', async (ctx) => {
    const from = ctx.from;
    if (from === undefined) return;
    const request: UserStartRequest = {
      telegramUserId: String(from.id),
      displayName: [from.first_name, from.last_name].filter(Boolean).join(' ').trim(),
      ...languageOf(from.language_code),
      ...payloadOf(ctx.match),
    };

    let user;
    try {
      user = await backend.recordStart(request);
    } catch (error) {
      logger.warn(
        { ...errorLogFields(error), ...backendErrorFields(error) },
        '/start not recorded',
      );
      await ctx.reply(TEXTS.unavailable);
      return;
    }

    if (user.status === UserStatus.Blocked) {
      await ctx.reply(TEXTS.blocked);
      return;
    }
    if (user.hasActiveBrokerAccount) {
      await ctx.reply(TEXTS.welcomeBack);
      return;
    }
    await sendWelcome(ctx);
  });

  privateChats.callbackQuery(CONNECT_CALLBACK_DATA, async (ctx) => {
    // the two calls are independent: the spinner on the button is worth less than the link, so
    // a rejected answerCallbackQuery ("query is too old" is the usual one) must not skip it
    const [answered, login] = await Promise.allSettled([
      ctx.answerCallbackQuery(),
      backend.startLogin(String(ctx.from.id)),
    ]);
    if (answered.status === 'rejected') {
      logger.warn(
        { ...errorLogFields(answered.reason), ...telegramErrorFields(answered.reason) },
        'answering the callback query failed',
      );
    }
    if (login.status === 'rejected') {
      const error: unknown = login.reason;
      if (error instanceof BackendError && error.reason === OAuthErrorCode.UserBlocked) {
        await ctx.reply(TEXTS.blocked);
        return;
      }
      logger.warn({ ...errorLogFields(error), ...backendErrorFields(error) }, 'login not started');
      await ctx.reply(TEXTS.unavailable);
      return;
    }
    await ctx.reply(TEXTS.loginLink, {
      reply_markup: new InlineKeyboard().url(TEXTS.loginButton, login.value.authorizeUrl),
    });
  });

  bot.catch((error) => {
    logger.error(
      {
        ...errorLogFields(error.error),
        ...telegramErrorFields(error.error),
        updateId: error.ctx.update.update_id,
      },
      'update handler failed',
    );
  });

  async function sendWelcome(ctx: Context): Promise<void> {
    const reply_markup = connectKeyboard();
    if (welcomeVideoFileId !== undefined) {
      try {
        await ctx.replyWithVideo(welcomeVideoFileId, { caption: TEXTS.welcome, reply_markup });
        return;
      } catch (error) {
        // a file id that Telegram refuses must not cost the user the whole first screen
        logger.warn(
          { ...errorLogFields(error), ...telegramErrorFields(error) },
          'the welcome video was refused, sending the text instead',
        );
      }
    }
    await ctx.reply(TEXTS.welcome, { reply_markup });
  }

  return bot;
}

// only what a /start may legitimately carry; anything else is treated as no payload at all,
// without telling the user off for a link they did not compose
function payloadOf(match: unknown): Pick<UserStartRequest, 'startPayload'> {
  return typeof match === 'string' && START_PAYLOAD_PATTERN.test(match)
    ? { startPayload: match }
    : {};
}

function languageOf(languageCode: string | undefined): Pick<UserStartRequest, 'languageCode'> {
  return languageCode !== undefined && LANGUAGE_CODE_PATTERN.test(languageCode)
    ? { languageCode }
    : {};
}

function backendErrorFields(error: unknown): { backendStatus?: number; backendReason?: string } {
  if (!(error instanceof BackendError)) return {};
  return { backendStatus: error.status, backendReason: error.reason };
}
