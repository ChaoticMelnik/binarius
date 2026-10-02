import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// The integration project carries the budgets a starved dev VM needs (#166); a test that reaches
// Postgres or Redis but lands in the unit project runs on vitest's 5 s / 10 s defaults again, and
// nothing else would notice. A unit test named like an integration test would quietly get 60 s.

const repoRoot = path.resolve(import.meta.dirname, '..');

interface ProjectConfig {
  extends?: unknown;
  test: {
    name: string;
    include: string[];
    exclude?: string[];
    hookTimeout?: number;
    testTimeout?: number;
  };
}

interface RootConfig {
  test: { include?: unknown; sequence?: { shuffle?: unknown }; projects: ProjectConfig[] };
}

// a non-literal specifier keeps vitest.config.ts out of tooling's tsc program (rootDir is tooling/)
const configModule = (await import(
  pathToFileURL(path.join(repoRoot, 'vitest.config.ts')).href
)) as {
  default: RootConfig;
  INTEGRATION_TEST_GLOB: string;
};
const config = configModule.default;

// What makes a test an integration test is that it reaches the services, not its file name.
// The three env.test.ts files pass these names to readEnv as data and never read process.env.
const INTEGRATION_MARKERS = [
  /process\.env\.(DATABASE_URL|REDIS_URL)\b/,
  /^import (?!type\b)[^;]*from '(pg|ioredis|bullmq|@binarius\/db\/testing)'/m,
  /createTempDatabase\(/,
];

function isIntegration(source: string): boolean {
  return INTEGRATION_MARKERS.some((marker) => marker.test(source));
}

// tracked or not yet staged, never ignored: the gate has to see a test before `git add`
const testFiles = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
  cwd: repoRoot,
  encoding: 'utf8',
})
  .split('\n')
  .filter((file) => file.endsWith('.test.ts') && existsSync(path.join(repoRoot, file)));

function project(name: string): ProjectConfig {
  const found = config.test.projects.find((p) => p.test.name === name);
  if (found === undefined) throw new Error(`no vitest project named ${name}`);
  return found;
}

describe('vitest projects', () => {
  it('declares exactly unit and integration, both inheriting the root config', () => {
    expect(config.test.projects.map((p) => p.test.name)).toEqual(['unit', 'integration']);
    expect(config.test.projects.map((p) => p.extends)).toEqual([true, true]);
    expect(config.test.sequence?.shuffle).toBe(false);
    expect(config.test.include).toBeUndefined();
  });

  it('gives integration a hook budget above its test budget, and leaves unit on the defaults', () => {
    const integration = project('integration').test;
    expect(integration.include).toEqual([configModule.INTEGRATION_TEST_GLOB]);
    const { testTimeout, hookTimeout } = integration;
    if (testTimeout === undefined || hookTimeout === undefined) {
      throw new Error('the integration project must set both testTimeout and hookTimeout');
    }
    expect(testTimeout).toBeLessThan(hookTimeout);
    const unit = project('unit').test;
    expect(unit.testTimeout).toBeUndefined();
    expect(unit.hookTimeout).toBeUndefined();
  });

  // a pattern starting with a wildcard would also collect other agents' worktrees under
  // .claude/worktrees/
  it('anchors every include pattern at the repository root', () => {
    const patterns = config.test.projects.flatMap((p) => p.test.include);
    expect(patterns.length).toBeGreaterThan(0);
    expect(patterns.filter((pattern) => pattern.startsWith('*'))).toEqual([]);
  });

  // vitest's own resolution, not a re-implementation of its include/exclude semantics
  it(
    'runs every test file in exactly the project its markers call for',
    { timeout: 30_000 },
    () => {
      const listed = JSON.parse(
        execFileSync('pnpm', ['exec', 'vitest', 'list', '--filesOnly', '--json'], {
          cwd: repoRoot,
          encoding: 'utf8',
        }),
      ) as { file: string; projectName: string }[];
      const assigned = listed.map(
        ({ file, projectName }) =>
          `${path.relative(repoRoot, file).split(path.sep).join('/')} ${projectName}`,
      );
      const expected = testFiles.map(
        (file) =>
          `${file} ${isIntegration(readFileSync(path.join(repoRoot, file), 'utf8')) ? 'integration' : 'unit'}`,
      );
      // both projects have to be populated, or the comparison says nothing about the markers
      expect(expected.filter((entry) => entry.endsWith(' integration')).length).toBeGreaterThan(0);
      expect(expected.filter((entry) => entry.endsWith(' unit')).length).toBeGreaterThan(0);
      expect(assigned.sort()).toEqual(expected.sort());
    },
  );
});
