import type { FastifyReply } from 'fastify';

/**
 * A fragment that is already HTML. Nothing becomes one by being a string: the only way to get
 * one is through `html`, which escapes everything it interpolates. That is what makes
 * `html`'s own output nestable without a second escaping pass, and a staff member's user
 * agent — which goes into a table cell — impossible to interpolate raw by mistake.
 */
export class SafeHtml {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }

  toString(): string {
    return this.value;
  }
}

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
  return new SafeHtml(out);
}

function render(value: unknown): string {
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  if (value === null || value === undefined || value === false) return '';
  return escapeHtml(String(value));
}

export interface PageOptions {
  title: string;
  body: SafeHtml;
}

export const layout = ({ title, body }: PageOptions): SafeHtml => html`<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <link rel="stylesheet" href="/admin/static/app.css" />
  </head>
  <body>
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
