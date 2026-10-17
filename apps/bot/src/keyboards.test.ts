import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { InlineKeyboard } from 'grammy';
import { describe, expect, it } from 'vitest';
import {
  BUY_CALLBACK_DATA,
  DEMO_CALLBACK_DATA,
  DEMO_SIGNALS_CALLBACK_DATA,
  demoAnalysisCallbackData,
  demoSignalsCallbackData,
  MENU_CALLBACK_DATA,
  TradeMode,
} from '@binarius/shared';
import {
  appendEndOfPath,
  INVITE_CALLBACK_DATA,
  MODE_CALLBACK_DATA,
  statusCardKeyboard,
  withBuy,
  withInvite,
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
    expect(filesWith(/web_app/)).toEqual(['keyboards.ts']);
    expect(filesWith(/LABELS\.depositButton/)).toEqual(['keyboards.ts']);
  });

  it('takes its URL from cashierUrlOf in index.ts only', () => {
    expect(filesWith(/cashierUrlOf|CASHIER_PAGE_PATH/)).toEqual(['index.ts']);
  });
});

// #506: two buttons whose labels are short share a row (docs/bot-navigation.md → The width); the
// menu keeps a row of its own, last; no row is ever empty
describe('the rows (#506)', () => {
  const CASHIER = 'https://cashier.example/';
  const button = (text: string, callback_data: string) => ({ text, callback_data });
  const DEPOSIT = { text: LABELS.depositButton, web_app: { url: CASHIER } };
  const INVITE = button(LABELS.inviteButton, INVITE_CALLBACK_DATA);
  const BUY = button(LABELS.buyButton, BUY_CALLBACK_DATA);
  const MENU = button(LABELS.menuButton, MENU_CALLBACK_DATA);
  const ANALYSIS = button(LABELS.newAnalysisButton, demoAnalysisCallbackData(101, 15));
  const SIGNALS = button(LABELS.toSignalsButton, demoSignalsCallbackData(15));
  const BACK = button('↩️', 'back');
  const back = () => new InlineKeyboard([[BACK]]);

  it('the status card: the entry and the mode, the invite and the purchase, the deposit', () => {
    const demo = [
      button(LABELS.demoButton, DEMO_CALLBACK_DATA),
      button(LABELS.modeButton, MODE_CALLBACK_DATA),
    ];
    const real = [
      button(LABELS.tradeButton, DEMO_CALLBACK_DATA),
      button(LABELS.modeBackDemoButton, MODE_CALLBACK_DATA),
    ];
    expect(statusCardKeyboard(TradeMode.Demo, CASHIER).inline_keyboard).toEqual([
      demo,
      [INVITE, BUY],
      [DEPOSIT],
    ]);
    expect(statusCardKeyboard(TradeMode.Real, CASHIER).inline_keyboard).toEqual([
      real,
      [INVITE, BUY],
      [DEPOSIT],
    ]);
    expect(statusCardKeyboard(TradeMode.Demo, undefined).inline_keyboard).toEqual([
      demo,
      [INVITE, BUY],
    ]);
  });

  it('withBuy: the purchase and the deposit in one row over the given rows', () => {
    expect(withBuy(back(), CASHIER).inline_keyboard).toEqual([[BUY, DEPOSIT], [BACK]]);
    expect(withBuy(back(), undefined).inline_keyboard).toEqual([[BUY], [BACK]]);
  });

  it('withInvite: the deposit and the invite in one row, then the menu', () => {
    expect(withInvite(new InlineKeyboard(), CASHIER).inline_keyboard).toEqual([
      [DEPOSIT, INVITE],
      [MENU],
    ]);
    expect(withInvite(new InlineKeyboard(), undefined).inline_keyboard).toEqual([[INVITE], [MENU]]);
    expect(withInvite(back(), undefined).inline_keyboard).toEqual([[BACK], [INVITE], [MENU]]);
  });

  it('appendEndOfPath: the analysis and the signals in one row, beforeMenu, the menu last', () => {
    expect(appendEndOfPath(back(), 101, 15).inline_keyboard).toEqual([
      [BACK],
      [ANALYSIS, SIGNALS],
      [MENU],
    ]);
    expect(
      appendEndOfPath(new InlineKeyboard(), 101, 15, [[DEPOSIT, INVITE]]).inline_keyboard,
    ).toEqual([[ANALYSIS, SIGNALS], [DEPOSIT, INVITE], [MENU]]);
    // a duration the demo does not offer: the duration screen alone
    expect(appendEndOfPath(new InlineKeyboard(), 101, 60).inline_keyboard).toEqual([
      [button(LABELS.toSignalsButton, DEMO_SIGNALS_CALLBACK_DATA)],
      [MENU],
    ]);
    // a session stopped for want of a signal (#509): another pair alone
    expect(
      appendEndOfPath(new InlineKeyboard(), 101, 15, [], { otherPair: true }).inline_keyboard,
    ).toEqual([[button(LABELS.otherPairButton, demoSignalsCallbackData(15))], [MENU]]);
  });
});
