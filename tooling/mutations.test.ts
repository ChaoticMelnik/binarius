import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MutationsError,
  parseMutationList,
  runMutations,
  vitestArgs,
  type Mutation,
  type Runner,
  type RunnerResult,
  type VitestReport,
} from './mutations';

const SOURCE =
  'export const a = 1;\nexport const b = 2;\nexport const twice = 3;\nexport const again = 3;\n';

let root: string;
let out: string;
let listPath: string;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function head(): string {
  return readFileSync(path.join(root, 'src/a.ts'), 'utf8');
}

function writeList(list: unknown): void {
  writeFileSync(listPath, JSON.stringify(list));
}

function mutation(id: string, edits: Mutation['edits'], expectNames = ['a works']): Mutation {
  return { id, edits, tests: ['src/a.test.ts'], expect: expectNames };
}

function report(
  ...files: { status: string; message?: string; failed?: string[]; passed?: string[] }[]
): VitestReport {
  return {
    testResults: files.map((f) => ({
      name: 'src/a.test.ts',
      status: f.status,
      message: f.message ?? '',
      assertionResults: [
        ...(f.failed ?? []).map((fullName) => ({
          fullName,
          status: 'failed',
          failureMessages: [`AssertionError: ${fullName} | broke\n    at line 2`],
        })),
        ...(f.passed ?? []).map((fullName) => ({
          fullName,
          status: 'passed',
          failureMessages: [],
        })),
      ],
    })),
  };
}

// the injected runner answers per mutation id (the report file is <out>/<id>.json)
function fakeRunner(byId: Record<string, RunnerResult | (() => RunnerResult)>) {
  const calls: { id: string; tests: string[]; seen: string }[] = [];
  const runner: Runner = (tests, reportFile) => {
    const id = path.basename(reportFile, '.json');
    calls.push({ id, tests, seen: head() });
    const answer = byId[id];
    if (answer === undefined) throw new Error(`no answer for ${id}`);
    return Promise.resolve(typeof answer === 'function' ? answer() : answer);
  };
  return { runner, calls };
}

function redOnly(...names: string[]): RunnerResult {
  return { exit: 1, report: report({ status: 'failed', failed: names }), stderrTail: '' };
}

function run(runner: Runner, only?: string[]) {
  return runMutations({ root, listPath, only, out, runner });
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'mutations-'));
  out = path.join(root, '.out');
  listPath = path.join(root, '.list.json');
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, 'src/a.ts'), SOURCE);
  writeFileSync(path.join(root, '.gitignore'), '.out/\n.list.json\n');
  git('init', '-q');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.');
  git(
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '-m',
    'init',
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('runMutations', () => {
  it('T1: only the expected test fails -> red, exit 0', async () => {
    writeList([mutation('M1', [{ file: 'src/a.ts', old: 'a = 1', new: 'a = 0' }])]);
    const outcome = await run(fakeRunner({ M1: redOnly('a works') }).runner);
    expect(outcome.rows.map((r) => r.kind)).toEqual(['red']);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.rows[0]?.firstLine).toBe('AssertionError: a works | broke');
    expect(readFileSync(outcome.tablePath, 'utf8')).toContain(
      '| M1 | a works | red | AssertionError: a works \\| broke |',
    );
  });

  it('T2: a test outside expect fails too -> red+extra naming it, exit 1', async () => {
    writeList([mutation('M1', [{ file: 'src/a.ts', old: 'a = 1', new: 'a = 0' }])]);
    const outcome = await run(fakeRunner({ M1: redOnly('a works', 'b works') }).runner);
    expect(outcome.rows[0]?.kind).toBe('red+extra');
    expect(outcome.rows[0]?.detail).toBe('b works');
    expect(outcome.exitCode).toBe(1);
  });

  it('T3: an expect entry matches no failure -> red-partial naming it', async () => {
    writeList([
      mutation('M1', [{ file: 'src/a.ts', old: 'a = 1', new: 'a = 0' }], ['a works', 'b works']),
    ]);
    const outcome = await run(fakeRunner({ M1: redOnly('a works') }).runner);
    expect(outcome.rows[0]?.kind).toBe('red-partial');
    expect(outcome.rows[0]?.detail).toBe('b works');
    expect(outcome.exitCode).toBe(1);
  });

  it('T4: nothing fails -> green, exit 1', async () => {
    writeList([mutation('M1', [{ file: 'src/a.ts', old: 'a = 1', new: 'a = 0' }])]);
    const outcome = await run(
      fakeRunner({
        M1: { exit: 0, report: report({ status: 'passed', passed: ['a works'] }), stderrTail: '' },
      }).runner,
    );
    expect(outcome.rows[0]?.kind).toBe('green');
    expect(outcome.exitCode).toBe(1);
  });

  it('T5: a test file failed without a failed test -> load-error', async () => {
    writeList([mutation('M1', [{ file: 'src/a.ts', old: 'a = 1', new: 'a = 0' }])]);
    const outcome = await run(
      fakeRunner({
        M1: {
          exit: 1,
          report: report({ status: 'failed', message: 'SyntaxError: nope\nmore' }),
          stderrTail: '',
        },
      }).runner,
    );
    expect(outcome.rows[0]?.kind).toBe('load-error');
    expect(outcome.rows[0]?.firstLine).toBe('SyntaxError: nope');
    expect(outcome.exitCode).toBe(1);
  });

  it('T6: no JSON report -> no-report with the exit code', async () => {
    writeList([mutation('M1', [{ file: 'src/a.ts', old: 'a = 1', new: 'a = 0' }])]);
    const outcome = await run(
      fakeRunner({ M1: { exit: 7, report: undefined, stderrTail: 'boom' } }).runner,
    );
    expect(outcome.rows[0]?.kind).toBe('no-report');
    expect(outcome.rows[0]?.detail).toBe('exit 7, boom');
    expect(outcome.exitCode).toBe(1);
  });

  it('T7: an old found 0 or 2 times -> error row, file unchanged, runner not called', async () => {
    writeList([
      mutation('M1', [{ file: 'src/a.ts', old: 'absent', new: 'x' }]),
      mutation('M2', [{ file: 'src/a.ts', old: '= 3', new: '= 4' }]),
    ]);
    const { runner, calls } = fakeRunner({});
    const outcome = await run(runner);
    expect(outcome.rows.map((r) => [r.kind, r.detail])).toEqual([
      ['error', 'pattern ×0 in src/a.ts'],
      ['error', 'pattern ×2 in src/a.ts'],
    ]);
    expect(calls).toEqual([]);
    expect(head()).toBe(SOURCE);
  });

  it('T8: an uncommitted edit in an edited file -> refusal (exit 2), edit kept, runner not called', async () => {
    writeList([mutation('M1', [{ file: 'src/a.ts', old: 'a = 1', new: 'a = 0' }])]);
    const dirty = `${SOURCE}// work in progress\n`;
    writeFileSync(path.join(root, 'src/a.ts'), dirty);
    const { runner, calls } = fakeRunner({ M1: redOnly('a works') });
    const error = await run(runner).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MutationsError);
    expect((error as MutationsError).exitCode).toBe(2);
    expect(head()).toBe(dirty);
    expect(calls).toEqual([]);
  });

  it('T8b: an uncommitted change outside the edited files, or an untracked file -> refusal (exit 2)', async () => {
    writeList([mutation('M1', [{ file: 'src/a.ts', old: 'a = 1', new: 'a = 0' }])]);
    const { runner, calls } = fakeRunner({ M1: redOnly('a works') });
    const gitignore = readFileSync(path.join(root, '.gitignore'), 'utf8');
    writeFileSync(path.join(root, '.gitignore'), `${gitignore}extra/\n`);
    const tracked = await run(runner).catch((e: unknown) => e);
    expect((tracked as MutationsError).exitCode).toBe(2);
    expect(readFileSync(path.join(root, '.gitignore'), 'utf8')).toBe(`${gitignore}extra/\n`);
    writeFileSync(path.join(root, '.gitignore'), gitignore);
    writeFileSync(path.join(root, 'src/new.ts'), 'export {};\n');
    const untracked = await run(runner).catch((e: unknown) => e);
    expect((untracked as MutationsError).exitCode).toBe(2);
    expect((untracked as MutationsError).message).toContain('src/new.ts');
    expect(calls).toEqual([]);
    expect(head()).toBe(SOURCE);
  });

  it('T9: the runner throws -> the file is back at HEAD', async () => {
    writeList([mutation('M1', [{ file: 'src/a.ts', old: 'a = 1', new: 'a = 0' }])]);
    const error = await run(
      fakeRunner({
        M1: () => {
          throw new Error('runner died');
        },
      }).runner,
    ).catch((e: unknown) => e);
    expect((error as Error).message).toBe('runner died');
    expect(head()).toBe(SOURCE);
  });

  it('T10: the runner sees the mutated text, HEAD text after it', async () => {
    writeList([
      mutation('M1', [
        { file: 'src/a.ts', old: 'a = 1', new: 'a = 0' },
        { file: 'src/a.ts', old: 'a = 0;\nexport const b', new: 'a = 5;\nexport const b' },
      ]),
    ]);
    const { runner, calls } = fakeRunner({ M1: redOnly('a works') });
    await run(runner);
    expect(calls[0]?.seen).toBe(SOURCE.replace('a = 1', 'a = 5'));
    expect(head()).toBe(SOURCE);
  });

  it('T11: the header carries the head and the sha256 of the list file', async () => {
    writeList([mutation('M1', [{ file: 'src/a.ts', old: 'a = 1', new: 'a = 0' }])]);
    const outcome = await run(fakeRunner({ M1: redOnly('a works') }).runner);
    const header = readFileSync(outcome.tablePath, 'utf8').split('\n')[0] ?? '';
    const sha = createHash('sha256').update(readFileSync(listPath)).digest('hex');
    expect(header).toContain(` head=${git('rev-parse', 'HEAD')} `);
    expect(header).toContain(` list-sha256=${sha} `);
    expect(header).toContain(' only=all ');
  });

  it('T12: --only runs only the named mutation and says so in the header', async () => {
    writeList([
      mutation('M1', [{ file: 'src/a.ts', old: 'a = 1', new: 'a = 0' }]),
      mutation('M2', [{ file: 'src/a.ts', old: 'b = 2', new: 'b = 0' }]),
    ]);
    const { runner, calls } = fakeRunner({ M1: redOnly('a works'), M2: redOnly('a works') });
    const outcome = await run(runner, ['M2']);
    expect(calls.map((c) => c.id)).toEqual(['M2']);
    expect(outcome.rows.map((r) => r.id)).toEqual(['M2']);
    expect(readFileSync(outcome.tablePath, 'utf8').split('\n')[0]).toContain(' only=M2 ');
  });
});

describe('classify through runMutations', () => {
  it('T18: a tests entry that matched no test file -> not-run naming it', async () => {
    writeList([mutation('M1', [{ file: 'src/a.ts', old: 'a = 1', new: 'a = 0' }])]);
    const empty = await run(
      fakeRunner({ M1: { exit: 1, report: { testResults: [] }, stderrTail: '' } }).runner,
    );
    expect(empty.rows[0]?.kind).toBe('not-run');
    expect(empty.rows[0]?.detail).toBe('no test file matched src/a.test.ts');
    writeList([
      {
        ...mutation('M1', [{ file: 'src/a.ts', old: 'a = 1', new: 'a = 0' }]),
        tests: ['src/a.test.ts', 'src/b.test.ts'],
      },
    ]);
    const partial = await run(fakeRunner({ M1: redOnly('a works') }).runner);
    expect(partial.rows[0]?.kind).toBe('not-run');
    expect(partial.rows[0]?.detail).toBe('no test file matched src/b.test.ts');
    expect(partial.exitCode).toBe(1);
  });

  it('T19: vitest exited non-zero with every test passed -> not-run, not green', async () => {
    writeList([mutation('M1', [{ file: 'src/a.ts', old: 'a = 1', new: 'a = 0' }])]);
    const outcome = await run(
      fakeRunner({
        M1: {
          exit: 1,
          report: report({ status: 'passed', passed: ['a works'] }),
          stderrTail: 'Unhandled Rejection',
        },
      }).runner,
    );
    expect(outcome.rows[0]?.kind).toBe('not-run');
    expect(outcome.rows[0]?.detail).toBe('exit 1 without a failed test, Unhandled Rejection');
    expect(outcome.exitCode).toBe(1);
  });
});

// The CLI with the real default runner and a real child process: PATH holds only a git wrapper
// and, where a case needs one, a fake pnpm, so no real vitest runs.
describe('the CLI', () => {
  const script = fileURLToPath(new URL('./mutations.ts', import.meta.url));
  // a non-literal import, as in tooling/vitest-projects.test.ts: tooling's rootDir is tooling/
  const testing = async () =>
    (await import(
      pathToFileURL(fileURLToPath(new URL('../packages/shared/src/testing.ts', import.meta.url)))
        .href
    )) as { until: (what: string, condition: () => boolean) => Promise<void> };
  const which = (name: string) =>
    execFileSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim();
  let bin: string;

  beforeEach(() => {
    bin = mkdtempSync(path.join(tmpdir(), 'mutations-bin-'));
    writeExecutable('git', `#!/bin/sh\nexec ${which('git')} "$@"\n`);
    writeList([mutation('M1', [{ file: 'src/a.ts', old: 'a = 1', new: 'a = 0' }])]);
  });

  afterEach(() => {
    rmSync(bin, { recursive: true, force: true });
  });

  function writeExecutable(name: string, body: string): void {
    writeFileSync(path.join(bin, name), body);
    chmodSync(path.join(bin, name), 0o755);
  }

  function cli(onStart?: (child: ReturnType<typeof spawn>) => void) {
    return new Promise<{ code: number | null; stderr: string; stdout: string }>(
      (resolve, reject) => {
        const child = spawn(process.execPath, [script, listPath, '--out', out], {
          cwd: root,
          env: { PATH: bin },
        });
        let stderr = '';
        let stdout = '';
        child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
        child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, stderr, stdout }));
        onStart?.(child);
      },
    );
  }

  it('T15: pnpm not found -> exit 3 naming ENOENT, the file back at HEAD', async () => {
    const result = await cli();
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('ENOENT');
    expect(head()).toBe(SOURCE);
    expect(git('status', '--porcelain')).toBe('');
  }, 20_000);

  it('T16: a truncated report -> no-report row, exit 1, the file back at HEAD', async () => {
    writeExecutable(
      'pnpm',
      '#!/bin/sh\nfor a in "$@"; do case "$a" in --outputFile=*) printf \'{"testResults":[\' > "${a#--outputFile=}";; esac; done\nexit 1\n',
    );
    const result = await cli();
    expect(result.code).toBe(1);
    expect(readFileSync(path.join(out, 'table.md'), 'utf8')).toContain(
      '| M1 | a works | no-report: exit 1, report is not JSON |',
    );
    expect(head()).toBe(SOURCE);
    expect(git('status', '--porcelain')).toBe('');
  }, 20_000);

  it('T17: SIGTERM while the runner works -> exit 130, the file back at HEAD', async () => {
    const marker = path.join(bin, 'started');
    writeExecutable('pnpm', `#!/bin/sh\n: > ${marker}\nexec ${which('sleep')} 10\n`);
    const { until } = await testing();
    let child: ReturnType<typeof spawn> | undefined;
    const done = cli((started) => (child = started));
    try {
      await until('the fake pnpm to start', () => existsSync(marker));
    } finally {
      child?.kill('SIGTERM');
    }
    const result = await done;
    expect(result.code).toBe(130);
    expect(head()).toBe(SOURCE);
    expect(git('status', '--porcelain')).toBe('');
  }, 20_000);
});

describe('parseMutationList', () => {
  const valid = {
    id: 'M1',
    edits: [{ file: 'src/a.ts', old: 'a', new: 'b' }],
    tests: ['src/a.test.ts'],
    expect: ['x'],
  };

  it('T13: refuses a duplicate id, an empty expect and a ../ path', () => {
    const exitOf = (list: unknown) => {
      try {
        parseMutationList(JSON.stringify(list));
      } catch (error) {
        return (error as MutationsError).exitCode;
      }
      return undefined;
    };
    expect(exitOf([valid])).toBeUndefined();
    expect(exitOf([valid, valid])).toBe(2);
    expect(exitOf([{ ...valid, expect: [] }])).toBe(2);
    expect(exitOf([{ ...valid, edits: [{ file: '../a.ts', old: 'a', new: 'b' }] }])).toBe(2);
    expect(exitOf([{ ...valid, tests: ['src/../../x.test.ts'] }])).toBe(2);
  });
});

describe('vitestArgs', () => {
  it('T14: the default runner calls vitest run with the JSON reporter', () => {
    expect(vitestArgs(['a.test.ts', 'b.test.ts'], '/o/M1.json')).toEqual([
      'exec',
      'vitest',
      'run',
      '--reporter=json',
      '--outputFile=/o/M1.json',
      'a.test.ts',
      'b.test.ts',
    ]);
  });
});
