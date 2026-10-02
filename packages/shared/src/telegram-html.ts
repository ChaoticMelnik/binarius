// Text a Telegram user receives with parse_mode HTML. The Bot API's "HTML style" (as shipped in
// @grammyjs/types 5.0.0, message.d.ts) has three rules this module is built around: only the tags
// it lists are accepted; every `<`, `>` and `&` that is not part of a tag or an entity must be
// written as an entity; and the only named entities are &lt; &gt; &amp; &quot; (numeric ones are
// all accepted). Breaking any of them makes Telegram refuse the whole message.
//
// Not for browser HTML: apps/web has its own `html` with a wider escape set. The names differ on
// purpose, and the two classes are not assignable to each other.

/**
 * A fragment that is already Telegram HTML. The class is not exported and carries a private
 * member, so the type is nominal: an object literal does not satisfy it and the class cannot be
 * named outside this module — the only way in without a cast is `telegramHtml`, which escapes
 * every hole. A class rather than a branded string because the tag has to recognise its own
 * output at runtime to nest it without escaping it a second time. A cast defeats this, as it
 * defeats any type. `telegram-html.typecheck.ts` is the oracle.
 */
class TelegramHtmlValue {
  declare private readonly brand: void;
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }

  toString(): string {
    return this.value;
  }
}

export type TelegramHtml = TelegramHtmlValue;

// Bot API: sendMessage takes "1-4096 characters after entities parsing", a caption "0-1024", both
// counted in UTF-16 code units — what String#length returns on plainTextOf's result.
export const TELEGRAM_MESSAGE_LIMIT = 4096;
export const TELEGRAM_CAPTION_LIMIT = 1024;

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };

// Only the three the Bot API requires: `"`, `'`, `_` and `*` mean nothing in HTML mode text.
export const escapeTelegramHtml = (value: string): string =>
  value.replace(/[&<>]/g, (c) => ESCAPES[c] ?? c);

// No number or bigint: tokens and money are strings in every view, and a number that reaches a
// text was converted somewhere it should not have been. No null either: the caller decides what
// an absent value reads as.
export type TelegramHtmlHole = string | TelegramHtml | readonly TelegramHtml[];

/** Tagged template: every hole is escaped unless it is already TelegramHtml. */
export function telegramHtml(
  strings: TemplateStringsArray,
  ...values: TelegramHtmlHole[]
): TelegramHtml {
  let out = strings[0] ?? '';
  for (let index = 0; index < values.length; index += 1) {
    out += render(values[index]) + (strings[index + 1] ?? '');
  }
  return new TelegramHtmlValue(out);
}

// String(...) rather than trusting the hole type: a cast that lets a foreign object through is
// escaped through its toString() instead of crashing on it.
function render(value: unknown): string {
  if (value instanceof TelegramHtmlValue) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  return escapeTelegramHtml(String(value));
}

type AttributeRule = 'required' | 'optional';

// tag → the attributes it may carry; anything not listed is refused
const TAGS: Record<string, Record<string, AttributeRule>> = {
  b: {},
  strong: {},
  i: {},
  em: {},
  u: {},
  ins: {},
  s: {},
  strike: {},
  del: {},
  span: { class: 'required' },
  'tg-spoiler': {},
  a: { href: 'required' },
  'tg-emoji': { 'emoji-id': 'required' },
  'tg-time': { unix: 'required', format: 'optional' },
  code: { class: 'optional' },
  pre: {},
  blockquote: { expandable: 'optional' },
};

// attributes that are written bare (`<blockquote expandable>`); every other one needs a value
const BARE_ATTRIBUTES = new Set(['expandable']);

const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[a-zA-Z][a-zA-Z0-9-]*(?:="[^"<>]*")?)*)\s*>/y;
const ATTRIBUTE = /\s+([a-zA-Z][a-zA-Z0-9-]*)(?:="([^"<>]*)")?/g;
const ENTITY = /&(?:lt|gt|amp|quot|#\d+|#x[0-9a-fA-F]+);/y;

/**
 * What would make Telegram refuse `value` as HTML; empty when it is valid. A tokenizer over
 * Telegram's small dialect, not an HTML parser: it checks tags, attributes, nesting and entities,
 * not the URLs, emoji ids or timestamps inside attribute values.
 */
export function telegramHtmlProblems(value: string): string[] {
  const problems: string[] = [];
  const open: string[] = [];
  let index = 0;
  while (index < value.length) {
    const char = value[index];
    if (char === '<') {
      TAG.lastIndex = index;
      const match = TAG.exec(value);
      if (match === null) {
        problems.push(`a bare "<" at ${index}`);
        index += 1;
        continue;
      }
      const [whole, slash, rawName = '', attributes = ''] = match;
      const name = rawName.toLowerCase();
      if (slash === '/') {
        if (attributes !== '') problems.push(`</${name}> carries attributes`);
        const innermost = open.pop();
        if (innermost !== name) {
          problems.push(
            innermost === undefined
              ? `</${name}> closes nothing`
              : `</${name}> closes <${innermost}>`,
          );
          if (innermost !== undefined) open.push(innermost);
        }
      } else {
        problems.push(...openingTagProblems(name, attributes, open));
        open.push(name);
      }
      index += whole.length;
      continue;
    }
    if (char === '>') {
      problems.push(`a bare ">" at ${index}`);
    } else if (char === '&') {
      ENTITY.lastIndex = index;
      const match = ENTITY.exec(value);
      if (match === null) problems.push(`a bare "&" at ${index}`);
      else {
        index += match[0].length;
        continue;
      }
    }
    index += 1;
  }
  for (const name of open.reverse()) problems.push(`<${name}> is never closed`);
  return problems;
}

function openingTagProblems(name: string, attributes: string, open: readonly string[]): string[] {
  const allowed = TAGS[name];
  if (allowed === undefined) return [`<${name}> is not a Telegram tag`];
  const problems: string[] = [];
  const seen = new Map<string, string | undefined>();
  for (const [, rawAttribute = '', attributeValue] of attributes.matchAll(ATTRIBUTE)) {
    const attribute = rawAttribute.toLowerCase();
    if (allowed[attribute] === undefined) {
      problems.push(`<${name}> does not take ${attribute}`);
      continue;
    }
    if ((attributeValue === undefined) !== BARE_ATTRIBUTES.has(attribute)) {
      problems.push(
        attributeValue === undefined
          ? `${attribute} on <${name}> needs a value`
          : `${attribute} on <${name}> takes no value`,
      );
    }
    seen.set(attribute, attributeValue);
  }
  for (const [attribute, rule] of Object.entries(allowed)) {
    if (rule === 'required' && !seen.has(attribute)) {
      problems.push(`<${name}> needs ${attribute}`);
    }
  }
  if (name === 'span' && seen.has('class') && seen.get('class') !== 'tg-spoiler') {
    problems.push('<span> is only a spoiler: class="tg-spoiler"');
  }
  if (name === 'code' && seen.has('class')) {
    if (!/^language-./.test(seen.get('class') ?? '')) {
      problems.push('class on <code> must be language-…');
    }
    if (open.at(-1) !== 'pre') {
      problems.push('class on <code> is allowed only directly inside <pre>');
    }
  }
  if (name === 'blockquote' && open.includes('blockquote')) {
    problems.push('blockquotes cannot be nested');
  }
  return problems;
}

const TAG_ANYWHERE = new RegExp(TAG.source, 'g');
const ENTITY_ANYWHERE = new RegExp(ENTITY.source, 'g');
const NAMED_ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"' };

/**
 * The text "after entities parsing" that the Bot API's length limits count: tags removed,
 * entities decoded in one pass (so `&amp;lt;` reads `&lt;`, as in Telegram). Meaningful only for a
 * value telegramHtmlProblems accepts.
 */
export function plainTextOf(value: TelegramHtml | string): string {
  return String(value)
    .replace(TAG_ANYWHERE, '')
    .replace(ENTITY_ANYWHERE, (entity) => {
      const body = entity.slice(1, -1);
      if (!body.startsWith('#')) return NAMED_ENTITIES[body] ?? entity;
      const codePoint = body.startsWith('#x')
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
    });
}
