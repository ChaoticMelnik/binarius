import {
  BUY_CALLBACK_DATA,
  buyPackageCallbackData,
  ButtonRole,
  callbackButton,
  DEMO_CALLBACK_DATA,
  DEMO_SIGNALS_CALLBACK_DATA,
  demoAnalysisCallbackData,
  keyboardOf,
  MENU_CALLBACK_DATA,
  sessionStopCallbackData,
  STAR_PACKAGES,
  supportUrl,
  TradeMode,
  urlButton,
  webAppButton,
  type BotButton,
  type BotKeyboard,
  type ButtonGroup,
} from '@binarius/shared';
import { DEMO_DURATION_SEC, type DemoDurationSec } from './demo-catalog';
import { buyPackageLabel, inviteShareText, LABELS } from './texts';

// The next steps the bot's screens share (#350, docs/bot-navigation.md), each button with its
// role (#475, docs/bot-navigation.md → Roles, colours and rows): the role gives the colour and
// the row, keyboardOf lays the groups out.

// `buttons` join the screen's last group of actions, so they share its rows; under a list, or with
// no group, they go as a group of their own
export function joinLast(groups: readonly ButtonGroup[], buttons: readonly BotButton[]) {
  const last = groups.at(-1);
  if (last === undefined || 'perRow' in last) return [...groups, buttons];
  return [...groups.slice(0, -1), [...last, ...buttons]];
}

export const menuButton = (): BotButton =>
  callbackButton(ButtonRole.Nav, LABELS.menuButton, MENU_CALLBACK_DATA);

export const menuKeyboard = (): BotKeyboard => keyboardOf([menuButton()]);

// «🏠 В меню» in the screen's last row of actions
export const withMenu = (...groups: readonly ButtonGroup[]): BotKeyboard =>
  keyboardOf(...joinLast(groups, [menuButton()]));

// The waiting message's «⏹» drawn again in place of the pressed one after a stop whose outcome is
// unknown (#587): pressed again, it stops the session or reads how it ended (409). Its next step is
// the stop itself, so no menu under it.
export const waitingStopKeyboard = (sessionId: string): BotKeyboard =>
  keyboardOf([
    callbackButton(
      ButtonRole.Danger,
      LABELS.sessionStopButton,
      sessionStopCallbackData(sessionId, { waiting: true }),
    ),
  ]);

// An H1 session's «⏹» on the bot's own session message (#745, docs/bot-session.md -> The session
// message): an H1 session has no waiting message (#722), so this is its one button. No suffix: the
// stop handler's path of a status message's button, the reply drawn in place.
export const h1SessionStopKeyboard = (sessionId: string): BotKeyboard =>
  keyboardOf([
    callbackButton(ButtonRole.Danger, LABELS.sessionStopButton, sessionStopCallbackData(sessionId)),
  ]);

export const demoButton = (): BotButton =>
  callbackButton(ButtonRole.Forward, LABELS.demoButton, DEMO_CALLBACK_DATA);

// the status card's entry, and the account card's since #350
export const demoKeyboard = (): BotKeyboard => keyboardOf([demoButton()]);

// «👥 Позвать» (#115, docs/referrals.md): the /invite screen. Only the bot sends it.
export const INVITE_CALLBACK_DATA = 'invite';
export const inviteButton = (): BotButton =>
  callbackButton(ButtonRole.Nav, LABELS.inviteButton, INVITE_CALLBACK_DATA);

// «⭐ Купить» (#117, docs/stars.md): the package screen
export const buyButton = (): BotButton =>
  callbackButton(ButtonRole.Secondary, LABELS.buyButton, BUY_CALLBACK_DATA);

// «💳 Пополнить» (#27, docs/deposit.md): the cashier as a Mini App, so the page gets initData.
// The only builders of the button: `cashierUrl` is cashierUrlOf's, and without one (an origin that
// is not https) there is no button at all.
export const depositButton = (cashierUrl: string): BotButton =>
  webAppButton(ButtonRole.Forward, LABELS.depositButton, cashierUrl);
export const depositButtons = (cashierUrl: string | undefined): BotButton[] =>
  cashierUrl === undefined ? [] : [depositButton(cashierUrl)];

// The status card's: the entry on its own row, the invite (#115) and the purchase (#117) in one
// row, then the deposit (#27) on its own (rows: docs/bot-navigation.md → Roles, colours and rows);
// the language is the /language command since #708, the mode screen is under /settings since #686.
// In real mode the entry reads «🚀 Торговать» and keeps DEMO_CALLBACK_DATA: the path is the same up
// to the stake button (#121). The account card keeps demoKeyboard.
export const statusCardKeyboard = (mode: TradeMode, cashierUrl: string | undefined): BotKeyboard =>
  keyboardOf([
    mode === TradeMode.Real
      ? callbackButton(ButtonRole.Forward, LABELS.tradeButton, DEMO_CALLBACK_DATA)
      : demoButton(),
    inviteButton(),
    buyButton(),
    ...depositButtons(cashierUrl),
  ]);

// The deposit (#27) on its own row, then the purchase in one row with `actions`: the
// `insufficient_tokens` refusals (#117)
export const withBuy = (actions: readonly BotButton[], cashierUrl: string | undefined) =>
  keyboardOf([...depositButtons(cashierUrl), buyButton(), ...actions]);

// /buy's screen: a row per package, then the menu
export const buyPackagesKeyboard = (): BotKeyboard =>
  withMenu(
    STAR_PACKAGES.map((pack) =>
      callbackButton(ButtonRole.Forward, buyPackageLabel(pack), buyPackageCallbackData(pack.code)),
    ),
  );

// under `groups`, the deposit (#27) on its own row, then the invite and the menu in one
export const withInvite = (
  groups: readonly ButtonGroup[],
  cashierUrl: string | undefined,
): BotKeyboard =>
  keyboardOf(...groups, [...depositButtons(cashierUrl), inviteButton(), menuButton()]);

// /invite: Telegram's share picker with the link and the catalog's text, then the menu
export const inviteKeyboard = (referralLink: string): BotKeyboard =>
  withMenu([
    urlButton(
      ButtonRole.Forward,
      LABELS.inviteShareButton,
      `https://t.me/share/url?url=${encodeURIComponent(referralLink)}&text=${encodeURIComponent(inviteShareText())}`,
    ),
  ]);

export const supportButton = (): BotButton =>
  urlButton(ButtonRole.Nav, LABELS.supportButton, supportUrl());

// a blocked user has nowhere to go in the bot but to a person
export const supportKeyboard = (): BotKeyboard => keyboardOf([supportButton()]);

// A read pressed again with the same data. Only for a read: a write repeated with its data would
// be a second write (docs/bot-navigation.md -> The repeat).
export const retryButton = (data: string): BotButton =>
  callbackButton(ButtonRole.Secondary, LABELS.demoRetryButton, data);

// the repeat, then the menu
export const retryKeyboard = (data: string): BotKeyboard => withMenu([retryButton(data)]);

// After a write that failed or whose outcome is unknown (a trade, a session): back to the analysis
// it was pressed from, never the write again.
export const backToAnalysisButton = (assetId: number, durationSec: DemoDurationSec): BotButton =>
  callbackButton(
    ButtonRole.Nav,
    LABELS.stakeBackAnalysisButton,
    demoAnalysisCallbackData(assetId, durationSec),
  );

export const backToAnalysisKeyboard = (assetId: number, durationSec: DemoDurationSec) =>
  withMenu([backToAnalysisButton(assetId, durationSec)]);

// The end of a path: a trade the tracker no longer follows, a stopped session (#350). The
// analysis of the same pair at the demo's one duration and the signals list (#685: the duration
// is one, so a trade or a session of an older one ends the same way) join the last row of actions
// in `groups`, the menu with them. `beforeMenu` buttons go in a group of their own right above
// and with the menu (the session result's deposit and invite, #115). `otherPair`, a session that
// stopped for want of a signal (#509): no analysis of that pair, «🔀 Выбрать другую пару» in place
// of «📡 Сигналы» on the same data, a step forward.
export function appendEndOfPath(
  groups: readonly ButtonGroup[],
  assetId: number,
  beforeMenu: readonly BotButton[] = [],
  { otherPair = false }: { otherPair?: boolean } = {},
): BotKeyboard {
  const end = otherPair
    ? [callbackButton(ButtonRole.Forward, LABELS.otherPairButton, DEMO_SIGNALS_CALLBACK_DATA)]
    : [
        callbackButton(
          ButtonRole.Secondary,
          LABELS.newAnalysisButton,
          demoAnalysisCallbackData(assetId, DEMO_DURATION_SEC),
        ),
        callbackButton(ButtonRole.Nav, LABELS.toSignalsButton, DEMO_SIGNALS_CALLBACK_DATA),
      ];
  if (beforeMenu.length === 0) return keyboardOf(...joinLast(groups, [...end, menuButton()]));
  return keyboardOf(...joinLast(groups, end), [...beforeMenu, menuButton()]);
}
