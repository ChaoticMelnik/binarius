import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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
