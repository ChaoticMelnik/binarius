// pino redact paths shared by every app logger. `*` matches exactly one key level and pino has
// no recursive wildcard, so each secret key is listed at depths 0–5: that reaches the shapes an
// HTTP/socket client error carries (`err.config.headers.authorization`,
// `err.response.request.headers.authorization`) and a bare top-level key. Deeper nesting is
// not covered, and no key path scrubs a string: a secret inside `err.message` or `err.stack`
// survives, which is why error objects are logged by name and code only (see errorIdentity
// below). Sixty-two paths cost a traversal per log line — accepted for the loggers' volume.
const SECRET_KEYS = [
  'authorization',
  'token',
  'accessToken',
  'refreshToken',
  'password',
  // OAuth wire names: the broker speaks snake_case, and a state is as good as a token for the
  // window it is alive
  'access_token',
  'refresh_token',
  'client_secret',
  'state',
  'authorizationCode',
] as const;
const MAX_DEPTH = 5;

const atEveryDepth = (key: string): string[] =>
  Array.from({ length: MAX_DEPTH + 1 }, (_, depth) => `${'*.'.repeat(depth)}${key}`);

export const LOG_REDACT_PATHS: readonly string[] = [
  'req.headers.authorization',
  // the authorization code is a secret only where it actually travels — as a request field.
  // `code` at every depth would also blank `err.code`, `SQLSTATE` and Fastify's `FST_ERR_*`,
  // which is the diagnostic this project logs errors by.
  'req.body.code',
  ...SECRET_KEYS.flatMap(atEveryDepth),
];

// name and code only: an error's message or cause can carry a header, a response body or a
// token, and none of the redact paths above can scrub a string
export function errorIdentity(error: unknown): { name: string; code?: string } {
  const name = error instanceof Error ? error.name : typeof error;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? { name, code } : { name };
}

export interface ErrorLogFields {
  err: { name: string; code?: string };
  cause?: { name: string; code?: string };
}

// What to spread into a log call instead of the error itself. The cause is carried because a
// wrapper often has nothing useful of its own: drizzle's query error sets neither `name` nor
// `code`, and the SQLSTATE that makes a database failure actionable sits on the pg error
// underneath. One level only, and by identity — a pg error's `detail` holds the offending
// value, and `message` holds whatever the driver put there.
export function errorLogFields(error: unknown): ErrorLogFields {
  const cause = (error as { cause?: unknown } | null)?.cause;
  const fields: ErrorLogFields = { err: errorIdentity(error) };
  return cause === undefined || cause === null
    ? fields
    : { ...fields, cause: errorIdentity(cause) };
}
