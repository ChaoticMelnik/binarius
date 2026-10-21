import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ButtonRole,
  callbackButton,
  DEMO_CALLBACK_DATA,
  DEMO_SIGNALS_CALLBACK_DATA,
  demoAnalysisCallbackData,
  MENU_CALLBACK_DATA,
  TradeMode,
  type BotKeyboard,
} from '@binarius/shared';
import {
  appendEndOfPath,
  backToAnalysisButton,
  backToAnalysisKeyboard,
  buyPackagesKeyboard,
  depositButton,
  inviteButton,
  inviteKeyboard,
  menuButton,
  menuKeyboard,
  MODE_CALLBACK_DATA,
  retryKeyboard,
  statusCardKeyboard,
  supportKeyboard,
  waitingStopKeyboard,
  withBuy,
  withInvite,
  withMenu,
} from './keyboards';
import { LABELS } from './texts';

const SRC = fileURLToPath(new URL('.', import.meta.url));

// the bot's own code, comment lines dropped: a comment may name what it does not build; the
// tests' helpers (testing.ts reads a web_app button back) are not the bot's code
const sources = readdirSync(SRC, { recursive: true, encoding: 'utf8' })
  .filter(
    (file) =>
      file.endsWith('.ts') &&
      !file.endsWith('.test.ts') &&
      !file.endsWith('.typecheck.ts') &&
      file !== 'testing.ts',
  )
  .map((file) => ({
    file,
    code: readFileSync(`${SRC}/${file}`, 'utf8').replace(/^\s*\/\/.*$/gm, ''),
  }));
const filesWith = (pattern: RegExp) =>
  sources.filter(({ code }) => pattern.test(code)).map(({ file }) => file);

// #27: every entry leads to one cashier, so one place builds the button and one reads the URL
describe('«💳 Пополнить» (#27)', () => {
  it('is built in keyboards.ts only', () => {
    expect(sources.length).toBeGreaterThan(20);
    expect(filesWith(/web_app|webAppButton/)).toEqual(['keyboards.ts']);
    expect(filesWith(/LABELS\.depositButton/)).toEqual(['keyboards.ts']);
  });

  it('takes its URL from cashierUrlOf in index.ts only', () => {
    expect(filesWith(/cashierUrlOf|CASHIER_PAGE_PATH/)).toEqual(['index.ts']);
  });
});

// #475: no keyboard of the bot is built outside keyboardOf, so every button has a role
describe('keyboards by role (#475)', () => {
  it('no grammY InlineKeyboard in the bot', () => {
    expect(filesWith(/\bInlineKeyboard\b|inline_keyboard\s*:/)).toEqual([]);
  });
});

// #475 (docs/bot-navigation.md → Roles, colours and rows): each builder's buttons by row, with the
// role and the colour; a forward button alone in its row, the rest two or three a row
describe('the rows and colours of the shared keyboards (#475)', () => {
  const CASHIER = 'https://cashier.example/';
  const rows = (keyboard: BotKeyboard) =>
    keyboard.inline_keyboard.map((row, r) =>
      row.map((button, b) => [button.text, keyboard.rows[r]?.[b]?.role, button.style ?? null]),
    );
  const F = ButtonRole.Forward;
  const S = ButtonRole.Secondary;
  const N = ButtonRole.Nav;
  const MENU = [LABELS.menuButton, N, null];
  const INVITE = [LABELS.inviteButton, N, null];
  const BUY = [LABELS.buyButton, S, 'primary'];
  const DEPOSIT = [LABELS.depositButton, F, 'success'];
  const LANGUAGE = [LABELS.languageButton, N, null];
  const ANALYSIS = [LABELS.newAnalysisButton, S, 'primary'];
  const SIGNALS = [LABELS.toSignalsButton, N, null];
  const BACK = callbackButton(N, '↩️', 'back');
  const back = [LABELS.stakeBackAnalysisButton, N, null];

  it('R1: the status card: the entry alone, two pairs, the deposit alone', () => {
    expect(rows(statusCardKeyboard(TradeMode.Demo, CASHIER))).toEqual([
      [[LABELS.demoButton, F, 'success']],
      [[LABELS.modeButton, N, null], INVITE],
      [BUY, LANGUAGE],
      [DEPOSIT],
    ]);
    expect(rows(statusCardKeyboard(TradeMode.Real, CASHIER))).toEqual([
      [[LABELS.tradeButton, F, 'success']],
      [[LABELS.modeBackDemoButton, S, 'primary'], INVITE],
      [BUY, LANGUAGE],
      [DEPOSIT],
    ]);
    expect(rows(statusCardKeyboard(TradeMode.Demo, undefined)).at(-1)).toEqual([BUY, LANGUAGE]);
  });

  it('R2: the entry data stays the same in both modes', () => {
    for (const mode of Object.values(TradeMode)) {
      const wire = statusCardKeyboard(mode, CASHIER).inline_keyboard;
      expect(wire[0]?.[0]).toMatchObject({ callback_data: DEMO_CALLBACK_DATA });
      expect(wire[1]?.[0]).toMatchObject({ callback_data: MODE_CALLBACK_DATA });
    }
  });

  it('R3: withBuy: the deposit alone, then the purchase in one row with the given actions', () => {
    const actions = [backToAnalysisButton(101, 5), menuButton()];
    expect(rows(withBuy(actions, CASHIER))).toEqual([[DEPOSIT], [BUY, back, MENU]]);
    expect(rows(withBuy(actions, undefined))).toEqual([[BUY, back, MENU]]);
  });

  it('R4: withInvite: the deposit alone, the invite and the menu in one row', () => {
    expect(rows(withInvite([], CASHIER))).toEqual([[DEPOSIT], [INVITE, MENU]]);
    expect(rows(withInvite([], undefined))).toEqual([[INVITE, MENU]]);
  });

  // #685: one duration, so the end of any path is the analysis at 5 s and `demo:sig`
  it('R5: appendEndOfPath joins the last row of actions, the menu with them', () => {
    expect(rows(appendEndOfPath([[BACK]], 101))).toEqual([
      [['↩️', N, null], ANALYSIS],
      [SIGNALS, MENU],
    ]);
    expect(rows(appendEndOfPath([], 101))).toEqual([[ANALYSIS, SIGNALS, MENU]]);
    expect(
      appendEndOfPath([], 101).inline_keyboard[0]?.map(
        (b) => 'callback_data' in b && b.callback_data,
      ),
    ).toEqual([demoAnalysisCallbackData(101, 5), DEMO_SIGNALS_CALLBACK_DATA, MENU_CALLBACK_DATA]);
  });

  it('R6: appendEndOfPath with beforeMenu: those buttons and the menu in a group of their own', () => {
    expect(rows(appendEndOfPath([], 101, [depositButton(CASHIER), inviteButton()]))).toEqual([
      [ANALYSIS, SIGNALS],
      [DEPOSIT],
      [INVITE, MENU],
    ]);
  });

  // a session stopped for want of a signal (#509): another pair, a step forward on its own row
  it('R7: appendEndOfPath otherPair: «🔀 Выбрать другую пару» alone and green', () => {
    expect(rows(appendEndOfPath([], 101, [], { otherPair: true }))).toEqual([
      [[LABELS.otherPairButton, F, 'success']],
      [MENU],
    ]);
  });

  it('R8: /buy: a package a row, green, then the menu', () => {
    const keyboard = rows(buyPackagesKeyboard());
    expect(keyboard.at(-1)).toEqual([MENU]);
    expect(keyboard.slice(0, -1).every((row) => row.length === 1 && row[0]?.[1] === F)).toBe(true);
  });

  it('R9: /invite: the share link alone and green, then the menu', () => {
    expect(
      rows(inviteKeyboard('https://t.me/bot?start=r')).map((row) => row.map((b) => b[1])),
    ).toEqual([[F], [N]]);
  });

  it('R10: the repeat is blue beside the menu; the way back to the analysis beside it', () => {
    expect(rows(retryKeyboard('demo:sig'))).toEqual([
      [[LABELS.demoRetryButton, S, 'primary'], MENU],
    ]);
    expect(rows(backToAnalysisKeyboard(101, 5))).toEqual([[back, MENU]]);
  });

  it('R11: the waiting message’s «⏹» is red', () => {
    expect(rows(waitingStopKeyboard('00000000-0000-4000-8000-000000000000'))).toEqual([
      [[LABELS.sessionStopButton, ButtonRole.Danger, 'danger']],
    ]);
  });

  it('R12: support and the menu have no colour', () => {
    expect(rows(supportKeyboard())).toEqual([[[LABELS.supportButton, N, null]]]);
    expect(rows(menuKeyboard())).toEqual([[MENU]]);
    expect(rows(withMenu({ buttons: [BACK], perRow: 2 }))).toEqual([[['↩️', N, null]], [MENU]]);
  });
});
