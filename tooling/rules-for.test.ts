import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  type GateResult,
  type Repo,
  type Rule,
  PATH_SHAPED_LITERALS,
  RulesError,
  SKILL_FILE,
  buildCorpus,
  checkIndex,
  checkNumbering,
  checkRules,
  citesPath,
  classifyToken,
  directoriesOf,
  extractSectionRules,
  idFound,
  identifierFound,
  idsAfter,
  literalsFound,
  loadRepo,
  loadRules,
  mapBlock,
  mapKey,
  mergeRules,
  normalisePrime,
  parseIndex,
  parseRuleFile,
  renderDump,
  renderList,
  renderMap,
  renderRuleFile,
  resolvePath,
  rulesFor,
  splitRules,
  tokensOf,
} from './rules-for';

// The gate (G1–G3) holds each backticked token of a rule by its class: a path resolves to a
// `git ls-files` entry (`PATH_SHAPED_LITERALS` excepted), an identifier is an identifier of the
// corpus, a literal a substring of it; an expression is skipped. Test ids: after each test-file
// citation, up to ". ", "; ", the end of the line or the next test-file citation (other backtick
// spans are cut out), every word shaped as an id with a digit or a hyphen — `D1–D3`, `M7b–M7d`,
// `H1-DR1–DR20`, `W-door1–3`, `U-dep 11`, `K5′` — must be in a test file the rule cites. Not read
// (accepted): labels without a digit or hyphen (`CUT`, `JL`, `P`), a bare number after an id
// (`U-dep 9, 10` — the 10), and ids outside a test-file citation's window.

const repoRoot = path.resolve(import.meta.dirname, '..');

const rule = (number: number, area: Rule['area'], text: string): Rule => ({
  number,
  area,
  body: `${number}. **R${number}.** ${text}`,
});

describe('rule files', () => {
  it('U1 a "### Rule N" heading opens a rule whose body runs to the next heading', () => {
    const rules = parseRuleFile(
      'trading',
      '# Architecture Rules — trading\n\nabout\n\n### Rule 15\n15. **Executor:** one.\n\n### Rule 21\n21. **Snap.** two.\n',
    );
    expect(rules).toEqual([
      { number: 15, area: 'trading', body: '15. **Executor:** one.' },
      { number: 21, area: 'trading', body: '21. **Snap.** two.' },
    ]);
  });

  it('U2 a body of two lines keeps its second, indented line', () => {
    const [only] = parseRuleFile('core', '### Rule 5\n5. **Locks** a.\n   `users → jobs` b.\n\n');
    expect(only.body).toBe('5. **Locks** a.\n   `users → jobs` b.');
  });

  it('U3 a body that does not start with its heading number is refused with the file and number', () => {
    expect(() => parseRuleFile('auth', '### Rule 12\n13. **OAuth.** x\n')).toThrow(
      /rules\/auth\.md.*"### Rule 12"/,
    );
  });

  it('U4 the same number in two files is refused', () => {
    expect(() => mergeRules([[rule(7, 'core', 'a')], [rule(7, 'trading', 'b')]])).toThrow(
      /Rule 7 is in both .*core\.md and .*trading\.md/,
    );
  });
});

describe('test ids', () => {
  it("U5 ′ and ' are one character on both sides", () => {
    expect(idFound('D5′', normalisePrime("it('D5' keeps the row')"))).toBe(true);
    expect(idFound("D5'", normalisePrime("it('D5′ keeps the row')"))).toBe(true);
  });

  it('U6 an id needs a boundary on the left and no digit on the right', () => {
    expect(idFound('K2', "it('WK2 wakes')")).toBe(false);
    expect(idFound('R5', "it('R5a refuses')")).toBe(true);
    const text = "it('R30b starts'); it('R32b stops')";
    expect(idFound('R30', text)).toBe(true);
    expect(idFound('R3', text)).toBe(false);
    expect(idFound('R33', text)).toBe(false);
  });

  it.each([
    [' D1–D3, M7b–M7d, K1–K3b; X9', ['D1', 'D2', 'D3', 'M7b', 'M7c', 'M7d', 'K1', 'K2', 'K3b']],
    [' W-door1–3', ['W-door1', 'W-door2', 'W-door3']],
    [
      ' H1-M1–M3, H1-DR1–DR3, H-D1–H-D2',
      ['H1-M1', 'H1-M2', 'H1-M3', 'H1-DR1', 'H1-DR2', 'H1-DR3', 'H-D1', 'H-D2'],
    ],
    [' U-dep 1–2, U-mode 6', ['U-dep 1', 'U-dep 2', 'U-mode 6']],
    [" K3–K5′, G9′–G11, D5'", ['K3', 'K4', "K5'", "G9'", 'G10', 'G11', "D5'"]],
    [' U9–U9c', ['U9', 'U9c']],
    [' M1 (только захват, фильтр выключен), перехват — M2. M3', ['M1', 'M2']],
    [' R27: пользователь, оставшийся в real', ['R27']],
    [' M1–M2 (с M5b, M7b–M7c)', ['M1', 'M2', 'M5b', 'M7b', 'M7c']],
    [' K2′ (с #709 — без `t.me/` в подписи), K3–K4', ["K2'", 'K3', 'K4']],
    [' X1, `other.test.ts` Y1', ['X1']],
    [' X1; Y1', ['X1']],
    [' H1-BW, A-win, T-clock', ['H1-BW', 'A-win', 'T-clock']],
    [' X1–Y3', ['X1–Y3']],
    [' CUT, #709, e2e, 429, 5xx', []],
    [' → the lock order staff → sessions', []],
  ])('U7 the ids after a test-file citation:%s', (rest, ids) => {
    expect(idsAfter(rest)).toEqual(ids);
  });
});

describe('tokens', () => {
  const entries = [
    'apps/trading-worker/src/stake/size.ts',
    'packages/db/src/schema/columns.ts',
    'packages/db/src/user-ops.db.test.ts',
    'apps/backend/src/admin/routes.ts',
  ];

  it('U8 a path resolves exactly, as a directory, a suffix, a segment or a glob; else it is no path', () => {
    expect(resolvePath('packages/db/src/schema/columns.ts', entries)?.kind).toBe('exact');
    expect(resolvePath('apps/trading-worker/src/stake/', entries)).toEqual({
      kind: 'directory',
      matches: ['apps/trading-worker/src/stake/size.ts'],
    });
    expect(resolvePath('columns.ts', entries)?.kind).toBe('suffix');
    expect(resolvePath('apps/backend/src/*/routes.ts', entries)?.kind).toBe('glob');
    expect(resolvePath('*.db.test.ts', entries)?.matches).toEqual([
      'packages/db/src/user-ops.db.test.ts',
    ]);
    expect(resolvePath('admin/', entries)).toEqual({
      kind: 'segment',
      matches: ['apps/backend/src/admin/routes.ts'],
    });
    expect(resolvePath('apps/*/src', entries)?.matches).toEqual([
      'apps/trading-worker/src/stake/size.ts',
      'apps/backend/src/admin/routes.ts',
    ]);
    expect(resolvePath('README.md', ['docs/README.md', 'README.md'])).toEqual({
      kind: 'exact',
      matches: ['README.md'],
    });
    expect(resolvePath('payments/', entries)).toBeUndefined();
    expect(classifyToken('@binarius/shared')).toBe('literal');
    expect(classifyToken('columns.ts')).toBe('path');
  });

  it('U9 an expression is skipped: a space, brackets, quotes, ::, or a commit hash', () => {
    for (const token of [
      'pnpm db:migrate',
      'status = from',
      'f(x)',
      "'demo'",
      '«x»',
      'a::b',
      'deadbeef1',
      'a|b',
    ])
      expect(classifyToken(token), token).toBe('expression');
    expect(classifyToken('deadbee')).toBe('expression');
    expect(classifyToken('createStakeSizer')).toBe('identifier');
  });

  it('U10 a compound identifier is held by its leading segment, a wildcard by its fixed part', () => {
    const corpus = buildCorpus(['const BALANCE_TTL = x.y; foo_ticks_until_check();']);
    expect(identifierFound('BALANCE_TTL.value', corpus)).toBe(true);
    expect(identifierFound('BALANCE_*', corpus)).toBe(true);
    expect(identifierFound('…_ticks_until_check', corpus)).toBe(true);
    expect(identifierFound('ASSUMED_*', corpus)).toBe(false);
    expect(identifierFound('Missing.value', corpus)).toBe(false);
  });

  it('U11 a literal is a substring of the corpus, overlapping matches included', () => {
    expect(classifyToken('.env')).toBe('literal');
    expect(
      [...literalsFound(['abcd', 'bcx', '.env', 'gone'], 'xabcdx; bcx; .env.example')].sort(),
    ).toEqual(['.env', 'abcd', 'bcx']);
    expect(literalsFound(['cde'], 'abcdef')).toEqual(new Set(['cde']));
  });

  it('U15 each class has its own check: no literal fallback for an identifier or a path', () => {
    const repo: Repo = {
      entries: ['apps/backend/src/postback/routes.ts'],
      corpus: buildCorpus(['recordPostbackFailure(); "/paysupport"; https://t.me/x']),
      read: () => '',
    };
    const result = checkRules(
      [rule(35, 'payments', '`recordPostback`, `gone/dir/`, `t.me/`, `/paysupport`, `/nowhere`')],
      repo,
    );
    expect(result.errors).toEqual([
      'rules/payments.md Rule 35: identifier recordPostback',
      'rules/payments.md Rule 35: path gone/dir/ (no file)',
      'rules/payments.md Rule 35: literal /nowhere',
    ]);
  });
});

describe('index', () => {
  const line = (n: number, area: string): string => `${n}. **Name** — gist → \`rules/${area}.md\``;

  it('U12 a duplicate line is refused; a missing or misplaced rule is an error', () => {
    expect(() => parseIndex(`### Index\n\n${line(1, 'core')}\n${line(1, 'core')}\n`)).toThrow(
      /Rule 1 has two index lines/,
    );
    const index = parseIndex(`### Index\n\n${line(1, 'core')}\n${line(3, 'core')}\n\n### Map\n`);
    expect(checkIndex(index, [rule(1, 'trading', 'a'), rule(2, 'core', 'b')])).toEqual([
      'index: Rule 1 points to rules/core.md, it is in rules/trading.md',
      'index: no line for Rule 2',
      'index: Rule 3 has a line but no rule',
    ]);
    expect(checkNumbering([rule(1, 'core', 'a'), rule(3, 'core', 'b')])).toEqual([
      'numbering: Rule 2 is missing',
    ]);
  });
});

describe('map', () => {
  const entries = [
    'apps/backend/src/admin/routes.ts',
    'apps/backend/src/app.ts',
    'packages/db/drizzle/0001_append_only.sql',
    'packages/db/src/schema/columns.ts',
    'docs/stake.md',
  ];

  it('U13 renderMap prints one row per key with its areas and rule numbers', () => {
    const rules = [
      rule(2, 'core', '`columns.ts` and `docs/stake.md`'),
      rule(3, 'core', '`packages/db/drizzle/0001_append_only.sql`, `columns.ts`'),
      rule(18, 'bot-ui', '`apps/backend/src/admin/routes.ts`'),
      rule(12, 'auth', '`apps/backend/src/*/routes.ts`'),
    ];
    expect(renderMap(rules, entries)).toBe(
      [
        '| Путь | Правила |',
        '|---|---|',
        '| `apps/backend/src` | auth 12 |',
        '| `apps/backend/src/admin` | bot-ui 18 |',
        '| `docs` | core 2 |',
        '| `packages/db/drizzle` | core 3 |',
        '| `packages/db/src/schema` | core 2, 3 |',
      ].join('\n'),
    );
  });

  it('U14 mapKey: a directory under src, src itself, drizzle, a package root, the first segment', () => {
    const directories = directoriesOf(entries);
    expect(mapKey('apps/backend/src/admin/routes.ts', directories)).toBe('apps/backend/src/admin');
    expect(mapKey('apps/backend/src/app.ts', directories)).toBe('apps/backend/src');
    expect(mapKey('apps/backend/src/new/file.ts', directories)).toBe('apps/backend/src');
    expect(mapKey('packages/db/drizzle/0001_append_only.sql', directories)).toBe(
      'packages/db/drizzle',
    );
    expect(mapKey('apps/bot/package.json', directories)).toBe('apps/bot');
    expect(mapKey('docs/stake.md', directories)).toBe('docs');
    expect(mapKey('compose.yaml', directories)).toBe('compose.yaml');
  });
});

describe('rulesFor', () => {
  const entries = [
    'packages/db/src/user-ops.ts',
    'packages/db/src/schema/columns.ts',
    'packages/db/src/schema/users.ts',
  ];
  const rules = [
    rule(34, 'payments', '`packages/db/src/user-ops.ts` → `recordUserStart`'),
    rule(2, 'core', '`tokenAmount`, `columns.ts`'),
  ];

  it('C1 a file a rule cites by its full path', () => {
    const result = rulesFor(['packages/db/src/user-ops.ts'], rules, entries);
    expect(result.perFile[0].direct.map((r) => r.number)).toEqual([34]);
    expect(result.areas).toEqual(['payments']);
  });

  it('C2 a file a rule cites by its basename is a direct citation; its directory brings the rest', () => {
    const result = rulesFor(
      ['packages/db/src/schema/columns.ts', 'packages/db/src/schema/users.ts'],
      rules,
      entries,
    );
    expect(result.perFile[0].direct.map((r) => r.number)).toEqual([2]);
    expect(result.perFile[1].direct).toEqual([]);
    expect(result.perFile[1].directory.map((r) => r.number)).toEqual([2]);
    expect(renderList(result.perFile)).toContain('  cites: core 2');
  });

  it('C3 a file no rule cites sends the reader to core', () => {
    const result = rulesFor(['apps/x/src/new.ts'], rules, entries);
    expect(result.rules).toEqual([]);
    expect(result.areas).toEqual(['core']);
    expect(renderList(result.perFile)).toContain('no rule cites apps/x/src/new.ts → read');
  });

  it.each([
    [
      'packages/db/src/schema/columns.ts',
      'packages/db/src/schema/columns.ts',
      'packages/db/src/schema/columns.tsx',
    ],
    ['columns.ts', 'packages/db/src/schema/columns.ts', 'packages/db/src/schema/not-columns.ts'],
    [
      'intents/config.test.ts',
      'apps/trading-worker/src/intents/config.test.ts',
      'apps/trading-worker/src/my-intents/config.test.ts',
    ],
    [
      'apps/trading-worker/src/stake/',
      'apps/trading-worker/src/stake/new.ts',
      'apps/trading-worker/src/stakes/new.ts',
    ],
    [
      'apps/trading-worker/src/stake',
      'apps/trading-worker/src/stake/new.ts',
      'apps/trading-worker/src/stakes/new.ts',
    ],
    ['payments/', 'apps/backend/src/payments/new.ts', 'apps/backend/src/payments-old/new.ts'],
    ['apps/*/src', 'apps/bot/src/new.ts', 'apps/bot/scripts/new.ts'],
    ['apps/*', 'apps/web/src/admin/new.ts', 'packages/web/src/new.ts'],
    ['*.test.ts', 'apps/bot/src/new.test.ts', 'apps/bot/src/new.ts'],
    [
      'circuit-breaker/*.test.ts',
      'apps/trading-worker/src/circuit-breaker/new.test.ts',
      'apps/trading-worker/src/circuit-breakers/new.test.ts',
    ],
    [
      'packages/db/drizzle/*.sql',
      'packages/db/drizzle/0099_new.sql',
      'packages/db/drizzle-old/0099_new.sql',
    ],
    ['packages/**/schema/*.ts', 'packages/db/src/schema/new.ts', 'packages/db/src/schemas/new.ts'],
    ['apps/?ot/src', 'apps/bot/src/new.ts', 'apps/boot/src/new.ts'],
  ])('C4 a file a plan adds, which may not exist: %s holds %s, not %s', (token, inside, beside) => {
    expect(citesPath(token, inside)).toBe(true);
    expect(citesPath(token, beside)).toBe(false);
  });
});

describe('--split', () => {
  const skill = [
    '## Architecture Rules to Enforce in Every Plan',
    '',
    'Модульные границы: …',
    '',
    '1. **One.** a',
    '2. **Two.** b',
    '   second line',
    '',
    '---',
    '',
    '3. **Three.** c',
    '',
    '## Forbidden Actions',
  ].join('\n');
  const index = `### Index\n\n1. **One** — a → \`rules/core.md\`\n2. **Two** — b → \`rules/trading.md\`\n3. **Three** — c → \`rules/core.md\`\n`;

  it('S1 the old section splits into area files whose dump is the section without blank and --- lines', () => {
    const section = extractSectionRules(skill);
    const rules = splitRules(section, parseIndex(index));
    const core = renderRuleFile(
      '# Architecture Rules — core\n\n',
      rules.filter((r) => r.area === 'core'),
    );
    const trading = renderRuleFile(
      '# h\n\n',
      rules.filter((r) => r.area === 'trading'),
    );
    expect(core).toBe(
      '# Architecture Rules — core\n\n### Rule 1\n1. **One.** a\n\n### Rule 3\n3. **Three.** c\n',
    );
    const parsed = mergeRules([parseRuleFile('core', core), parseRuleFile('trading', trading)]);
    expect(renderDump(parsed)).toBe(
      '1. **One.** a\n2. **Two.** b\n   second line\n3. **Three.** c\n',
    );
  });

  it('S2 a rule without an index line, or a section that is already an index, is refused', () => {
    expect(() =>
      splitRules(
        extractSectionRules(skill),
        parseIndex('### Index\n\n1. **One** — a → `rules/core.md`\n'),
      ),
    ).toThrow(/Rule 2, 3: add it first/);
    expect(() =>
      extractSectionRules(
        '## Architecture Rules to Enforce in Every Plan\n\n### Index\n\n## Forbidden Actions\n',
      ),
    ).toThrow(RulesError);
  });
});

describe('the command line', () => {
  const run = (args: string[], cwd = repoRoot) =>
    spawnSync(process.execPath, [path.join(repoRoot, 'tooling/rules-for.ts'), ...args], {
      cwd,
      encoding: 'utf8',
    });

  let fromRoot: string;
  beforeAll(() => {
    const result = run(['--list', 'apps/backend/src/app.ts']);
    expect(result.status).toBe(0);
    fromRoot = result.stdout;
  });

  it.each([
    ['./apps/backend/src/app.ts', './apps/backend/src/app.ts', repoRoot],
    ['an absolute path', path.join(repoRoot, 'apps/backend/src/app.ts'), repoRoot],
    ['src/app.ts from apps/backend', 'src/app.ts', path.join(repoRoot, 'apps/backend')],
  ])('C6 --list %s prints as the path from the root', (_label, file, cwd) => {
    expect(fromRoot).toMatch(/^apps\/backend\/src\/app\.ts\n {2}cites: /);
    expect(run(['--list', file], cwd).stdout).toBe(fromRoot);
  });

  it('E1 --split of a ref git cannot show exits 2 with one line and writes nothing', () => {
    const rulesDir = path.join(repoRoot, '.claude/skills/architect/rules');
    const before = ['core', 'trading'].map((area) =>
      readFileSync(path.join(rulesDir, `${area}.md`), 'utf8'),
    );
    const result = run(['--split', 'no-such-ref']);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/^git show: [^\n]+\n$/);
    expect(
      ['core', 'trading'].map((area) => readFileSync(path.join(rulesDir, `${area}.md`), 'utf8')),
    ).toEqual(before);
  });

  it('E2 outside a repository: exit 2, one line from git rev-parse', () => {
    const result = run(['--map'], os.tmpdir());
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/^git rev-parse: [^\n]+\n$/);
  });

  it('E3 --list without files: exit 2 and the usage', () => {
    const result = run(['--list']);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/^usage:\n/);
  });
});

describe('the rules in this repository', () => {
  let repo: Repo;
  let rules: Rule[];
  let gate: GateResult;
  let skill: string;

  beforeAll(() => {
    repo = loadRepo(repoRoot);
    rules = loadRules(repoRoot);
    gate = checkRules(rules, repo);
    skill = readFileSync(path.join(repoRoot, SKILL_FILE), 'utf8');
  });

  it('every path, identifier and literal the rules cite resolves; every test id the grammar reads after a test-file citation is in a cited test file (G1–G3)', () => {
    const summary = `token classes ${JSON.stringify(gate.counts)}, ${gate.ids} test ids checked, ${gate.citationsWithoutIds} test-file citations without ids`;
    expect(rules.length).toBeGreaterThan(0);
    expect(repo.corpus.identifiers.size).toBeGreaterThan(1000);
    expect(gate.ids, summary).toBeGreaterThan(1200);
    expect(gate.errors, summary).toEqual([]);
  });

  it('G6 every path-shaped literal is cited by a rule and names no file', () => {
    const cited = new Set(rules.flatMap((r) => tokensOf(r.body)));
    for (const token of PATH_SHAPED_LITERALS) {
      expect(cited.has(token), token).toBe(true);
      expect(resolvePath(token, repo.entries), token).toBeUndefined();
    }
  });

  it('G7 every resolved path a rule cites routes that rule to the files it names', () => {
    const cases = rules.flatMap((r) =>
      tokensOf(r.body)
        .filter((token) => classifyToken(token) === 'path')
        .flatMap((token) => {
          const resolved = resolvePath(token, repo.entries);
          return resolved === undefined
            ? []
            : [{ number: r.number, token, file: resolved.matches[0] }];
        }),
    );
    const { perFile } = rulesFor(
      cases.map(({ file }) => file),
      rules,
      repo.entries,
    );
    const missed = cases
      .filter(({ number }, i) => !perFile[i].direct.some((r) => r.number === number))
      .map(({ number, token, file }) => `Rule ${number} ${token} -> ${file}`);
    expect(missed).toEqual([]);
  });

  it('C5 a new file under a directory glob or a relative directory gets the rule', () => {
    const { perFile } = rulesFor(
      [
        'apps/trading-worker/src/new-writer.ts',
        'packages/shared/src/new.ts',
        'apps/backend/src/payments/new.ts',
      ],
      rules,
      repo.entries,
    );
    const [writer, shared, payments] = perFile.map(({ direct, directory }) =>
      [...direct, ...directory].map((r) => r.number),
    );
    expect(writer).toEqual(expect.arrayContaining([18, 20, 43, 51]));
    expect(shared).toEqual(expect.arrayContaining([18, 51]));
    expect(payments).toContain(33);
  });

  it('G4 rule numbers run 1..max without a gap', () => {
    expect(checkNumbering(rules)).toEqual([]);
  });

  it('G5 the index has one line per rule, pointing to the file the rule is in', () => {
    expect(checkIndex(parseIndex(skill), rules)).toEqual([]);
  });

  it('P1 the index map is what `node tooling/rules-for.ts --map` prints', () => {
    expect(mapBlock(skill)).toBe(renderMap(rules, repo.entries));
  });
});
