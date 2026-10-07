import { describe, expect, it } from 'vitest';
import {
  escapeTelegramHtml,
  InvalidTelegramTemplate,
  plainTextOf,
  TELEGRAM_CAPTION_LIMIT,
  TELEGRAM_MESSAGE_LIMIT,
  telegramHtml,
  telegramHtmlProblems,
  telegramHtmlTagRanges,
  telegramHtmlTemplate,
  type TelegramHtml,
} from './telegram-html';

describe('escapeTelegramHtml', () => {
  it('escapes the three characters the Bot API requires and the double quote, nothing else', () => {
    expect(escapeTelegramHtml(`a<b>&c_d*e"f'g`)).toBe(`a&lt;b&gt;&amp;c_d*e&quot;f'g`);
  });

  it('escapes an entity-looking text instead of passing it through', () => {
    expect(escapeTelegramHtml('&lt;')).toBe('&amp;lt;');
  });
});

describe('telegramHtml', () => {
  it('escapes a string hole and keeps the static parts as written', () => {
    expect(telegramHtml`<b>${'a<b&c>'}</b>`.value).toBe('<b>a&lt;b&amp;c&gt;</b>');
  });

  it('nests a fragment without escaping it a second time', () => {
    const inner = telegramHtml`<i>${'&'}</i>`;
    expect(telegramHtml`<b>${inner}</b>`.value).toBe('<b><i>&amp;</i></b>');
  });

  it('joins an array of fragments without escaping them again', () => {
    const items = [telegramHtml`${'<'}`, telegramHtml`<b>${'&'}</b>`];
    expect(telegramHtml`${items}`.value).toBe('&lt;<b>&amp;</b>');
  });

  it('escapes a foreign object that a cast let through instead of crashing on it', () => {
    const foreign = { toString: () => '<script>' } as unknown as TelegramHtml;
    expect(telegramHtml`${foreign}`.value).toBe('&lt;script&gt;');
  });

  // no text has an attribute hole today
  it('keeps a hole inside an attribute from closing it', () => {
    const link = telegramHtml`<a href="${'x" onclick="y'}">t</a>`;
    expect(link.value).toContain('href="x&quot; onclick=&quot;y"');
    expect(telegramHtmlProblems(link.value)).toEqual([]);
  });

  it('turns into its value as a string', () => {
    expect(String(telegramHtml`<b>${'x'}</b>`)).toBe('<b>x</b>');
  });
});

describe('telegramHtmlProblems', () => {
  it.each([
    ['plain text', 'plain'],
    [
      'every simple tag',
      '<b>1</b><strong>2</strong><i>3</i><em>4</em><u>5</u><ins>6</ins><s>7</s><strike>8</strike><del>9</del>',
    ],
    ['a spoiler both ways', '<span class="tg-spoiler">a</span><tg-spoiler>b</tg-spoiler>'],
    ['a link', '<a href="https://example.com/?a=1&amp;b=2">x</a>'],
    ['a custom emoji', '<tg-emoji emoji-id="5368324170671202286">👍</tg-emoji>'],
    [
      'a time with and without a format',
      '<tg-time unix="1647531900" format="t">x</tg-time><tg-time unix="1">y</tg-time>',
    ],
    [
      'code, pre and a language inside pre',
      '<code>a</code><pre>b</pre><pre><code class="language-ts">c</code></pre>',
    ],
    [
      'a blockquote and an expandable one',
      '<blockquote>a</blockquote><blockquote expandable>b</blockquote>',
    ],
    ['nested formatting', '<b>a <i>b <u>c</u></i></b>'],
    ['every supported entity', '&lt;&gt;&amp;&quot;&#39;&#x1F600;'],
    ['an uppercase tag', '<B>a</B>'],
    ['formatting inside a link', '<a href="x"><b>a</b></a>'],
    ['a link inside formatting', '<b><a href="x">a</a></b>'],
    ['code inside bold, which the spec leaves unsettled', '<b><code>a</code></b>'],
    [
      'a link inside a blockquote, which the spec leaves unsettled',
      '<blockquote><a href="x">a</a></blockquote>',
    ],
    [
      'code inside a blockquote, which the spec leaves unsettled',
      '<blockquote><code>a</code></blockquote>',
    ],
  ])('accepts %s', (_name, value) => {
    expect(telegramHtmlProblems(value)).toEqual([]);
  });

  it.each([
    ['an unknown tag', '<p>a</p>', '<p> is not a Telegram tag'],
    ['a tag Telegram does not list', '<br>', '<br> is not a Telegram tag'],
    [
      'a tag named like an Object member',
      '<constructor>a</constructor>',
      '<constructor> is not a Telegram tag',
    ],
    ['an attribute the tag does not take', '<b class="x">a</b>', '<b> does not take class'],
    [
      'an attribute named like an Object member',
      '<b constructor="x">a</b>',
      '<b> does not take constructor',
    ],
    ['a link without href', '<a>a</a>', '<a> needs href'],
    [
      'a span that is not a spoiler',
      '<span class="x">a</span>',
      '<span> is only a spoiler: class="tg-spoiler"',
    ],
    [
      'a language on standalone code',
      '<code class="language-ts">a</code>',
      'class on <code> is allowed only directly inside <pre>',
    ],
    [
      'a code class that is not a language',
      '<pre><code class="ts">a</code></pre>',
      'class on <code> must be language-…',
    ],
    [
      'expandable with a value',
      '<blockquote expandable="1">a</blockquote>',
      'expandable on <blockquote> takes no value',
    ],
    ['href without a value', '<a href>a</a>', 'href on <a> needs a value'],
    ['a mismatched closing tag', '<b><i>a</b></i>', '</b> closes <i>'],
    ['a closing tag with nothing open', 'a</b>', '</b> closes nothing'],
    ['a closing tag with attributes', '<b>a</b class="x">', '</b> carries attributes'],
    ['an unclosed tag', '<b>a', '<b> is never closed'],
    [
      'a nested blockquote',
      '<blockquote><blockquote>a</blockquote></blockquote>',
      'blockquotes cannot be nested',
    ],
    [
      'a blockquote nested through another tag',
      '<blockquote><b><blockquote>a</blockquote></b></blockquote>',
      'blockquotes cannot be nested',
    ],
    ['a tag inside code', '<code><b>a</b></code>', '<b> inside <code>: pre and code hold no tags'],
    ['a tag inside pre', '<pre><b>a</b></pre>', '<b> inside <pre>: pre and code hold no tags'],
    [
      'code inside pre through another tag',
      '<pre><b><code>a</code></b></pre>',
      '<code> inside <pre>: pre and code hold no tags',
    ],
    [
      'a link inside code',
      '<code><a href="x">a</a></code>',
      '<a> inside <code>: pre and code hold no tags',
    ],
    [
      'a link inside a link',
      '<a href="x"><a href="y">a</a></a>',
      '<a> inside <a>: these tags do not nest in each other',
    ],
    [
      'a custom emoji inside a link through another tag',
      '<a href="x"><b><tg-emoji emoji-id="1">👍</tg-emoji></b></a>',
      '<tg-emoji> inside <a>: these tags do not nest in each other',
    ],
    [
      'pre inside a link',
      '<a href="x"><pre>a</pre></a>',
      '<pre> inside <a>: these tags do not nest in each other',
    ],
    [
      'a link inside a time',
      '<tg-time unix="1"><a href="x">a</a></tg-time>',
      '<a> inside <tg-time>: these tags do not nest in each other',
    ],
    ['a bare <', 'a < b', 'a bare "<" at 2'],
    ['a bare >', 'a > b', 'a bare ">" at 2'],
    ['a bare &', 'R&D', 'a bare "&" at 1'],
    ['a named entity Telegram does not support', '&nbsp;', 'a bare "&" at 0'],
    ['an entity without its semicolon', '&amp', 'a bare "&" at 0'],
  ])('refuses %s', (_name, value, problem) => {
    expect(telegramHtmlProblems(value)).toContain(problem);
  });
});

describe('plainTextOf', () => {
  it('drops the tags and decodes the entities', () => {
    expect(
      plainTextOf(
        '<b>a &lt;b&gt; &amp; &quot;c&quot;</b> <blockquote expandable>&#39;&#x1F600;</blockquote>',
      ),
    ).toBe(`a <b> & "c" '😀`);
  });

  it('decodes in one pass, as Telegram does', () => {
    expect(plainTextOf('&amp;lt;')).toBe('&lt;');
  });

  it('gives back exactly what went through a hole', () => {
    const hostile = `<&>_*"'`;
    expect(plainTextOf(telegramHtml`<b>${hostile}</b>`)).toBe(hostile);
  });
});

describe('telegramHtmlTemplate', () => {
  it('escapes a string hole exactly as telegramHtml does with the same statics', () => {
    const hostile = `<&>"`;
    expect(telegramHtmlTemplate(['<b>', '</b> и ', '.'], [hostile, hostile]).value).toBe(
      telegramHtml`<b>${hostile}</b> и ${hostile}.`.value,
    );
  });

  it('nests a TelegramHtml hole without escaping it a second time', () => {
    const inner = telegramHtml`<i>${'&'}</i>`;
    expect(telegramHtmlTemplate(['<b>', '</b>'], [inner]).value).toBe('<b><i>&amp;</i></b>');
  });

  it('refuses statics Telegram would refuse, and says nothing but its name', () => {
    let thrown: unknown;
    try {
      telegramHtmlTemplate(['<b>', ''], ['x']);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(InvalidTelegramTemplate);
    expect((thrown as Error).name).toBe('InvalidTelegramTemplate');
    expect((thrown as Error).message).toBe('');
  });

  // valid statics, valid hole: only the assembled text shows <a> inside <a>
  it('refuses a TelegramHtml hole that breaks the nesting of valid statics', () => {
    const link = telegramHtml`<a href="https://f.test">x</a>`;
    expect(() => telegramHtmlTemplate(['<a href="https://e.test">', '</a>'], [link])).toThrow(
      InvalidTelegramTemplate,
    );
  });
});

describe('telegramHtmlTagRanges', () => {
  it('gives the offsets of every tag and nothing else', () => {
    expect(telegramHtmlTagRanges('a<b>c</b> <x &amp;')).toEqual([
      [1, 4],
      [5, 9],
    ]);
  });
});

describe('limits', () => {
  it('are the Bot API numbers', () => {
    expect(TELEGRAM_MESSAGE_LIMIT).toBe(4096);
    expect(TELEGRAM_CAPTION_LIMIT).toBe(1024);
  });
});
