import { Api, InlineKeyboard } from 'grammy';
import type { InlineKeyboardMarkup } from 'grammy/types';
import {
  BOT_MESSAGE_SPACER,
  CONNECT_CALLBACK_DATA,
  confirmButtonLabel,
  confirmCallbackData,
  DEMO_CALLBACK_DATA,
  MENU_CALLBACK_DATA,
  supportUrl,
  type BotTextBalance,
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

// the demo (#320's entry): the next step of a re-login and of every first-session reminder
export const demoKeyboard = () =>
  new InlineKeyboard().text(CLIENT_LABELS.demoButton, DEMO_CALLBACK_DATA);

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
        reply_markup: demoKeyboard(),
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

// After the cashier's credited event (#112, docs/deposit.md -> After a deposit): the real balance
// from the snapshot the route has just written, never an amount from the widget, and the menu.
export const depositCreditedMessage = (balance: BotTextBalance): ClientPushMessage => ({
  text: CLIENT_TEXTS.depositCredited({ realBalance: balance }),
  reply_markup: new InlineKeyboard().text(CLIENT_LABELS.menuButton, MENU_CALLBACK_DATA),
});

// A message the backend sends a Telegram user on its own: a link push, or a mailing
// (apps/backend/src/mailing). It carries its next step, as every message of the bot does (#350,
// docs/bot-navigation.md): the buttons are the bot's, built from bot-navigation.ts, so a press
// lands on its handler.
export interface ClientPushMessage {
  text: TelegramHtml;
  reply_markup: InlineKeyboardMarkup;
}

export interface ClientPush {
  // the transport, exposed so tests can intercept it the way they do the staff bot's
  readonly api: Api;
  // Each throws when Telegram refuses (GrammyError) or the transport fails or times out (HttpError).
  sendLink(telegramUserId: bigint, outcome: LinkPushOutcome): Promise<void>;
  sendMailing(telegramUserId: bigint, message: ClientPushMessage): Promise<void>;
  sendDepositCredited(telegramUserId: bigint, balance: BotTextBalance): Promise<void>;
  // A session's cycle message (#464, #551, docs/bot-session.md → Trade messages): without sound
  // and without a keyboard, the one exception of this seam (docs/bot-navigation.md → Exceptions,
  // `session_trade`). It takes the text alone, so no other message can drop its keyboard here.
  // Resolves to the sent message's message_id, which the next step of the cycle edits.
  sendSessionTrade(telegramUserId: bigint, text: TelegramHtml): Promise<number>;
  // The next step of a cycle (#551): the cycle message edited to `text`, still without a
  // keyboard. An edit makes no sound.
  editSessionTrade(telegramUserId: bigint, messageId: number, text: TelegramHtml): Promise<void>;
  // the finished session's summary (#464): with sound and its next step
  sendSessionSummary(telegramUserId: bigint, message: ClientPushMessage): Promise<void>;
  // The waiting message under the session's messages (#536, docs/bot-session.md → The waiting
  // message): without sound, with its «⏹». Resolves to its message_id, which its delete takes.
  sendSessionWaiting(telegramUserId: bigint, message: ClientPushMessage): Promise<number>;
  deleteSessionWaiting(telegramUserId: bigint, messageId: number): Promise<void>;
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
  // not parse it. Every text ends with the width spacer, as the bot's do (#506,
  // docs/bot-navigation.md → The width).
  const sent = (text: TelegramHtml) => text.value + BOT_MESSAGE_SPACER;
  const send = async (telegramUserId: bigint, { text, reply_markup }: ClientPushMessage) => {
    await api.sendMessage(String(telegramUserId), sent(text), { parse_mode: 'HTML', reply_markup });
  };
  const sendSessionTrade = async (telegramUserId: bigint, text: TelegramHtml) => {
    const message = await api.sendMessage(String(telegramUserId), sent(text), {
      parse_mode: 'HTML',
      disable_notification: true,
    });
    return message.message_id;
  };
  const editSessionTrade = async (
    telegramUserId: bigint,
    messageId: number,
    text: TelegramHtml,
  ) => {
    await api.editMessageText(String(telegramUserId), messageId, sent(text), {
      parse_mode: 'HTML',
    });
  };
  const sendSessionWaiting = async (
    telegramUserId: bigint,
    { text, reply_markup }: ClientPushMessage,
  ) => {
    const message = await api.sendMessage(String(telegramUserId), sent(text), {
      parse_mode: 'HTML',
      disable_notification: true,
      reply_markup,
    });
    return message.message_id;
  };
  const deleteSessionWaiting = async (telegramUserId: bigint, messageId: number) => {
    await api.deleteMessage(String(telegramUserId), messageId);
  };
  return {
    api,
    sendLink: (telegramUserId, outcome) => send(telegramUserId, linkPushMessage(outcome)),
    sendMailing: send,
    sendDepositCredited: (telegramUserId, balance) =>
      send(telegramUserId, depositCreditedMessage(balance)),
    sendSessionTrade,
    editSessionTrade,
    sendSessionSummary: send,
    sendSessionWaiting,
    deleteSessionWaiting,
  };
}
