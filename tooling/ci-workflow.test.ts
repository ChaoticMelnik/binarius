import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The CI workflow runs `pnpm check`'s coverage as parallel jobs (#877): typecheck, lint, the unit
// tests and the integration shards, beside the compose job, with one gate job named `ci`. A line
// reader of the workflow's text, the same approach as compose-text.ts: two-space job names,
// four-space job keys, six-space `- ` steps.

const root = path.resolve(import.meta.dirname, '..');
const workflow = readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8').split('\n');
const scripts = (
  JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  }
).scripts;

const jobsStart = workflow.indexOf('jobs:');
const jobNames = workflow.slice(jobsStart + 1).flatMap((line) => {
  const match = /^ {2}([\w-]+):\s*$/.exec(line);
  return match?.[1] === undefined ? [] : [match[1]];
});

function job(name: string): string[] {
  const start = workflow.findIndex((line, index) => index > jobsStart && line === `  ${name}:`);
  if (start === -1) return [];
  const end = workflow.findIndex((line, index) => index > start && /^ {0,2}[\w-]/.test(line));
  return workflow.slice(start + 1, end === -1 ? undefined : end);
}

function jobValue(name: string, key: string): string | undefined {
  for (const line of job(name)) {
    const match = /^ {4}([\w-]+):\s*(.*?)\s*$/.exec(line);
    if (match !== null && match[1] === key) return match[2];
  }
  return undefined;
}

/** The job's steps, each as its lines, the first one starting with `      - `. */
function steps(name: string): string[][] {
  const lines = job(name);
  const start = lines.indexOf('    steps:');
  if (start === -1) return [];
  const result: string[][] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^ {0,4}\S/.test(line)) break;
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (line.startsWith('      - ')) result.push([line]);
    else result.at(-1)?.push(line);
  }
  return result;
}

/** A step's one-line `run:` value, or its `name:`. */
function stepField(step: string[], field: 'run' | 'name' | 'if'): string | undefined {
  for (const line of step) {
    const match = new RegExp(`^ {6}(?:- | {2})${field}: (.+?)\\s*$`).exec(line);
    if (match?.[1] !== undefined) return match[1];
  }
  return undefined;
}

function runs(name: string): string[] {
  return steps(name).flatMap((step) => {
    const run = stepField(step, 'run');
    return run === undefined ? [] : [run];
  });
}

const PATHS =
  "['**', '!.claude/**', '!audits.md', '!docs/process-decisions.md', '.claude/skills/architect/**']";

describe('the CI workflow', () => {
  it("C1 runs pnpm check's phases as jobs, the integration tests in every shard of the matrix", () => {
    const checkSegments = (scripts.check ?? '').split(' && ');
    for (const script of ['typecheck', 'lint', 'test']) {
      expect(checkSegments, script).toContain(scripts[script]);
    }
    expect(runs('typecheck')).toContain('pnpm typecheck');
    expect(runs('lint').filter((run) => run.startsWith('pnpm lint'))).toHaveLength(1);
    expect(runs('test-unit')).toContain('pnpm test --project unit');

    const matrix = /^ {8}shard: \[(.+)\]$/
      .exec(job('test-integration').find((line) => line.startsWith('        shard:')) ?? '')?.[1]
      ?.split(', ')
      .map(Number);
    expect(matrix).toBeDefined();
    const shards = matrix?.length ?? 0;
    expect(shards).toBeGreaterThan(1);
    expect(matrix).toEqual(Array.from({ length: shards }, (_, index) => index + 1));
    expect(runs('test-integration')).toContain(
      `pnpm test --project integration --shard \${{ matrix.shard }}/${String(shards)}`,
    );
  });

  it('C2 gates on every other job, and runs even when one of them failed', () => {
    expect(jobValue('ci', 'if')).toBe('always()');
    const needs = /^\[(.*)\]$/.exec(jobValue('ci', 'needs') ?? '')?.[1]?.split(', ') ?? [];
    expect(needs.sort()).toEqual(jobNames.filter((name) => name !== 'ci').sort());
  });

  it('C3 gives the services to the integration tests alone, the schema checks to the unit job', () => {
    expect(jobNames.filter((name) => job(name).includes('    services:'))).toEqual([
      'test-integration',
    ]);
    const integration = runs('test-integration');
    const migrate = integration.indexOf('pnpm db:migrate');
    expect(migrate).toBeGreaterThan(-1);
    expect(migrate).toBeLessThan(
      integration.findIndex((run) => run.startsWith('pnpm test --project integration')),
    );
    const unitSteps = steps('test-unit');
    expect(unitSteps.map((step) => stepField(step, 'name')).filter(Boolean)).toEqual([
      'Schema changes carry a committed migration',
      'Committed migrations are immutable',
    ]);
    expect(runs('test-unit')).toContain('pnpm db:check');
    expect(job('test-unit')).toContain('          fetch-depth: 0');
  });

  it('C4 keeps the path filters of push and pull_request one list', () => {
    const paths = workflow.flatMap((line) => {
      const match = /^ {4}paths: (.+)$/.exec(line);
      return match?.[1] === undefined ? [] : [match[1]];
    });
    expect(paths).toEqual([PATHS, PATHS]);
  });

  it('C5 ends the compose job with the logs on failure and the teardown, both allowed to fail', () => {
    const [logs, down] = steps('compose').slice(-2);
    expect(logs).toEqual([
      '      - if: failure()',
      '        continue-on-error: true',
      '        run: docker compose logs',
    ]);
    expect(down).toEqual([
      '      - if: always()',
      '        continue-on-error: true',
      '        run: docker compose down -v',
    ]);
  });
});
