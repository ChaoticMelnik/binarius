import { InlineKeyboard } from 'grammy';
import type { InlineKeyboardButton } from 'grammy/types';
import { DEMO_CALLBACK_DATA, MENU_CALLBACK_DATA, supportUrl, TradeMode } from '@binarius/shared';
import {
  DEMO_SIGNALS_CALLBACK_DATA,
  demoAnalysisCallbackData,
  demoSignalsCallbackData,
  durationOf,
} from './demo';
import type { DemoDurationSec } from './demo-catalog';
import { inviteShareText, LABELS } from './texts';

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

// «⚙️ Режим» and the card's mode button (#121): the mode screen (trading-mode.ts). Only the bot
// sends it.
export const MODE_CALLBACK_DATA = 'mode';

// The status card's: the entry and the mode button in one row, then the invite (#115). The entry
// keeps DEMO_CALLBACK_DATA in both modes: the path is mode-agnostic up to the stake button (#121).
// The account card keeps demoKeyboard.
export const statusCardKeyboard = (mode: TradeMode): InlineKeyboard =>
  (mode === TradeMode.Real
    ? new InlineKeyboard()
        .text(LABELS.tradeButton, DEMO_CALLBACK_DATA)
        .text(LABELS.modeBackDemoButton, MODE_CALLBACK_DATA)
    : demoKeyboard().text(LABELS.modeButton, MODE_CALLBACK_DATA)
  )
    .row()
    .add(inviteButton());

// the invite row, then the menu row, under `keyboard`'s rows; an empty keyboard gets no empty
// first row
export const withInvite = (keyboard: InlineKeyboard): InlineKeyboard =>
  new InlineKeyboard([
    ...keyboard.inline_keyboard.filter((row) => row.length > 0),
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
// rows go right above the menu (the session result's invite, #115).
export function appendEndOfPath(
  keyboard: InlineKeyboard,
  assetId: number,
  durationSec: number,
  beforeMenu: readonly InlineKeyboardButton[][] = [],
): InlineKeyboard {
  const demoDuration = durationOf(String(durationSec));
  const rows = [
    ...(demoDuration === undefined
      ? []
      : [[button(LABELS.newAnalysisButton, demoAnalysisCallbackData(assetId, demoDuration))]]),
    [
      button(
        LABELS.toSignalsButton,
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
