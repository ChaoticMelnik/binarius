import { decodeTelegramEntities, telegramHtmlTokens } from '@binarius/shared';
import { html, type SafeHtml } from '../html';

// The admin preview (#300, docs/admin-pages.md → Bot texts): Telegram HTML the backend rendered
// and web's contract check passed (telegramHtmlProblems), as browser HTML. Every tag is rebuilt
// from this table and every text goes through `html`, so nothing of the input reaches the page
// raw; attributes are dropped except a link's href, kept only for the schemes below.

const LINK_SCHEMES = new Set(['http:', 'https:', 'tg:']);

const SIMPLE: Record<string, (inner: SafeHtml) => SafeHtml> = {
  b: (inner) => html`<b>${inner}</b>`,
  strong: (inner) => html`<b>${inner}</b>`,
  i: (inner) => html`<i>${inner}</i>`,
  em: (inner) => html`<i>${inner}</i>`,
  u: (inner) => html`<u>${inner}</u>`,
  ins: (inner) => html`<u>${inner}</u>`,
  s: (inner) => html`<s>${inner}</s>`,
  strike: (inner) => html`<s>${inner}</s>`,
  del: (inner) => html`<s>${inner}</s>`,
  span: (inner) => html`<span class="tg-spoiler">${inner}</span>`,
  'tg-spoiler': (inner) => html`<span class="tg-spoiler">${inner}</span>`,
  code: (inner) => html`<code>${inner}</code>`,
  pre: (inner) => html`<pre>${inner}</pre>`,
  'tg-emoji': (inner) => html`<span class="tg-emoji">${inner}</span>`,
  'tg-time': (inner) => html`<span class="tg-time">${inner}</span>`,
};

// the href as Telegram reads it (entities decoded), and only when its scheme is one of ours
function safeHref(raw: string | true | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const href = decodeTelegramEntities(raw);
  try {
    return LINK_SCHEMES.has(new URL(href).protocol) ? href : undefined;
  } catch {
    return undefined;
  }
}

interface Frame {
  name: string;
  attributes: Readonly<Record<string, string | true>>;
  children: SafeHtml[];
}

function element(frame: Frame): SafeHtml {
  const inner = html`${frame.children}`;
  if (frame.name === 'a') {
    const href = safeHref(frame.attributes.href);
    return href === undefined
      ? inner
      : html`<a href="${href}" rel="noopener noreferrer" target="_blank">${inner}</a>`;
  }
  if (frame.name === 'blockquote') {
    return frame.attributes.expandable === true
      ? html`<blockquote class="expandable">${inner}</blockquote>`
      : html`<blockquote>${inner}</blockquote>`;
  }
  const build = Object.hasOwn(SIMPLE, frame.name) ? SIMPLE[frame.name] : undefined;
  return build === undefined ? inner : build(inner);
}

export function telegramPreview(value: string): SafeHtml {
  const root: Frame = { name: '', attributes: {}, children: [] };
  const stack: Frame[] = [root];
  for (const token of telegramHtmlTokens(value)) {
    const top = stack.at(-1) ?? root;
    if (token.type === 'text') top.children.push(html`${token.text}`);
    else if (token.type === 'open') {
      stack.push({ name: token.name, attributes: token.attributes, children: [] });
    } else if (stack.length > 1) {
      const closed = stack.pop() ?? root;
      (stack.at(-1) ?? root).children.push(element(closed));
    }
  }
  return html`${root.children}`;
}
