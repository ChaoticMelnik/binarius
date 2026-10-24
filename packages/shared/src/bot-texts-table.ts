import { BOT_TEXT_CATALOG, type BotTextGroup, type BotTextKey } from './bot-texts';

// The owner's proofreading table of the English texts (#508): «key | group | Russian | English»
// for every translated key, in the catalog's order; with `groups`, only the keys of those groups
// (#632). tooling/bot-texts-table.ts prints it for the PR; a cell shows the text as written: its
// tags as text, `|` escaped, a line break as <br>.
const cell = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, '<br>');

export function botTextsReviewTable(
  english: Partial<Record<BotTextKey, string>>,
  head: string,
  groups?: readonly BotTextGroup[],
): { markdown: string; count: number } {
  const keys = (Object.keys(BOT_TEXT_CATALOG) as BotTextKey[]).filter(
    (key) =>
      english[key] !== undefined &&
      (groups === undefined || groups.includes(BOT_TEXT_CATALOG[key].group)),
  );
  const rows = keys.map((key) => {
    const entry = BOT_TEXT_CATALOG[key];
    return `| \`${key}\` | ${entry.group} | ${cell(entry.source)} | ${cell(english[key] ?? '')} |`;
  });
  const markdown = [
    `head=${head} keys=${String(keys.length)}${groups === undefined ? '' : ` groups=${groups.join(',')}`}`,
    '',
    '| key | group | русский | English |',
    '|---|---|---|---|',
    ...rows,
  ].join('\n');
  return { markdown, count: keys.length };
}
