import { describe, expect, it } from 'vitest';
import {
  BUTTON_ROLE_STYLES,
  ButtonRole,
  buttonLabelWidth,
  callbackButton,
  isBotKeyboard,
  keyboardOf,
  payButton,
  stackKeyboards,
  switchInlineButton,
  urlButton,
  webAppButton,
  type BotButton,
} from './bot-keyboard';
import { botKeyboardProblems } from './testing';

const f = (text: string) => callbackButton(ButtonRole.Forward, text, `f:${text}`);
const s = (text: string) => callbackButton(ButtonRole.Secondary, text, `s:${text}`);
const n = (text: string) => callbackButton(ButtonRole.Nav, text, `n:${text}`);
// grammY's InlineKeyboard in shape: a class with the wire and nothing else (shared has no grammY)
class ForeignKeyboard {
  readonly inline_keyboard = [[{ text: 'a', callback_data: 'b' }]];
}

const texts = (keyboard: { inline_keyboard: { text: string }[][] }) =>
  keyboard.inline_keyboard.map((row) => row.map((b) => b.text));

describe('keyboardOf (#475)', () => {
  it('K1: each role gives its own style, nav none', () => {
    expect(BUTTON_ROLE_STYLES).toEqual({
      forward: 'success',
      forward_down: 'danger',
      danger: 'danger',
      stake: 'success',
      stake_risk: 'danger',
      up: 'success',
      down: 'danger',
      secondary: 'primary',
      nav: null,
    });
    for (const role of Object.values(ButtonRole)) {
      const [[wire]] = keyboardOf([callbackButton(role, 'x', 'd')]).inline_keyboard as [[object]];
      const style = BUTTON_ROLE_STYLES[role];
      expect(wire, role).toEqual(
        style === null
          ? { text: 'x', callback_data: 'd' }
          : { text: 'x', callback_data: 'd', style },
      );
    }
  });

  it('K2/K14: forward and forward_down take a row of their own inside a group', () => {
    const down = callbackButton(ButtonRole.ForwardDown, 'D', 'd');
    expect(texts(keyboardOf([s('a'), f('F'), s('b'), down, n('c')]))).toEqual([
      ['a'],
      ['F'],
      ['b'],
      ['D'],
      ['c'],
    ]);
    expect(keyboardOf([down]).inline_keyboard[0]?.[0]?.style).toBe('danger');
  });

  it('K3/K4: actions in rows of two, an odd run of three or more ends in a three', () => {
    const run = (count: number) =>
      texts(keyboardOf(Array.from({ length: count }, (_, i) => s(String(i))))).map((r) => r.length);
    expect(run(1)).toEqual([1]);
    expect(run(2)).toEqual([2]);
    expect(run(3)).toEqual([3]);
    expect(run(4)).toEqual([2, 2]);
    expect(run(5)).toEqual([2, 3]);
    expect(run(7)).toEqual([2, 2, 3]);
  });

  it('K5: a list goes in rows of perRow, the remainder as is', () => {
    const list = (count: number, perRow: 2 | 3) =>
      texts(
        keyboardOf({ buttons: Array.from({ length: count }, (_, i) => n(String(i))), perRow }),
      ).map((r) => r.length);
    expect(list(5, 2)).toEqual([2, 2, 1]);
    expect(list(4, 3)).toEqual([3, 1]);
    expect(list(3, 3)).toEqual([3]);
  });

  it('K6: an empty group gives no row; groups never share a row', () => {
    expect(keyboardOf([], { buttons: [], perRow: 2 }).inline_keyboard).toEqual([]);
    expect(texts(keyboardOf([s('a')], [], [s('b')]))).toEqual([['a'], ['b']]);
  });

  it('K7: style only on a coloured role, and JSON carries the wire alone', () => {
    const keyboard = keyboardOf([n('menu'), s('again')]);
    expect(keyboard.inline_keyboard).toEqual([
      [
        { text: 'menu', callback_data: 'n:menu' },
        { text: 'again', callback_data: 's:again', style: 'primary' },
      ],
    ]);
    expect(Object.keys(keyboard.inline_keyboard[0]?.[0] ?? {})).toEqual(['text', 'callback_data']);
    expect(JSON.parse(JSON.stringify(keyboard))).toEqual({
      inline_keyboard: keyboard.inline_keyboard,
    });
    expect(keyboard.rows).toEqual([
      [
        { role: 'nav', text: 'menu', list: false },
        { role: 'secondary', text: 'again', list: false },
      ],
    ]);
  });

  it('K8: stackKeyboards keeps both keyboards rows and roles', () => {
    const stacked = stackKeyboards(
      keyboardOf([f('share')]),
      keyboardOf({ buttons: [n('p')], perRow: 2 }),
    );
    expect(texts(stacked)).toEqual([['share'], ['p']]);
    expect(stacked.rows).toEqual([
      [{ role: 'forward', text: 'share', list: false }],
      [{ role: 'nav', text: 'p', list: true }],
    ]);
    expect(isBotKeyboard(stacked)).toBe(true);
  });

  it('K9: a label width leaves out emoji, flags and joiners', () => {
    expect(buttonLabelWidth('❌ Выключить ✅')).toBe(9);
    expect(buttonLabelWidth('◀️')).toBe(0);
    expect(buttonLabelWidth('$10.00 ✅ · риск')).toBe(13);
    expect(buttonLabelWidth('🇷🇺 Русский')).toBe(7);
    expect(buttonLabelWidth('1️⃣ two')).toBe(5);
  });

  it('K10: the pay button is forward, first and alone', () => {
    const keyboard = stackKeyboards(keyboardOf([payButton('⭐ Pay')]), keyboardOf([n('menu')]));
    expect(keyboard.inline_keyboard[0]).toEqual([{ text: '⭐ Pay', pay: true, style: 'success' }]);
  });

  it('K11: url, web_app and switch_inline buttons carry their style', () => {
    const buttons: BotButton[] = [
      urlButton(ButtonRole.Forward, 'u', 'https://x'),
      webAppButton(ButtonRole.Forward, 'w', 'https://y'),
      switchInlineButton(ButtonRole.Forward, 'i', { query: 'q', allow_user_chats: true }),
    ];
    expect(keyboardOf(buttons).inline_keyboard).toEqual([
      [{ text: 'u', url: 'https://x', style: 'success' }],
      [{ text: 'w', web_app: { url: 'https://y' }, style: 'success' }],
      [
        {
          text: 'i',
          switch_inline_query_chosen_chat: { query: 'q', allow_user_chats: true },
          style: 'success',
        },
      ],
    ]);
  });

  it('K12: a grammY keyboard or a bare markup is not a BotKeyboard', () => {
    expect(isBotKeyboard(new ForeignKeyboard())).toBe(false);
    expect(isBotKeyboard({ inline_keyboard: [] })).toBe(false);
    expect(isBotKeyboard(keyboardOf())).toBe(true);
  });

  it('K13: callback_data and the order of buttons are as given', () => {
    expect(
      keyboardOf([s('a'), n('b'), s('c')])
        .inline_keyboard.flat()
        .map((b) => ('callback_data' in b ? b.callback_data : null)),
    ).toEqual(['s:a', 'n:b', 's:c']);
  });
});

describe('botKeyboardProblems (#475)', () => {
  it('refuses a keyboard built outside keyboardOf', () => {
    expect(botKeyboardProblems(new ForeignKeyboard())).toEqual([
      'a keyboard built outside keyboardOf',
    ]);
    expect(botKeyboardProblems({ inline_keyboard: [[{ text: 'a', callback_data: 'b' }]] })).toEqual(
      ['a keyboard built outside keyboardOf'],
    );
  });

  it('a lone non-forward action is a problem when it is not the one such button', () => {
    expect(
      botKeyboardProblems(keyboardOf([s('📊 Анализ'), n('📡 Сигналы')], [n('🏠 В меню')])),
    ).toEqual(['lone_button: 🏠 В меню']);
    expect(botKeyboardProblems(keyboardOf([f('🎮 Демо')], [n('🏠 В меню')]))).toEqual([]);
  });

  it('a list remainder alone is no problem', () => {
    expect(
      botKeyboardProblems(
        keyboardOf({ buttons: [n('EUR/USD'), n('GBP/USD'), n('USD/JPY')], perRow: 2 }, [
          n('↩️ Типы'),
        ]),
      ),
    ).toEqual([]);
  });

  it('a label wider than its row of two or three is a problem, a list label is not', () => {
    expect(botKeyboardProblems(keyboardOf([n('123456789012345'), n('b')]))).toEqual([
      'label_width: 123456789012345 (15 > 14)',
    ]);
    expect(botKeyboardProblems(keyboardOf([n('12345678901234'), n('b')]))).toEqual([]);
    expect(botKeyboardProblems(keyboardOf([n('1234567890'), n('b'), n('c')]))).toEqual([
      'label_width: 1234567890 (10 > 9)',
    ]);
    expect(botKeyboardProblems(keyboardOf([n('123456789'), n('b'), n('c')]))).toEqual([]);
    expect(
      botKeyboardProblems(keyboardOf({ buttons: [n('1234567890123456'), n('b')], perRow: 2 })),
    ).toEqual([]);
  });

  it('an empty keyboard has no problems', () => {
    expect(botKeyboardProblems(keyboardOf())).toEqual([]);
  });
});
