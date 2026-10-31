import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appEntryPoints } from './build';

// The image's shape (#877, Rule 52): the Dockerfile's base/dev/prod stages, the manifests the
// install links, `tsx` among the prod dependencies, and a .dockerignore that keeps out what no
// container reads and nothing a container does. The CI compose job checks the built image itself
// (the prod image's files, the layers a docs-only change leaves); these pins hold the text.

const root = path.resolve(import.meta.dirname, '..');
const dockerfile = readFileSync(path.join(root, 'Dockerfile'), 'utf8').split('\n');
const ignoreEntries = readFileSync(path.join(root, '.dockerignore'), 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '' && !line.startsWith('#'));

const STORE_MOUNT =
  'RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store,uid=1000,gid=1000,sharing=locked \\';

// Docker's matching, as far as these entries need it: `**/` is any number of directories, `*` any
// run within one path segment, and an entry that matches a directory excludes everything under it.
function excludes(entry: string, file: string): boolean {
  const pattern = entry
    .split('**/')
    .map((part) =>
      part
        .split('*')
        .map((literal) => literal.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('[^/]*'),
    )
    .join('(?:.*/)?');
  const matcher = new RegExp(`^${pattern}$`);
  const segments = file.split('/');
  return segments.some((_, index) => matcher.test(segments.slice(0, index + 1).join('/')));
}

// docs/deploy.md -> Files a package reads, and what the dev stage builds from
const migrationSql = readdirSync(path.join(root, 'packages/db/drizzle')).find((file) =>
  file.endsWith('.sql'),
);
const RUNTIME_FILES = [
  `packages/db/drizzle/${migrationSql ?? 'no-sql-file'}`,
  'packages/db/drizzle/meta/_journal.json',
  'apps/bot/fonts/Inter-Regular.ttf',
  'apps/bot/src/assets.ts',
  'apps/bot/src/assets',
  'packages/shared/assets',
  'apps/web/src/admin/static/admin.css',
  'apps/bot/package.json',
  'apps/web/package.json',
  'packages/db/package.json',
  'packages/shared/package.json',
  'packages/db/src/cli/migrate.ts',
  'apps/backend/src/index.ts',
  'tooling/build.ts',
  'package.json',
  'pnpm-lock.yaml',
];

function stage(name: string): string[] {
  const start = dockerfile.findIndex((line) => line.endsWith(` AS ${name}`));
  if (start === -1) return [];
  const end = dockerfile.findIndex((line, index) => index > start && line.startsWith('FROM '));
  return dockerfile.slice(start, end === -1 ? undefined : end);
}

describe('.dockerignore', () => {
  it('D1 keeps out what no container reads and nothing a container does', () => {
    for (const entry of [
      '**/node_modules',
      '**/dist',
      '**/.env*',
      '!**/.env.example',
      '**/.claude',
      '**/*.test.ts',
      '**/*.typecheck.ts',
      'docs',
      'audits.md',
      'README.md',
      '.github',
      'deploy',
      'packages/db/drizzle/meta/*_snapshot.json',
    ]) {
      expect(ignoreEntries, entry).toContain(entry);
    }
    expect(migrationSql).toBeDefined();
    const excluded = RUNTIME_FILES.flatMap((file) =>
      ignoreEntries
        .filter((entry) => !entry.startsWith('!') && excludes(entry, file))
        .map((entry) => `${file} <- ${entry}`),
    );
    expect(excluded).toEqual([]);
  });
});

describe('Dockerfile', () => {
  it('D2 builds base, dev and prod, prod last with dependencies only and the bundles from dev', () => {
    const nodeVersion = readFileSync(path.join(root, '.node-version'), 'utf8').trim();
    expect(dockerfile.find((line) => line.startsWith('ARG '))).toBe(
      `ARG NODE_VERSION=${nodeVersion}`,
    );
    expect(dockerfile.filter((line) => line.startsWith('FROM '))).toEqual([
      'FROM node:${NODE_VERSION}-alpine AS base',
      'FROM base AS dev',
      'FROM base AS prod',
    ]);
    expect(stage('base')).toContain('ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 PNPM_HOME=/pnpm');

    const dev = stage('dev');
    expect(dev).toContain(STORE_MOUNT);
    expect(dev).toContain('    pnpm install --frozen-lockfile');
    expect(dev).toContain('RUN pnpm build');

    const prod = stage('prod');
    expect(prod).toContain(STORE_MOUNT);
    expect(prod).toContain('    pnpm install --prod --frozen-lockfile');
    expect(prod.filter((line) => line.includes('pnpm install'))).toEqual([
      '    pnpm install --prod --frozen-lockfile',
    ]);
    expect(prod.filter((line) => line.includes('--from='))).toEqual(
      appEntryPoints(root).map(
        (app) =>
          `COPY --from=dev --chown=node:node /app/apps/${app.name}/dist apps/${app.name}/dist`,
      ),
    );
  });

  it('D3 copies the manifest of every workspace package, and only those, into base', () => {
    const workspaceDirs = (
      JSON.parse(
        execFileSync('pnpm', ['ls', '-r', '--depth', '-1', '--json'], {
          cwd: root,
          encoding: 'utf8',
        }),
      ) as { path: string }[]
    )
      .map((pkg) => path.relative(root, pkg.path).split(path.sep).join('/'))
      .filter((dir) => dir !== '');
    const manifestCopies = stage('base').flatMap((line) => {
      const match = /^COPY --chown=node:node (\S+)\/package\.json (\S+)\/$/.exec(line);
      return match === null ? [] : [match[1] === match[2] ? match[1] : line];
    });
    expect(manifestCopies.sort()).toEqual(workspaceDirs.sort());
  });
});

describe('package.json', () => {
  it('D4 makes tsx a dependency, so the prod stage installs it', () => {
    const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(manifest.dependencies?.tsx).toBeDefined();
    expect(manifest.devDependencies?.tsx).toBeUndefined();
  });
});
