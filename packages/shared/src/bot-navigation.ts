// The client bot's navigation that more than one sender draws: the bot's own screens and the
// backend's pushes to the user (#350, docs/bot-navigation.md). One source, so a button the backend
// sends is one the bot handles when it is pressed (precedent: link-confirmation.ts). Callback data
// is 1-64 bytes.

// The status card's button (#24), and since #350 the account card's: the signals screen (#320).
// Kept as `demo`, so a button on an old card leads there too.
export const DEMO_CALLBACK_DATA = 'demo';
// The welcome's main button: asks for the address. Buttons sent by earlier versions carry the same
// data, so they lead where the new ones do; `✏️ Изменить адрес` carries it too.
export const CONNECT_CALLBACK_DATA = 'connect';
// «🏠 В меню» (#350): the status card, as /menu.
export const MENU_CALLBACK_DATA = 'menu';
// «🔄 Повторить» under a command's failure (#350): the command again. /start and /menu repeat as
// «🏠 В меню»; the longest, `cmd:settings`, is 12 bytes.
export const RETRY_COMMANDS = ['account', 'settings'] as const;
export type RetryCommand = (typeof RETRY_COMMANDS)[number];
export const commandRetryCallbackData = (command: RetryCommand): string => `cmd:${command}`;
export const COMMAND_RETRY_PATTERN = new RegExp(`^cmd:(${RETRY_COMMANDS.join('|')})$`);

// Where /support leads (#120). A temporary personal account: #220 replaces it, and this is the one
// line to change.
export const SUPPORT_TELEGRAM_USERNAME = 'dimmelya';
export const supportUrl = (): string => `https://t.me/${SUPPORT_TELEGRAM_USERNAME}`;
