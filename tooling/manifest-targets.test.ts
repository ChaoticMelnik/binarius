import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// A manifest entry point that names a build output resolves only after a build ran, so a check
// that builds first passes while a fresh clone fails (#2). Every `main`, `module`, `types`, `bin`,
// `exports` and `typesVersions` target has to name a file that is part of the tree: tracked or
// not yet staged (the check runs before `git add`), not ignored, and present on disk.

const repoRoot = path.resolve(import.meta.dirname, '..');

function git(...args: string[]): string[] {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' })
    .split('\n')
    .filter((line) => line !== '');
}

// ignored files (dist/, .env) are excluded, which is what keeps a build output from counting
const treeFiles = new Set(
  git('ls-files', '--cached', '--others', '--exclude-standard').filter((file) =>
    existsSync(path.join(repoRoot, file)),
  ),
);

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

function entryPoints(manifest: Record<string, unknown>): string[] {
  return [
    manifest.main,
    manifest.module,
    manifest.types,
    ...leaves(manifest.bin),
    ...leaves(manifest.exports),
    ...leaves(manifest.typesVersions),
  ].filter((target): target is string => typeof target === 'string');
}

// `typesVersions` leaves are patterns (`src/*`): such a target must match at least one file
function unresolved(dir: string, targets: string[], files: ReadonlySet<string>): string[] {
  return targets
    .map((target) => path.posix.join(dir, target))
    .filter((target) => {
      if (!target.includes('*')) return !files.has(target);
      const [head = '', ...rest] = target.split('*');
      const tail = rest.join('*');
      return ![...files].some(
        (file) =>
          file.startsWith(head) && file.endsWith(tail) && file.length >= head.length + tail.length,
      );
    });
}

describe('workspace manifests', () => {
  // the check below is vacuous if pnpm lists nothing, or if a tracked package sits outside the
  // workspace, so both directions have to agree first
  it('lists exactly the tracked packages as the workspace', () => {
    const trackedDirs = git('ls-files')
      .filter((file) => path.posix.basename(file) === 'package.json')
      .map((file) => path.posix.dirname(file))
      .map((dir) => (dir === '.' ? '' : dir));
    expect([...workspaceDirs].sort()).toEqual([...new Set(trackedDirs)].sort());
    expect(workspaceDirs.filter((dir) => dir !== '').length).toBeGreaterThan(0);
  });

  // no manifest here uses `bin` or `typesVersions` yet, so their branches are pinned on a
  // synthetic manifest against a synthetic tree
  it('resolves bin targets and typesVersions patterns', () => {
    const files = new Set(['pkg/src/cli.ts', 'pkg/src/index.ts']);
    const manifest = {
      bin: { tool: './src/cli.ts' },
      typesVersions: { '*': { '*': ['src/*'], old: ['legacy/*'] } },
    };
    expect(unresolved('pkg', entryPoints(manifest), files)).toEqual(['pkg/legacy/*']);
    expect(unresolved('pkg', entryPoints({ bin: './dist/cli.js' }), files)).toEqual([
      'pkg/dist/cli.js',
    ]);
  });

  it.each(workspaceDirs.map((dir) => [dir === '' ? '(root)' : dir, dir]))(
    '%s points every entry at a file in the tree',
    (label, dir) => {
      const manifest = JSON.parse(
        readFileSync(path.join(repoRoot, dir, 'package.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(
        unresolved(dir, entryPoints(manifest), treeFiles),
        `${label}/package.json names files outside the tree`,
      ).toEqual([]);
    },
  );
});
