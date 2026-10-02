import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// The integration project carries the budgets a starved database needs and the preflight that
// refuses the wrong one (#166); a test that reaches Postgres or Redis but lands in the unit project
// runs on vitest's 5 s / 10 s defaults with no preflight, and nothing else would notice. A unit
// test named like an integration test would quietly get 60 s.

const repoRoot = path.resolve(import.meta.dirname, '..');

interface ProjectConfig {
  extends?: unknown;
  test: {
    name: string;
    include: string[];
    exclude?: string[];
    hookTimeout?: number;
    testTimeout?: number;
    globalSetup?: string[];
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
// The three env.test.ts files pass variable names to readEnv as data and never read process.env;
// a bare DATABASE_URL is the dev stack's and drizzle-kit's, which no test reads.
//
// Not seen, all deliberate: process.env through an alias (`const env = process.env; env.X`), a
// specifier held in a variable, require(). The gate narrows the class of mistake; it does not
// close it.
const ENV_NAMES = '(TEST_DATABASE_URL|REDIS_URL)';
const SERVICE_MODULES = `(pg|ioredis|bullmq|@binarius/db/testing)`;
const ENV_READS = [
  new RegExp(`process\\.env\\.${ENV_NAMES}\\b`),
  new RegExp(`process\\.env\\[\\s*['"]${ENV_NAMES}['"]\\s*\\]`),
  new RegExp(`\\{[^}]*\\b${ENV_NAMES}\\b[^}]*\\}\\s*=\\s*process\\.env\\b`),
];
const STATIC_IMPORT = new RegExp(
  `^\\s*import\\s+(type\\s+)?([^;'"]*?)\\s*from\\s*['"]${SERVICE_MODULES}['"]`,
  'gm',
);
const BARE_OR_DYNAMIC_IMPORT = new RegExp(
  `(^\\s*import\\s*['"]${SERVICE_MODULES}['"]|\\bimport\\(\\s*['"]${SERVICE_MODULES}['"]\\s*\\))`,
  'm',
);

// a clause whose every specifier is `type`-qualified (`{ type Pool }`) brings in no runtime value
function importsAValue(clause: string): boolean {
  const named = /\{([^}]*)\}/.exec(clause);
  const outside = clause
    .replace(/\{[^}]*\}/, '')
    .replace(/,/g, '')
    .trim();
  if (outside !== '') return true;
  if (named === null) return false;
  return (named[1] ?? '')
    .split(',')
    .map((specifier) => specifier.trim())
    .some((specifier) => specifier !== '' && !/^type\s/.test(specifier));
}

function isIntegration(source: string): boolean {
  if (ENV_READS.some((read) => read.test(source))) return true;
  if (/createTempDatabase\(/.test(source)) return true;
  if (BARE_OR_DYNAMIC_IMPORT.test(source)) return true;
  for (const match of source.matchAll(STATIC_IMPORT)) {
    if (match[1] === undefined && importsAValue(match[2] ?? '')) return true;
  }
  return false;
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

  it('runs the database preflight before integration tests only', () => {
    expect(project('integration').test.globalSetup).toEqual(['./tooling/integration-preflight.ts']);
    expect(project('unit').test.globalSetup).toBeUndefined();
  });

  it.each([
    ['process.env.TEST_DATABASE_URL', 'const u = process.env.TEST_DATABASE_URL;', true],
    ['process.env.REDIS_URL', 'const u = process.env.REDIS_URL;', true],
    ["process.env['X']", "const u = process.env['TEST_DATABASE_URL'];", true],
    ['process.env["X"]', 'const u = process.env["REDIS_URL"];', true],
    ['destructuring', 'const { TEST_DATABASE_URL } = process.env;', true],
    ['destructuring with an alias', 'const { REDIS_URL: url } = process.env;', true],
    ['a value import', "import { Pool } from 'pg';", true],
    ['a value import in double quotes', 'import { Queue } from "bullmq";', true],
    ['a default import', "import pg from 'pg';", true],
    ['a namespace import', 'import * as testing from "@binarius/db/testing";', true],
    [
      'a multi-line import',
      "import {\n  createTempDatabase,\n  type TempDatabase,\n} from '@binarius/db/testing';",
      true,
    ],
    ['a value beside a type', "import { type Pool, Client } from 'pg';", true],
    ['a dynamic import', "const { Redis } = await import('ioredis');", true],
    ['a dynamic import in double quotes', 'await import("pg");', true],
    ['a bare import', "import 'pg';", true],
    ['createTempDatabase(', 'tmp = await createTempDatabase(url);', true],
    ['an import type', "import type { Pool } from 'pg';", false],
    ['type-only specifiers', "import { type Pool } from 'pg';", false],
    ['a bare DATABASE_URL', 'parseEnv({ DATABASE_URL: "postgres://h/db" });', false],
    [
      'the names as data',
      "it.each(['TEST_DATABASE_URL', 'REDIS_URL'])('rejects %s', () => {});",
      false,
    ],
    ['a lookalike module', "import { x } from 'pg-format';", false],
  ])('classifies %s', (_label, source, expected) => {
    expect(isIntegration(source)).toBe(expected);
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
      // this file quotes every marker as sample source above, and reaches no service itself
      const self = path
        .relative(repoRoot, import.meta.filename)
        .split(path.sep)
        .join('/');
      const expected = testFiles.map(
        (file) =>
          `${file} ${file !== self && isIntegration(readFileSync(path.join(repoRoot, file), 'utf8')) ? 'integration' : 'unit'}`,
      );
      // both projects have to be populated, or the comparison says nothing about the markers
      expect(expected.filter((entry) => entry.endsWith(' integration')).length).toBeGreaterThan(0);
      expect(expected.filter((entry) => entry.endsWith(' unit')).length).toBeGreaterThan(0);
      expect(assigned.sort()).toEqual(expected.sort());
    },
  );
});
