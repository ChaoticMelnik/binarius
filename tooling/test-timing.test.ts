import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// A deadline written into a test sits below the runner's budget and fails on a loaded host
// (#205). Waits go through until() from @binarius/shared/testing, whose ceiling is per project and
// gated below that project's testTimeout (tooling/vitest-projects.test.ts). This scan fails
// `pnpm check` on the four forms such a deadline takes. It is regex-based: a deadline built
// another way (performance.now(), a ceiling held under some other name, a reject timer in a
// fake) is not seen, and the forms grow when one slips through.

const repoRoot = path.resolve(import.meta.dirname, '..');
const self = 'tooling/test-timing.test.ts';

type Form = 'F1' | 'F2' | 'F3' | 'F4';

const ADVICE: Record<Form, string> = {
  F1: 'a polling loop with its own deadline - use until(what, condition)',
  F2: 'vi.waitFor/vi.waitUntil carries its own ceiling - use until(what, condition)',
  F3: 'an elapsed-time ceiling written as a number - use UNIT_WAIT_CEILING_MS / INTEGRATION_WAIT_CEILING_MS, or prove it structurally',
  F4: 'a fixed wait - wait with until() on what the next step reads, or list it in ALLOWED with its reason',
};

const DEADLINE_NAME = String.raw`\w*(?:deadline|until|ceiling)\w*`;
const F1_PATTERNS = [
  new RegExp(String.raw`Date\.now\(\)\s*[<>]=?\s*${DEADLINE_NAME}`, 'i'),
  new RegExp(String.raw`\b${DEADLINE_NAME}\s*[<>]=?\s*Date\.now\(\)`, 'i'),
  new RegExp(String.raw`\b${DEADLINE_NAME}\s*=\s*Date\.now\(\)\s*\+`, 'i'),
];
const F2_PATTERN = /\bvi\.(?:waitFor|waitUntil)\(/;
const SHARED_CEILINGS = new Set(['UNIT_WAIT_CEILING_MS', 'INTEGRATION_WAIT_CEILING_MS']);
const F3_CEILING = /toBeLessThan(?:OrEqual)?\(\s*([0-9][0-9_]*|[A-Z][A-Z0-9_]*)\s*\)/;
const F3_TIMED = /Date\.now\(\)|elapsed|duration|took|Age(?:Ms|Sec)\b|\bage\b/;
// the delay argument of a fixed wait; a literal 0 is a turn of the event loop, not a wait
const isZero = (argument: string): boolean => /^\s*0\s*$/.test(argument);
const PROMISE_WAIT =
  /await new Promise(?:<\w+>)?\(\s*\(?\s*\w*\s*\)?\s*=>\s*setTimeout\(\s*\w+\s*,\s*([^)]*)\)/;
const WRAPPER_DEFINITION =
  /\b(?:const|function)\s+(\w+)\s*=?\s*(?:async\s*)?\(\s*(\w*)[^)]*\)\s*(?::[^=>{]*)?(?:=>)?\s*\{?\s*(?:return\s+)?new Promise(?:<\w+>)?\(\s*\(?\s*\w*\s*\)?\s*=>\s*setTimeout\(\s*\w+\s*,\s*([^)]*)\)/g;

// `const settle = () => new Promise((r) => setTimeout(r, 20))`, `const sleep = (ms) => ...`
function waitWrappers(source: string): Map<string, string | undefined> {
  // name -> its fixed delay, or undefined when the delay is the caller's argument
  const wrappers = new Map<string, string | undefined>();
  for (const [, name = '', parameter = '', delay = ''] of source.matchAll(WRAPPER_DEFINITION)) {
    wrappers.set(name, parameter !== '' && delay.trim() === parameter ? undefined : delay);
  }
  return wrappers;
}

interface Flagged {
  line: number;
  form: Form;
  text: string;
}

function timingForms(source: string): Flagged[] {
  const wrappers = waitWrappers(source);
  const lines = source.split('\n');
  const flagged: Flagged[] = [];
  lines.forEach((text, index) => {
    const line = index + 1;
    const code = text.replace(/\/\/.*$/, '');
    if (F1_PATTERNS.some((pattern) => pattern.test(code))) flagged.push({ line, form: 'F1', text });
    if (F2_PATTERN.test(code)) flagged.push({ line, form: 'F2', text });
    const ceiling = F3_CEILING.exec(code);
    if (ceiling !== null && !SHARED_CEILINGS.has(ceiling[1] ?? '') && F3_TIMED.test(code)) {
      flagged.push({ line, form: 'F3', text });
    }
    // prettier may break the arrow after `=>`, so the next line is read with this one
    const statement = /=>\s*$/.test(code) ? `${code} ${(lines[index + 1] ?? '').trim()}` : code;
    const promise = PROMISE_WAIT.exec(statement);
    let fixedWait = promise !== null && !isZero(promise[1] ?? '');
    for (const [, name = '', argument = ''] of code.matchAll(/\bawait\s+(\w+)\(([^)]*)\)/g)) {
      if (!wrappers.has(name)) continue;
      if (!isZero(wrappers.get(name) ?? argument)) fixedWait = true;
    }
    if (fixedWait) flagged.push({ line, form: 'F4', text });
  });
  return flagged;
}

// Every fixed wait or ceiling left on purpose, with its reason. `match` is a substring of the
// flagged line; an entry skips only its own form, and an entry that matches nothing fails.
const NEGATIVE =
  'a negative wait: nothing may happen within it; load can only hide a regression, never fail the case';
const DURATION =
  'a duration, not a synchronization: a scripted delay or hold-back has to run out, and load makes it longer, never shorter';
const IN_FAKE = 'a wait inside a fake: the time the faked operation takes';
const ALLOWED: readonly { file: string; form: Form; match: string; reason: string }[] = [
  {
    file: 'apps/backend/src/outbox/publisher.redis.test.ts',
    form: 'F4',
    match: 'await sleep(20);',
    reason: IN_FAKE,
  },
  {
    file: 'apps/backend/src/outbox/publisher.redis.test.ts',
    form: 'F4',
    match: 'await sleep(150);',
    reason: IN_FAKE,
  },
  {
    file: 'apps/backend/src/outbox/publisher.redis.test.ts',
    form: 'F4',
    match: 'await sleep(100);',
    reason: IN_FAKE,
  },
  {
    file: 'apps/backend/src/outbox/publisher.redis.test.ts',
    form: 'F4',
    match: 'await sleep(10);',
    reason: 'lets a fresh start() run before stop(); nothing is asserted after it',
  },
  {
    file: 'apps/backend/src/outbox/publisher.redis.test.ts',
    form: 'F4',
    match: 'await sleep(200);',
    reason: NEGATIVE,
  },
  {
    file: 'packages/broker-rest/src/pairs-catalog.test.ts',
    form: 'F4',
    match: 'await sleep(100);',
    reason: NEGATIVE,
  },
  {
    file: 'packages/broker-rest/src/pairs-catalog.test.ts',
    form: 'F4',
    match: 'await sleep(4 * ttlMs);',
    reason: NEGATIVE,
  },
  {
    file: 'apps/bot/src/lifecycle.test.ts',
    form: 'F4',
    match: 'await settle();',
    reason: `${NEGATIVE} (the second SIGTERM, the exit before polling ends); the afterEach drain asserts nothing`,
  },
  {
    file: 'apps/backend/src/admin/password-queue.test.ts',
    form: 'F4',
    match: 'setTimeout(resolve, 10)',
    reason: NEGATIVE,
  },
  {
    file: 'apps/backend/src/broker/oauth-client.test.ts',
    form: 'F4',
    match: 'setTimeout(resolve, 30)',
    reason: 'a lower bound: the 10 ms code TTL has to have run out',
  },
  {
    file: 'packages/mock-broker/src/server.test.ts',
    form: 'F4',
    match: 'setTimeout(resolve, 250)',
    reason: DURATION,
  },
  {
    file: 'packages/mock-broker/src/server.test.ts',
    form: 'F4',
    match: 'await sleep(400);',
    reason: `${NEGATIVE} (sized past the 300 ms delay it must outlast)`,
  },
  {
    file: 'apps/backend/src/broker/balance-reconciler.db.test.ts',
    form: 'F4',
    match: 'setTimeout(resolve, 150)',
    reason: DURATION,
  },
  {
    file: 'apps/backend/src/broker/balance-reconciler.db.test.ts',
    form: 'F4',
    match: 'setTimeout(resolve, 100)',
    reason: NEGATIVE,
  },
  {
    file: 'apps/trading-worker/src/intents/reconciliation.db.test.ts',
    form: 'F4',
    match: 'setTimeout(resolve, 300)',
    reason: IN_FAKE,
  },
  {
    file: 'apps/trading-worker/src/intents/reconciliation.db.test.ts',
    form: 'F4',
    match: 'setTimeout(resolve, 200)',
    reason: IN_FAKE,
  },
  {
    file: 'packages/mock-broker/src/socket.test.ts',
    form: 'F4',
    match: 'setTimeout(resolve, QUIET_MS)',
    reason: `${NEGATIVE} (expectQuiet, and the ack that must stay uncalled)`,
  },
  {
    file: 'apps/backend/src/trading/access.db.test.ts',
    form: 'F3',
    match: 'toBeLessThan(TRADING_ACCESS_BUDGET_MS)',
    reason:
      'the route budget is the property; 1 s of margin over the 3 s refresh budget inside it, a chain asserted at import',
  },
];

// Files that in-flight issues still own; their conversion is the follow-up to #205. Each has to
// still carry a form, so a converted file has to leave the list.
const DEFERRED_TO_FOLLOW_UP: readonly string[] = [
  'apps/backend/src/admin/routes.db.test.ts', // #107
  'apps/backend/src/admin/telegram.db.test.ts', // #154
];

// tracked or not yet staged, never ignored: the scan has to see a test before `git add`
const testFiles = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
  cwd: repoRoot,
  encoding: 'utf8',
})
  .split('\n')
  .filter(
    (file) => file.endsWith('.test.ts') && file !== self && existsSync(path.join(repoRoot, file)),
  );

describe('timingForms', () => {
  it.each([
    ['F1', 'const deadline = Date.now() + 2_000;'],
    ['F1', 'while (!done() && Date.now() < deadline) {'],
    ['F1', 'if (Date.now() > deadline) throw new Error();'],
    ['F1', 'const until = Date.now() + WAIT_CEILING_MS;'],
    ['F1', 'if (deadline <= Date.now()) break;'],
    ['F2', 'await vi.waitFor(() => expect(x).toBe(1));'],
    ['F2', 'await vi.waitUntil(() => ready);'],
    ['F3', 'expect(Date.now() - started).toBeLessThan(1_000);'],
    ['F3', 'expect(elapsed).toBeLessThan(2_000);'],
    ['F3', 'expect(Date.now() - started).toBeLessThan(TRADING_ACCESS_BUDGET_MS);'],
    ['F3', 'expect(read!.restSnapshotAgeSec).toBeLessThanOrEqual(91);'],
    ['F3', 'expect(Math.abs(stored!.restAgeMs)).toBeLessThan(2_000);'],
    ['F3', 'expect(age).toBeLessThanOrEqual(11);'],
    ['F4', 'await new Promise((resolve) => setTimeout(resolve, 20));'],
    ['F4', 'await new Promise((r) => setTimeout(r, 5));'],
  ] as const)('%s: %s', (form, line) => {
    expect(timingForms(line).map((flag) => flag.form)).toEqual([form]);
  });

  it.each([
    ['a fixture timestamp', 'expiresAt: new Date(Date.now() + 3_600_000).toISOString(),'],
    [
      'a fixture field named like a deadline',
      'state.updatePair(GBPUSD, { scheduled_until: Date.now() + 60_000 });',
    ],
    ['the shared unit ceiling', 'expect(elapsed).toBeLessThan(UNIT_WAIT_CEILING_MS);'],
    [
      'the shared integration ceiling',
      'expect(Date.now() - t).toBeLessThan(INTEGRATION_WAIT_CEILING_MS);',
    ],
    ['an expression bound', 'expect(reset * 1000).toBeLessThanOrEqual(Date.now() + 60_000);'],
    [
      'a sum with the shared ceiling',
      'expect(age).toBeLessThanOrEqual(90 + INTEGRATION_WAIT_CEILING_MS / 1_000);',
    ],
    ['a size, not a time', 'expect(maxAge).toBeLessThanOrEqual(7_200);'],
    ['a constant chain', 'expect(STARTUP_BUDGET_MS).toBeLessThan(SHUTDOWN_BUDGET_MS);'],
    ['a zero-delay yield', 'await new Promise((resolve) => setTimeout(resolve, 0));'],
    [
      'a timer inside a fake, not awaited',
      'new Promise((_r, reject) => setTimeout(() => reject(e), 150))',
    ],
    ['a commented-out wait', '// await new Promise((resolve) => setTimeout(resolve, 20));'],
  ])('passes %s', (_label, line) => {
    expect(timingForms(line)).toEqual([]);
  });

  it('flags a fixed wait whatever the next line is, through a wrapper defined in the file', () => {
    const source = [
      'const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));',
      'const settle = () => new Promise((resolve) => setTimeout(resolve, 20));',
      'const yieldOnce = () => new Promise((resolve) => setTimeout(resolve, 0));',
      'await sleep(windowMs);',
      'await sleep(4 * ttlMs);',
      'await sleep(0);',
      'await settle();',
      'await yieldOnce();',
      'await new Promise((resolve) => setTimeout(resolve, 20));',
      'const refused = await login();',
    ].join('\n');
    expect(timingForms(source).map(({ line, form }) => `${line} ${form}`)).toEqual([
      '4 F4',
      '5 F4',
      '7 F4',
      '9 F4',
    ]);
  });

  it('reads a fixed wait that prettier broke after the arrow', () => {
    const source = ['await new Promise((resolve) =>', '  setTimeout(resolve, 100),', ');'].join(
      '\n',
    );
    expect(timingForms(source).map(({ line, form }) => `${line} ${form}`)).toEqual(['1 F4']);
  });
});

describe('test files', () => {
  const flaggedByFile = new Map(
    testFiles.map((file) => [file, timingForms(readFileSync(path.join(repoRoot, file), 'utf8'))]),
  );

  it('carry no deadline of their own outside ALLOWED and DEFERRED_TO_FOLLOW_UP', () => {
    const offences = [...flaggedByFile].flatMap(([file, flagged]) =>
      DEFERRED_TO_FOLLOW_UP.includes(file)
        ? []
        : flagged
            .filter(
              ({ form, text }) =>
                !ALLOWED.some(
                  (entry) =>
                    entry.file === file && entry.form === form && text.includes(entry.match),
                ),
            )
            .map(({ line, form }) => `${file}:${line}: ${form} - ${ADVICE[form]}`),
    );
    expect(offences).toEqual([]);
  });

  it('keep every ALLOWED entry in use', () => {
    const unused = ALLOWED.filter(
      (entry) =>
        !(flaggedByFile.get(entry.file) ?? []).some(
          ({ form, text }) => form === entry.form && text.includes(entry.match),
        ),
    ).map((entry) => `${entry.file} ${entry.form} ${entry.match}: remove from ALLOWED`);
    expect(unused).toEqual([]);
  });

  it('keep a file in DEFERRED_TO_FOLLOW_UP only while it still has a form to convert', () => {
    const done = DEFERRED_TO_FOLLOW_UP.filter(
      (file) => (flaggedByFile.get(file) ?? []).length === 0,
    ).map((file) => `${file}: remove from DEFERRED_TO_FOLLOW_UP`);
    expect(done).toEqual([]);
  });
});
