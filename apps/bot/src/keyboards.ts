import { InlineKeyboard } from 'grammy';
import type { InlineKeyboardButton } from 'grammy/types';
import {
  BUY_CALLBACK_DATA,
  buyPackageCallbackData,
  DEMO_CALLBACK_DATA,
  DEMO_SIGNALS_CALLBACK_DATA,
  demoSignalsCallbackData,
  MENU_CALLBACK_DATA,
  STAR_PACKAGES,
  supportUrl,
  TradeMode,
  demoAnalysisCallbackData,
} from '@binarius/shared';
import { durationOf } from './demo';
import type { DemoDurationSec } from './demo-catalog';
import { buyPackageLabel, inviteShareText, LABELS } from './texts';

// The next steps the bot's screens share (#350, docs/bot-navigation.md). Each builds a new
// keyboard, so a caller can add rows to it.

export const menuKeyboard = (): InlineKeyboard =>
  new InlineKeyboard().text(LABELS.menuButton, MENU_CALLBACK_DATA);

// «🏠 В меню» in its own row under a screen's keyboard
export const withMenu = (keyboard: InlineKeyboard): InlineKeyboard =>
  keyboard.row().text(LABELS.menuButton, MENU_CALLBACK_DATA);

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
export const depositRows = (cashierUrl: string | undefined): InlineKeyboardButton[][] =>
  cashierUrl === undefined ? [] : [[depositButton(cashierUrl)]];

// The mode screen (#474, trading-mode.ts), opened from the status card as a new message
export const MODE_CALLBACK_DATA = 'mode';

// The status card's: the entry and the mode screen, then the invite (#115), the purchase (#117)
// and the deposit (#27). In real mode the entry reads «🚀 Торговать» and keeps DEMO_CALLBACK_DATA:
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
    [inviteButton()],
    [buyButton()],
    ...depositRows(cashierUrl),
  ]);

// The purchase, then the deposit (#27), above `keyboard`'s rows: the `insufficient_tokens`
// refusals (#117)
export const withBuy = (keyboard: InlineKeyboard, cashierUrl: string | undefined): InlineKeyboard =>
  new InlineKeyboard([
    [buyButton()],
    ...depositRows(cashierUrl),
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

// the deposit row (#27), the invite row, then the menu row, under `keyboard`'s rows; an empty
// keyboard gets no empty first row
export const withInvite = (
  keyboard: InlineKeyboard,
  cashierUrl: string | undefined,
): InlineKeyboard =>
  new InlineKeyboard([
    ...keyboard.inline_keyboard.filter((row) => row.length > 0),
    ...depositRows(cashierUrl),
    [inviteButton()],
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
// analysis of the same pair and duration while the demo still offers it, the signals of that
// duration (the duration screen when the demo no longer offers it, #382), the menu;
// each in its own row, under the rows a caller already put in `keyboard` (or none). `beforeMenu`
// rows go right above the menu (the session result's invite, #115). `otherPair`, a session that
// stopped for want of a signal (#509): no analysis of that pair, «🔀 Выбрать другую пару» in
// place of «📡 К сигналам» on the same data.
export function appendEndOfPath(
  keyboard: InlineKeyboard,
  assetId: number,
  durationSec: number,
  beforeMenu: readonly InlineKeyboardButton[][] = [],
  { otherPair = false }: { otherPair?: boolean } = {},
): InlineKeyboard {
  const demoDuration = durationOf(String(durationSec));
  const rows = [
    ...(demoDuration === undefined || otherPair
      ? []
      : [[button(LABELS.newAnalysisButton, demoAnalysisCallbackData(assetId, demoDuration))]]),
    [
      button(
        otherPair ? LABELS.otherPairButton : LABELS.toSignalsButton,
        demoDuration === undefined
          ? DEMO_SIGNALS_CALLBACK_DATA
          : demoSignalsCallbackData(demoDuration),
      ),
    ],
    ...beforeMenu,
    [button(LABELS.menuButton, MENU_CALLBACK_DATA)],
  ];
  return new InlineKeyboard([...keyboard.inline_keyboard.filter((row) => row.length > 0), ...rows]);
}

const button = (text: string, callback_data: string) => ({ text, callback_data });
