import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Prints the owner's proofreading table of the client bot's English texts (#508, docs/bot-texts.md
// → Languages): `pnpm -s exec tsx tooling/bot-texts-table.ts`. tsx, not node: the shared sources
// import without extensions. Exit 1 when no key is translated, so an empty table never reads as a
// finished one.
const repoRoot = path.resolve(import.meta.dirname, '..');
const shared = (file: string) =>
  pathToFileURL(path.join(repoRoot, 'packages/shared/src', file)).href;

// non-literal specifiers keep packages/shared out of tooling's tsc program (rootDir is tooling/)
const { botTextsReviewTable } = (await import(shared('bot-texts-table.ts'))) as {
  botTextsReviewTable(
    english: Record<string, string | undefined>,
    head: string,
  ): { markdown: string; count: number };
};
const { BOT_TEXT_SOURCES_EN } = (await import(shared('bot-texts-en.ts'))) as {
  BOT_TEXT_SOURCES_EN: Record<string, string | undefined>;
};

const head = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
  cwd: repoRoot,
  encoding: 'utf8',
}).trim();
const { markdown, count } = botTextsReviewTable(BOT_TEXT_SOURCES_EN, head);
process.stdout.write(`${markdown}\n`);
process.exitCode = count === 0 ? 1 : 0;
