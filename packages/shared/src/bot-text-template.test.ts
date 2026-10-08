import { describe, expect, it } from 'vitest';
import {
  botHtmlText,
  botPlainText,
  botTextEntryProblems,
  createBotTextViews,
  InvalidBotText,
  parseBotTextTemplate,
  type BotTextSource,
  type BotTextVariable,
} from './bot-text-template';
import { telegramHtml } from './telegram-html';

// a registry of its own, as bot-text-vars.ts is the catalog's
const shown = (sample: string): BotTextVariable<string> => ({
  description: 'строка',
  sample,
  format: (value) => value,
});
const formatted: string[] = [];
const count: BotTextVariable<number> = {
  description: 'число',
  sample: '12',
  format: (value) => {
    formatted.push('n');
    return `${String(value)} шт.`;
  },
};
const who: BotTextVariable<string | null> = {
  description: 'кто, или слово каталога вместо него',
  sample: 'Ада',
  format: (value, texts) => value ?? texts('word'),
};

const CATALOG = {
  msg: botHtmlText('g', 'сообщение', '<b>{v}</b>', {
    variables: { v: shown('Ада') },
    fragments: { word: 'word', bold: 'bold' },
  }),
  count: botHtmlText('g', 'число', 'Токены: {v}', { variables: { v: shown('100') } }),
  short: botHtmlText('g', 'короткое', '{v}', { variables: { v: shown('Ада') }, limit: 10 }),
  pair: botHtmlText('g', 'две переменные', 'Привет, {v}! Токены: {n}', {
    variables: { v: shown('Ада'), n: count },
  }),
  host: botHtmlText('g', 'хозяин', 'Нажми «{word}», затем {bold}.', {
    fragments: { word: 'word', bold: 'bold' },
  }),
  line: botPlainText('g', 'надпись', '{v}', { variables: { v: shown('Ада') } }),
  whoLine: botPlainText('g', 'кто', '{who}', { variables: { who } }),
  plainHost: botPlainText('g', 'plain-хозяин', '{word}!', { fragments: { word: 'word' } }),
  word: botPlainText('g', 'слово', 'слово'),
  bold: botHtmlText('g', 'жирный', '<b>жирный</b>'),
};
type Key = keyof typeof CATALOG;

const sourceOf = (overrides: Partial<Record<Key, string>> = {}): BotTextSource<Key> => ({
  sourceOf: (key) => overrides[key] ?? CATALOG[key].source,
});
const problems = (key: Key, source: string) =>
  botTextEntryProblems(CATALOG, key, source, sourceOf());

describe('parseBotTextTemplate', () => {
  it('splits the text around its placeholders and counts the stray braces', () => {
    expect(parseBotTextTemplate('a {x} b {yZ1} {Bad} }')).toEqual({
      statics: ['a ', ' b ', ' {Bad} }'],
      names: ['x', 'yZ1'],
      strayBraces: 3,
    });
  });
});

describe('botTextEntryProblems', () => {
  it.each<[string, Key, string, unknown[]]>([
    ['empty', 'msg', '  \n ', [{ code: 'empty' }]],
    ['nothing but markup', 'host', '<b></b>', [{ code: 'empty' }]],
    ['stray closing brace', 'msg', '{v} }', [{ code: 'stray_brace' }]],
    ['stray opening brace', 'msg', '{ {v}', [{ code: 'stray_brace' }]],
    ['a capitalised name', 'msg', '{v} {V}', [{ code: 'stray_brace' }]],
    [
      'unknown placeholder',
      'msg',
      '{v} {other}',
      [{ code: 'unknown_placeholder', detail: 'other' }],
    ],
    // #358 В3: no variable is required, the old argument included
    ['a variable left out', 'msg', 'без переменной', []],
    ['one of two variables left out', 'pair', 'Токены: {n}', []],
    ["another key's variable", 'count', '{v} {n}', [{ code: 'unknown_placeholder', detail: 'n' }]],
    ['a variable twice', 'msg', '{v} и {v}', []],
    [
      'placeholder in an attribute value',
      'msg',
      '<pre><code class="language-{v}">x</code></pre>',
      [{ code: 'placeholder_in_tag', detail: 'v' }],
    ],
    [
      'fragment in an attribute value',
      'host',
      '<a href="https://e.test/{word}">x</a>',
      [{ code: 'placeholder_in_tag', detail: 'word' }],
    ],
    ['placeholder in text next to a tag', 'msg', '<b>{v}</b>{v}<i>{v}</i>', []],
    [
      'partial numeric entity before a variable',
      'count',
      '&#{v};',
      [{ code: 'invalid_html', detail: 'a bare "&" at 0' }],
    ],
    [
      'partial numeric entity around a variable',
      'count',
      '&#{v}1;',
      [{ code: 'invalid_html', detail: 'a bare "&" at 0' }],
    ],
    [
      'partial named entity before a variable',
      'count',
      '&am{v};',
      [{ code: 'invalid_html', detail: 'a bare "&" at 0' }],
    ],
    [
      'partial entity before the second of two variables',
      'pair',
      '{v} &am{n};',
      [{ code: 'invalid_html', detail: 'a bare "&" at 2' }],
    ],
    ['full entities around a variable', 'count', '{v} &amp; {v}', []],
    ['unclosed tag', 'msg', '<b>{v}', [{ code: 'invalid_html', detail: '<b> is never closed' }]],
    ['too long', 'short', '{v} 12345678', [{ code: 'too_long', detail: '12' }]],
    ['at the limit', 'short', '<b>{v}</b> 123456', []],
    ['padded first line', 'msg', ' {v}', [{ code: 'padded_line' }]],
    ['padded second line', 'msg', '{v}\n x', [{ code: 'padded_line' }]],
    ['LF in a single line', 'line', '{v}\nx', [{ code: 'multiline' }]],
    ['CR in a single line', 'line', '{v}\rx', [{ code: 'multiline' }]],
    [
      'U+2028 in a single line',
      'line',
      `{v}${String.fromCharCode(0x2028)}x`,
      [{ code: 'multiline' }],
    ],
    [
      'U+2029 in a single line',
      'line',
      `{v}${String.fromCharCode(0x2029)}x`,
      [{ code: 'multiline' }],
    ],
    ['one line', 'line', '{v} x', []],
    ['a plain text with markup characters', 'line', '<{v}> & co', []],
  ])('%s', (_name, key, source, expected) => {
    expect(problems(key, source)).toEqual(expected);
  });

  it('refuses a placeholder inside a tag even where it breaks the tag', () => {
    expect(problems('msg', '<blockquote e{v}pandable>x</blockquote>')).toContainEqual({
      code: 'placeholder_in_tag',
      detail: 'v',
    });
  });

  it("checks a host against its fragments' current texts", () => {
    const source = '<b>{bold}</b>';
    expect(botTextEntryProblems(CATALOG, 'host', source, sourceOf({ bold: 'жирный' }))).toEqual([]);
    expect(botTextEntryProblems(CATALOG, 'host', source, sourceOf({ bold: '<i>жирный' }))).toEqual([
      { code: 'invalid_html', detail: '</b> closes <i>' },
    ]);
  });
});

describe('createBotTextViews', () => {
  const HOSTILE = `<&>"`;

  it('escapes a plain fragment in an html host exactly once', () => {
    const { html } = createBotTextViews(CATALOG, sourceOf({ word: HOSTILE, bold: 'b' }));
    expect(html.host.value).toBe('Нажми «&lt;&amp;&gt;&quot;», затем b.');
  });

  it('nests an html fragment without escaping it a second time', () => {
    const { html } = createBotTextViews(CATALOG, sourceOf());
    expect(html.host.value).toBe('Нажми «слово», затем <b>жирный</b>.');
  });

  it('renders a host that leaves its fragment out', () => {
    const { html } = createBotTextViews(CATALOG, sourceOf({ host: 'Без фрагментов.' }));
    expect(html.host.value).toBe('Без фрагментов.');
  });

  it('puts a plain fragment into a plain host as it is', () => {
    const { plain } = createBotTextViews(CATALOG, sourceOf({ word: HOSTILE }));
    expect(plain.plainHost).toBe(`${HOSTILE}!`);
  });

  // #299 V12: html goes into html only through a declared fragment, which the validator checks
  it('escapes a string value; a non-string value throws InvalidBotText', () => {
    const { html, plain } = createBotTextViews(CATALOG, sourceOf({ msg: '{v}, {v}' }));
    expect(html.msg({ v: HOSTILE }).value).toBe('&lt;&amp;&gt;&quot;, &lt;&amp;&gt;&quot;');
    expect(() => html.msg({ v: telegramHtml`<i>${'&'}</i>` as unknown as string })).toThrow(
      InvalidBotText,
    );
    expect(plain.line({ v: HOSTILE })).toBe(HOSTILE);
  });

  it('fills every variable of the key, each through its formatter', () => {
    const { html } = createBotTextViews(CATALOG, sourceOf());
    expect(html.pair({ v: 'Ада', n: 12 }).value).toBe('Привет, Ада! Токены: 12 шт.');
  });

  it('formats only the variables the text holds', () => {
    const { html } = createBotTextViews(CATALOG, sourceOf({ pair: 'Привет, {v}!' }));
    formatted.length = 0;
    expect(html.pair({ v: 'Ада', n: 12 }).value).toBe('Привет, Ада!');
    expect(formatted).toEqual([]);
  });

  it("reads a formatter's stand-in from the same source as the text", () => {
    const { plain } = createBotTextViews(CATALOG, sourceOf({ word: 'никто' }));
    expect(plain.whoLine({ who: null })).toBe('никто');
    expect(plain.whoLine({ who: 'Ада' })).toBe('Ада');
  });

  it("renders every key at its variables' samples", () => {
    const { samples } = createBotTextViews(CATALOG, sourceOf({ msg: '{v} &amp; {word}' }));
    expect(samples.html.pair.value).toBe('Привет, Ада! Токены: 12');
    expect(samples.html.msg.value).toBe('Ада &amp; слово');
    expect(samples.plain.line).toBe('Ада');
    expect(samples.html.bold.value).toBe('<b>жирный</b>');
  });

  it('refuses a text that does not parse against its key', () => {
    const { html } = createBotTextViews(CATALOG, sourceOf({ bold: '{nope}' }));
    expect(() => html.bold).toThrow(InvalidBotText);
  });

  describe('memoisation', () => {
    const overrides: Partial<Record<Key, string>> = {};
    const views = () => createBotTextViews(CATALOG, sourceOf(overrides));

    it('returns the same object while the sources stay', () => {
      const { html } = views();
      expect(html.host).toBe(html.host);
    });

    it('returns the same function for a key with variables while the sources stay', () => {
      const { html, plain } = views();
      expect(html.msg).toBe(html.msg);
      expect(plain.line).toBe(plain.line);
    });

    it("renders again once the key's own text changes", () => {
      const live: Partial<Record<Key, string>> = {};
      const { html } = createBotTextViews(CATALOG, sourceOf(live));
      live.bold = '<b>жирный</b>';
      const before = html.bold;
      live.bold = '<i>курсив</i>';
      expect(html.bold).not.toBe(before);
      expect(html.bold.value).toBe('<i>курсив</i>');
    });

    it('renders the host again once only a fragment changes', () => {
      const live: Partial<Record<Key, string>> = {};
      const { html } = createBotTextViews(CATALOG, {
        sourceOf: (key) => live[key] ?? CATALOG[key].source,
      });
      const before = html.host;
      live.word = 'другое';
      expect(html.host).not.toBe(before);
      expect(html.host.value).toMatch(/^Нажми «другое», затем /);
    });

    it('enumerates every key of its kind', () => {
      const { html, plain } = views();
      expect(Object.keys(html).sort()).toEqual(['bold', 'count', 'host', 'msg', 'pair', 'short']);
      expect(Object.keys(plain).sort()).toEqual(['line', 'plainHost', 'whoLine', 'word']);
      expect(Object.entries(html)).toHaveLength(6);
    });
  });
});
