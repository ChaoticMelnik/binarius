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

// A value a text can print (bot-text-vars.ts, docs/bot-texts.md → Variables): `format` turns the
// caller's input into the string that fills the placeholder, reading a stand-in text (an unknown
// address, a stale balance) through `texts`; `sample` is what the validator and the preview put
// there. Synchronous and given nothing but its input and the texts: a text never causes a request.
export interface BotTextVariable<I = unknown> {
  // in Russian, for the editor and the CLI
  readonly description: string;
  readonly sample: string;
  format(input: I, texts: (key: string) => string): string;
}

export type BotTextVariables = Readonly<Record<string, BotTextVariable>>;

export type BotTextVariableInput<V> = V extends BotTextVariable<infer I> ? I : never;

// What the caller of a key with variables passes: every variable of the key, by name.
export type BotTextContextOf<R> = { readonly [N in keyof R]: BotTextVariableInput<R[N]> };

export interface BotTextEntry<
  K extends BotTextKind = BotTextKind,
  G extends string = string,
  R extends BotTextVariables = BotTextVariables,
> {
  readonly kind: K;
  readonly group: G;
  // where the text is shown, in Russian, for the admin section
  readonly description: string;
  readonly source: string;
  // the values every caller of the key holds when it renders; each optional in the template (#358)
  // the names of `variables`, in the catalog's order
  readonly vars: readonly string[];
  readonly variables: R;
  // placeholder → the key whose text goes there; optional in the template
  readonly fragments: Readonly<Record<string, string>>;
  readonly limit: number;
  readonly singleLine: boolean;
}

export interface BotTextOptions<R extends BotTextVariables> {
  variables?: R;
  fragments?: Readonly<Record<string, string>>;
  limit?: number;
  singleLine?: boolean;
}

export type BotTextNoVariables = Readonly<Record<never, BotTextVariable>>;

function entryOf<K extends BotTextKind, G extends string, R extends BotTextVariables>(
  kind: K,
  group: G,
  description: string,
  source: string,
  options: BotTextOptions<R>,
  defaults: { limit: number; singleLine: boolean },
): BotTextEntry<K, G, R> {
  const variables = options.variables ?? ({} as R);
  return {
    kind,
    group,
    description,
    source,
    vars: Object.keys(variables),
    variables,
    fragments: options.fragments ?? {},
    limit: options.limit ?? defaults.limit,
    singleLine: options.singleLine ?? defaults.singleLine,
  };
}

// A message part: Telegram HTML, a message's limit, any number of lines.
export const botHtmlText = <
  const G extends string,
  R extends BotTextVariables = BotTextNoVariables,
>(
  group: G,
  description: string,
  source: string,
  options: BotTextOptions<R> = {},
): BotTextEntry<typeof BotTextKind.Html, G, R> =>
  entryOf(BotTextKind.Html, group, description, source, options, {
    limit: TELEGRAM_MESSAGE_LIMIT,
    singleLine: false,
  });

// A label, a word put into a message, a command description or the profile: never parsed by
// Telegram, so never escaped; one line of BOT_LABEL_LIMIT unless told otherwise.
export const botPlainText = <
  const G extends string,
  R extends BotTextVariables = BotTextNoVariables,
>(
  group: G,
  description: string,
  source: string,
  options: BotTextOptions<R> = {},
): BotTextEntry<typeof BotTextKind.Plain, G, R> =>
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
type VariablesOf<E> = E extends { variables: infer R } ? R : never;
// a key with no variables is its text; one with variables, a function of their values
type ViewOf<E, T> = [keyof VariablesOf<E>] extends [never]
  ? T
  : (context: BotTextContextOf<VariablesOf<E>>) => T;
export type BotHtmlTextsOf<C> = {
  // a variable's value is data a formatter turns into a string, never TelegramHtml: html is
  // nested into html through declared fragments, which the validator renders and checks (#299)
  readonly [K in BotHtmlKeyOf<C>]: ViewOf<C[K], TelegramHtml>;
};
export type BotPlainTextsOf<C> = { readonly [K in BotPlainKeyOf<C>]: ViewOf<C[K], string> };
// every key rendered with its variables' samples: the preview, the CLI, the validator's view
export interface BotTextSamplesOf<C> {
  readonly html: { readonly [K in BotHtmlKeyOf<C>]: TelegramHtml };
  readonly plain: { readonly [K in BotPlainKeyOf<C>]: string };
}

// Where a key's current text comes from: the catalog's default, or an override (#299).
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

const isVariable = (entry: BotTextEntry, name: string): boolean =>
  Object.hasOwn(entry.variables, name);

function unknownNames(entry: BotTextEntry, names: readonly string[]): string[] {
  return [...new Set(names)].filter(
    (name) => !isVariable(entry, name) && !Object.hasOwn(entry.fragments, name),
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

  const isHtml = entry.kind === BotTextKind.Html;
  const fragmentOf = (name: string): string => {
    const fragmentKey = entry.fragments[name] as KeyOf<C>;
    const text = lookup.sourceOf(fragmentKey);
    return isHtml && catalog[fragmentKey]?.kind !== BotTextKind.Html
      ? escapeTelegramHtml(text)
      : text;
  };
  // every variable gets the same value: a stand-in, or its own sample
  const withVariables = (valueOf: (name: string) => string) => (name: string) =>
    isVariable(entry, name) ? valueOf(name) : fragmentOf(name);
  const sampleOf = (name: string): string => {
    const sample = entry.variables[name]?.sample ?? '';
    return isHtml ? escapeTelegramHtml(sample) : sample;
  };
  const withSample = assemble(parsed, withVariables(sampleOf)).text;

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
      telegramHtmlProblems(
        assemble(
          parsed,
          withVariables(() => STAND_IN),
        ).text,
      )[0] ?? telegramHtmlProblems(withSample)[0];
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

// A key's text with each variable's placeholder filled by `holeOf`, called only for the variables
// the text holds; TelegramHtml for an html key, a string for a plain one.
type RenderWith = (holeOf: (name: string) => string) => unknown;

interface Built {
  value: unknown;
  renderWith: RenderWith;
}

interface Cached {
  sources: readonly string[];
  built: Built;
}

const sameSources = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

export interface BotTextViews<C> {
  html: BotHtmlTextsOf<C>;
  plain: BotPlainTextsOf<C>;
  samples: BotTextSamplesOf<C>;
  // the estimate of assembled messages (bot-text-messages.ts): each placeholder a string of a width
  renderWith(key: KeyOf<C>, holeOf: (name: string) => string): unknown;
}

/**
 * The catalog's texts as `{ html, plain }`, one getter per key, read from `source` on every access;
 * `samples` the same with every variable at its sample. A getter returns the same object (or
 * function) while the key's text and its fragments' texts are unchanged — the suites compare texts
 * with toBe — and renders again once any of them changes. A variable is formatted only when its
 * placeholder is in the text, so a stand-in text is read only when it can be shown.
 */
export function createBotTextViews<C extends BotTextCatalog>(
  catalog: C,
  source: BotTextSource<KeyOf<C>>,
): BotTextViews<C> {
  const cache = new Map<string, Cached>();

  function builtOf(key: KeyOf<C>): Built {
    const entry: BotTextEntry = catalog[key];
    const fragmentKeys = Object.values(entry.fragments) as KeyOf<C>[];
    const sources = [source.sourceOf(key), ...fragmentKeys.map((k) => source.sourceOf(k))];
    const cached = cache.get(key);
    if (cached !== undefined && sameSources(cached.sources, sources)) return cached.built;
    const built = build(entry, sources[0] ?? '');
    cache.set(key, { sources, built });
    return built;
  }

  const textOf = (key: string): string => String(builtOf(key as KeyOf<C>).value);

  function build(entry: BotTextEntry, text: string): Built {
    const parsed = parseBotTextTemplate(text);
    if (parsed.strayBraces > 0 || unknownNames(entry, parsed.names).length > 0) {
      throw new InvalidBotText();
    }
    const fragments = new Map(
      parsed.names
        .filter((name) => !isVariable(entry, name))
        .map((name) => [name, builtOf(entry.fragments[name] as KeyOf<C>).value] as const),
    );
    const holesWith = (holeOf: (name: string) => string): unknown[] =>
      parsed.names.map((name) => (isVariable(entry, name) ? holeOf(name) : fragments.get(name)));
    const renderWith: RenderWith =
      entry.kind === BotTextKind.Html
        ? (holeOf) => telegramHtmlTemplate(parsed.statics, holesWith(holeOf) as TelegramHtmlHole[])
        : (holeOf) =>
            assemble(parsed, (name) =>
              isVariable(entry, name) ? holeOf(name) : String(fragments.get(name)),
            ).text;
    if (entry.vars.length === 0) {
      return { value: renderWith(() => ''), renderWith };
    }
    const value = (context: Readonly<Record<string, unknown>>): unknown =>
      renderWith((name) => {
        const formatted: unknown = entry.variables[name]?.format(context[name], textOf);
        // the types say string; a cast or a JS caller could still pass a TelegramHtml through
        if (typeof formatted !== 'string') throw new InvalidBotText();
        return formatted;
      });
    return { value, renderWith };
  }

  const html = {};
  const plain = {};
  const samples = { html: {}, plain: {} };
  for (const key of Object.keys(catalog) as KeyOf<C>[]) {
    const isHtml = catalog[key]?.kind === BotTextKind.Html;
    Object.defineProperty(isHtml ? html : plain, key, {
      get: () => builtOf(key).value,
      enumerable: true,
    });
    Object.defineProperty(isHtml ? samples.html : samples.plain, key, {
      get: () => builtOf(key).renderWith((name) => catalog[key]?.variables[name]?.sample ?? ''),
      enumerable: true,
    });
  }
  return {
    html: html as BotHtmlTextsOf<C>,
    plain: plain as BotPlainTextsOf<C>,
    samples: samples as BotTextSamplesOf<C>,
    renderWith: (key, holeOf) => builtOf(key).renderWith(holeOf),
  };
}
