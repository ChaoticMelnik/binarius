import {
  ADMIN_BOT_PROFILE_IDENTITY_MAX,
  adminBotProfilePublishedSchema,
  BOT_PROFILE_METHODS,
  type AdminBotProfileMethodResult,
} from '@binarius/shared';

// A publish result carried through the redirect after a POST (#361, docs/admin-pages.md → Bot
// texts → Publishing): `method:ok` or `method:Name[.code][:telegramErrorCode]`, joined by `,`.
// Only what the page shows — the cause stays in the backend's log and audit row. No cap on the
// whole value: each segment is bounded by the grammar, and the request line by Node's header size.

const NAME_CHARS = `[A-Za-z][A-Za-z0-9_]{0,${ADMIN_BOT_PROFILE_IDENTITY_MAX - 1}}`;
const CODE_CHARS = `[A-Za-z0-9_-]{1,${ADMIN_BOT_PROFILE_IDENTITY_MAX}}`;
const NAME = new RegExp(`^${NAME_CHARS}$`);
const CODE = new RegExp(`^${CODE_CHARS}$`);
const SEGMENT = new RegExp(
  `^(${BOT_PROFILE_METHODS.join('|')}):(?:(ok)|(${NAME_CHARS})(?:\\.(${CODE_CHARS}))?(?::([1-5]\\d\\d))?)$`,
);

export function encodePublishResults(results: readonly AdminBotProfileMethodResult[]): string {
  return results
    .map((result) => {
      if (result.ok) return `${result.method}:ok`;
      // `ok` is the success segment's word
      const name =
        NAME.test(result.err.name) && result.err.name !== 'ok' ? result.err.name : 'Error';
      const code =
        result.err.code !== undefined && CODE.test(result.err.code) ? `.${result.err.code}` : '';
      const telegram = result.telegramErrorCode === undefined ? '' : `:${result.telegramErrorCode}`;
      return `${result.method}:${name}${code}${telegram}`;
    })
    .join(',');
}

/** `?publish=` as the results it encodes; anything else, a repeated key included, is none. */
export function decodePublishResults(value: unknown): AdminBotProfileMethodResult[] | undefined {
  if (typeof value !== 'string') return undefined;
  const results: unknown[] = [];
  for (const segment of value.split(',')) {
    const match = SEGMENT.exec(segment);
    if (match === null) return undefined;
    const [, method, ok, name, code, telegram] = match;
    results.push(
      ok === undefined
        ? {
            method,
            ok: false,
            err: code === undefined ? { name } : { name, code },
            ...(telegram === undefined ? {} : { telegramErrorCode: Number(telegram) }),
          }
        : { method, ok: true },
    );
  }
  const methods = new Set(results.map((result) => (result as { method: string }).method));
  if (methods.size !== results.length) return undefined;
  const parsed = adminBotProfilePublishedSchema.safeParse(results);
  return parsed.success ? parsed.data : undefined;
}
