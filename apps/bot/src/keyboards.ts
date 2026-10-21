import { InlineKeyboard } from 'grammy';
import type { InlineKeyboardButton } from 'grammy/types';
import {
  BUY_CALLBACK_DATA,
  buyPackageCallbackData,
  DEMO_CALLBACK_DATA,
  DEMO_SIGNALS_CALLBACK_DATA,
  LANGUAGE_CALLBACK_DATA,
  MENU_CALLBACK_DATA,
  STAR_PACKAGES,
  sessionStopCallbackData,
  supportUrl,
  TradeMode,
  demoAnalysisCallbackData,
} from '@binarius/shared';
import { DEMO_DURATION_SEC, type DemoDurationSec } from './demo-catalog';
import { buyPackageLabel, inviteShareText, LABELS } from './texts';

// The next steps the bot's screens share (#350, docs/bot-navigation.md). Each builds a new
// keyboard, so a caller can add rows to it.

export const menuKeyboard = (): InlineKeyboard =>
  new InlineKeyboard().text(LABELS.menuButton, MENU_CALLBACK_DATA);

// «🏠 В меню» in its own row under a screen's keyboard
export const withMenu = (keyboard: InlineKeyboard): InlineKeyboard =>
  keyboard.row().text(LABELS.menuButton, MENU_CALLBACK_DATA);

// The waiting message's «⏹» drawn again in place of the pressed one after a stop whose outcome is
// unknown (#587): pressed again, it stops the session or reads how it ended (409). Its next step is
// the stop itself, so no menu under it.
export const waitingStopKeyboard = (sessionId: string): InlineKeyboard =>
  new InlineKeyboard().text(
    LABELS.sessionStopButton,
    sessionStopCallbackData(sessionId, { waiting: true }),
  );

// the status card's entry, and the account card's since #350
export const demoKeyboard = (): InlineKeyboard =>
  new InlineKeyboard().text(LABELS.demoButton, DEMO_CALLBACK_DATA);

// «👥 Пригласить друга» (#115, docs/referrals.md): the /invite screen. Only the bot sends it.
export const INVITE_CALLBACK_DATA = 'invite';
export const inviteButton = (): InlineKeyboardButton.CallbackButton => ({
  text: LABELS.inviteButton,
  callback_data: INVITE_CALLBACK_DATA,
});

// «⭐ Купить токены» (#117, docs/stars.md): the package screen
export const buyButton = (): InlineKeyboardButton.CallbackButton => ({
  text: LABELS.buyButton,
  callback_data: BUY_CALLBACK_DATA,
});

// «💳 Пополнить» (#27, docs/deposit.md): the cashier as a Mini App, so the page gets initData.
// The only builders of the button: `cashierUrl` is cashierUrlOf's, and without one (an origin that
// is not https) there is no row at all.
export const depositButton = (cashierUrl: string): InlineKeyboardButton.WebAppButton => ({
  text: LABELS.depositButton,
  web_app: { url: cashierUrl },
});
export const depositButtons = (cashierUrl: string | undefined): InlineKeyboardButton[] =>
  cashierUrl === undefined ? [] : [depositButton(cashierUrl)];

// «🌐 Язык / Language» (#508, language-screen.ts): the language screen as a new message. The label
// is in both languages at once: a user who cannot read the bot's language still finds it.
export const languageButton = (): InlineKeyboardButton.CallbackButton => ({
  text: LABELS.languageButton,
  callback_data: LANGUAGE_CALLBACK_DATA,
});

// The mode screen (#474, trading-mode.ts), opened from the status card as a new message
export const MODE_CALLBACK_DATA = 'mode';

// The status card's: the entry and the mode screen, then the invite (#115) and the purchase (#117)
// in one row, then the deposit (#27) and the language (#508) (rows: docs/bot-navigation.md → The
// width). In real mode the entry reads «🚀 Торговать» and keeps DEMO_CALLBACK_DATA:
// the path is the same up to the stake button (#121); the mode button reads «🎮 Вернуться в демо»
// there and opens the screen too, it never switches by itself (#474). The account card keeps
// demoKeyboard.
export const statusCardKeyboard = (
  mode: TradeMode,
  cashierUrl: string | undefined,
): InlineKeyboard =>
  new InlineKeyboard([
    mode === TradeMode.Real
      ? [
          button(LABELS.tradeButton, DEMO_CALLBACK_DATA),
          button(LABELS.modeBackDemoButton, MODE_CALLBACK_DATA),
        ]
      : [
          button(LABELS.demoButton, DEMO_CALLBACK_DATA),
          button(LABELS.modeButton, MODE_CALLBACK_DATA),
        ],
    [inviteButton(), buyButton()],
    [...depositButtons(cashierUrl), languageButton()],
  ]);

// The purchase and the deposit (#27) in one row above `keyboard`'s rows: the `insufficient_tokens`
// refusals (#117)
export const withBuy = (keyboard: InlineKeyboard, cashierUrl: string | undefined): InlineKeyboard =>
  new InlineKeyboard([
    [buyButton(), ...depositButtons(cashierUrl)],
    ...keyboard.inline_keyboard.filter((row) => row.length > 0),
  ]);

// /buy's screen: a row per package, then the menu
export const buyPackagesKeyboard = (): InlineKeyboard => {
  const keyboard = new InlineKeyboard();
  for (const pack of STAR_PACKAGES) {
    keyboard.text(buyPackageLabel(pack), buyPackageCallbackData(pack.code)).row();
  }
  return keyboard.text(LABELS.menuButton, MENU_CALLBACK_DATA);
};

// the deposit (#27) and the invite in one row, then the menu row, under `keyboard`'s rows; an
// empty keyboard gets no empty first row
export const withInvite = (
  keyboard: InlineKeyboard,
  cashierUrl: string | undefined,
): InlineKeyboard =>
  new InlineKeyboard([
    ...keyboard.inline_keyboard.filter((row) => row.length > 0),
    [...depositButtons(cashierUrl), inviteButton()],
    [button(LABELS.menuButton, MENU_CALLBACK_DATA)],
  ]);

// /invite: Telegram's share picker with the link and the catalog's text, then the menu
export const inviteKeyboard = (referralLink: string): InlineKeyboard =>
  withMenu(
    new InlineKeyboard().url(
      LABELS.inviteShareButton,
      `https://t.me/share/url?url=${encodeURIComponent(referralLink)}&text=${encodeURIComponent(inviteShareText())}`,
    ),
  );

// a blocked user has nowhere to go in the bot but to a person
export const supportKeyboard = (): InlineKeyboard =>
  new InlineKeyboard().url(LABELS.supportButton, supportUrl());

// A read pressed again with the same data, then the menu. Only for a read: a write repeated with
// its data would be a second write (docs/bot-navigation.md -> The repeat).
export const retryKeyboard = (data: string): InlineKeyboard =>
  withMenu(new InlineKeyboard().text(LABELS.demoRetryButton, data));

// After a write that failed or whose outcome is unknown (a trade, a session): back to the analysis
// it was pressed from, never the write again.
export const backToAnalysisKeyboard = (assetId: number, durationSec: DemoDurationSec) =>
  withMenu(
    new InlineKeyboard().text(
      LABELS.stakeBackAnalysisButton,
      demoAnalysisCallbackData(assetId, durationSec),
    ),
  );

// The end of a path: a trade the tracker no longer follows, a stopped session (#350). The
// analysis of the same pair at the demo's one duration and the signals list in one row (#685: the
// duration is one, so a trade or a session of an older one ends the same way), the menu in its own,
// under the rows a caller already put in `keyboard` (or none). `beforeMenu` rows go right above the
// menu (the session result's invite, #115). `otherPair`, a session that stopped for want of a
// signal (#509): no analysis of that pair, «🔀 Выбрать другую пару» in place of «📡 К сигналам» on
// the same data.
export function appendEndOfPath(
  keyboard: InlineKeyboard,
  assetId: number,
  beforeMenu: readonly InlineKeyboardButton[][] = [],
  { otherPair = false }: { otherPair?: boolean } = {},
): InlineKeyboard {
  const rows = [
    [
      ...(otherPair
        ? []
        : [button(LABELS.newAnalysisButton, demoAnalysisCallbackData(assetId, DEMO_DURATION_SEC))]),
      button(
        otherPair ? LABELS.otherPairButton : LABELS.toSignalsButton,
        DEMO_SIGNALS_CALLBACK_DATA,
      ),
    ],
    ...beforeMenu,
    [button(LABELS.menuButton, MENU_CALLBACK_DATA)],
  ];
  return new InlineKeyboard([...keyboard.inline_keyboard.filter((row) => row.length > 0), ...rows]);
}

const button = (text: string, callback_data: string) => ({ text, callback_data });
