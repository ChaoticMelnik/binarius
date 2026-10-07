import {
  escapeTelegramHtml,
  plainTextOf,
  TELEGRAM_MESSAGE_LIMIT,
  telegramHtmlProblems,
  telegramHtmlTagRanges,
  telegramHtmlTemplate,
  type TelegramHtml,
  type TelegramHtmlHole,
} from './telegram-html';

// The machinery behind the bot texts catalog (bot-texts.ts, docs/bot-texts.md): the entry shape,
// the template grammar, the validator and the views the bot and the backend read. Generic over the
// catalog, so its tests run on a small one of their own.

export const BotTextKind = { Html: 'html', Plain: 'plain' } as const;
export type BotTextKind = (typeof BotTextKind)[keyof typeof BotTextKind];

// A project limit, not the Bot API's: it publishes none for an inline button's text. It holds a
// button readable and is well above the longest default (docs/bot-texts.md → Limits).
export const BOT_LABEL_LIMIT = 64;

export interface BotTextEntry<
  K extends BotTextKind = BotTextKind,
  G extends string = string,
  A extends string | undefined = string | undefined,
> {
  readonly kind: K;
  readonly group: G;
  // where the text is shown, in Russian, for the admin section
  readonly description: string;
  readonly source: string;
  // the one value the caller passes, and a sample of it for the validator
  readonly arg: A;
  readonly sample: string | undefined;
  // placeholder → the key whose text goes there; optional in the template
  readonly fragments: Readonly<Record<string, string>>;
  readonly limit: number;
  readonly singleLine: boolean;
}

export interface BotTextOptions<A extends string> {
  arg?: { name: A; sample: string };
  fragments?: Readonly<Record<string, string>>;
  limit?: number;
  singleLine?: boolean;
}

type ArgOf<A extends string> = [A] extends [never] ? undefined : A;

function entryOf<K extends BotTextKind, G extends string, A extends string>(
  kind: K,
  group: G,
  description: string,
  source: string,
  options: BotTextOptions<A>,
  defaults: { limit: number; singleLine: boolean },
): BotTextEntry<K, G, ArgOf<A>> {
  return {
    kind,
    group,
    description,
    source,
    arg: options.arg?.name as ArgOf<A>,
    sample: options.arg?.sample,
    fragments: options.fragments ?? {},
    limit: options.limit ?? defaults.limit,
    singleLine: options.singleLine ?? defaults.singleLine,
  };
}

// A message part: Telegram HTML, a message's limit, any number of lines.
export const botHtmlText = <const G extends string, const A extends string = never>(
  group: G,
  description: string,
  source: string,
  options: BotTextOptions<A> = {},
): BotTextEntry<typeof BotTextKind.Html, G, ArgOf<A>> =>
  entryOf(BotTextKind.Html, group, description, source, options, {
    limit: TELEGRAM_MESSAGE_LIMIT,
    singleLine: false,
  });

// A label, a word put into a message, a command description or the profile: never parsed by
// Telegram, so never escaped; one line of BOT_LABEL_LIMIT unless told otherwise.
export const botPlainText = <const G extends string, const A extends string = never>(
  group: G,
  description: string,
  source: string,
  options: BotTextOptions<A> = {},
): BotTextEntry<typeof BotTextKind.Plain, G, ArgOf<A>> =>
  entryOf(BotTextKind.Plain, group, description, source, options, {
    limit: BOT_LABEL_LIMIT,
    singleLine: true,
  });

export type BotTextCatalog = Readonly<Record<string, BotTextEntry>>;

type KeyOf<C> = keyof C & string;
export type BotHtmlKeyOf<C> = {
  [K in KeyOf<C>]: C[K] extends { kind: typeof BotTextKind.Html } ? K : never;
}[KeyOf<C>];
export type BotPlainKeyOf<C> = Exclude<KeyOf<C>, BotHtmlKeyOf<C>>;
export type BotHtmlTextsOf<C> = {
  readonly [K in BotHtmlKeyOf<C>]: C[K] extends { arg: string }
    ? (value: string | TelegramHtml) => TelegramHtml
    : TelegramHtml;
};
export type BotPlainTextsOf<C> = {
  readonly [K in BotPlainKeyOf<C>]: C[K] extends { arg: string }
    ? (value: string) => string
    : string;
};

// Where a key's current text comes from: the catalog's default, or (part 2) an override.
export interface BotTextSource<K extends string = string> {
  sourceOf(key: K): string;
}

// ---- Grammar --------------------------------------------------------------------------------
// `{name}` is a placeholder; any other brace is a stray one. There is no escape: no default needs
// a literal brace.

const TOKEN = /\{([a-z][a-zA-Z0-9]*)\}|[{}]/g;

export interface ParsedBotText {
  // one more than names: the text around and between the placeholders
  statics: string[];
  names: string[];
  strayBraces: number;
}

export function parseBotTextTemplate(source: string): ParsedBotText {
  const statics: string[] = [];
  const names: string[] = [];
  let strayBraces = 0;
  let current = '';
  let last = 0;
  for (const match of source.matchAll(TOKEN)) {
    current += source.slice(last, match.index);
    last = match.index + match[0].length;
    const name = match[1];
    if (name === undefined) {
      strayBraces += 1;
      current += match[0];
      continue;
    }
    statics.push(current);
    current = '';
    names.push(name);
  }
  statics.push(current + source.slice(last));
  return { statics, names, strayBraces };
}

// ---- Validator ------------------------------------------------------------------------------

export const BotTextProblemCode = {
  Empty: 'empty',
  StrayBrace: 'stray_brace',
  UnknownPlaceholder: 'unknown_placeholder',
  MissingPlaceholder: 'missing_placeholder',
  PlaceholderInTag: 'placeholder_in_tag',
  InvalidHtml: 'invalid_html',
  TooLong: 'too_long',
  PaddedLine: 'padded_line',
  Multiline: 'multiline',
} as const;
export type BotTextProblemCode = (typeof BotTextProblemCode)[keyof typeof BotTextProblemCode];

export interface BotTextProblem {
  code: BotTextProblemCode;
  detail?: string;
}

// Stands in for a string value when an html text is checked: not a letter, a digit, `#` or `;`,
// so a partial entity of the statics right before a hole (`&am{v};`) is left a bare `&` and
// refused. A text valid with it and with no placeholder inside a tag is valid with any escaped
// value, the empty one included (docs/bot-texts.md → Why a saved text cannot break on a value).
const STAND_IN = '·';
// For finding a placeholder inside a tag: a letter keeps a tag that holds one a tag
// (`<blockquote e{v}pandable>`), where the stand-in above would leave a bare `<` instead.
const TAG_STAND_IN = 'x';
const LINE_BREAK = /[\n\r\p{Zl}\p{Zp}]/u;

function unknownNames(entry: BotTextEntry, names: readonly string[]): string[] {
  return [...new Set(names)].filter(
    (name) => name !== entry.arg && !Object.hasOwn(entry.fragments, name),
  );
}

function assemble(
  parsed: ParsedBotText,
  holeOf: (name: string) => string,
): { text: string; offsets: number[] } {
  let text = parsed.statics[0] ?? '';
  const offsets: number[] = [];
  parsed.names.forEach((name, index) => {
    offsets.push(text.length);
    text += holeOf(name) + (parsed.statics[index + 1] ?? '');
  });
  return { text, offsets };
}

/**
 * What is wrong with `source` as the text of `key`; empty when nothing is. Fragments are rendered
 * from `lookup`'s current texts. A stray brace or an unknown placeholder stops the check there:
 * nothing can be rendered.
 */
export function botTextEntryProblems<C extends BotTextCatalog>(
  catalog: C,
  key: KeyOf<C>,
  source: string,
  lookup: BotTextSource<KeyOf<C>>,
): BotTextProblem[] {
  const entry: BotTextEntry = catalog[key];
  if (source.trim() === '') return [{ code: BotTextProblemCode.Empty }];
  const parsed = parseBotTextTemplate(source);
  const problems: BotTextProblem[] = [];
  if (parsed.strayBraces > 0) problems.push({ code: BotTextProblemCode.StrayBrace });
  for (const name of unknownNames(entry, parsed.names)) {
    problems.push({ code: BotTextProblemCode.UnknownPlaceholder, detail: name });
  }
  if (problems.length > 0) return problems;
  if (entry.arg !== undefined && !parsed.names.includes(entry.arg)) {
    problems.push({ code: BotTextProblemCode.MissingPlaceholder, detail: entry.arg });
  }

  const isHtml = entry.kind === BotTextKind.Html;
  const fragmentOf = (name: string): string => {
    const fragmentKey = entry.fragments[name] as KeyOf<C>;
    const text = lookup.sourceOf(fragmentKey);
    return isHtml && catalog[fragmentKey]?.kind !== BotTextKind.Html
      ? escapeTelegramHtml(text)
      : text;
  };
  const withArg = (value: string) => (name: string) =>
    name === entry.arg ? value : fragmentOf(name);
  const sample = entry.sample ?? '';
  const withSample = assemble(parsed, withArg(isHtml ? escapeTelegramHtml(sample) : sample)).text;

  if (isHtml) {
    const allStandIns = assemble(parsed, () => TAG_STAND_IN);
    const tags = telegramHtmlTagRanges(allStandIns.text);
    const inTag = new Set(
      parsed.names.filter((_name, index) => {
        const offset = allStandIns.offsets[index] ?? 0;
        return tags.some(([start, end]) => offset >= start && offset < end);
      }),
    );
    for (const name of inTag) {
      problems.push({ code: BotTextProblemCode.PlaceholderInTag, detail: name });
    }
    const htmlProblem =
      telegramHtmlProblems(assemble(parsed, withArg(STAND_IN)).text)[0] ??
      telegramHtmlProblems(withSample)[0];
    if (htmlProblem !== undefined) {
      problems.push({ code: BotTextProblemCode.InvalidHtml, detail: htmlProblem });
    }
  }

  const shown = isHtml ? plainTextOf(withSample) : withSample;
  if (shown.trim() === '') problems.push({ code: BotTextProblemCode.Empty });
  if (shown.length > entry.limit) {
    problems.push({ code: BotTextProblemCode.TooLong, detail: String(shown.length) });
  }
  if (shown.split('\n').some((line) => line !== line.trim())) {
    problems.push({ code: BotTextProblemCode.PaddedLine });
  }
  if (entry.singleLine && LINE_BREAK.test(shown)) {
    problems.push({ code: BotTextProblemCode.Multiline });
  }
  return problems;
}

// ---- Views ----------------------------------------------------------------------------------

// A text that does not parse against its key reached a view: a catalog default the tests let
// through, or a source that skipped the validator. Only `name`, as InvalidTelegramTemplate.
export class InvalidBotText extends Error {
  override readonly name = 'InvalidBotText';
}

interface Cached {
  sources: readonly string[];
  value: unknown;
}

const sameSources = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

/**
 * The catalog's texts as `{ html, plain }`, one getter per key, read from `source` on every access.
 * A getter returns the same object (or function) while the key's text and its fragments' texts are
 * unchanged — the suites compare texts with toBe — and renders again once any of them changes.
 */
export function createBotTextViews<C extends BotTextCatalog>(
  catalog: C,
  source: BotTextSource<KeyOf<C>>,
): { html: BotHtmlTextsOf<C>; plain: BotPlainTextsOf<C> } {
  const cache = new Map<string, Cached>();

  function valueOf(key: KeyOf<C>): unknown {
    const entry: BotTextEntry = catalog[key];
    const fragmentKeys = Object.values(entry.fragments) as KeyOf<C>[];
    const sources = [source.sourceOf(key), ...fragmentKeys.map((k) => source.sourceOf(k))];
    const cached = cache.get(key);
    if (cached !== undefined && sameSources(cached.sources, sources)) return cached.value;
    const value = build(entry, sources[0] ?? '');
    cache.set(key, { sources, value });
    return value;
  }

  function build(entry: BotTextEntry, text: string): unknown {
    const parsed = parseBotTextTemplate(text);
    if (parsed.strayBraces > 0 || unknownNames(entry, parsed.names).length > 0) {
      throw new InvalidBotText();
    }
    const fragments = new Map(
      parsed.names
        .filter((name) => name !== entry.arg)
        .map((name) => [name, valueOf(entry.fragments[name] as KeyOf<C>)] as const),
    );
    const holesWith = (value: unknown): unknown[] =>
      parsed.names.map((name) => (name === entry.arg ? value : fragments.get(name)));
    if (entry.kind === BotTextKind.Html) {
      const render = (value?: string | TelegramHtml): TelegramHtml =>
        telegramHtmlTemplate(parsed.statics, holesWith(value) as TelegramHtmlHole[]);
      return entry.arg === undefined ? render() : (value: string | TelegramHtml) => render(value);
    }
    const render = (value?: string): string =>
      assemble(parsed, (name) => String(name === entry.arg ? value : fragments.get(name))).text;
    return entry.arg === undefined ? render() : (value: string) => render(value);
  }

  const html = {};
  const plain = {};
  for (const key of Object.keys(catalog) as KeyOf<C>[]) {
    Object.defineProperty(catalog[key]?.kind === BotTextKind.Html ? html : plain, key, {
      get: () => valueOf(key),
      enumerable: true,
    });
  }
  return { html: html as BotHtmlTextsOf<C>, plain: plain as BotPlainTextsOf<C> };
}
