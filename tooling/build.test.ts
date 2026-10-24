import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  appEntryPoints,
  BuildError,
  bundleApp,
  checkInputs,
  packageNameOf,
  undeclaredExternals,
} from './build';
import { composeServices, composeServiceValue } from './compose-text';

const root = path.resolve(import.meta.dirname, '..');
const apps = appEntryPoints(root);

it('B1 builds exactly the apps compose.yaml runs', () => {
  const base = readFileSync(path.join(root, 'compose.yaml'), 'utf8');
  const devApps = composeServices(base)
    .filter(
      (service) =>
        composeServiceValue(base, service, 'command') === `pnpm --filter @binarius/${service} dev`,
    )
    .sort();
  expect(devApps.length).toBeGreaterThan(0);
  expect(apps.map((app) => app.name)).toEqual(devApps);
});

// a real build, into a temporary directory: the repository's apps/*/dist belongs to tsc -b
describe('B2 the bundle of each app', () => {
  const out = mkdtempSync(path.join(tmpdir(), 'binarius-build-'));
  afterAll(() => {
    rmSync(out, { recursive: true, force: true });
  });

  it.each(apps.map((app) => [app.name, app]))('%s', async (name, app) => {
    const result = await bundleApp(root, app, path.join(out, name, 'index.js'));
    const imports = Object.values(result.metafile.outputs).flatMap((output) => output.imports);
    const external = imports.filter((entry) => entry.external).map((entry) => entry.path);
    expect(external.length).toBeGreaterThan(0);
    // (a) workspace code is inside, nothing relative is left to resolve at run time
    expect(external.filter((specifier) => /^(@binarius\/|\.)/.test(specifier))).toEqual([]);
    const inputs = Object.keys(result.metafile.inputs);
    // (b) third-party code stays outside
    expect(inputs.filter((input) => input.includes('node_modules/'))).toEqual([]);
    // (c) no CLI, testing or test module
    expect(
      inputs.filter((input) =>
        /\/cli\/|\/cli\.ts$|export-pages\.ts$|testing\.ts$|\.test\.ts$/.test(input),
      ),
    ).toEqual([]);
    // (d) every external package is one the app declares in dependencies
    const manifest = JSON.parse(
      readFileSync(path.join(root, 'apps', name, 'package.json'), 'utf8'),
    ) as { dependencies: Record<string, string> };
    expect(undeclaredExternals(new Set(result.externals), manifest.dependencies)).toEqual([]);
  });
});

it('B3 names the packages dependencies does not declare, builtins aside', () => {
  expect(
    undeclaredExternals(new Set(['pg', 'node:fs', 'fs', '@scope/pkg/sub', 'drizzle-orm/pg-core']), {
      pg: '^8',
      'drizzle-orm': '^0.45',
    }),
  ).toEqual(['@scope/pkg']);
});

it('B4 reduces a specifier to its package name', () => {
  expect(packageNameOf('@s/n/x/y')).toBe('@s/n');
  expect(packageNameOf('a/b/c')).toBe('a');
  expect(packageNameOf('a')).toBe('a');
});

describe('B5 refuses a bundle with a forbidden input', () => {
  it('from node_modules', () => {
    expect(() => {
      checkInputs('backend', { 'node_modules/x/index.js': {} });
    }).toThrow(BuildError);
  });

  it('a CLI module', () => {
    expect(() => {
      checkInputs('backend', { 'apps/backend/src/cli/staff.ts': {} });
    }).toThrow(BuildError);
  });

  it('a top-level cli.ts', () => {
    expect(() => {
      checkInputs('backend', { 'packages/signal-stand/src/cli.ts': {} });
    }).toThrow(BuildError);
  });

  it('accepts workspace sources', () => {
    expect(() => {
      checkInputs('backend', { 'apps/backend/src/index.ts': {}, 'packages/db/src/migrate.ts': {} });
    }).not.toThrow();
  });
});
