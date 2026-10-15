import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { parseArgs, stripVTControlCharacters } from 'node:util';

// Mutation evidence in one call (decision of the owner 2026-10-15, #511): apply each mutation of
// a list, run its test files, record a table row, put the files back. Hand-made tables and
// mutations run one at a time are a process deviation (.claude/CLAUDE.md -> Постоянные ответы
// владельца -> «Доказательства мутаций»).
//
//   node tooling/mutations.ts <list.json> --out <dir> [--only M1,M2]
//
// The list is a JSON array:
//   [{ "id": "M1",
//      "edits": [{ "file": "<repo-relative>", "old": "<exact text>", "new": "<text>" }],
//      "tests": ["<repo-relative test file>"],
//      "expect": ["<substring of the vitest fullName of a test that must fail>"] }]
// Each `old` must occur exactly once in its file (after the mutation's earlier edits). The working
// tree must be clean (`git status --porcelain` empty), so `head=` certifies exactly that commit;
// keep the list and --out outside it or ignored. The runner restores the edited files from memory
// and then compares them byte for byte with HEAD, and it never touches git's index, stash or
// checkout (#460).
//
// Output: <dir>/table.md (a header line with the head and the list's sha256, then the table),
// <dir>/<id>.json and <dir>/<id>.log per mutation, one summary line on stdout. The environment
// is inherited, so an integration test uses the caller's TEST_DATABASE_URL.
//
// Result per row: red (only the expected tests failed, each expect matched), red+extra (a test
// outside expect failed too - not discriminating), red-partial (some expect matched no failure),
// green (the mutation survived: exit 0, every `tests` entry ran, nothing failed), load-error (a
// test file failed without a failed test), not-run (a `tests` entry matched no test file, or
// vitest exited non-zero without a failed test), no-report (vitest wrote no JSON report, or one
// that is not JSON), error (an `old` did not occur exactly once).
//
// Exit codes: 0 every row red; 1 any other row; 2 bad usage, bad list or a working tree that is
// not clean (nothing touched); 3 the runner itself failed, including a file that did not come
// back to HEAD; 130 interrupted by SIGINT/SIGTERM, after the mutation in flight was put back.

export interface Edit {
  file: string;
  old: string;
  new: string;
}

export interface Mutation {
  id: string;
  edits: Edit[];
  tests: string[];
  expect: string[];
}

interface AssertionResult {
  fullName: string;
  status: string;
  failureMessages?: string[];
}

export interface VitestReport {
  testResults: {
    name?: string;
    status: string;
    message?: string;
    assertionResults: AssertionResult[];
  }[];
}

export interface RunnerResult {
  exit: number;
  report: VitestReport | undefined;
  stderrTail: string;
}

export type Runner = (
  tests: string[],
  reportFile: string,
  logFile: string,
) => Promise<RunnerResult>;

export type Kind =
  'red' | 'red+extra' | 'red-partial' | 'green' | 'load-error' | 'not-run' | 'no-report' | 'error';

export interface Row {
  id: string;
  expect: string[];
  kind: Kind;
  detail: string;
  firstLine: string;
}

export class MutationsError extends Error {
  readonly exitCode: 2 | 3;

  constructor(message: string, exitCode: 2 | 3) {
    super(message);
    this.name = 'MutationsError';
    this.exitCode = exitCode;
  }
}

const ID_RE = /^[A-Za-z0-9_.-]+$/;
const FIRST_LINE_MAX = 200;

function relativePath(value: unknown, what: string): string {
  if (typeof value !== 'string' || value === '') throw new MutationsError(`${what}: not a path`, 2);
  if (path.isAbsolute(value) || value.split(/[\\/]/).includes('..')) {
    throw new MutationsError(`${what}: ${value} must be repo-relative without ..`, 2);
  }
  return value;
}

function nonEmptyArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0) throw new MutationsError(`${what}: empty`, 2);
  return value;
}

export function parseMutationList(text: string): Mutation[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new MutationsError('the list is not JSON', 2);
  }
  const ids = new Set<string>();
  return nonEmptyArray(raw, 'the list').map((entry, index) => {
    const m = (entry ?? {}) as Record<string, unknown>;
    const id = m.id;
    if (typeof id !== 'string' || !ID_RE.test(id)) {
      throw new MutationsError(`entry ${index}: id must match ${ID_RE.source}`, 2);
    }
    if (ids.has(id)) throw new MutationsError(`${id}: duplicate id`, 2);
    ids.add(id);
    const edits = nonEmptyArray(m.edits, `${id}.edits`).map((e, i) => {
      const edit = (e ?? {}) as Record<string, unknown>;
      if (typeof edit.old !== 'string' || edit.old === '' || typeof edit.new !== 'string') {
        throw new MutationsError(
          `${id}.edits[${i}]: old must be a non-empty string, new a string`,
          2,
        );
      }
      return {
        file: relativePath(edit.file, `${id}.edits[${i}].file`),
        old: edit.old,
        new: edit.new,
      };
    });
    const tests = nonEmptyArray(m.tests, `${id}.tests`).map((t, i) =>
      relativePath(t, `${id}.tests[${i}]`),
    );
    const expect = nonEmptyArray(m.expect, `${id}.expect`).map((x, i) => {
      if (typeof x !== 'string' || x === '')
        throw new MutationsError(`${id}.expect[${i}]: empty`, 2);
      return x;
    });
    return { id, edits, tests, expect };
  });
}

function firstLineOf(message: string | undefined): string {
  const line =
    stripVTControlCharacters(message ?? '')
      .trim()
      .split('\n')[0] ?? '';
  return line.slice(0, FIRST_LINE_MAX);
}

export function classify(
  { exit, report, stderrTail }: RunnerResult,
  { tests, expect }: Pick<Mutation, 'tests' | 'expect'>,
): { kind: Kind; detail: string; firstLine: string } {
  if (report === undefined) {
    return { kind: 'no-report', detail: `exit ${exit}, ${stderrTail}`, firstLine: '' };
  }
  const unmatchedTests = tests.filter(
    (t) => !report.testResults.some((file) => (file.name ?? '').includes(t)),
  );
  if (unmatchedTests.length > 0) {
    return {
      kind: 'not-run',
      detail: `no test file matched ${unmatchedTests.join('; ')}`,
      firstLine: '',
    };
  }
  const loadFailed = report.testResults.filter(
    (file) => file.status === 'failed' && !file.assertionResults.some((a) => a.status === 'failed'),
  );
  if (loadFailed.length > 0) {
    const first = loadFailed[0];
    return {
      kind: 'load-error',
      detail: first?.name ?? '',
      firstLine: firstLineOf(first?.message),
    };
  }
  const failed = report.testResults.flatMap((file) =>
    file.assertionResults.filter((a) => a.status === 'failed'),
  );
  if (failed.length === 0 && exit !== 0) {
    return {
      kind: 'not-run',
      detail: `exit ${exit} without a failed test, ${stderrTail}`,
      firstLine: '',
    };
  }
  if (failed.length === 0) return { kind: 'green', detail: '', firstLine: '' };
  const firstLine = firstLineOf(failed[0]?.failureMessages?.[0]);
  const extra = failed.filter((a) => !expect.some((x) => a.fullName.includes(x)));
  if (extra.length > 0) {
    return { kind: 'red+extra', detail: extra.map((a) => a.fullName).join('; '), firstLine };
  }
  const unmatched = expect.filter((x) => !failed.some((a) => a.fullName.includes(x)));
  if (unmatched.length > 0) return { kind: 'red-partial', detail: unmatched.join('; '), firstLine };
  return { kind: 'red', detail: '', firstLine };
}

function cell(text: string): string {
  return text.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

export function renderTable(header: string, rows: Row[]): string {
  const lines = [
    header,
    '',
    '| mutation | expected test | result | first failing line |',
    '|---|---|---|---|',
    ...rows.map((row) => {
      const result = row.detail === '' ? row.kind : `${row.kind}: ${row.detail}`;
      return `| ${cell(row.id)} | ${cell(row.expect.join('; '))} | ${cell(result)} | ${cell(row.firstLine)} |`;
    }),
  ];
  return `${lines.join('\n')}\n`;
}

export function vitestArgs(tests: string[], reportFile: string): string[] {
  return ['exec', 'vitest', 'run', '--reporter=json', `--outputFile=${reportFile}`, ...tests];
}

export function defaultRunner(root: string): Runner {
  return (tests, reportFile, logFile) =>
    new Promise((resolve, reject) => {
      const fd = openSync(logFile, 'w');
      const child = spawn('pnpm', vitestArgs(tests, reportFile), {
        cwd: root,
        stdio: ['ignore', fd, fd],
      });
      // a throw inside a listener is an uncaught exception that skips runMutations' finally (#511
      // M1), and Node emits 'close' after 'error' too: settle once, close the fd once
      let settled = false;
      const settle = (outcome: () => RunnerResult): void => {
        if (settled) return;
        settled = true;
        try {
          closeSync(fd);
          resolve(outcome());
        } catch (error) {
          reject(error as Error);
        }
      };
      child.on('error', (error) => {
        settle(() => {
          throw error;
        });
      });
      child.on('close', (code, signal) => {
        settle(() => {
          let report: VitestReport | undefined;
          let note = '';
          if (existsSync(reportFile)) {
            try {
              report = JSON.parse(readFileSync(reportFile, 'utf8')) as VitestReport;
            } catch {
              note = 'report is not JSON';
            }
          }
          const tail = stripVTControlCharacters(readFileSync(logFile, 'utf8'))
            .trim()
            .split('\n')
            .slice(-3)
            .join(' / ');
          return {
            exit: code ?? (signal === null ? 1 : 128),
            report,
            stderrTail: [note, tail].filter((part) => part !== '').join(', '),
          };
        });
      });
    });
}

function git(root: string, args: string[]): Buffer {
  return execFileSync('git', args, { cwd: root, maxBuffer: 256 * 1024 * 1024 });
}

// the originals of the mutation in flight, so a signal handler can put them back
let inFlight: { root: string; originals: Map<string, Buffer> } | undefined;

export function restoreInFlight(): void {
  if (inFlight === undefined) return;
  for (const [file, original] of inFlight.originals)
    writeFileSync(path.join(inFlight.root, file), original);
  inFlight = undefined;
}

export interface RunOptions {
  root: string;
  listPath: string;
  only: string[] | undefined;
  out: string;
  runner: Runner;
}

export interface RunOutcome {
  exitCode: 0 | 1;
  rows: Row[];
  summary: string;
  tablePath: string;
}

export async function runMutations({
  root,
  listPath,
  only,
  out,
  runner,
}: RunOptions): Promise<RunOutcome> {
  const listBytes = readFileSync(listPath);
  const list = parseMutationList(listBytes.toString('utf8'));
  const known = new Set(list.map((m) => m.id));
  const unknown = (only ?? []).filter((id) => !known.has(id));
  if (unknown.length > 0) throw new MutationsError(`--only: unknown id ${unknown.join(', ')}`, 2);
  const selected = only === undefined ? list : list.filter((m) => only.includes(m.id));

  const dirty = git(root, ['status', '--porcelain']).toString('utf8').trim();
  if (dirty !== '') {
    throw new MutationsError(`the working tree must be clean:\n${dirty}`, 2);
  }
  const head = git(root, ['rev-parse', 'HEAD']).toString('utf8').trim();
  mkdirSync(out, { recursive: true });

  const rows: Row[] = [];
  for (const mutation of selected) {
    const originals = new Map<string, Buffer>();
    let row: Row | undefined;
    try {
      const texts = new Map<string, string>();
      for (const edit of mutation.edits) {
        if (!originals.has(edit.file)) {
          const original = readFileSync(path.join(root, edit.file));
          originals.set(edit.file, original);
          texts.set(edit.file, original.toString('utf8'));
        }
        const text = texts.get(edit.file) ?? '';
        const count = text.split(edit.old).length - 1;
        if (count !== 1) {
          row = {
            id: mutation.id,
            expect: mutation.expect,
            kind: 'error',
            detail: `pattern ×${count} in ${edit.file}`,
            firstLine: '',
          };
          break;
        }
        texts.set(
          edit.file,
          text.replace(edit.old, () => edit.new),
        );
      }
      if (row === undefined) {
        inFlight = { root, originals };
        for (const [file, text] of texts) writeFileSync(path.join(root, file), text);
        const reportFile = path.join(out, `${mutation.id}.json`);
        rmSync(reportFile, { force: true });
        const result = await runner(
          mutation.tests,
          reportFile,
          path.join(out, `${mutation.id}.log`),
        );
        row = { id: mutation.id, expect: mutation.expect, ...classify(result, mutation) };
      }
    } finally {
      for (const [file, original] of originals) writeFileSync(path.join(root, file), original);
      inFlight = undefined;
    }
    for (const file of originals.keys()) {
      if (!readFileSync(path.join(root, file)).equals(git(root, ['show', `HEAD:${file}`]))) {
        throw new MutationsError(`${file} did not come back to HEAD after ${mutation.id}`, 3);
      }
    }
    rows.push(row);
  }

  const header = [
    'mutations.ts',
    `list=${listPath}`,
    `list-sha256=${createHash('sha256').update(listBytes).digest('hex')}`,
    `head=${head}`,
    `only=${only === undefined ? 'all' : only.join(',')}`,
    `at=${new Date().toISOString()}`,
    `node=${process.version}`,
  ].join(' ');
  const tablePath = path.join(out, 'table.md');
  writeFileSync(tablePath, renderTable(header, rows));

  const count = (...kinds: Kind[]) => rows.filter((r) => kinds.includes(r.kind)).length;
  const summary = [
    `total=${rows.length}`,
    `red=${count('red')}`,
    `extra=${count('red+extra')}`,
    `partial=${count('red-partial')}`,
    `green=${count('green')}`,
    `errors=${count('load-error', 'not-run', 'no-report', 'error')}`,
    `table=${tablePath}`,
  ].join(' ');
  const exitCode = rows.length > 0 && count('red') === rows.length ? 0 : 1;
  return { exitCode, rows, summary, tablePath };
}

const USAGE = 'usage: node tooling/mutations.ts <list.json> --out <dir> [--only id1,id2]';

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: { out: { type: 'string' }, only: { type: 'string' } },
    });
  } catch {
    throw new MutationsError(USAGE, 2);
  }
  const [listPath, ...rest] = parsed.positionals;
  const out = parsed.values.out;
  if (listPath === undefined || rest.length > 0 || out === undefined)
    throw new MutationsError(USAGE, 2);
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const outcome = await runMutations({
    root,
    listPath,
    only: parsed.values.only?.split(',').filter((id) => id !== ''),
    out: path.resolve(out),
    runner: defaultRunner(root),
  });
  console.log(outcome.summary);
  process.exitCode = outcome.exitCode;
}

function fail(error: unknown): never {
  restoreInFlight();
  if (error instanceof MutationsError) {
    console.error(`mutations: ${error.message}`);
    process.exit(error.exitCode);
  }
  console.error(`mutations failed: ${(error as Error).name}: ${(error as Error).message}`);
  process.exit(3);
}

if (import.meta.main) {
  const interrupt = (): void => {
    restoreInFlight();
    process.exit(130);
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  process.on('uncaughtException', fail);
  main().catch(fail);
}
