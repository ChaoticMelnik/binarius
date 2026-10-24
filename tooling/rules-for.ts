import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// The Architecture Rules (#770): the index lives in .claude/skills/architect/SKILL.md, the rules
// in .claude/skills/architect/rules/<area>.md, one `### Rule N` heading per rule. This prints the
// rules a list of files touches (the flags are in USAGE); tooling/rules-for.test.ts is the gate
// that holds the rules' citations to the repository.
//
// Input from a diff: `gh pr diff <N> --name-only | xargs node tooling/rules-for.ts`. A path may be
// relative to the working directory or absolute; run from inside the repository.
//
// --split <ref> exists so that a rebase onto a main whose rules changed regenerates the rule files
// from the old one-section SKILL.md at <ref> instead of merging them by hand; the independent
// proof of the move is the awk/diff in the PR of #770, not the hash it prints.
//
// Exit codes: 0 done; 1 --split wrote files whose dump differs from the source; 2 anything else
// that stopped the script: usage, a rule file or the index that does not parse, a git command that
// failed (one line on stderr; a stack for an error of the script itself).

export const SKILL_FILE = '.claude/skills/architect/SKILL.md';
const RULES_DIR = '.claude/skills/architect/rules';
const AREAS = ['core', 'trading', 'signal-h1', 'bot-ui', 'payments', 'auth'] as const;
type Area = (typeof AREAS)[number];

const MAP_START = '<!-- generated: node tooling/rules-for.ts --map -->';
const MAP_END = '<!-- /generated -->';

const SECTION_HEADING = '## Architecture Rules to Enforce in Every Plan';
const SECTION_END = '## Forbidden Actions';

export class RulesError extends Error {}

export interface Rule {
  number: number;
  area: Area;
  body: string;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const isArea = (value: string): value is Area => (AREAS as readonly string[]).includes(value);

function ruleFilePath(area: Area): string {
  return `${RULES_DIR}/${area}.md`;
}

export function parseRuleFile(area: Area, text: string): Rule[] {
  const rules: Rule[] = [];
  let current: { number: number; lines: string[] } | undefined;
  const close = (): void => {
    if (current === undefined) return;
    const lines = [...current.lines];
    while (lines.length > 0 && lines.at(-1) === '') lines.pop();
    const body = lines.join('\n');
    if (!body.startsWith(`${current.number}. `))
      throw new RulesError(
        `${ruleFilePath(area)}: the body under "### Rule ${current.number}" does not start with "${current.number}. "`,
      );
    rules.push({ number: current.number, area, body });
  };
  for (const line of text.split('\n')) {
    if (line.startsWith('### ')) {
      close();
      const heading = /^### Rule (\d+)$/.exec(line);
      if (heading === null)
        throw new RulesError(`${ruleFilePath(area)}: unexpected heading "${line}"`);
      current = { number: Number(heading[1]), lines: [] };
    } else if (current !== undefined) {
      current.lines.push(line);
    }
  }
  close();
  return rules;
}

export function mergeRules(perFile: Rule[][]): Rule[] {
  const seen = new Map<number, Area>();
  const all: Rule[] = [];
  for (const rule of perFile.flat()) {
    const earlier = seen.get(rule.number);
    if (earlier !== undefined)
      throw new RulesError(
        `Rule ${rule.number} is in both ${ruleFilePath(earlier)} and ${ruleFilePath(rule.area)}`,
      );
    seen.set(rule.number, rule.area);
    all.push(rule);
  }
  return all.sort((a, b) => a.number - b.number);
}

export function loadRules(root: string): Rule[] {
  return mergeRules(
    AREAS.map((area) => {
      const file = path.join(root, ruleFilePath(area));
      if (!existsSync(file)) throw new RulesError(`${ruleFilePath(area)} is missing`);
      return parseRuleFile(area, readFileSync(file, 'utf8'));
    }),
  );
}

export function renderDump(rules: readonly Rule[]): string {
  return rules.map((rule) => `${rule.body}\n`).join('');
}

// --- the index -----------------------------------------------------------------------------

const INDEX_LINE = /^(\d+)\. \*\*[^*]+\*\* — .+ → `rules\/([a-z0-9-]+)\.md`$/;

export function parseIndex(skillText: string): Map<number, string> {
  const lines = skillText.split('\n');
  const start = lines.indexOf('### Index');
  if (start === -1) throw new RulesError(`${SKILL_FILE}: no "### Index" heading`);
  const index = new Map<number, string>();
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('#')) break;
    if (line === '') continue;
    const match = INDEX_LINE.exec(line);
    if (match === null) throw new RulesError(`${SKILL_FILE}: index line does not parse: ${line}`);
    const number = Number(match[1]);
    if (index.has(number))
      throw new RulesError(`${SKILL_FILE}: Rule ${number} has two index lines`);
    index.set(number, match[2]);
  }
  return index;
}

export function checkIndex(index: Map<number, string>, rules: readonly Rule[]): string[] {
  const errors: string[] = [];
  const byNumber = new Map(rules.map((rule) => [rule.number, rule]));
  for (const rule of rules) {
    const area = index.get(rule.number);
    if (area === undefined) errors.push(`index: no line for Rule ${rule.number}`);
    else if (area !== rule.area)
      errors.push(
        `index: Rule ${rule.number} points to rules/${area}.md, it is in rules/${rule.area}.md`,
      );
  }
  for (const number of index.keys())
    if (!byNumber.has(number)) errors.push(`index: Rule ${number} has a line but no rule`);
  return errors;
}

export function checkNumbering(rules: readonly Rule[]): string[] {
  const numbers = new Set(rules.map((rule) => rule.number));
  const max = Math.max(0, ...numbers);
  const errors: string[] = [];
  for (let n = 1; n <= max; n += 1)
    if (!numbers.has(n)) errors.push(`numbering: Rule ${n} is missing`);
  return errors;
}

// --- tokens --------------------------------------------------------------------------------

type TokenClass = 'expression' | 'path' | 'identifier' | 'literal' | 'short';

const EXPRESSION_CHARS = /[<>=×≤≥(){}|[\]"'«»]/;
const PATH_EXTENSION = /\.(ts|md|sql|json|yaml|yml|js|sh)$/;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

export function tokensOf(body: string): string[] {
  return [...body.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]);
}

// Markdown emphasis (`**Title.**`) and a closing `.`, `?` or `-` (`docs/h1.md.`, `code?`) are not
// part of a word; `**/` and `/**` are a glob's.
function normaliseWord(raw: string): string {
  let word = raw;
  for (;;) {
    const next = word
      .replace(/^\*\*(?!\/)/, '')
      .replace(/(?<!\/)\*\*$/, '')
      .replace(/[.?-]+$/, '');
    if (next === word) return word;
    word = next;
  }
}

// What a rule can name a path with: every maximal run of path characters of its whole text, in a
// backtick span, inside a command or in the prose.
export function wordsOf(body: string): string[] {
  const words = new Set<string>();
  for (const match of body.matchAll(/[A-Za-z0-9_.\-/*?]+/g)) {
    const word = normaliseWord(match[0]);
    if (word !== '') words.add(word);
  }
  return [...words];
}

const WILDCARD = /[*?]/;

// A glob names something only if a letter or digit is left once its wildcards and the last
// segment's extension are removed: `*` and `*.ts` name nothing, `*.test.ts` and `apps/*` do.
function globNames(glob: string): boolean {
  return /[A-Za-z0-9]/.test(glob.replace(/\.[A-Za-z0-9]+$/, '').replace(/[*?]/g, ''));
}

function isExpression(token: string): boolean {
  return (
    /\s/.test(token) ||
    EXPRESSION_CHARS.test(token) ||
    token.includes('::') ||
    /^[0-9a-f]{7,40}$/.test(token)
  );
}

function isPathShaped(token: string): boolean {
  if (/^(\/|@|GET |POST )/.test(token)) return false;
  return token.includes('/') || PATH_EXTENSION.test(token);
}

export function classifyToken(token: string, entries: readonly string[]): TokenClass {
  if (isExpression(token)) return 'expression';
  if (resolvePath(token, entries) !== undefined || isPathShaped(token)) return 'path';
  if (identifierShape(token) !== undefined) return 'identifier';
  return token.length >= 3 ? 'literal' : 'short';
}

// Matches the path itself and every path under it: `apps/*/src` holds `apps/bot/src/x.ts`; group 1
// is the part the glob itself matched.
const globCache = new Map<string, RegExp>();
function globRegExp(token: string): RegExp {
  const cached = globCache.get(token);
  if (cached !== undefined) return cached;
  const glob = token.replace(/\/$/, '');
  let source = '';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === '*' && glob[i + 1] === '*') {
      source += '.*';
      i += 1;
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += escapeRegExp(char);
  }
  const pattern = new RegExp(`^((?:.*/)?${source})(?:/.*)?$`);
  globCache.set(token, pattern);
  return pattern;
}

type PathKind = 'glob' | 'exact' | 'directory' | 'suffix' | 'segment';

const PATH_KINDS: readonly PathKind[] = ['glob', 'exact', 'directory', 'suffix', 'segment'];

// The one matcher of a cited path against a file, which may not exist yet (a file a plan adds).
// A word without `/` names a file only, by its whole path or its basename, never a directory: the
// bare words equal to a directory name are tables, services and fields (NOT_DIRECTORY_NAMES).
// `segment` tests `file`, not `'/' + file`: a leading directory is `directory`'s.
function pathKind(token: string, file: string): PathKind | undefined {
  if (WILDCARD.test(token)) {
    if (!globNames(token)) return undefined;
    const subject = token.includes('/') ? file : file.slice(file.lastIndexOf('/') + 1);
    return globRegExp(token).test(subject) ? 'glob' : undefined;
  }
  const bare = token.replace(/\/$/, '');
  if (bare === '') return undefined;
  if (!token.includes('/')) {
    if (file === bare) return 'exact';
    if (file.endsWith('/' + bare)) return 'suffix';
    return undefined;
  }
  if (file === bare) return 'exact';
  if (file.startsWith(bare + '/')) return 'directory';
  if (file.endsWith('/' + bare)) return 'suffix';
  if (file.includes('/' + bare + '/')) return 'segment';
  return undefined;
}

export function citesPath(token: string, file: string): boolean {
  return pathKind(token, file) !== undefined;
}

type Resolution = { kind: PathKind; matches: string[] } | undefined;

// The gate, the map and rulesFor resolve the same tokens against the same entries.
const resolutions = new WeakMap<readonly string[], Map<string, Resolution>>();

// The gate's resolution against `git ls-files`: the entries of the first kind that has any.
export function resolvePath(token: string, entries: readonly string[]): Resolution {
  let cache = resolutions.get(entries);
  if (cache === undefined) {
    cache = new Map();
    resolutions.set(entries, cache);
  }
  if (cache.has(token)) return cache.get(token);
  const byKind = new Map<PathKind, string[]>();
  for (const entry of entries) {
    const kind = pathKind(token, entry);
    if (kind === undefined) continue;
    const matches = byKind.get(kind);
    if (matches === undefined) byKind.set(kind, [entry]);
    else matches.push(entry);
  }
  const kind = PATH_KINDS.find((k) => byKind.has(k));
  const resolution = kind === undefined ? undefined : { kind, matches: byKind.get(kind) ?? [] };
  cache.set(token, resolution);
  return resolution;
}

// Path-shaped tokens that name no file: an ESLint rule id and a URL prefix.
export const PATH_SHAPED_LITERALS: readonly string[] = ['local/no-status-literal', 't.me/'];

// Bare tokens equal to a directory's name that mean a table, a compose service, a field or an
// attribute, not the directory; any other such token fails the gate.
export const NOT_DIRECTORY_NAMES: readonly string[] = [
  'backend',
  'bot',
  'deposit',
  'h1',
  'oauth',
  'signal',
  'src',
  'stake',
  'trading',
  'trading-worker',
  'users',
  'web',
];

type IdentifierShape =
  | { kind: 'plain'; name: string }
  | { kind: 'tail'; tail: string }
  | { kind: 'prefix'; prefix: string };

function identifierShape(token: string): IdentifierShape | undefined {
  const tail = /^(?:…|\*)([\w$]+)$/.exec(token);
  if (tail !== null) return { kind: 'tail', tail: tail[1] };
  const prefix = /^([A-Za-z_$][\w$]*)\*$/.exec(token);
  if (prefix !== null) return { kind: 'prefix', prefix: prefix[1] };
  if (IDENTIFIER.test(token)) return { kind: 'plain', name: token };
  const compound = /^([A-Za-z_$][\w$]*)[.:\-…*]\S*$/.exec(token);
  if (compound !== null) return { kind: 'plain', name: compound[1] };
  return undefined;
}

interface Corpus {
  identifiers: Set<string>;
  text: string;
}

export function buildCorpus(texts: readonly string[]): Corpus {
  const text = texts.join('\n');
  return { identifiers: new Set(text.match(/[A-Za-z_$][\w$]*/g) ?? []), text };
}

export function identifierFound(token: string, corpus: Corpus): boolean {
  const shape = identifierShape(token);
  if (shape === undefined) return false;
  if (shape.kind === 'plain') return corpus.identifiers.has(shape.name);
  for (const name of corpus.identifiers) {
    if (shape.kind === 'tail' ? name.endsWith(shape.tail) : name.startsWith(shape.prefix))
      return true;
  }
  return false;
}

// --- test ids ------------------------------------------------------------------------------

export function normalisePrime(text: string): string {
  return text.replaceAll('′', "'");
}

const TEST_CITATION = /`([^`\n]+\.(?:test|typecheck)\.ts)`/g;

// The window of a test-file citation: the text after it up to ". ", "; ", the end of the line or
// the next test-file citation; any other backtick span is cut out of it, not an end.
function idWindow(rest: string): string {
  let window = '';
  let at = 0;
  for (const match of rest.matchAll(/`([^`\n]*)`|\. |; |\n/g)) {
    window += rest.slice(at, match.index);
    at = match.index + match[0].length;
    if (match[1] === undefined || TEST_FILE.test(match[1])) return window;
  }
  return window + rest.slice(at);
}

// both primes, so an id whose ′ was not normalised fails the lookup instead of losing its prime
const ID = String.raw`(?:[A-Z]-[a-z]+ \d+[a-z]?|[A-Z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*)['′]?`;
const ID_END = String.raw`(?:[A-Z]-[a-z]+ )?[A-Za-z0-9-]*\d[a-z]?['′]?`;
const ID_WORD = new RegExp(String.raw`(?<![\w'′-])(${ID})(?:–(${ID_END}))?(?![\w'′-])`, 'g');
const ID_PARTS = /^(.*?)(\d+)([a-z]?)(['′]?)$/;

// The ids a test-file citation lists: every word of its window shaped as an id that has a digit
// or a hyphen (`CUT`, `e2e`, `429` are not ids). A range expands; one that does not (another
// prefix, a descending range) is returned whole, so the lookup fails instead of a silent skip.
export function idsAfter(rest: string): string[] {
  const ids: string[] = [];
  for (const match of normalisePrime(idWindow(rest)).matchAll(ID_WORD)) {
    if (!/[\d-]/.test(match[0])) continue;
    if (match[2] === undefined) ids.push(match[1]);
    else ids.push(...(expandRange(match[1], match[2]) ?? [match[0]]));
  }
  return ids;
}

function expandRange(first: string, last: string): string[] | undefined {
  const from = ID_PARTS.exec(first);
  const to = ID_PARTS.exec(last);
  if (from === null || to === null) return undefined;
  const [, prefix, fromNumber, fromLetter] = from;
  const [, endPrefix, toNumber, toLetter] = to;
  if (!prefix.endsWith(endPrefix)) return undefined;
  const n = Number(fromNumber);
  const m = Number(toNumber);
  if (n === m && fromLetter !== '' && toLetter !== '') {
    if (toLetter < fromLetter) return undefined;
    const ids: string[] = [];
    for (let c = fromLetter.charCodeAt(0); c <= toLetter.charCodeAt(0); c += 1)
      ids.push(`${prefix}${n}${String.fromCharCode(c)}`);
    return ids;
  }
  if (m < n) return undefined;
  const ids = [first];
  for (let k = n + 1; k < m; k += 1) ids.push(`${prefix}${k}`);
  ids.push(`${prefix}${last.slice(endPrefix.length)}`);
  return ids;
}

// `normalisedText` has been through normalisePrime: tests write D5', rules D5′.
export function idFound(id: string, normalisedText: string): boolean {
  const escaped = escapeRegExp(normalisePrime(id));
  return new RegExp(`(?<![A-Za-z0-9-])${escaped}(?!\\d)`).test(normalisedText);
}

const TEST_FILE = /\.(test|typecheck)\.ts$/;

// --- the gate ------------------------------------------------------------------------------

export interface Repo {
  entries: string[];
  corpus: Corpus;
  read: (entry: string) => string;
}

export interface GateResult {
  errors: string[];
  counts: Record<TokenClass, number>;
  rootedWords: number;
  ids: number;
  citationsWithoutIds: number;
}

// Every token found in the corpus text, in one pass of the text; the alternation can skip a
// match that overlaps an earlier one, so a token the pass missed is looked up again on its own.
export function literalsFound(tokens: Iterable<string>, text: string): Set<string> {
  const unique = [...new Set(tokens)].sort((a, b) => b.length - a.length);
  const found = new Set<string>();
  if (unique.length === 0) return found;
  const pattern = new RegExp(unique.map(escapeRegExp).join('|'), 'g');
  for (const match of text.matchAll(pattern)) found.add(match[0]);
  for (const token of unique) if (!found.has(token) && text.includes(token)) found.add(token);
  return found;
}

export function checkRules(rules: readonly Rule[], repo: Repo): GateResult {
  const errors = new Set<string>();
  const directories = directoriesOf(repo.entries);
  const directoryNames = new Set([...directories].map((d) => d.slice(d.lastIndexOf('/') + 1)));
  const topDirectories = new Set([...directories].filter((d) => !d.includes('/')));
  let rootedWords = 0;
  const counts: Record<TokenClass, number> = {
    expression: 0,
    path: 0,
    identifier: 0,
    literal: 0,
    short: 0,
  };
  const pending: { where: string; token: string }[] = [];
  const normalised = new Map<string, string>();
  const testText = (file: string): string => {
    const cached = normalised.get(file);
    if (cached !== undefined) return cached;
    const text = normalisePrime(repo.read(file));
    normalised.set(file, text);
    return text;
  };
  let ids = 0;
  let citationsWithoutIds = 0;
  for (const rule of rules) {
    const where = `rules/${rule.area}.md Rule ${rule.number}`;
    const testFiles = new Set<string>();
    for (const word of wordsOf(rule.body)) {
      const slash = word.indexOf('/');
      if (slash === -1 || !topDirectories.has(word.slice(0, slash))) continue;
      rootedWords += 1;
      if (resolvePath(word, repo.entries) === undefined)
        errors.add(`${where}: path ${word} (no file)`);
    }
    for (const token of tokensOf(rule.body)) {
      const kind = classifyToken(token, repo.entries);
      counts[kind] += 1;
      if (
        kind !== 'expression' &&
        !token.includes('/') &&
        !WILDCARD.test(token) &&
        directoryNames.has(token) &&
        resolvePath(token, repo.entries) === undefined &&
        !NOT_DIRECTORY_NAMES.includes(token)
      ) {
        errors.add(
          `${where}: name ${token} is a directory here: cite it as ${token}/ or by its path, or add it to NOT_DIRECTORY_NAMES`,
        );
        continue;
      }
      if (kind === 'path') {
        const resolved = resolvePath(token, repo.entries);
        if (resolved !== undefined) {
          // a glob of test files counts its files only when it names a place (`circuit-breaker/*.test.ts`)
          if (TEST_FILE.test(token) && (resolved.kind !== 'glob' || token.includes('/')))
            for (const match of resolved.matches) testFiles.add(match);
        } else if (PATH_SHAPED_LITERALS.includes(token)) pending.push({ where, token });
        else errors.add(`${where}: path ${token} (no file)`);
      } else if (kind === 'identifier') {
        if (!identifierFound(token, repo.corpus)) errors.add(`${where}: identifier ${token}`);
      } else if (kind === 'literal') {
        pending.push({ where, token });
      }
    }
    const texts = [...testFiles].map(testText);
    for (const match of rule.body.matchAll(TEST_CITATION)) {
      const listed = idsAfter(rule.body.slice(match.index + match[0].length));
      if (listed.length === 0) citationsWithoutIds += 1;
      for (const id of listed) {
        ids += 1;
        if (!texts.some((text) => idFound(id, text)))
          errors.add(`${where}: test id ${id} (after ${match[1]})`);
      }
    }
  }
  const found = literalsFound(
    pending.map(({ token }) => token),
    repo.corpus.text,
  );
  for (const { where, token } of pending)
    if (!found.has(token)) errors.add(`${where}: literal ${token}`);
  return { errors: [...errors], counts, rootedWords, ids, citationsWithoutIds };
}

const CORPUS_ROOTS = ['apps/', 'packages/', 'tooling/', 'scripts/', '.github/'];
const CORPUS_ROOT_FILES = [
  /^README\.md$/,
  /^compose.*\.yaml$/,
  /^eslint\.config\.js$/,
  /^package\.json$/,
  /^\.env\.example$/,
  /^vitest\.config\.ts$/,
  /^tsconfig.*\.json$/,
  /^pnpm-workspace\.yaml$/,
];
const BINARY = /\.(png|jpe?g|gif|ico|webp|svg|woff2?|ttf|otf|pdf|zip|gz|mp4|webm)$/i;
// The gate's own fixtures would satisfy any token. drizzle-kit's snapshots repeat the schema
// sources and are two thirds of the corpus by bytes.
const NOT_CORPUS =
  /^(tooling\/rules-for(\.test)?\.ts|packages\/db\/drizzle\/meta\/\d+_snapshot\.json)$/;

function git(cwd: string, args: readonly string[]): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 1 << 26,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? '').trim();
    throw new RulesError(`git ${args[0]}: ${stderr.split('\n')[0] || String(error)}`);
  }
}

function lsFiles(root: string): string[] {
  return git(root, ['ls-files', '-z'])
    .split('\0')
    .filter((entry) => entry !== '');
}

export function loadRepo(root: string): Repo {
  const entries = lsFiles(root);
  const read = (entry: string): string => readFileSync(path.join(root, entry), 'utf8');
  const corpusFiles = entries.filter(
    (entry) =>
      (CORPUS_ROOTS.some((prefix) => entry.startsWith(prefix)) ||
        CORPUS_ROOT_FILES.some((pattern) => pattern.test(entry))) &&
      !BINARY.test(entry) &&
      !NOT_CORPUS.test(entry) &&
      existsSync(path.join(root, entry)),
  );
  return { entries, corpus: buildCorpus(corpusFiles.map(read)), read };
}

// --- the map -------------------------------------------------------------------------------

export function mapKey(file: string, directories: ReadonlySet<string>): string {
  // documents are not each other's neighbours
  if (file.startsWith('docs/')) return file.replace(/\/$/, '');
  const parts = file.replace(/\/$/, '').split('/');
  if ((parts[0] === 'apps' || parts[0] === 'packages') && parts.length >= 3) {
    if (parts[2] === 'src') {
      const sub = parts.slice(0, 4).join('/');
      if (parts.length >= 4 && directories.has(sub)) return sub;
      return parts.slice(0, 3).join('/');
    }
    if (parts[2] === 'drizzle') return parts.slice(0, 3).join('/');
    return parts.slice(0, 2).join('/');
  }
  return parts[0];
}

export function directoriesOf(entries: readonly string[]): Set<string> {
  const directories = new Set<string>();
  for (const entry of entries) {
    const parts = entry.split('/');
    for (let i = 1; i < parts.length; i += 1) directories.add(parts.slice(0, i).join('/'));
  }
  return directories;
}

// The directory a word names `file` through, if it names it through one.
function citedDirectory(word: string, file: string, kind: PathKind): string | undefined {
  const bare = word.replace(/\/$/, '');
  if (kind === 'directory') return bare;
  if (kind === 'segment') return file.slice(0, file.indexOf('/' + bare + '/') + 1 + bare.length);
  if (kind === 'glob') {
    const matched = globRegExp(word).exec(file)?.[1];
    return matched === undefined || matched === file ? undefined : matched;
  }
  return undefined;
}

const wordKeys = new WeakMap<readonly string[], Map<string, readonly string[]>>();

// The map keys of a rule: per (word, entry) it names, the entry's key, or the cited directory when
// that is shorter. A glob without `/` (`*.test.ts`) names a kind of file, not a place: no key.
function ruleKeys(
  words: readonly string[],
  entries: readonly string[],
  directories: ReadonlySet<string>,
): Set<string> {
  let cache = wordKeys.get(entries);
  if (cache === undefined) {
    cache = new Map();
    wordKeys.set(entries, cache);
  }
  const keys = new Set<string>();
  for (const word of words) {
    let ofWord = cache.get(word);
    if (ofWord === undefined) {
      const found = new Set<string>();
      if (!WILDCARD.test(word) || word.includes('/'))
        for (const entry of entries) {
          const kind = pathKind(word, entry);
          if (kind === undefined) continue;
          const cited = citedDirectory(word, entry, kind);
          const key = mapKey(entry, directories);
          found.add(cited !== undefined && cited.length < key.length ? cited : key);
        }
      ofWord = [...found];
      cache.set(word, ofWord);
    }
    for (const key of ofWord) keys.add(key);
  }
  return keys;
}

function formatAreas(numbersByArea: ReadonlyMap<Area, readonly number[]>): string {
  return AREAS.filter((area) => (numbersByArea.get(area) ?? []).length > 0)
    .map(
      (area) => `${area} ${[...(numbersByArea.get(area) ?? [])].sort((a, b) => a - b).join(', ')}`,
    )
    .join('; ');
}

function groupByArea(rules: Iterable<Rule>): Map<Area, number[]> {
  const grouped = new Map<Area, number[]>();
  for (const rule of rules)
    grouped.set(rule.area, [...(grouped.get(rule.area) ?? []), rule.number]);
  return grouped;
}

export function renderMap(rules: readonly Rule[], entries: readonly string[]): string {
  const directories = directoriesOf(entries);
  const byKey = new Map<string, Rule[]>();
  for (const rule of rules)
    for (const key of ruleKeys(wordsOf(rule.body), entries, directories))
      byKey.set(key, [...(byKey.get(key) ?? []), rule]);
  const rows = [...byKey.keys()]
    .sort()
    .map((key) => `| \`${key}\` | ${formatAreas(groupByArea(byKey.get(key) ?? []))} |`);
  return ['| Путь | Правила |', '|---|---|', ...rows].join('\n');
}

export function mapBlock(skillText: string): string {
  const start = skillText.indexOf(MAP_START);
  const end = skillText.indexOf(MAP_END);
  if (start === -1 || end === -1 || end < start)
    throw new RulesError(`${SKILL_FILE}: no "${MAP_START}" ... "${MAP_END}" block`);
  return skillText
    .slice(start + MAP_START.length, end)
    .replace(/^\n/, '')
    .replace(/\n$/, '');
}

// --- rules for files -----------------------------------------------------------------------

interface FileRules {
  file: string;
  direct: Rule[];
  directory: Rule[];
  always: Rule[];
  key: string;
}

// The rules of the short invariant list `.claude/CLAUDE.md` loaded every time before #770, and
// Rule 11 so that auth.md comes whole: they hold where their text names no file (a new route
// directory, a new writer).
const ALWAYS: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 13];
const ALWAYS_UNDER: readonly string[] = ['apps/', 'packages/'];

export function rulesFor(
  files: readonly string[],
  rules: readonly Rule[],
  entries: readonly string[],
): { perFile: FileRules[]; rules: Rule[]; areas: Area[] } {
  const directories = directoriesOf(entries);
  const wordsByRule = new Map(rules.map((rule) => [rule.number, wordsOf(rule.body)]));
  const keysOf = new Map(
    rules.map((rule) => [
      rule.number,
      ruleKeys(wordsByRule.get(rule.number) ?? [], entries, directories),
    ]),
  );
  const found = new Map<number, Rule>();
  const perFile: FileRules[] = [];
  let uncovered = false;
  for (const file of files) {
    const key = mapKey(file, directories);
    const direct = rules.filter((rule) =>
      (wordsByRule.get(rule.number) ?? []).some((word) => citesPath(word, file)),
    );
    const directory = rules.filter(
      (rule) => !direct.includes(rule) && (keysOf.get(rule.number) ?? new Set()).has(key),
    );
    const always = ALWAYS_UNDER.some((prefix) => file.startsWith(prefix))
      ? rules.filter(
          (rule) =>
            ALWAYS.includes(rule.number) && !direct.includes(rule) && !directory.includes(rule),
        )
      : [];
    for (const rule of [...direct, ...directory, ...always]) found.set(rule.number, rule);
    if (direct.length === 0 && directory.length === 0) uncovered = true;
    perFile.push({ file, direct, directory, always, key });
  }
  const areas = new Set<Area>([...found.values()].map((rule) => rule.area));
  if (uncovered) areas.add('core');
  return {
    perFile,
    rules: [...found.values()].sort((a, b) => a.number - b.number),
    areas: AREAS.filter((area) => areas.has(area)),
  };
}

export function renderList(perFile: readonly FileRules[]): string {
  const lines: string[] = [];
  for (const { file, direct, directory, always, key } of perFile) {
    lines.push(file);
    if (direct.length > 0) lines.push(`  cites: ${formatAreas(groupByArea(direct))}`);
    if (directory.length > 0)
      lines.push(`  same directory (${key}): ${formatAreas(groupByArea(directory))}`);
    if (always.length > 0)
      lines.push(`  always (${ALWAYS_UNDER.join(', ')}): ${formatAreas(groupByArea(always))}`);
    if (direct.length === 0 && directory.length === 0)
      lines.push(`  no rule cites ${file} → read ${ruleFilePath('core')}`);
  }
  return lines.join('\n');
}

// --- --split -------------------------------------------------------------------------------

// The rules of the old one-section SKILL.md, the way the proof of #770 reads them: from the line
// starting "1. **", blank lines and `---` dropped, a line starting "N. " opening rule N.
export function extractSectionRules(skillText: string): Map<number, string> {
  const lines = skillText.split('\n');
  const start = lines.indexOf(SECTION_HEADING);
  const end = lines.indexOf(SECTION_END, start);
  if (start === -1 || end === -1) throw new RulesError('no "Architecture Rules" section');
  const section = lines.slice(start + 1, end);
  if (section.includes('### Index'))
    throw new RulesError('the section is already an index: nothing to split');
  const first = section.findIndex((line) => line.startsWith('1. **'));
  if (first === -1) throw new RulesError('the section has no "1. **" line');
  const rules = new Map<number, string[]>();
  let current: string[] | undefined;
  for (const line of section.slice(first)) {
    if (line === '' || line === '---') continue;
    const opening = /^(\d+)\. /.exec(line);
    if (opening !== null) {
      const number = Number(opening[1]);
      if (rules.has(number)) throw new RulesError(`Rule ${number} appears twice in the section`);
      current = [];
      rules.set(number, current);
    }
    if (current === undefined) throw new RulesError(`a line before rule 1: ${line}`);
    current.push(line);
  }
  return new Map([...rules].map(([number, body]) => [number, body.join('\n')]));
}

export function renderRuleFile(head: string, rules: readonly Rule[]): string {
  const sections = rules.map((rule) => `### Rule ${rule.number}\n${rule.body}\n`);
  return `${head}${sections.join('\n')}`;
}

function headOf(text: string | undefined, area: Area): string {
  if (text === undefined) return `# Architecture Rules — ${area}\n\n`;
  const at = text.search(/^### /m);
  return at === -1 ? text : text.slice(0, at);
}

export function splitRules(
  sectionRules: ReadonlyMap<number, string>,
  index: ReadonlyMap<number, string>,
): Rule[] {
  const missing = [...sectionRules.keys()].filter((number) => !index.has(number));
  if (missing.length > 0)
    throw new RulesError(
      `no index line in ${SKILL_FILE} for Rule ${missing.join(', ')}: add it first`,
    );
  return [...sectionRules]
    .map(([number, body]) => {
      const area = index.get(number) ?? '';
      if (!isArea(area))
        throw new RulesError(`index: Rule ${number} points to unknown area ${area}`);
      return { number, area, body };
    })
    .sort((a, b) => a.number - b.number);
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

function split(root: string, ref: string): number {
  const old = git(root, ['show', `${ref}:${SKILL_FILE}`]);
  const sectionRules = extractSectionRules(old);
  const rules = splitRules(
    sectionRules,
    parseIndex(readFileSync(path.join(root, SKILL_FILE), 'utf8')),
  );
  for (const area of AREAS) {
    const file = path.join(root, ruleFilePath(area));
    const head = headOf(existsSync(file) ? readFileSync(file, 'utf8') : undefined, area);
    writeFileSync(
      file,
      renderRuleFile(
        head,
        rules.filter((rule) => rule.area === area),
      ),
    );
  }
  const source = [...sectionRules.keys()]
    .sort((a, b) => a - b)
    .map((number) => `${sectionRules.get(number)}\n`)
    .join('');
  const written = renderDump(loadRules(root));
  process.stdout.write(
    `source  sha256 ${sha256(source)}  (${ref}:${SKILL_FILE}, the rules section)\n`,
  );
  process.stdout.write(`written sha256 ${sha256(written)}  (--dump of ${RULES_DIR}/*.md)\n`);
  return source === written ? 0 : 1;
}

// --- cli -----------------------------------------------------------------------------------

const USAGE = `usage:
  node tooling/rules-for.ts <file ...>          per file: the rules whose text names it, the rules
                                                of its directory and, under apps/ or packages/,
                                                the always-on set; then the text of every rule found
  node tooling/rules-for.ts --list <file ...>   the per-file lines only
  node tooling/rules-for.ts --files <file ...>  the rule files to read (core.md when a file has
                                                no rule)
  node tooling/rules-for.ts --map               the index's "path -> rules" block
  node tooling/rules-for.ts --dump              every rule by number, body as is
  node tooling/rules-for.ts --split <ref>       rewrite the rule files from the old one-section
                                                SKILL.md at <ref>; prints the sha256 of both sides`;

function main(argv: readonly string[]): number {
  const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim();
  const [first, ...rest] = argv;
  if (first === '--split') {
    if (rest.length !== 1) throw new RulesError(USAGE);
    return split(root, rest[0]);
  }
  const rules = loadRules(root);
  if (first === '--dump' || first === '--map') {
    if (rest.length > 0) throw new RulesError(USAGE);
    process.stdout.write(
      first === '--dump' ? renderDump(rules) : `${renderMap(rules, lsFiles(root))}\n`,
    );
    return 0;
  }
  const mode = first === '--list' || first === '--files' ? first : 'full';
  const files = mode === 'full' ? argv : rest;
  if (files.length === 0 || files.some((file) => file.startsWith('--')))
    throw new RulesError(USAGE);
  const result = rulesFor(
    files.map((file) => path.relative(root, path.resolve(file))),
    rules,
    lsFiles(root),
  );
  if (mode === '--files') {
    process.stdout.write(result.areas.map((area) => `${ruleFilePath(area)}\n`).join(''));
    return 0;
  }
  const out = [renderList(result.perFile)];
  if (mode === 'full')
    for (const rule of result.rules)
      out.push('', `### Rule ${rule.number} — rules/${rule.area}.md`, rule.body);
  process.stdout.write(`${out.join('\n')}\n`);
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof RulesError ? error.message : ((error as Error).stack ?? String(error))}\n`,
    );
    process.exitCode = 2;
  }
}
