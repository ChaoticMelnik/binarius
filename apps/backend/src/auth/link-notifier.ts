import { Api, InlineKeyboard } from 'grammy';
import type { InlineKeyboardMarkup } from 'grammy/types';
import { confirmCallbackData, LINK_LABELS, LINK_TEXTS, type TelegramHtml } from '@binarius/shared';
import { LINK_PUSH_TELEGRAM_API_TIMEOUT_MS } from '../timing';
import { AUTH_TEXTS } from './texts';

// What the push after POST /auth/binodex/callback tells the Telegram user who started the login.
export const LinkPushKind = {
  // a new link, or a re-login of one still waiting: the confirm button for that account
  Pending: 'pending',
  // a re-login of an account already confirmed
  Active: 'active',
  Blocked: 'blocked',
  Taken: 'taken',
  ExchangeFailed: 'exchange_failed',
  // someone else's Telegram account finished this user's login; the state is spent
  Mismatch: 'telegram_user_mismatch',
} as const;
export type LinkPushKind = (typeof LinkPushKind)[keyof typeof LinkPushKind];

export type LinkPushOutcome =
  | { kind: typeof LinkPushKind.Pending; account: { id: string; email: string | null } }
  | {
      kind: Exclude<LinkPushKind, typeof LinkPushKind.Pending>;
    };

export interface LinkPushMessage {
  text: TelegramHtml;
  reply_markup?: InlineKeyboardMarkup;
}

export function linkPushMessage(outcome: LinkPushOutcome): LinkPushMessage {
  switch (outcome.kind) {
    case LinkPushKind.Pending:
      return {
        text: LINK_TEXTS.confirmPrompt,
        reply_markup: new InlineKeyboard().text(
          LINK_LABELS.confirmButton(outcome.account.email),
          confirmCallbackData(outcome.account.id),
        ),
      };
    case LinkPushKind.Active:
      return { text: LINK_TEXTS.linkedActive };
    case LinkPushKind.Blocked:
      return { text: LINK_TEXTS.blocked };
    case LinkPushKind.Taken:
      return { text: LINK_TEXTS.accountTaken };
    case LinkPushKind.ExchangeFailed:
    case LinkPushKind.Mismatch:
      return { text: AUTH_TEXTS.oauthLoginFailed };
  }
}

export interface LinkNotifier {
  // the transport, exposed so tests can intercept it the way they do the staff bot's
  readonly api: Api;
  // Throws when Telegram refuses (GrammyError) or the transport fails or times out (HttpError).
  send(telegramUserId: bigint, outcome: LinkPushOutcome): Promise<void>;
}

export interface CreateLinkNotifierOptions {
  token: string;
  // the seams the tests need, as for the staff bot
  apiRoot?: string;
  telegramApiTimeoutMs?: number;
}

// Sends on the public bot's token without polling it: apps/bot is the one poller, and a bare Api
// calls nothing until send does — not even getMe.
export function createLinkNotifier({
  token,
  apiRoot,
  telegramApiTimeoutMs = LINK_PUSH_TELEGRAM_API_TIMEOUT_MS,
}: CreateLinkNotifierOptions): LinkNotifier {
  const api = new Api(token, {
    ...(apiRoot === undefined ? {} : { apiRoot }),
    // grammY's own default is 500 s
    timeoutSeconds: telegramApiTimeoutMs / 1000,
  });
  return {
    api,
    async send(telegramUserId, outcome) {
      const { text, reply_markup } = linkPushMessage(outcome);
      // chat_id as a string: the column is bigint, and a string is the conversion that cannot
      // round. This is the backend's one send seam for user texts, as apps/bot/src/send.ts is the
      // bot's: the only place here that sets parse_mode and unwraps TelegramHtml, which is why
      // ESLint allows a raw sendMessage in this file alone outside tests. The button label is
      // plain: Telegram does not parse it.
      await api.sendMessage(String(telegramUserId), text.value, {
        parse_mode: 'HTML',
        ...(reply_markup === undefined ? {} : { reply_markup }),
      });
    },
  };
}
