import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { botFile, packageRoot } from './package-root';

const botRoot = path.resolve(import.meta.dirname, '..');
const repoRoot = path.resolve(botRoot, '..', '..');
const bundleUrl = (app: string): string =>
  pathToFileURL(path.join(repoRoot, 'apps', app, 'dist', 'index.js')).href;

describe('packageRoot', () => {
  it('T1 finds the bot from its own source by the self-reference', () => {
    expect(packageRoot('@binarius/bot', import.meta.url)).toBe(botRoot);
  });

  // the file need not exist: resolution starts from its directory
  it("T2 finds the bot from its bundle's place", () => {
    expect(packageRoot('@binarius/bot', bundleUrl('bot'))).toBe(botRoot);
  });

  // migrate.ts inside these two bundles: the consumer's node_modules symlink, realpath'd
  it.each(['backend', 'trading-worker'])('T3 finds the db package from the %s bundle', (app) => {
    expect(packageRoot('@binarius/db', bundleUrl(app))).toBe(path.join(repoRoot, 'packages', 'db'));
  });

  it('T4 refuses a package that does not resolve', () => {
    expect(() => packageRoot('@binarius/no-such', import.meta.url)).toThrow();
  });
});

describe('botFile', () => {
  it('T5 gives a file under the package root and refuses a missing one', () => {
    expect(botFile('src', 'assets', 'account-card.jpg')).toBe(
      path.join(botRoot, 'src', 'assets', 'account-card.jpg'),
    );
    expect(() => botFile('src', 'assets', 'no-such.jpg')).toThrow(/ENOENT/);
  });
});
