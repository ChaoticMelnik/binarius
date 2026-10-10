import { Api, InlineKeyboard } from 'grammy';
import type { InlineKeyboardMarkup } from 'grammy/types';
import {
  CONNECT_CALLBACK_DATA,
  confirmButtonLabel,
  confirmCallbackData,
  DEMO_CALLBACK_DATA,
  MENU_CALLBACK_DATA,
  supportUrl,
  type TelegramHtml,
} from '@binarius/shared';
import { CLIENT_PUSH_TELEGRAM_API_TIMEOUT_MS } from '../timing';
import { CLIENT_LABELS, CLIENT_TEXTS } from './texts';

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
  // the account's address for the text's {email} (#358); null when the broker sent none
  | { kind: typeof LinkPushKind.Active; email: string | null }
  | {
      kind: Exclude<LinkPushKind, typeof LinkPushKind.Pending | typeof LinkPushKind.Active>;
    };

// Every push carries its next step, as the bot's own messages do (#350, docs/bot-navigation.md):
// the buttons are the bot's, built from bot-navigation.ts, so a press lands on its handler.

// a failed login: connect again, or the menu
const connectAgain = () =>
  new InlineKeyboard()
    .text(CLIENT_LABELS.connectButton, CONNECT_CALLBACK_DATA)
    .row()
    .text(CLIENT_LABELS.menuButton, MENU_CALLBACK_DATA);

export function linkPushMessage(outcome: LinkPushOutcome): ClientPushMessage {
  switch (outcome.kind) {
    case LinkPushKind.Pending:
      return {
        text: CLIENT_TEXTS.confirmPrompt,
        reply_markup: new InlineKeyboard().text(
          confirmButtonLabel(CLIENT_LABELS, outcome.account.email),
          confirmCallbackData(outcome.account.id),
        ),
      };
    case LinkPushKind.Active:
      return {
        text: CLIENT_TEXTS.linkedActive({ email: outcome.email }),
        reply_markup: new InlineKeyboard().text(CLIENT_LABELS.demoButton, DEMO_CALLBACK_DATA),
      };
    case LinkPushKind.Blocked:
      return {
        text: CLIENT_TEXTS.blocked,
        reply_markup: new InlineKeyboard().url(CLIENT_LABELS.supportButton, supportUrl()),
      };
    case LinkPushKind.Taken:
      return { text: CLIENT_TEXTS.accountTaken, reply_markup: connectAgain() };
    case LinkPushKind.ExchangeFailed:
    case LinkPushKind.Mismatch:
      return { text: CLIENT_TEXTS.oauthLoginFailed, reply_markup: connectAgain() };
  }
}

// A message the backend sends a Telegram user on its own: a link push, or a mailing
// (apps/backend/src/mailing). It carries its next step, as every message of the bot does.
export interface ClientPushMessage {
  text: TelegramHtml;
  reply_markup: InlineKeyboardMarkup;
}

export interface ClientPush {
  // the transport, exposed so tests can intercept it the way they do the staff bot's
  readonly api: Api;
  // Both throw when Telegram refuses (GrammyError) or the transport fails or times out (HttpError).
  sendLink(telegramUserId: bigint, outcome: LinkPushOutcome): Promise<void>;
  sendMailing(telegramUserId: bigint, message: ClientPushMessage): Promise<void>;
}

export interface CreateClientPushOptions {
  token: string;
  // the seams the tests need, as for the staff bot
  apiRoot?: string;
  telegramApiTimeoutMs?: number;
}

// Sends on the public bot's token without polling it: apps/bot is the one poller, and a bare Api
// calls nothing until a send does — not even getMe.
export function createClientPush({
  token,
  apiRoot,
  telegramApiTimeoutMs = CLIENT_PUSH_TELEGRAM_API_TIMEOUT_MS,
}: CreateClientPushOptions): ClientPush {
  const api = new Api(token, {
    ...(apiRoot === undefined ? {} : { apiRoot }),
    // grammY's own default is 500 s
    timeoutSeconds: telegramApiTimeoutMs / 1000,
  });
  // chat_id as a string: the column is bigint, and a string is the conversion that cannot round.
  // This is the backend's one send seam for user texts, as apps/bot/src/send.ts is the bot's: the
  // only place here that sets parse_mode and unwraps TelegramHtml, which is why ESLint allows a
  // raw sendMessage in this file alone outside tests. The button label is plain: Telegram does
  // not parse it.
  const send = async (telegramUserId: bigint, { text, reply_markup }: ClientPushMessage) => {
    await api.sendMessage(String(telegramUserId), text.value, { parse_mode: 'HTML', reply_markup });
  };
  return {
    api,
    sendLink: (telegramUserId, outcome) => send(telegramUserId, linkPushMessage(outcome)),
    sendMailing: send,
  };
}
