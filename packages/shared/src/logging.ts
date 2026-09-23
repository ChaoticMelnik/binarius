// pino redact paths shared by every app logger. `*` matches one key level, so each name is
// listed at depth one and two: an error thrown by an HTTP/socket client (ARCH-01) commonly
// carries `err.config.headers.authorization` or `err.response.request.headers.*`.
const SECRET_KEYS = ['authorization', 'token', 'accessToken', 'refreshToken', 'password'] as const;

export const LOG_REDACT_PATHS: readonly string[] = [
  'req.headers.authorization',
  ...SECRET_KEYS.flatMap((key) => [`*.${key}`, `*.*.${key}`]),
];
