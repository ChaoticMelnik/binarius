import { telegramHtml, type TelegramHtml } from './telegram-html';

// What a Telegram user sees about a pending broker-account link, whoever sends it: the bot on
// /start (#10) and the backend's push after the OAuth callback (#128). One source, so the button
// the backend sends is one the bot recognises when it is pressed.
//
// Messages are Telegram HTML (parse_mode HTML at the two send seams): built with telegramHtml,
// which escapes every hole. Button labels are not parsed by Telegram at all, so they stay plain
// strings and are never escaped — the broker's email in the confirm button keeps its `&` as is.

// Callback data is 1-64 bytes; 'confirm:' + a 36-character uuid is 44.
export const CONFIRM_CALLBACK_PREFIX = 'confirm:';
export const confirmCallbackData = (accountId: string): string =>
  `${CONFIRM_CALLBACK_PREFIX}${accountId}`;
export const CONFIRM_CALLBACK_PATTERN = new RegExp(`^${CONFIRM_CALLBACK_PREFIX}([0-9a-f-]{36})$`);

export const LINK_TEXTS = {
  confirmPrompt: telegramHtml`🔐 <b>Найдена новая привязка аккаунта Binodex</b>
Если вход выполнял ты — подтверди.`,
  // also the bot's recheck after an unknown outcome: it knows the account is active, not what
  // was paid
  linkedActive: telegramHtml`✅ <b>Аккаунт Binodex подключён!</b>`,
  blocked: telegramHtml`🔒 Доступ ограничен. Если это ошибка, напиши в поддержку: /support`,
  accountTaken: telegramHtml`❌ Этот аккаунт Binodex уже подключён к другому пользователю Telegram. Если это ошибка, напиши в поддержку: /support`,
} as const satisfies Record<string, TelegramHtml>;

export const LINK_LABELS = {
  confirmButton: (email: string | null) =>
    email === null ? '✅ Подтвердить привязку' : `✅ Подтвердить: ${email}`,
} as const satisfies Record<string, (email: string | null) => string>;
