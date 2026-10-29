import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sharedFile } from './package-root';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const sharedRoot = path.join(repoRoot, 'packages', 'shared');

describe('sharedFile (#860)', () => {
  it('PR1 gives a file of @binarius/shared and refuses a missing one', () => {
    expect(sharedFile('assets', 'scan-radar.gif')).toBe(
      path.join(sharedRoot, 'assets', 'scan-radar.gif'),
    );
    expect(() => sharedFile('assets', 'no-such.gif')).toThrow(/ENOENT/);
  });

  // the file need not exist: resolution starts from its directory, through the backend's
  // node_modules symlink, realpath'd
  it("PR2 finds @binarius/shared from the backend bundle's place", () => {
    const bundle = pathToFileURL(path.join(repoRoot, 'apps', 'backend', 'dist', 'index.js')).href;
    expect(path.dirname(createRequire(bundle).resolve('@binarius/shared/package.json'))).toBe(
      sharedRoot,
    );
  });
});
