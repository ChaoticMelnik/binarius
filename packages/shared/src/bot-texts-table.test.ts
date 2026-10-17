import { describe, expect, it } from 'vitest';
import { BOT_TEXT_CATALOG, type BotTextKey } from './bot-texts';
import { BOT_TEXT_SOURCES_EN } from './bot-texts-en';
import { botTextsReviewTable } from './bot-texts-table';

describe('botTextsReviewTable (#508)', () => {
  it('T1 lists every translated key once, in the catalog order, under the head line', () => {
    const { markdown, count } = botTextsReviewTable(BOT_TEXT_SOURCES_EN, 'abc123');
    const translated = (Object.keys(BOT_TEXT_CATALOG) as BotTextKey[]).filter(
      (key) => BOT_TEXT_SOURCES_EN[key] !== undefined,
    );
    expect(count).toBe(translated.length);
    const lines = markdown.split('\n');
    expect(lines[0]).toBe(`head=abc123 keys=${String(translated.length)}`);
    const keys = lines.slice(4).map((line) => /^\| `([A-Za-z0-9]+)` \|/.exec(line)?.[1]);
    expect(keys).toEqual(translated);
  });

  it('T2 shows tags as text, escapes a pipe and turns a line break into <br>, one line a row', () => {
    const { markdown } = botTextsReviewTable({ welcome: '<b>a</b> | b & c\nd' }, 'h');
    const row = markdown.split('\n')[4];
    expect(row).toMatch(
      /^\| `welcome` \| start \| 🚀 &lt;b&gt;.+ \| &lt;b&gt;a&lt;\/b&gt; \\\| b &amp; c<br>d \|$/u,
    );
    expect(row).not.toContain('\n');
  });

  it('T3 counts no keys for an empty source', () => {
    expect(botTextsReviewTable({}, 'h')).toEqual({
      markdown: 'head=h keys=0\n\n| key | group | русский | English |\n|---|---|---|---|',
      count: 0,
    });
  });
});
