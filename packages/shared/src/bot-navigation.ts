// The client bot's navigation that more than one sender draws: the bot's own screens and the
// backend's pushes to the user (#350, docs/bot-navigation.md). One source, so a button the backend
// sends is one the bot handles when it is pressed (precedent: link-confirmation.ts). Callback data
// is 1-64 bytes.

import { SIGNAL_CHART_INTERVAL_MS, SIGNAL_SCAN_INTERVALS } from './signal';

// «Сигналы сейчас» (#320): `demo:sig` is the duration screen (#382), every old «🔄 Обновить»,
// «↩️ К списку» and «📡 К сигналам» lands there; `demo:sig:<sec>` the list of one duration. Here
// since #509, when the backend's session summary started to carry «🔀 Выбрать другую пару».
export const DEMO_SIGNALS_CALLBACK_DATA = 'demo:sig';
export const demoSignalsCallbackData = (durationSec: number): string =>
  `${DEMO_SIGNALS_CALLBACK_DATA}:${String(durationSec)}`;
// the list of a duration the scanner lists, the duration screen for any other
export const signalsCallbackDataFor = (durationSec: number): string =>
  SIGNAL_SCAN_INTERVALS.some(
    (interval) => SIGNAL_CHART_INTERVAL_MS[interval] === durationSec * 1000,
  )
    ? demoSignalsCallbackData(durationSec)
    : DEMO_SIGNALS_CALLBACK_DATA;

// The status card's button (#24), and since #350 the account card's: the signals screen (#320).
// Kept as `demo`, so a button on an old card leads there too.
export const DEMO_CALLBACK_DATA = 'demo';
// The welcome's main button: asks for the address. Buttons sent by earlier versions carry the same
// data, so they lead where the new ones do; `✏️ Изменить адрес` carries it too.
export const CONNECT_CALLBACK_DATA = 'connect';
// «🏠 В меню» (#350): the status card, as /menu.
export const MENU_CALLBACK_DATA = 'menu';
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
