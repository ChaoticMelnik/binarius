import { InlineKeyboard } from 'grammy';
import { DEMO_CALLBACK_DATA, MENU_CALLBACK_DATA, supportUrl } from '@binarius/shared';
import { DEMO_SIGNALS_CALLBACK_DATA, demoAnalysisCallbackData, durationOf } from './demo';
import type { DemoDurationSec } from './demo-catalog';
import { LABELS } from './texts';

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
// analysis of the same pair and duration while the demo still offers it, the signals, the menu;
// each in its own row, under the rows a caller already put in `keyboard` (or none).
export function appendEndOfPath(
  keyboard: InlineKeyboard,
  assetId: number,
  durationSec: number,
): InlineKeyboard {
  const demoDuration = durationOf(String(durationSec));
  const rows = [
    ...(demoDuration === undefined
      ? []
      : [[button(LABELS.newAnalysisButton, demoAnalysisCallbackData(assetId, demoDuration))]]),
    [button(LABELS.toSignalsButton, DEMO_SIGNALS_CALLBACK_DATA)],
    [button(LABELS.menuButton, MENU_CALLBACK_DATA)],
  ];
  return new InlineKeyboard([...keyboard.inline_keyboard.filter((row) => row.length > 0), ...rows]);
}

const button = (text: string, callback_data: string) => ({ text, callback_data });
