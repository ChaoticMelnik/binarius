// eslint.config.js imports this file through Node's type stripping, so it may hold only erasable
// TypeScript: `import type` (a mixed import would leave a bare `./env` specifier Node cannot
// resolve), no enum, namespace or parameter property.
import type { LogLevel } from './env';

// pino redact paths shared by every app logger. `*` matches exactly one key level and pino has
// no recursive wildcard, so each secret key is listed at depths 0–5: that reaches the shapes an
// HTTP/socket client error carries (`err.config.headers.authorization`,
// `err.response.request.headers.authorization`) and a bare top-level key. Deeper nesting is
// not covered, and no key path scrubs a string: a secret inside `err.message` or `err.stack`
// survives, which is why error objects are logged by name and code only (see errorIdentity
// below). Under the four LOG_ERROR_KEYS an error object no longer reaches redaction at all — the
// serializer reduces it first; the paths stay for every other object a log line carries.
// Eighty-six paths cost a traversal per log line — accepted for the loggers' volume.
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
  // the callback's Telegram initData passes the state owner's identity check while it is fresh
  'initData',
  // the staff session: the value the admin cookie carries, the header it arrives in, and the
  // cookie jar it travels in
  'sessionToken',
  'x-staff-session',
  'cookie',
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

// An object is let through by its own `name` only when it already is an identity — the literal
// this file returns: a plain or null-prototype object whose own keys (symbols and
// non-enumerables included) are `name`, an optional string `code` and, at the top level, a
// `cause` of the same shape without one. Anything else — a class instance, a record that merely
// has a `name`, a thrown `{ name, message }` — is named by its type, so a person's name or a
// message never rides in. The residue is a plain object with nothing but string `name`/`code`,
// which is indistinguishable from an identity and logs its `name`.
function isIdentityShape(value: unknown, allowCause: boolean): value is LoggedError {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  const record = value as Record<PropertyKey, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'name' || key === 'code') continue;
    if (key === 'cause' && allowCause) continue;
    return false;
  }
  if (!Object.hasOwn(value, 'name') || typeof record.name !== 'string') return false;
  if (Object.hasOwn(value, 'code') && typeof record.code !== 'string') return false;
  return !Object.hasOwn(value, 'cause') || isIdentityShape(record.cause, false);
}

// name and code only: an error's message or cause can carry a header, a response body or a
// token, and none of the redact paths above can scrub a string. Idempotent on its own output,
// because pino runs the serializers below over values that already went through it.
export function errorIdentity(error: unknown): { name: string; code?: string } {
  const name =
    error instanceof Error || isIdentityShape(error, true) ? error.name : typeof error;
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

export interface LoggedError {
  name: string;
  code?: string;
  cause?: { name: string; code?: string };
}

// The whitelist the logger itself applies under LOG_ERROR_KEYS: the identity plus one level of
// cause, nested — a serializer can only return its own key's value, so the cause sits under
// `err` here, where errorLogFields puts it beside `err` as a key of its own. An identity passes
// unchanged.
export function serializeError(value: unknown): LoggedError {
  const identity = errorIdentity(value);
  const cause = (value as { cause?: unknown } | null)?.cause;
  return cause === undefined || cause === null
    ? identity
    : { ...identity, cause: errorIdentity(cause) };
}

// the log-object keys the serializers guard; eslint.config.js builds its logging rule from the
// same list
export const LOG_ERROR_KEYS = ['err', 'error', 'cause', 'exception'] as const;
export type LogErrorKey = (typeof LOG_ERROR_KEYS)[number];

export const LOG_SERIALIZERS: Readonly<Record<LogErrorKey, typeof serializeError>> = {
  err: serializeError,
  error: serializeError,
  cause: serializeError,
  exception: serializeError,
};

export const UNNAMED_ERROR_MESSAGE = 'error logged without a message';

// pino copies `err.message` into `msg` when an error is logged without a message of its own —
// positionally (`log.error(err)`) or as `{ err }` — and a serializer cannot reach `msg`. This
// hook mirrors pino's two conditions (lib/proto.js, write) and supplies a fixed message first.
// An error logged with a message is left alone: pino wraps it in `{ err }` itself.
export function positionalErrorHook(
  this: unknown,
  args: unknown[],
  method: (...args: never[]) => void,
): void {
  const [first, second] = args;
  let next = args;
  if (second === undefined && first instanceof Error) {
    next = [{ err: first }, UNNAMED_ERROR_MESSAGE, ...args.slice(2)];
  } else if (second === undefined && typeof first === 'object' && first !== null) {
    const obj = first as { err?: { message?: unknown } | null; msg?: unknown };
    if (obj.err && obj.err.message !== undefined && obj.msg === undefined) {
      next = [first, UNNAMED_ERROR_MESSAGE, ...args.slice(2)];
    }
  }
  Reflect.apply(method, this, next);
}

// Structural, so this package needs no pino dependency; it is assignable to pino's LoggerOptions.
export interface SharedLogOptions {
  level: LogLevel;
  redact: string[];
  serializers: Readonly<Record<string, (value: unknown) => unknown>>;
  hooks: { logMethod: typeof positionalErrorHook };
}

// every process builds its logger from this, so the whitelist cannot be left out of one of them
export function logOptions(level: LogLevel): SharedLogOptions {
  return {
    level,
    redact: [...LOG_REDACT_PATHS],
    serializers: LOG_SERIALIZERS,
    hooks: { logMethod: positionalErrorHook },
  };
}
