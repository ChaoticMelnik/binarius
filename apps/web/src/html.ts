import type { FastifyReply } from 'fastify';

/**
 * A fragment that is already HTML. The class is not exported and it carries a private member, so
 * the type is nominal: an object literal does not satisfy it (TS2741) and the class cannot be
 * named outside this module — the only way in without a cast is `html`, which escapes everything
 * it interpolates. (A cast defeats any mechanism, and saying otherwise would be the kind of
 * promise this file is here to avoid.) `sendHtml` sends `.value` raw on the strength of exactly
 * that. It is also what makes `html`'s own output nestable without a second escaping pass, and a
 * staff member's user agent — which goes into a table cell — impossible to interpolate raw by
 * mistake. `html.typecheck.ts` is the oracle for all three ways in.
 */
class SafeHtmlValue {
  declare private readonly brand: void;
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }

  toString(): string {
    return this.value;
  }
}

export type SafeHtml = SafeHtmlValue;

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);

/** Tagged template: every hole is escaped unless it is already SafeHtml. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let out = strings[0] ?? '';
  for (let index = 0; index < values.length; index += 1) {
    out += render(values[index]) + (strings[index + 1] ?? '');
  }
  return new SafeHtmlValue(out);
}

function render(value: unknown): string {
  if (value instanceof SafeHtmlValue) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  if (value === null || value === undefined || value === false) return '';
  return escapeHtml(String(value));
}

export interface PageOptions {
  title: string;
  body: SafeHtml;
  /** extra `<head>` elements, after the stylesheet */
  head?: SafeHtml;
  /** `data-page` on `<body>`, for a page script to tell the pages apart */
  page?: string;
}

export const layout = ({ title, body, head, page }: PageOptions): SafeHtml => html`<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <link rel="stylesheet" href="/admin/static/app.css" />${head}
  </head>
  <body${page === undefined ? '' : html` data-page="${page}"`}>
    <main>${body}</main>
  </body>
</html>
`;

/**
 * Fastify serialises a string reply as `text/plain` (reply.js sets it when no Content-Type is
 * set), and with `nosniff` a browser would then render the markup as text. Every HTML answer
 * goes out through here so that cannot be forgotten at one call site.
 */
export function sendHtml(reply: FastifyReply, status: number, body: SafeHtml): FastifyReply {
  return reply.code(status).type('text/html; charset=utf-8').send(body.value);
}
