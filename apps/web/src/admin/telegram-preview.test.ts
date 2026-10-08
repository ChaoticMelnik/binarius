import { describe, expect, it } from 'vitest';
import {
  BOT_TEXT_CATALOG,
  defaultBotTextSource,
  plainTextOf,
  renderBotTextPreview,
  resolveBotTextOverrides,
  telegramHtmlProblems,
  type BotTextKey,
} from '@binarius/shared';
import { telegramPreview } from './telegram-preview';

const preview = (value: string): string => {
  // the converter is only ever handed what web's contract check passed
  expect(telegramHtmlProblems(value)).toEqual([]);
  return telegramPreview(value).value;
};

describe('telegramPreview (#300)', () => {
  it.each([
    ['<b>a</b>', '<b>a</b>'],
    ['<strong>a</strong>', '<b>a</b>'],
    ['<i>a</i>', '<i>a</i>'],
    ['<em>a</em>', '<i>a</i>'],
    ['<u>a</u>', '<u>a</u>'],
    ['<ins>a</ins>', '<u>a</u>'],
    ['<s>a</s>', '<s>a</s>'],
    ['<strike>a</strike>', '<s>a</s>'],
    ['<del>a</del>', '<s>a</s>'],
    ['<span class="tg-spoiler">a</span>', '<span class="tg-spoiler">a</span>'],
    ['<tg-spoiler>a</tg-spoiler>', '<span class="tg-spoiler">a</span>'],
    ['<code>a</code>', '<code>a</code>'],
    ['<pre><code class="language-ts">a</code></pre>', '<pre><code>a</code></pre>'],
    ['<blockquote>a</blockquote>', '<blockquote>a</blockquote>'],
    ['<blockquote expandable>a</blockquote>', '<blockquote class="expandable">a</blockquote>'],
    ['<tg-emoji emoji-id="5368324170671202286">👍</tg-emoji>', '<span class="tg-emoji">👍</span>'],
    ['<tg-time unix="1" format="d">сегодня</tg-time>', '<span class="tg-time">сегодня</span>'],
  ])('rebuilds %s as %s, dropping the attributes', (value, expected) => {
    expect(preview(value)).toBe(expected);
  });

  it('escapes every text again, so an entity never becomes markup', () => {
    expect(preview('a &lt; b &amp; c')).toBe('a &lt; b &amp; c');
    expect(preview('<b>&lt;script&gt;alert(1)&lt;/script&gt;</b>')).not.toContain('<script');
    expect(preview('&quot;"')).toBe('&quot;&quot;');
  });

  it.each([
    ['https://e.test/?a=1&amp;b=2', 'https://e.test/?a=1&amp;b=2'],
    ['http://e.test', 'http://e.test'],
    ['tg://resolve?domain=binarius', 'tg://resolve?domain=binarius'],
  ])('keeps a link to %s', (href, written) => {
    expect(preview(`<a href="${href}">x</a>`)).toBe(
      `<a href="${written}" rel="noopener noreferrer" target="_blank">x</a>`,
    );
  });

  it.each([
    'javascript:alert(1)',
    'java&#115;cript:alert(1)',
    'JavaScript:alert(1)',
    'data:text/html,x',
    '/relative',
    'not a url',
  ])('drops the link to %s and keeps its text', (href) => {
    expect(preview(`<a href="${href}">x</a>`)).toBe('x');
  });

  it('gives every html default, rendered with its sample, only browser tags and the same text', () => {
    const keys = (Object.keys(BOT_TEXT_CATALOG) as BotTextKey[]).filter(
      (key) => BOT_TEXT_CATALOG[key].kind === 'html',
    );
    for (const key of keys) {
      const rendered = renderBotTextPreview(key, defaultBotTextSource);
      if (rendered.kind !== 'html') throw new Error(`${key} rendered plain`);
      const output = preview(rendered.telegramHtml);
      for (const [tag] of output.matchAll(/<\/?[a-z][a-z-]*/g)) {
        expect(['<b', '<i', '<u', '<s', '<span', '<code', '<pre', '<blockquote', '<a']).toContain(
          tag.replace('</', '<'),
        );
      }
      expect(plainTextOf(output)).toBe(plainTextOf(rendered.telegramHtml));
    }
  });

  it('shows the welcome with the connect button fragment in effect', () => {
    const { source } = resolveBotTextOverrides([]);
    const rendered = renderBotTextPreview('welcome', source);
    if (rendered.kind !== 'html') throw new Error('welcome rendered plain');
    expect(preview(rendered.telegramHtml)).toContain('Нажми «🔗 Подключить аккаунт Binodex»');
  });
});
