import { describe, expect, it } from 'vitest';
import { BOT_TEXT_CATALOG, BotTextGroup, type BotTextKey } from './bot-texts';
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

  it('T4 keeps only the keys of the named groups, in the catalog order, and names them in the head line (#632)', () => {
    const groups: readonly BotTextGroup[] = [BotTextGroup.Demo, BotTextGroup.Trade];
    const { markdown, count } = botTextsReviewTable(BOT_TEXT_SOURCES_EN, 'h', groups);
    const expected = (Object.keys(BOT_TEXT_CATALOG) as BotTextKey[]).filter(
      (key) =>
        BOT_TEXT_SOURCES_EN[key] !== undefined && groups.includes(BOT_TEXT_CATALOG[key].group),
    );
    const lines = markdown.split('\n');
    expect(lines[0]).toBe(`head=h keys=${String(expected.length)} groups=demo,trade`);
    const rows = lines.slice(4).map((line) => /^\| `([A-Za-z0-9]+)` \| ([a-z]+) \|/.exec(line));
    expect(rows.map((row) => row?.[1])).toEqual(expected);
    expect(new Set(rows.map((row) => row?.[2]))).toEqual(new Set(['demo', 'trade']));
    expect(count).toBe(expected.length);
    expect(botTextsReviewTable(BOT_TEXT_SOURCES_EN, 'h', [BotTextGroup.Deposit]).count).toBe(0);
  });
});
