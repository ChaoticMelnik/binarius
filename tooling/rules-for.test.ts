import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  type GateResult,
  type Repo,
  type Rule,
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
} from './rules-for';

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

  it('U7 ranges expand by number or letter, and a segment that is not an id ends the list', () => {
    expect(idsAfter(' D1–D3, M7b–M7d, K1–K8b, W-door1–3; then')).toEqual([
      'D1',
      'D2',
      'D3',
      'M7b',
      'M7c',
      'M7d',
      ...['K1', 'K2', 'K3', 'K4', 'K5', 'K6', 'K7', 'K8'],
      'W-door1',
      'W-door2',
      'W-door3',
    ]);
    expect(idsAfter(', A1, гонка CLI и сверки — B2.')).toEqual(['A1']);
    expect(idsAfter(' P1–P2). Next C9')).toEqual(['P1', 'P2']);
  });
});

describe('tokens', () => {
  const entries = [
    'apps/trading-worker/src/stake/size.ts',
    'packages/db/src/schema/columns.ts',
    'packages/db/src/user-ops.db.test.ts',
    'apps/backend/src/admin/routes.ts',
  ];

  it('U8 a path resolves exactly, as a directory, as a suffix or as a glob; else it is no path', () => {
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

  it('C4 a path a plan adds is matched by the directory a rule cites', () => {
    expect(
      citesPath('apps/trading-worker/src/stake/', 'apps/trading-worker/src/stake/new.ts'),
    ).toBe(true);
    expect(citesPath('apps/*/src', 'apps/bot/src')).toBe(true);
    expect(citesPath('columns.ts', 'packages/db/src/schema/not-columns.ts')).toBe(false);
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

  it('every citation of the rules resolves: G1 paths, G2 expressions skipped, G3 test ids', () => {
    expect(rules.length).toBeGreaterThan(0);
    expect(repo.corpus.identifiers.size).toBeGreaterThan(1000);
    expect(gate.ids).toBeGreaterThan(0);
    expect(gate.errors, `token classes ${JSON.stringify(gate.counts)}`).toEqual([]);
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
