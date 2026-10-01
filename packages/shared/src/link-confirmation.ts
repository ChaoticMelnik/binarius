// What a Telegram user sees about a pending broker-account link, whoever sends it: the bot on
// /start (#10) and the backend's push after the OAuth callback (#128). One source, so the button
// the backend sends is one the bot recognises when it is pressed.
//
// Sent without parse_mode: the confirm button carries the email the broker reported, which is
// someone else's data, and plain text can neither be broken by a stray underscore in it nor
// turned into markup by it.

// Bot API sendMessage: "1-4096 characters after entities parsing"
export const TELEGRAM_MESSAGE_LIMIT = 4096;

// Callback data is 1-64 bytes; 'confirm:' + a 36-character uuid is 44.
export const CONFIRM_CALLBACK_PREFIX = 'confirm:';
export const confirmCallbackData = (accountId: string): string =>
  `${CONFIRM_CALLBACK_PREFIX}${accountId}`;
export const CONFIRM_CALLBACK_PATTERN = new RegExp(`^${CONFIRM_CALLBACK_PREFIX}([0-9a-f-]{36})$`);

export const LINK_TEXTS = {
  confirmPrompt: 'Найдена новая привязка аккаунта Binodex. Если вход выполняли вы — подтвердите.',
  confirmButton: (email: string | null) =>
    email === null ? 'Подтвердить привязку' : `Подтвердить: ${email}`,
  // also the bot's recheck after an unknown outcome: it knows the account is active, not what
  // was paid
  linkedActive: 'Аккаунт Binodex подключён.',
  blocked: 'Доступ ограничен. Если это ошибка, напишите в поддержку.',
  accountTaken:
    'Этот аккаунт Binodex уже подключён к другому пользователю Telegram. Если это ошибка, напишите в поддержку.',
} as const;
