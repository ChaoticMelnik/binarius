// The client bot's navigation that more than one sender draws: the bot's own screens and the
// backend's pushes to the user (#350, docs/bot-navigation.md). One source, so a button the backend
// sends is one the bot handles when it is pressed (precedent: link-confirmation.ts). Callback data
// is 1-64 bytes.

import { BotLanguage } from './bot-language';

// «Сигналы сейчас» (#320): the list of the demo's one duration, 5 s (#685); every «🔄 Обновить»,
// «↩️ К списку», «📡 К сигналам» and «🔀 Выбрать другую пару» carries it. `demo:sig:<sec>` is the
// data of old buttons (#382 to #685), which lead to the same list. Here since #509, when the
// backend's session summary started to carry «🔀 Выбрать другую пару».
export const DEMO_SIGNALS_CALLBACK_DATA = 'demo:sig';

// «📊 Анализ» of a pair and duration (#482): the bot's analysis card, and since #484 the backend's
// analysis reminder, «📊 Новый анализ» of the same pair and duration. The bot's pattern takes the
// durations it offers. The longest, `demo:an:2147483647:5`, is 20 bytes.
export const demoAnalysisCallbackData = (assetId: number, durationSec: number): string =>
  `demo:an:${String(assetId)}:${String(durationSec)}`;

// The status card's button (#24), and since #350 the account card's: the signals screen (#320).
// Kept as `demo`, so a button on an old card leads there too.
export const DEMO_CALLBACK_DATA = 'demo';
// The welcome's main button: asks for the address. Buttons sent by earlier versions carry the same
// data, so they lead where the new ones do; `✏️ Изменить адрес` carries it too.
export const CONNECT_CALLBACK_DATA = 'connect';
// «🏠 В меню» (#350): the status card, as /menu.
export const MENU_CALLBACK_DATA = 'menu';
// «🌐 Язык / Language» on the status card (#508): the language screen, a read; `lang:<language>`
// on that screen saves the choice, a write. Only the bot draws them, kept beside «🏠 В меню».
export const LANGUAGE_CALLBACK_DATA = 'lang';
export const languageSetCallbackData = (language: BotLanguage): string =>
  `${LANGUAGE_CALLBACK_DATA}:${language}`;
export const LANGUAGE_SET_PATTERN = new RegExp(
  `^${LANGUAGE_CALLBACK_DATA}:(${Object.values(BotLanguage).join('|')})$`,
);
// «🔄 Повторить» under a command's failure (#350): the command again. /start and /menu repeat as
// «🏠 В меню»; the longest, `cmd:settings`, is 12 bytes. /invite's read creates the user's code
// on first use, idempotently, so repeating it is a read (#115).
export const RETRY_COMMANDS = ['account', 'settings', 'invite'] as const;
export type RetryCommand = (typeof RETRY_COMMANDS)[number];
export const commandRetryCallbackData = (command: RetryCommand): string => `cmd:${command}`;
export const COMMAND_RETRY_PATTERN = new RegExp(`^cmd:(${RETRY_COMMANDS.join('|')})$`);

// «⭐ Купить токены» (#117, docs/stars.md): the package screen. Under the status card, under the
// `insufficient_tokens` refusals and #123's nudges, which the backend sends; a package's button is
// `buy:<code>`, a read that asks the backend for the invoice. The longest, `buy:p150`, is 8 bytes.
export const BUY_CALLBACK_DATA = 'buy';
export const buyPackageCallbackData = (code: string): string => `${BUY_CALLBACK_DATA}:${code}`;
export const BUY_PACKAGE_PATTERN = /^buy:([a-z0-9]{1,16})$/;

// /paysupport (#118, docs/stars.md → /paysupport): `ps:l` is its list, a read; `ps:r:<payment id>`
// asks for a refund, a write that a «🔄 Повторить» must never carry. The id carries no authority:
// the backend matches it to the presser's Telegram id. `ps:r:` and a uuid is 41 bytes.
export const PAYSUPPORT_LIST_CALLBACK = 'ps:l';
export const paysupportRefundCallbackData = (paymentId: string): string => `ps:r:${paymentId}`;
export const PAYSUPPORT_REFUND_PATTERN = /^ps:r:([0-9a-f-]{36})$/;

// Where /support leads (#120). A temporary personal account: #220 replaces it, and this is the one
// line to change.
export const SUPPORT_TELEGRAM_USERNAME = 'dimmelya';
export const supportUrl = (): string => `https://t.me/${SUPPORT_TELEGRAM_USERNAME}`;

// The cashier page (#11, docs/deposit.md): apps/web serves it, the bot's «💳 Пополнить» (#27)
// opens it as a Mini App. Telegram takes a `web_app` button's URL over https only, so on any other
// origin there is no URL and no button. `origin` is already normalised by parseOriginEnv.
export const CASHIER_PAGE_PATH = '/cashier';
export const cashierUrlOf = (origin: string): string | undefined =>
  new URL(origin).protocol === 'https:' ? `${origin}${CASHIER_PAGE_PATH}` : undefined;

// «⏹ Остановить сессию» (#122; since #536 under the waiting message the backend sends, docs/
// bot-session.md → The waiting message). `:w` says it was pressed under the waiting message, so
// the bot hands that message to the stop and draws its reply in place of it (#587); the data
// without it is the old status message's button.
// The id carries no authority: the backend stops only the presser's own session. 49 / 51 bytes.
const SESSION_UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
export const sessionStopCallbackData = (
  sessionId: string,
  { waiting = false }: { waiting?: boolean } = {},
): string => `session:stop:${sessionId}${waiting ? ':w' : ''}`;
// group 1 the session's id, group 2 `w` or undefined
export const SESSION_STOP_PATTERN = new RegExp(`^session:stop:${SESSION_UUID}(?::(w))?$`);
