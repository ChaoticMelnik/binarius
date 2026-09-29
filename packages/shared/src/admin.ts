import * as z from 'zod';

// How long the backend may hold POST /admin/auth/login: the wait for a slot in the scrypt
// queue, the KDF itself, and the one Telegram call that follows. It lives here rather than in
// either process because both size their own chains against it — apps/backend/src/timing.ts
// must fit inside it, apps/web/src/timing.ts must wait longer than it.
export const ADMIN_LOGIN_BUDGET_MS = 6_000;

// Every `error` value an /admin/* route answers with. `unauthorized` (the bearer) and
// `validation` are not staff-facing outcomes: web treats either as its own misconfiguration.
export const AdminErrorCode = {
  Unauthorized: 'unauthorized',
  Validation: 'validation',
  InvalidCredentials: 'invalid_credentials',
  TooManyAttempts: 'too_many_attempts',
  TelegramUnavailable: 'telegram_unavailable',
  InvalidCode: 'invalid_code',
  AwaitingTelegram: 'awaiting_telegram',
  ChallengeUnavailable: 'challenge_unavailable',
  SessionInvalid: 'session_invalid',
  NotFound: 'not_found',
} as const;
export type AdminErrorCode = (typeof AdminErrorCode)[keyof typeof AdminErrorCode];

// A staff login is an operator-chosen identifier, not an address: no case folding, no unicode.
// Three places must agree on it — the schema below, the CLI, and staff_login_check in
// packages/db, which is built from this regex's source rather than from a copy of it.
export const STAFF_LOGIN_PATTERN = /^[A-Za-z0-9._-]{3,64}$/;
export const staffLoginSchema = z.string().regex(STAFF_LOGIN_PATTERN, {
  error: 'expected 3-64 characters of A-Z a-z 0-9 . _ -',
});

// The six digits the staff member reads out of Telegram.
export const STAFF_LOGIN_CODE_PATTERN = /^\d{6}$/;
export const staffLoginCodeSchema = z.string().regex(STAFF_LOGIN_CODE_PATTERN, {
  error: 'expected six digits',
});

// 32 random bytes as base64url. Checked before the database is asked anything, so a token of
// the wrong shape costs no query.
export const STAFF_SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

// A password is bounded before it reaches the KDF: scrypt's cost is in its parameters, not in
// the input length, but an unbounded body is still work an unauthenticated caller can ask for.
export const STAFF_PASSWORD_MAX_LENGTH = 256;

// `ip` and `userAgent` are what the web process saw and the backend records as given
// (docs/staff-login.md → Trust boundaries); the lengths are the columns' own bound.
const clientFacts = {
  ip: z.string().min(1).max(64),
  userAgent: z.string().max(512),
};

export const adminLoginRequestSchema = z.object({
  login: staffLoginSchema,
  password: z.string().min(1).max(STAFF_PASSWORD_MAX_LENGTH),
  ...clientFacts,
});
export type AdminLoginRequest = z.infer<typeof adminLoginRequestSchema>;

export const adminConfirmRequestSchema = z.object({
  challengeId: z.uuid(),
  code: staffLoginCodeSchema,
  ...clientFacts,
});
export type AdminConfirmRequest = z.infer<typeof adminConfirmRequestSchema>;

export const adminLoginResponseSchema = z.object({
  challengeId: z.uuid(),
  expiresAt: z.iso.datetime({ offset: true }),
});
export type AdminLoginResponse = z.infer<typeof adminLoginResponseSchema>;

export const adminConfirmResponseSchema = z.object({
  sessionToken: z.string().regex(STAFF_SESSION_TOKEN_PATTERN),
  expiresAt: z.iso.datetime({ offset: true }),
});
export type AdminConfirmResponse = z.infer<typeof adminConfirmResponseSchema>;

// Allowlisted projection of a staff_sessions row joined to its owner. The token hash, the
// staff id and the owner's Telegram id never leave the backend.
export const staffSessionViewSchema = z.object({
  id: z.uuid(),
  login: z.string(),
  displayName: z.string().nullable(),
  ip: z.string(),
  userAgent: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
  lastSeenAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
  current: z.boolean(),
});
export type StaffSessionView = z.infer<typeof staffSessionViewSchema>;

export const staffSessionsResponseSchema = z.object({
  me: z.object({ staffId: z.uuid(), login: z.string(), sessionId: z.uuid() }),
  sessions: z.array(staffSessionViewSchema),
});
export type StaffSessionsResponse = z.infer<typeof staffSessionsResponseSchema>;

export const revokeSessionResponseSchema = z.object({
  revoked: z.literal(true),
  // the caller revoked the session it is holding, so web has to drop its own cookie
  current: z.boolean(),
});
export type RevokeSessionResponse = z.infer<typeof revokeSessionResponseSchema>;

export const logoutResponseSchema = z.object({ loggedOut: z.literal(true) });
export type LogoutResponse = z.infer<typeof logoutResponseSchema>;

export const safeParseAdminLoginRequest = (input: unknown) =>
  adminLoginRequestSchema.safeParse(input);
export const safeParseAdminConfirmRequest = (input: unknown) =>
  adminConfirmRequestSchema.safeParse(input);
export const safeParseAdminLoginResponse = (input: unknown) =>
  adminLoginResponseSchema.safeParse(input);
export const safeParseAdminConfirmResponse = (input: unknown) =>
  adminConfirmResponseSchema.safeParse(input);
export const safeParseStaffSessionsResponse = (input: unknown) =>
  staffSessionsResponseSchema.safeParse(input);
export const safeParseRevokeSessionResponse = (input: unknown) =>
  revokeSessionResponseSchema.safeParse(input);
export const safeParseLogoutResponse = (input: unknown) => logoutResponseSchema.safeParse(input);
