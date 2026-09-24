import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// A manifest entry point that names a build output resolves only after a build ran, so a check
// that builds first passes while a fresh clone fails (#2). Every entry point has to name a file
// git tracks.

const repoRoot = path.resolve(import.meta.dirname, '..');

function git(...args: string[]): string[] {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' })
    .split('\n')
    .filter((line) => line !== '');
}

const tracked = new Set(git('ls-files'));

// pnpm's own view of the workspace, so a package added to pnpm-workspace.yaml is checked without
// a list here to keep in sync
const workspaceDirs = (
  JSON.parse(
    execFileSync('pnpm', ['ls', '-r', '--depth', '-1', '--json'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }),
  ) as { path: string }[]
).map((pkg) => path.relative(repoRoot, pkg.path).split(path.sep).join('/'));

function leaves(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (value === null || typeof value !== 'object') return [];
  return Object.values(value).flatMap(leaves);
}

describe('workspace manifests', () => {
  // the check below is vacuous if pnpm lists nothing, or if a tracked package sits outside the
  // workspace, so both directions have to agree first
  it('lists exactly the tracked packages as the workspace', () => {
    const trackedDirs = [...tracked]
      .filter((file) => path.posix.basename(file) === 'package.json')
      .map((file) => path.posix.dirname(file))
      .map((dir) => (dir === '.' ? '' : dir));
    expect([...workspaceDirs].sort()).toEqual([...new Set(trackedDirs)].sort());
    expect(workspaceDirs.filter((dir) => dir !== '').length).toBeGreaterThan(0);
  });

  it.each(workspaceDirs.map((dir) => [dir === '' ? '(root)' : dir, dir]))(
    '%s points every entry at a tracked file',
    (_label, dir) => {
      const manifest = JSON.parse(
        readFileSync(path.join(repoRoot, dir, 'package.json'), 'utf8'),
      ) as Record<string, unknown>;
      const targets = [manifest.main, manifest.module, manifest.types, ...leaves(manifest.exports)]
        .filter((target): target is string => typeof target === 'string')
        .map((target) => path.posix.join(dir, target));
      const untracked = targets.filter((target) => !tracked.has(target));
      expect(untracked, `${dir || '(root)'}/package.json names files git does not track`).toEqual(
        [],
      );
    },
  );
});
