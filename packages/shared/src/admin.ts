import * as z from 'zod';
import {
  adminIntentsByStatusSchema,
  adminIntentStatusFilterSchema,
  adminTradeIntentViewSchema,
  adminTradingSessionViewSchema,
  adminUserIntentsSectionSchema,
} from './admin-trading';
import { auditActionSchema, auditActorTypeSchema, auditEntityTypeSchema } from './audit';
import {
  depositEventStatusSchema,
  tokenLedgerKindSchema,
  tokenLedgerRefTypeSchema,
} from './ledger';
import { decimalStringSchema } from './money';
import { accountHaltReasonSchema, authRevokedReasonSchema, BrokerAccountStatus } from './oauth';
import { telegramUserIdSchema, tokenCountSchema, tradeModeSchema } from './trading';
import { tokenBalanceViewSchema } from './trading-access';
import { notificationLevelSchema, userStatusSchema } from './users';

// The KDF part of both credential routes: POST /admin/auth/login is the wait for a slot in the
// scrypt queue, the KDF itself, and the one Telegram call that follows; POST /admin/auth/password
// is the wait plus two derivations in that one slot (verify the current password, hash the new
// one). The route as a whole is not bounded by it, so web treats its own timeout as an unknown
// outcome. It lives here rather than in either process because both size
// their own chains against it — apps/backend/src/timing.ts must fit inside it,
// apps/web/src/timing.ts must wait longer than it.
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
const STAFF_LOGIN_CODE_PATTERN = /^\d{6}$/;
export const staffLoginCodeSchema = z.string().regex(STAFF_LOGIN_CODE_PATTERN, {
  error: 'expected six digits',
});

// 32 random bytes as base64url. Checked before the database is asked anything, so a token of
// the wrong shape costs no query.
export const STAFF_SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

// A UUID as PostgreSQL prints one. Both processes check it: `web` before it forwards a
// challenge cookie, `backend` before it looks a session id up.
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A password is bounded before it reaches the KDF: scrypt's cost is in its parameters, not in
// the input length, but an unbounded body is still work an unauthenticated caller can ask for.
export const STAFF_PASSWORD_MAX_LENGTH = 256;

// `ip` and `userAgent` are what the web process saw and the backend records as given
// (docs/staff-login.md → Trust boundaries). Both columns are bare `text` (0007_staff_auth.sql):
// these lengths are the only bound. `web` truncates the user agent to this same constant before
// sending, so a long header is a shortened row, never a failed login; `ip` is a socket address
// and is not truncated — 64 covers IPv6 with a zone id.
export const CLIENT_USER_AGENT_MAX_LENGTH = 512;
const clientFacts = {
  ip: z.string().min(1).max(64),
  userAgent: z.string().max(CLIENT_USER_AGENT_MAX_LENGTH),
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

const adminLoginResponseSchema = z.object({
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

// Who is asking: every response under a staff session carries it, so web prints the login from
// the answer it just got and keeps it nowhere else.
export const adminMeSchema = z.object({
  staffId: z.uuid(),
  login: z.string(),
  sessionId: z.uuid(),
});
export type AdminMe = z.infer<typeof adminMeSchema>;

export const staffSessionsResponseSchema = z.object({
  me: adminMeSchema,
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

// A staff member changing their own password (#78). Unknown keys are dropped, as in the login
// body. The refine runs even when a field already failed, so web can tell "same as the current
// one" from any other refusal by its issue: code `custom`, path ['newPassword'].
export const adminChangePasswordRequestSchema = z
  .object({
    currentPassword: z.string().min(1).max(STAFF_PASSWORD_MAX_LENGTH),
    newPassword: z.string().min(1).max(STAFF_PASSWORD_MAX_LENGTH),
    ...clientFacts,
  })
  .refine((v) => v.newPassword !== v.currentPassword, {
    path: ['newPassword'],
    error: 'the new password must differ from the current one',
  });
export type AdminChangePasswordRequest = z.infer<typeof adminChangePasswordRequestSchema>;

// The current session survives the change; revokedSessions counts the caller's other sessions
// that were not revoked and within their absolute lifetime (idle-expired ones included).
export const changePasswordResponseSchema = z.strictObject({
  changed: z.literal(true),
  revokedSessions: z.int().nonnegative(),
});
export type ChangePasswordResponse = z.infer<typeof changePasswordResponseSchema>;

// --- Read pages (#107) --------------------------------------------------------------------------

export const ADMIN_PAGE_SIZE = 50;
// covers a 254-character address (RFC 5321); also bounds `q` in the durable audit payload
export const ADMIN_SEARCH_MAX_LENGTH = 256;
// "active now" = the users row changed within this window: a proxy, not presence
export const ADMIN_ACTIVE_WINDOW_MINUTES = 15;

const isoDateTime = z.iso.datetime({ offset: true });
const adminStrictMeSchema = z.strictObject(adminMeSchema.shape);

// Unknown keys (utm_*, a bookmark's leftovers) are stripped, not refused: only q and cursor
// outside their shape are a 400.
export const adminUsersQuerySchema = z.object({
  q: z
    .string()
    .trim()
    .min(1)
    .max(ADMIN_SEARCH_MAX_LENGTH)
    .regex(/^[^\p{C}]+$/u, { error: 'control or invisible characters are not searchable' })
    .optional(),
  cursor: z.string().regex(UUID_PATTERN).optional(),
});
export type AdminUsersQuery = z.infer<typeof adminUsersQuerySchema>;

// The one serialization of the list query: web's links and redirects and its request to the
// backend all go through it, in the schema's key order, so `q = 'a&b'` stays one parameter.
export function adminUsersSearchParams(query: AdminUsersQuery): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of Object.keys(adminUsersQuerySchema.shape) as (keyof AdminUsersQuery)[]) {
    const value = query[key];
    if (value !== undefined) params.set(key, value);
  }
  return params;
}

// The views below are strict: a key the backend grew is a contract violation on web, not a
// silently stripped field.
export const adminUserListItemSchema = z.strictObject({
  id: z.uuid(),
  telegramUserId: telegramUserIdSchema,
  displayName: z.string().nullable(),
  status: userStatusSchema,
  tokenBalance: tokenCountSchema,
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type AdminUserListItem = z.infer<typeof adminUserListItemSchema>;

export const adminUsersResponseSchema = z.strictObject({
  me: adminStrictMeSchema,
  users: z.array(adminUserListItemSchema).max(ADMIN_PAGE_SIZE),
  nextCursor: z.string().regex(UUID_PATTERN).nullable(),
});
export type AdminUsersResponse = z.infer<typeof adminUsersResponseSchema>;

// No ciphertext, key id or refresh-token hash: those never leave the backend.
export const adminBrokerAccountViewSchema = z.strictObject({
  id: z.uuid(),
  brokerUserId: z.string(),
  email: z.string().nullable(),
  isPartnerClient: z.boolean(),
  status: z.enum(BrokerAccountStatus),
  authRevokedReason: authRevokedReasonSchema.nullable(),
  tradingHalted: z.boolean(),
  haltedReason: accountHaltReasonSchema.nullable(),
  accessTokenExpiresAt: isoDateTime,
  tokenRotatedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type AdminBrokerAccountView = z.infer<typeof adminBrokerAccountViewSchema>;

export const adminUserDetailSchema = z.strictObject({
  id: z.uuid(),
  telegramUserId: telegramUserIdSchema,
  displayName: z.string().nullable(),
  languageCode: z.string().nullable(),
  status: userStatusSchema,
  acquisitionSource: z.string().nullable(),
  acquiredAt: isoDateTime.nullable(),
  telegramBlockedAt: isoDateTime.nullable(),
  notificationLevel: notificationLevelSchema,
  // null = the broker's minimum (#297)
  demoStake: decimalStringSchema.nullable(),
  tokens: tokenBalanceViewSchema,
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type AdminUserDetail = z.infer<typeof adminUserDetailSchema>;

// The token ledger row (#109) is declared here, ahead of the card that embeds it: `const`s
// initialize in order. The page's query and envelope are in the #109 block below.
export const ADMIN_USER_RECENT_LEDGER = 20;

// A signed whole number of tokens as PostgreSQL prints a bigint: tokenCountSchema is unsigned,
// and release, settle and adjustment rows move a balance down.
export const tokenDeltaSchema = z.string().regex(/^(0|-?[1-9]\d*)$/);

export const adminLedgerEntrySchema = z.strictObject({
  id: z.uuid(),
  userId: z.uuid(),
  telegramUserId: telegramUserIdSchema,
  kind: tokenLedgerKindSchema,
  balanceDelta: tokenDeltaSchema,
  reservedDelta: tokenDeltaSchema,
  intentId: z.uuid().nullable(),
  depositEventId: z.uuid().nullable(),
  brokerAccountId: z.uuid().nullable(),
  refType: tokenLedgerRefTypeSchema.nullable(),
  refId: z.uuid().nullable(),
  note: z.string().nullable(),
  createdAt: isoDateTime,
});
export type AdminLedgerEntry = z.infer<typeof adminLedgerEntrySchema>;

export const adminUserLedgerSectionSchema = z.strictObject({
  recent: z.array(adminLedgerEntrySchema).max(ADMIN_USER_RECENT_LEDGER),
});
export type AdminUserLedgerSection = z.infer<typeof adminUserLedgerSectionSchema>;

// The deposit row (#341), declared ahead of the card for the same reason as the ledger row; the
// page's query and envelope are in the #341 block below. `payload` is not a key: the raw postback
// never leaves the backend. `amount` is the numeric(20,8) column as PostgreSQL prints it.
export const adminDepositViewSchema = z.strictObject({
  id: z.uuid(),
  userId: z.uuid().nullable(),
  telegramUserId: telegramUserIdSchema.nullable(),
  brokerAccountId: z.uuid().nullable(),
  postbackId: z.string(),
  paymentId: z.string().nullable(),
  amount: decimalStringSchema.nullable(),
  currency: z.string().nullable(),
  status: depositEventStatusSchema,
  processedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
});
export type AdminDepositView = z.infer<typeof adminDepositViewSchema>;

export const adminUserDepositsSectionSchema = z.strictObject({
  recent: z.array(adminDepositViewSchema).max(ADMIN_USER_RECENT_LEDGER),
});
export type AdminUserDepositsSection = z.infer<typeof adminUserDepositsSectionSchema>;

export const adminUserResponseSchema = z.strictObject({
  me: adminStrictMeSchema,
  user: adminUserDetailSchema,
  brokerAccounts: z.array(adminBrokerAccountViewSchema),
  intents: adminUserIntentsSectionSchema,
  ledger: adminUserLedgerSectionSchema,
  deposits: adminUserDepositsSectionSchema,
});
export type AdminUserResponse = z.infer<typeof adminUserResponseSchema>;

const countSchema = z.int().nonnegative();
export const adminOverviewSchema = z.strictObject({
  users: z.strictObject({
    total: countSchema,
    today: countSchema,
    blocked: countSchema,
    withActiveBrokerAccount: countSchema,
    activeNow: countSchema,
  }),
  intents: z.strictObject({
    total: countSchema,
    today: countSchema,
    byStatus: adminIntentsByStatusSchema,
    active: countSchema,
  }),
  activeWindowMinutes: z.literal(ADMIN_ACTIVE_WINDOW_MINUTES),
  dayStartsAt: isoDateTime,
  asOf: isoDateTime,
});
export type AdminOverview = z.infer<typeof adminOverviewSchema>;

export const adminOverviewResponseSchema = z.strictObject({
  me: adminStrictMeSchema,
  overview: adminOverviewSchema,
});
export type AdminOverviewResponse = z.infer<typeof adminOverviewResponseSchema>;

// --- Intents (#108) -----------------------------------------------------------------------------

// Exact-match filters; the key order is the order adminIntentsSearchParams writes them in.
// Unknown keys are stripped, as on the users list.
export const adminIntentsQuerySchema = z.object({
  status: adminIntentStatusFilterSchema.optional(),
  mode: tradeModeSchema.optional(),
  user: z.string().regex(UUID_PATTERN).optional(),
  session: z.string().regex(UUID_PATTERN).optional(),
  cursor: z.string().regex(UUID_PATTERN).optional(),
});
export type AdminIntentsQuery = z.infer<typeof adminIntentsQuerySchema>;

export function adminIntentsSearchParams(query: AdminIntentsQuery): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of Object.keys(adminIntentsQuerySchema.shape) as (keyof AdminIntentsQuery)[]) {
    const value = query[key];
    if (value !== undefined) params.set(key, value);
  }
  return params;
}

export const adminIntentsResponseSchema = z.strictObject({
  me: adminStrictMeSchema,
  intents: z.array(adminTradeIntentViewSchema).max(ADMIN_PAGE_SIZE),
  nextCursor: z.string().regex(UUID_PATTERN).nullable(),
});
export type AdminIntentsResponse = z.infer<typeof adminIntentsResponseSchema>;

export const adminIntentResponseSchema = z.strictObject({
  me: adminStrictMeSchema,
  intent: adminTradeIntentViewSchema,
});
export type AdminIntentResponse = z.infer<typeof adminIntentResponseSchema>;

// --- Trading sessions (#330) --------------------------------------------------------------------

// No filters: only the cursor, and unknown keys are stripped as on the other lists.
export const adminTradingSessionsQuerySchema = z.object({
  cursor: z.string().regex(UUID_PATTERN).optional(),
});
export type AdminTradingSessionsQuery = z.infer<typeof adminTradingSessionsQuerySchema>;

export function adminTradingSessionsSearchParams(
  query: AdminTradingSessionsQuery,
): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of Object.keys(
    adminTradingSessionsQuerySchema.shape,
  ) as (keyof AdminTradingSessionsQuery)[]) {
    const value = query[key];
    if (value !== undefined) params.set(key, value);
  }
  return params;
}

export const adminTradingSessionsResponseSchema = z.strictObject({
  me: adminStrictMeSchema,
  sessions: z.array(adminTradingSessionViewSchema).max(ADMIN_PAGE_SIZE),
  nextCursor: z.string().regex(UUID_PATTERN).nullable(),
});
export type AdminTradingSessionsResponse = z.infer<typeof adminTradingSessionsResponseSchema>;

// --- Token ledger (#109) ------------------------------------------------------------------------

// Exact-match filters, intersected; unknown keys are stripped, as on the other lists.
export const adminTokensQuerySchema = z.object({
  user: z.string().regex(UUID_PATTERN).optional(),
  kind: tokenLedgerKindSchema.optional(),
  cursor: z.string().regex(UUID_PATTERN).optional(),
});
export type AdminTokensQuery = z.infer<typeof adminTokensQuerySchema>;

export function adminTokensSearchParams(query: AdminTokensQuery): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of Object.keys(adminTokensQuerySchema.shape) as (keyof AdminTokensQuery)[]) {
    const value = query[key];
    if (value !== undefined) params.set(key, value);
  }
  return params;
}

export const adminTokensResponseSchema = z.strictObject({
  me: adminStrictMeSchema,
  entries: z.array(adminLedgerEntrySchema).max(ADMIN_PAGE_SIZE),
  nextCursor: z.string().regex(UUID_PATTERN).nullable(),
});
export type AdminTokensResponse = z.infer<typeof adminTokensResponseSchema>;

// --- Audit log (#110) ---------------------------------------------------------------------------

// The most of a row's payload the page carries, in characters (code points, as Postgres left()
// and zod's max() both count them; at most 4 bytes each). A bot text payload (#299) holds two
// texts of up to BOT_TEXT_SOURCE_MAX code points, so the jsonb itself would make a page of 50
// rows megabytes long; every other writer's payload (ip, reason, counters, error identities, a
// search query, uuids, enums, dates) fits inside the preview whole.
export const ADMIN_AUDIT_PAYLOAD_PREVIEW_CHARS = 1024;

// Exact-match filters plus a UTC date range, intersected; unknown keys are stripped, as on the
// other lists. Every value is an enum, a uuid or a date, so the audit row of a view carries no
// free text.
export const adminAuditQuerySchema = z
  .object({
    action: auditActionSchema.optional(),
    entityType: auditEntityTypeSchema.optional(),
    entityId: z.string().regex(UUID_PATTERN).optional(),
    actorId: z.string().regex(UUID_PATTERN).optional(),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    cursor: z.string().regex(UUID_PATTERN).optional(),
  })
  .refine(
    (query: { from?: string | undefined; to?: string | undefined }) =>
      query.from === undefined || query.to === undefined || query.from <= query.to,
    { path: ['to'], error: 'expected from on or before to' },
  );
export type AdminAuditQuery = z.infer<typeof adminAuditQuerySchema>;

export function adminAuditSearchParams(query: AdminAuditQuery): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of Object.keys(adminAuditQuerySchema.shape) as (keyof AdminAuditQuery)[]) {
    const value = query[key];
    if (value !== undefined) params.set(key, value);
  }
  return params;
}

// entityType stays free text on the way out (the column is): a writer outside AuditEntityType
// is still shown. entityId is the bare uuid column, so UUID_PATTERN rather than z.uuid().
export const adminAuditEntryViewSchema = z.strictObject({
  id: z.uuid(),
  createdAt: isoDateTime,
  actorType: auditActorTypeSchema,
  actorId: z.string().nullable(),
  actorLogin: z.string().nullable(),
  action: auditActionSchema,
  entityType: z.string().nullable(),
  entityId: z.string().regex(UUID_PATTERN).nullable(),
  payload: z.string().max(ADMIN_AUDIT_PAYLOAD_PREVIEW_CHARS),
  payloadTruncated: z.boolean(),
});
export type AdminAuditEntryView = z.infer<typeof adminAuditEntryViewSchema>;

export const adminAuditResponseSchema = z.strictObject({
  me: adminStrictMeSchema,
  entries: z.array(adminAuditEntryViewSchema).max(ADMIN_PAGE_SIZE),
  nextCursor: z.string().regex(UUID_PATTERN).nullable(),
});
export type AdminAuditResponse = z.infer<typeof adminAuditResponseSchema>;

// --- Deposits (#341) ----------------------------------------------------------------------------

// Exact-match filters, intersected; unknown keys are stripped, as on the other lists.
export const adminDepositsQuerySchema = z.object({
  user: z.string().regex(UUID_PATTERN).optional(),
  status: depositEventStatusSchema.optional(),
  cursor: z.string().regex(UUID_PATTERN).optional(),
});
export type AdminDepositsQuery = z.infer<typeof adminDepositsQuerySchema>;

export function adminDepositsSearchParams(query: AdminDepositsQuery): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of Object.keys(adminDepositsQuerySchema.shape) as (keyof AdminDepositsQuery)[]) {
    const value = query[key];
    if (value !== undefined) params.set(key, value);
  }
  return params;
}

export const adminDepositsResponseSchema = z.strictObject({
  me: adminStrictMeSchema,
  deposits: z.array(adminDepositViewSchema).max(ADMIN_PAGE_SIZE),
  nextCursor: z.string().regex(UUID_PATTERN).nullable(),
});
export type AdminDepositsResponse = z.infer<typeof adminDepositsResponseSchema>;

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
export const safeParseAdminChangePasswordRequest = (input: unknown) =>
  adminChangePasswordRequestSchema.safeParse(input);
export const safeParseChangePasswordResponse = (input: unknown) =>
  changePasswordResponseSchema.safeParse(input);
export const safeParseAdminUsersQuery = (input: unknown) => adminUsersQuerySchema.safeParse(input);
export const safeParseAdminUsersResponse = (input: unknown) =>
  adminUsersResponseSchema.safeParse(input);
export const safeParseAdminUserResponse = (input: unknown) =>
  adminUserResponseSchema.safeParse(input);
export const safeParseAdminOverviewResponse = (input: unknown) =>
  adminOverviewResponseSchema.safeParse(input);
export const safeParseAdminIntentsQuery = (input: unknown) =>
  adminIntentsQuerySchema.safeParse(input);
export const safeParseAdminIntentsResponse = (input: unknown) =>
  adminIntentsResponseSchema.safeParse(input);
export const safeParseAdminIntentResponse = (input: unknown) =>
  adminIntentResponseSchema.safeParse(input);
export const safeParseAdminTradingSessionsQuery = (input: unknown) =>
  adminTradingSessionsQuerySchema.safeParse(input);
export const safeParseAdminTradingSessionsResponse = (input: unknown) =>
  adminTradingSessionsResponseSchema.safeParse(input);
export const safeParseAdminTokensQuery = (input: unknown) =>
  adminTokensQuerySchema.safeParse(input);
export const safeParseAdminTokensResponse = (input: unknown) =>
  adminTokensResponseSchema.safeParse(input);
export const safeParseAdminAuditQuery = (input: unknown) => adminAuditQuerySchema.safeParse(input);
export const safeParseAdminAuditResponse = (input: unknown) =>
  adminAuditResponseSchema.safeParse(input);
export const safeParseAdminDepositsQuery = (input: unknown) =>
  adminDepositsQuerySchema.safeParse(input);
export const safeParseAdminDepositsResponse = (input: unknown) =>
  adminDepositsResponseSchema.safeParse(input);
