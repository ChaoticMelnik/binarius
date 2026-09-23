// pino redact paths shared by every app logger. `*` matches exactly one key level and pino has
// no recursive wildcard, so each secret key is listed at depths 0–5: that reaches the shapes an
// HTTP/socket client error carries (`err.config.headers.authorization`,
// `err.response.request.headers.authorization`) and a bare top-level key. Deeper nesting is
// not covered, and no key path scrubs a string: a secret inside `err.message` or `err.stack`
// survives, which is why the worker logs executor errors by name and code only (see
// apps/trading-worker/src/intents/processor.ts errorIdentity). Thirty-one paths cost a
// traversal per log line — accepted for the loggers' volume.
const SECRET_KEYS = [
  'authorization',
  'token',
  'accessToken',
  'refreshToken',
  'password',
  // OAuth wire names: the broker speaks snake_case, and an authorization code or a state is
  // as good as a token for the window it is alive
  'access_token',
  'refresh_token',
  'client_secret',
  'code',
  'state',
] as const;
const MAX_DEPTH = 5;

const atEveryDepth = (key: string): string[] =>
  Array.from({ length: MAX_DEPTH + 1 }, (_, depth) => `${'*.'.repeat(depth)}${key}`);

export const LOG_REDACT_PATHS: readonly string[] = [
  'req.headers.authorization',
  ...SECRET_KEYS.flatMap(atEveryDepth),
];
