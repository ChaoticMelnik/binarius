import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import {
  ADMIN_ACTIVE_WINDOW_MINUTES,
  ADMIN_BOT_TEXT_BODY_LIMIT_BYTES,
  adminBotProfileIdentity,
  adminBotTextProblems,
  isAdminTelegramErrorCode,
  BOT_PROFILE_METHODS,
  BOT_TEXT_KEY_PATTERN,
  botProfileMethodsOf,
  botTextChangeProblems,
  isBotTextKey,
  renderBotTextPreview,
  resolveBotTextOverrides,
  safeParseAdminBotTextPreviewRequest,
  safeParseAdminBotTextResetRequest,
  safeParseAdminBotTextSaveRequest,
  UnexpectedBotTextOutcome,
  type AdminBotProfileMethodResult,
  type AdminBotProfilePublishResponse,
  type AdminBotTextPreviewResponse,
  type AdminBotTextResetResponse,
  type AdminBotTextResponse,
  type AdminBotTextSaveResponse,
  type BotProfileMethod,
  type BotTextKey,
  ADMIN_PAGE_SIZE,
  AdminErrorCode,
  AuditAction,
  AuditEntityType,
  errorIdentity,
  errorLogFields,
  safeParseAdminAuditQuery,
  safeParseAdminBrokerAccountsQuery,
  safeParseAdminChangePasswordRequest,
  safeParseAdminConfirmRequest,
  safeParseAdminDepositsQuery,
  safeParseAdminIntentsQuery,
  safeParseAdminLinkCompleteRequest,
  safeParseAdminLinkInspectRequest,
  safeParseAdminLoginRequest,
  safeParseAdminTokenAdjustmentRequest,
  safeParseAdminTokensQuery,
  safeParseAdminTradingSessionsQuery,
  safeParseAdminUsersQuery,
  LinkState,
  STAFF_SESSION_TOKEN_PATTERN,
  UUID_PATTERN,
  type AdminTokenAdjustmentResponse,
  type StaffSessionView,
} from '@binarius/shared';
import {
  adjustTokens,
  applyBotTextReset,
  applyBotTextSave,
  applyStaffPasswordChange,
  listBotTextOverridesForAdmin,
  toAdminBotTextOverrideView,
  toAdminBotTextView,
  type StaffAuditDescription,
  classifyUserSearch,
  completeLinkLogin,
  completeLogin,
  countPasswordFailure,
  DUMMY_PASSWORD_HASH,
  endStaffSession,
  failChallengeDelivery,
  findStaffForLogin,
  findStaffForPasswordChange,
  hashPassword,
  inspectLoginLink,
  listIntentsForAdmin,
  listAuditForAdmin,
  listBrokerAccountsForAdmin,
  listDepositsForAdmin,
  listLedgerForAdmin,
  listLiveStaffSessions,
  listTradingSessionsForAdmin,
  listUsersForAdmin,
  markChallengePromptSent,
  readAdminOverview,
  readIntentForAdmin,
  readLiveStaffContext,
  readUserForAdmin,
  recordBotProfilePublish,
  recordLoginLockout,
  recordPasswordChangeLockout,
  recordLoginRefusal,
  registerPasswordFailure,
  revokeStaffSession,
  runAsStaff,
  StaffLoginChallengeStatus,
  StaffStatus,
  startLoginChallenge,
  STAFF_SESSION_IDLE_MS,
  toAdminBrokerAccountListItem,
  toAdminBrokerAccountView,
  toAdminAuditEntryView,
  toAdminDepositView,
  toAdminLedgerEntry,
  toAdminOverview,
  toAdminTradeIntentView,
  toAdminTradingSessionView,
  toAdminUserDetail,
  toAdminUserListItem,
  verifyPassword,
  type AdminUserCard,
  type Db,
  type StaffActionResult,
  type StaffContext,
  type StaffPasswordChangeResult,
  type StaffPasswordChangeRow,
  type StaffSessionRow,
  type Tx,
} from '@binarius/db';
import { internalBearerAuth } from '../auth/internal';
import { createKeyedWindow, createWindow } from '../auth/rate-window';
import { createPasswordQueue, PasswordQueueOverflow, type PasswordQueue } from './password-queue';
import { telegramErrorFields } from '../telegram-logging';
import {
  publishBotProfile,
  readBotProfileSource,
  type BotProfileApi,
  type BotProfileMethodResult,
} from '../bot-texts/publish';
import type { AdminTelegram } from './telegram';

// Ceilings on the unauthenticated routes, taken before the body is read: they bound how much
// work an anonymous caller can ask this process for. Real staff logins are orders of magnitude
// rarer, so these only ever catch a flood. The link's inspect is a read every preview and
// prefetch can trigger, hence the wider one; its complete creates a session, like login (#448).
const LOGIN_MAX_PER_MINUTE = 120;
const CONFIRM_MAX_PER_MINUTE = 300;
const LINK_INSPECT_MAX_PER_MINUTE = 300;
const LINK_COMPLETE_MAX_PER_MINUTE = 120;
const ADMIN_BODY_LIMIT_BYTES = 4 * 1024;

// Per-login attempts at a name that has no live account. The lockout in `staff` covers a real
// account; this covers the rest, so guessing names costs the same as guessing passwords.
const UNKNOWN_LOGIN_MAX = 5;
const UNKNOWN_LOGIN_WINDOW_MS = 15 * 60_000;
// bounded on purpose: the keys come from request bodies
const UNKNOWN_LOGIN_MAX_KEYS = 10_000;

export interface AdminRoutesDeps {
  db: Db;
  adminWebToken: string;
  telegram: AdminTelegram;
  // the public bot's command menu and profile, published after a save or reset (#361)
  botProfileApi: BotProfileApi;
  // the seams the tests need; production takes every default
  passwordQueue?: PasswordQueue;
  verify?: (stored: string, password: string) => Promise<boolean>;
  hash?: (password: string) => Promise<string>;
  loginMaxPerMinute?: number;
  confirmMaxPerMinute?: number;
  linkInspectMaxPerMinute?: number;
  linkCompleteMaxPerMinute?: number;
  sessionIdleMs?: number;
}

export const adminRoutes: FastifyPluginAsync<AdminRoutesDeps> = async (app, deps) => {
  const queue = deps.passwordQueue ?? createPasswordQueue();
  const verify = deps.verify ?? verifyPassword;
  const hashNew = deps.hash ?? hashPassword;
  const idleMs = deps.sessionIdleMs ?? STAFF_SESSION_IDLE_MS;
  const loginCeiling = createWindow(deps.loginMaxPerMinute ?? LOGIN_MAX_PER_MINUTE);
  const confirmCeiling = createWindow(deps.confirmMaxPerMinute ?? CONFIRM_MAX_PER_MINUTE);
  const linkInspectCeiling = createWindow(
    deps.linkInspectMaxPerMinute ?? LINK_INSPECT_MAX_PER_MINUTE,
  );
  const linkCompleteCeiling = createWindow(
    deps.linkCompleteMaxPerMinute ?? LINK_COMPLETE_MAX_PER_MINUTE,
  );
  const unknownLogins = createKeyedWindow(
    UNKNOWN_LOGIN_MAX,
    UNKNOWN_LOGIN_WINDOW_MS,
    UNKNOWN_LOGIN_MAX_KEYS,
  );

  // The narrow bearer covers the whole prefix. It is not the internal token: it opens /admin/*
  // and nothing else, and every route below it except the login steps (the password, the code,
  // and the link from the bot) additionally needs a staff session.
  app.addHook('onRequest', internalBearerAuth(deps.adminWebToken));

  // Never runs the KDF when it refuses: a refusal that cost a derivation would be the thing
  // the queue exists to prevent.
  const hash = async (stored: string, password: string): Promise<boolean | 'refused'> => {
    try {
      return await queue.run(() => verify(stored, password));
    } catch (error) {
      if (error instanceof PasswordQueueOverflow) return 'refused';
      throw error;
    }
  };

  // The password change's two derivations share one slot (timing.ts →
  // PASSWORD_CHANGE_DERIVATIONS), and the new hash is derived only when the row, read again after
  // verify, is still the one the pre-read saw: a lockout or a reset that lands while the request
  // waits for the slot or while verify runs gets one answer in one time whatever the guess, so a
  // session cookie is no faster an oracle for the password than the login form. The two reads of
  // the staff row inside the slot are bounded by the pool's query_timeout, not by the timing chain.
  const derive = async (
    pre: StaffPasswordChangeRow,
    token: string,
    current: string,
    next: string,
  ): Promise<{ kind: 'ok'; hash: string } | { kind: 'miss' } | 'refused'> => {
    const stale = async (): Promise<boolean> => {
      const row = await findStaffForPasswordChange(deps.db, { token, idleMs });
      return row === undefined || row.lockedUntil !== null || row.passwordHash !== pre.passwordHash;
    };
    try {
      return await queue.run(async () => {
        if (await stale()) return { kind: 'miss' as const };
        const verified = await verify(pre.passwordHash, current);
        // before the branch on the guess, so a right and a wrong one differ by nothing here
        if (await stale()) return { kind: 'miss' as const };
        if (!verified) return { kind: 'miss' as const };
        return { kind: 'ok' as const, hash: await hashNew(next) };
      });
    } catch (error) {
      if (error instanceof PasswordQueueOverflow) return 'refused';
      throw error;
    }
  };

  app.post(
    '/admin/auth/login',
    { bodyLimit: ADMIN_BODY_LIMIT_BYTES },
    async (request, reply) => {
      if (loginCeiling.take().over) {
        return reply.code(429).send({ error: AdminErrorCode.TooManyAttempts });
      }
      const parsed = safeParseAdminLoginRequest(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: AdminErrorCode.Validation, issues: parsed.error.issues });
      }
      const { login, password, ip, userAgent } = parsed.data;

      const staff = await findStaffForLogin(deps.db, login);
      if (staff === undefined || staff.status !== StaffStatus.Active) {
        if (unknownLogins.take(login.toLowerCase())) {
          return reply.code(429).send({ error: AdminErrorCode.TooManyAttempts });
        }
        // the same derivation a live account costs, so the answer does not say which it was
        const spent = await hash(DUMMY_PASSWORD_HASH, password);
        if (spent === 'refused') {
          return reply.code(429).send({ error: AdminErrorCode.TooManyAttempts });
        }
        await recordLoginRefusal(deps.db, {
          staffId: staff?.id ?? null,
          reason: staff === undefined ? 'unknown_login' : 'disabled',
          ip,
        });
        return reply.code(401).send({ error: AdminErrorCode.InvalidCredentials });
      }

      // null unless a lockout is running right now, by the database's clock (findStaffForLogin);
      // re-read where it is recorded, so one that ended in between is not a refusal
      if (staff.lockedUntil !== null) {
        const until = await recordLoginLockout(deps.db, { staffId: staff.id, ip });
        if (until !== null) return reply.code(429).send({ error: AdminErrorCode.TooManyAttempts });
      }

      const correct = await hash(staff.passwordHash, password);
      if (correct === 'refused') {
        return reply.code(429).send({ error: AdminErrorCode.TooManyAttempts });
      }
      if (!correct) {
        await registerPasswordFailure(deps.db, {
          staffId: staff.id,
          passwordHash: staff.passwordHash,
          ip,
        });
        return reply.code(401).send({ error: AdminErrorCode.InvalidCredentials });
      }

      // The hash the derivation above ran against, re-checked inside the transaction: about
      // 250 ms passed, and a reset, a disable or a lockout in that window has to win.
      const started = await startLoginChallenge(deps.db, {
        staffId: staff.id,
        passwordHash: staff.passwordHash,
        ip,
        userAgent,
      });
      if (!started.ok) {
        return reply.code(401).send({ error: AdminErrorCode.InvalidCredentials });
      }

      // `deliverPrompt` runs for two reasons: an invitation is owed, or polling is down and the
      // fail-closed gate inside it has to run even though nothing is owed — a reused challenge is
      // otherwise five minutes of waiting for a button that cannot arrive.
      if (started.sendPrompt || !deps.telegram.isPolling()) {
        const delivered = await deliverPrompt(started.challengeId, staff, { ip, userAgent });
        // 'closed' means the challenge is gone and nobody can be waiting on it. 'moved on' means
        // the button was pressed while the message was in flight: the code is already on its way
        // to the same person, so answering 503 would be a lie about a challenge that is alive.
        if (delivered === 'closed') {
          return reply.code(503).send({ error: AdminErrorCode.TelegramUnavailable });
        }
      }
      return reply.send({
        challengeId: started.challengeId,
        expiresAt: started.expiresAt.toISOString(),
      });
    },
  );

  // Outside the transaction that created the challenge: a Bot API call must not be held open
  // across a commit. A process that dies between the two leaves prompt_sent_at NULL, and the
  // next login sends the invitation again.
  async function deliverPrompt(
    challengeId: string,
    staff: { id: string; login: string; telegramUserId: bigint },
    client: { ip: string; userAgent: string },
  ): Promise<'sent' | 'closed' | 'moved on'> {
    const close = async (reason: 'polling_down' | 'prompt_send_failed', error: unknown) =>
      (await failChallengeDelivery(deps.db, {
        challengeId,
        staffId: staff.id,
        from: StaffLoginChallengeStatus.Pending,
        reason,
        err: errorIdentity(error),
        telegram: { ...telegramErrorFields(error, 'sendMessage') },
      }))
        ? ('closed' as const)
        : ('moved on' as const);

    if (!deps.telegram.isPolling()) {
      // fail closed: with polling down the button cannot arrive, so leaving the challenge open
      // would be five minutes of a staff member waiting for a message nobody will send
      app.log.error({ challengeId }, 'a staff login arrived while the bot was not polling');
      return close('polling_down', new Error('the staff login bot is not polling'));
    }
    try {
      await deps.telegram.sendLoginPrompt({
        challengeId,
        telegramUserId: staff.telegramUserId,
        login: staff.login,
        ip: client.ip,
        userAgent: client.userAgent,
      });
    } catch (error) {
      app.log.error(
        { ...errorLogFields(error), ...telegramErrorFields(error, 'sendMessage'), challengeId },
        'the staff login invitation could not be delivered',
      );
      return close('prompt_send_failed', error);
    }
    await markChallengePromptSent(deps.db, challengeId);
    return 'sent';
  }

  app.post(
    '/admin/auth/confirm',
    { bodyLimit: ADMIN_BODY_LIMIT_BYTES },
    async (request, reply) => {
      if (confirmCeiling.take().over) {
        return reply.code(429).send({ error: AdminErrorCode.TooManyAttempts });
      }
      const parsed = safeParseAdminConfirmRequest(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: AdminErrorCode.Validation, issues: parsed.error.issues });
      }
      const { challengeId, code, ip, userAgent } = parsed.data;
      const completed = await completeLogin(deps.db, { challengeId, code, ip, userAgent });
      if (completed.ok) {
        return reply.send({
          sessionToken: completed.sessionToken,
          expiresAt: completed.expiresAt.toISOString(),
        });
      }
      // 401 while attempts remain, 410 on the last one: telling someone to retry a challenge
      // that the same call just exhausted costs them one more round trip to find out
      if (completed.reason === 'wrong_code' && completed.exhausted !== true) {
        return reply.code(401).send({ error: AdminErrorCode.InvalidCode });
      }
      if (completed.reason === 'awaiting_telegram') {
        return reply.code(409).send({ error: AdminErrorCode.AwaitingTelegram });
      }
      // every other reason — expired, denied, exhausted, failed, completed, a disabled owner,
      // an id nobody was issued — is one answer: this attempt is over, start again
      return reply.code(410).send({ error: AdminErrorCode.ChallengeUnavailable });
    },
  );

  // docs/staff-login.md → Logging in by a link from the bot (#448). The token is in the body, so
  // no request line of this hop carries it; neither route logs it.
  app.post(
    '/admin/auth/link/inspect',
    { bodyLimit: ADMIN_BODY_LIMIT_BYTES },
    async (request, reply) => {
      if (linkInspectCeiling.take().over) {
        return reply.code(429).send({ error: AdminErrorCode.TooManyAttempts });
      }
      const parsed = safeParseAdminLinkInspectRequest(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: AdminErrorCode.Validation, issues: parsed.error.issues });
      }
      return reply.send({ state: await inspectLoginLink(deps.db, parsed.data.token) });
    },
  );

  app.post(
    '/admin/auth/link/complete',
    { bodyLimit: ADMIN_BODY_LIMIT_BYTES },
    async (request, reply) => {
      if (linkCompleteCeiling.take().over) {
        return reply.code(429).send({ error: AdminErrorCode.TooManyAttempts });
      }
      const parsed = safeParseAdminLinkCompleteRequest(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: AdminErrorCode.Validation, issues: parsed.error.issues });
      }
      const { token, ip, userAgent } = parsed.data;
      const completed = await completeLinkLogin(deps.db, { token, ip, userAgent });
      if (completed.ok) {
        return reply.send({
          sessionToken: completed.sessionToken,
          expiresAt: completed.expiresAt.toISOString(),
        });
      }
      // the refusal left an audit row when the link belongs to someone; this line is for the
      // rest, and for an operator watching the log
      request.log.info({ linkState: completed.state }, 'a staff login link was refused');
      const error =
        completed.state === LinkState.Used
          ? AdminErrorCode.LinkUsed
          : completed.state === LinkState.Expired
            ? AdminErrorCode.LinkExpired
            : AdminErrorCode.LinkUnavailable;
      return reply.code(410).send({ error });
    },
  );

  /** The session token, checked for shape before the database is asked anything. */
  const tokenOf = (request: { headers: Record<string, unknown> }): string | undefined => {
    const header = request.headers['x-staff-session'];
    if (typeof header !== 'string' || !STAFF_SESSION_TOKEN_PATTERN.test(header)) return undefined;
    return header;
  };

  /**
   * The one way into runAsStaff: a token of the wrong shape or a session that is not live is a
   * 401 with no row; otherwise the work and its audit row share one transaction. `undefined`
   * means the 401 is already sent. `lockStaff` for a route that writes `staff` or touches a
   * session other than its own (runAsStaff).
   */
  const asStaff = async <T>(
    request: FastifyRequest,
    reply: FastifyReply,
    fn: (tx: Tx, ctx: StaffContext) => Promise<StaffActionResult<T>>,
    options: { lockStaff?: boolean } = {},
  ): Promise<T | undefined> => {
    const token = tokenOf(request);
    if (token === undefined) {
      await reply.code(401).send({ error: AdminErrorCode.SessionInvalid });
      return undefined;
    }
    const answer = await runAsStaff(deps.db, { token, idleMs, ...options }, fn);
    if (answer === undefined) {
      request.log.info('a staff session was refused');
      await reply.code(401).send({ error: AdminErrorCode.SessionInvalid });
    }
    return answer;
  };

  const meOf = (ctx: StaffContext) => ({
    staffId: ctx.staffId,
    login: ctx.login,
    sessionId: ctx.sessionId,
  });

  app.get('/admin/sessions', async (request, reply) => {
    const answer = await asStaff(request, reply, async (tx, ctx) => {
      const rows = await listLiveStaffSessions(tx, idleMs);
      return {
        result: {
          me: meOf(ctx),
          sessions: rows.map((row) => toStaffSessionView(row, ctx.sessionId)),
        },
        audit: {
          action: AuditAction.StaffSessionsViewed,
          payload: { path: '/admin/sessions', sessionId: ctx.sessionId },
        },
      };
    });
    if (answer === undefined) return reply;
    return reply.send(answer);
  });

  app.post('/admin/sessions/:id/revoke', async (request, reply) => {
    const targetSessionId = (request.params as { id?: unknown }).id;
    const answer = await asStaff(
      request,
      reply,
      async (tx, ctx) => {
        // Inside the session check, not in front of it: an id that is not a uuid is
        // indistinguishable from one nobody was issued, and both deserve the same row. The id
        // itself stays out of the payload here — it is arbitrary input, the same reason the
        // login someone typed for an account that does not exist is never recorded.
        if (typeof targetSessionId !== 'string' || !UUID_PATTERN.test(targetSessionId)) {
          return {
            result: { revoked: false, current: false },
            audit: {
              action: AuditAction.StaffSessionRevoked,
              payload: { result: 'not_found', current: false },
            },
          };
        }
        const revoked = await revokeStaffSession(tx, {
          sessionId: targetSessionId,
          byStaffId: ctx.staffId,
          idleMs,
        });
        const current = targetSessionId === ctx.sessionId;
        if (revoked === undefined) {
          // the truthful entry: an attempt happened, a revocation did not, so there is no
          // entity to name
          return {
            result: { revoked: false, current: false },
            audit: {
              action: AuditAction.StaffSessionRevoked,
              payload: { result: 'not_found', targetSessionId, current: false },
            },
          };
        }
        return {
          result: { revoked: true, current },
          audit: {
            action: AuditAction.StaffSessionRevoked,
            entity: { type: AuditEntityType.StaffSession, id: targetSessionId },
            payload: {
              result: 'revoked',
              targetSessionId,
              targetStaffId: revoked.staffId,
              current,
            },
          },
        };
      },
      { lockStaff: true },
    );
    if (answer === undefined) return reply;
    if (!answer.revoked) {
      return reply.code(404).send({ error: AdminErrorCode.NotFound });
    }
    return reply.send({ revoked: true, current: answer.current });
  });

  app.post('/admin/auth/logout', async (request, reply) => {
    const answer = await asStaff(request, reply, async (tx, ctx) => {
      await endStaffSession(tx, ctx.sessionId, ctx.staffId);
      return {
        result: { loggedOut: true as const },
        audit: {
          action: AuditAction.StaffLogout,
          entity: { type: AuditEntityType.StaffSession, id: ctx.sessionId },
          payload: {},
        },
      };
    });
    if (answer === undefined) return reply;
    return reply.send(answer);
  });

  // docs/staff-login.md → Changing your own password. Three phases, as at login: a read outside
  // any transaction, the KDF in the queue, then a transaction that re-checks by CAS what the
  // KDF saw. Refusals before the transaction leave no row, as the login's do.
  app.post(
    '/admin/auth/password',
    { bodyLimit: ADMIN_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const token = tokenOf(request);
      if (token === undefined) {
        return reply.code(401).send({ error: AdminErrorCode.SessionInvalid });
      }
      const parsed = safeParseAdminChangePasswordRequest(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: AdminErrorCode.Validation, issues: parsed.error.issues });
      }
      const { currentPassword, newPassword, ip } = parsed.data;

      const pre = await findStaffForPasswordChange(deps.db, { token, idleMs });
      if (pre === undefined) {
        request.log.info('a staff session was refused');
        return reply.code(401).send({ error: AdminErrorCode.SessionInvalid });
      }
      const failed = (ctx: StaffContext, payload: Record<string, unknown>) => ({
        action: AuditAction.StaffPasswordChangeFailed,
        entity: { type: AuditEntityType.Staff, id: ctx.staffId },
        payload: { ...payload, ip, sessionId: ctx.sessionId },
      });
      const locked = (until: Date) => ({ reason: 'locked', lockedUntil: until.toISOString() });

      // null unless a lockout is running right now, by the database's clock; no KDF under it.
      // Re-read where it is recorded, so one that ended in between is not a refusal.
      if (pre.lockedUntil !== null) {
        const until = await recordPasswordChangeLockout(deps.db, {
          staffId: pre.staffId,
          sessionId: pre.sessionId,
          ip,
        });
        if (until !== null) return reply.code(429).send({ error: AdminErrorCode.TooManyAttempts });
      }

      const derived = await derive(pre, token, currentPassword, newPassword);
      if (derived === 'refused') {
        return reply.code(429).send({ error: AdminErrorCode.TooManyAttempts });
      }
      // a wrong guess and a stale row are one transaction: the counter's CAS misses a row that
      // changed, so a right password caught by a lockout is never counted as a wrong one
      if (derived.kind !== 'ok') {
        const answer = await asStaff(
          request,
          reply,
          async (tx, ctx) => {
            const failure = await countPasswordFailure(tx, {
              staffId: ctx.staffId,
              passwordHash: pre.passwordHash,
            });
            const payload =
              failure.stateChanged !== true
                ? { reason: 'wrong_password', attempts: failure.attempts, locked: failure.locked }
                : failure.lockedUntil
                  ? locked(failure.lockedUntil)
                  : { reason: 'state_changed' };
            return { result: payload.reason, audit: failed(ctx, payload) };
          },
          { lockStaff: true },
        );
        if (answer === undefined) return reply;
        return answer === 'locked'
          ? reply.code(429).send({ error: AdminErrorCode.TooManyAttempts })
          : reply.code(401).send({ error: AdminErrorCode.InvalidCredentials });
      }

      const answer = await asStaff(
        request,
        reply,
        async (tx, ctx): Promise<StaffActionResult<StaffPasswordChangeResult>> => {
          const changed = await applyStaffPasswordChange(tx, {
            staffId: ctx.staffId,
            sessionId: ctx.sessionId,
            passwordHashSeen: pre.passwordHash,
            newPasswordHash: derived.hash,
          });
          if (!changed.ok) {
            return {
              result: changed,
              audit: failed(
                ctx,
                changed.reason === 'locked'
                  ? locked(changed.lockedUntil)
                  : { reason: changed.reason },
              ),
            };
          }
          return {
            result: changed,
            audit: {
              action: AuditAction.StaffPasswordChanged,
              entity: { type: AuditEntityType.Staff, id: ctx.staffId },
              payload: {
                sessionId: ctx.sessionId,
                closedChallenges: changed.closedChallenges,
                closedLinks: changed.closedLinks,
                revokedSessions: changed.revokedSessions,
                ip,
              },
            },
          };
        },
        { lockStaff: true },
      );
      if (answer === undefined) return reply;
      if (!answer.ok) {
        return answer.reason === 'locked'
          ? reply.code(429).send({ error: AdminErrorCode.TooManyAttempts })
          : reply.code(401).send({ error: AdminErrorCode.InvalidCredentials });
      }
      return reply.send({ changed: true, revokedSessions: answer.revokedSessions });
    },
  );

  // --- Read pages (#107, docs/admin-pages.md) ---------------------------------------------------

  app.get('/admin/overview', async (request, reply) => {
    const answer = await asStaff(request, reply, async (tx, ctx) => {
      const row = await readAdminOverview(tx, { activeWindowMinutes: ADMIN_ACTIVE_WINDOW_MINUTES });
      return {
        result: { me: meOf(ctx), overview: toAdminOverview(row, ADMIN_ACTIVE_WINDOW_MINUTES) },
        audit: { action: AuditAction.OverviewViewed, payload: { path: '/admin/overview' } },
      };
    });
    if (answer === undefined) return reply;
    return reply.send(answer);
  });

  app.get('/admin/users', async (request, reply) => {
    // before the session: a query outside the schema costs no transaction and leaves no row
    const parsed = safeParseAdminUsersQuery(request.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: AdminErrorCode.Validation, issues: parsed.error.issues });
    }
    const { q, cursor } = parsed.data;
    const search = q === undefined ? undefined : classifyUserSearch(q);
    const answer = await asStaff(request, reply, async (tx, ctx) => {
      const page = await listUsersForAdmin(tx, { search, cursor, limit: ADMIN_PAGE_SIZE });
      return {
        result: {
          me: meOf(ctx),
          users: page.rows.map(toAdminUserListItem),
          nextCursor: page.nextCursor,
        },
        audit: {
          action: AuditAction.UsersViewed,
          payload: {
            path: '/admin/users',
            ...(search === undefined ? {} : { q: search.value, by: search.by }),
            ...(cursor === undefined ? {} : { cursor }),
          },
        },
      };
    });
    if (answer === undefined) return reply;
    return reply.send(answer);
  });

  app.get('/admin/users/:id', async (request, reply) => {
    const userId = (request.params as { id?: unknown }).id;
    const path = '/admin/users/:id';
    const answer = await asStaff(request, reply, async (tx, ctx) => {
      // inside the session, as revoke does: the attempt leaves a row, and an id that is not a
      // uuid is arbitrary input, so it is not recorded
      if (typeof userId !== 'string' || !UUID_PATTERN.test(userId)) {
        return {
          result: null,
          audit: { action: AuditAction.UserViewed, payload: { path, result: 'not_found' } },
        };
      }
      const card = await readUserForAdmin(tx, userId);
      if (card === undefined) {
        return {
          result: null,
          audit: {
            action: AuditAction.UserViewed,
            payload: { path, result: 'not_found', userId },
          },
        };
      }
      return {
        result: { me: meOf(ctx), ...toAdminUserCard(card) },
        audit: {
          action: AuditAction.UserViewed,
          entity: { type: AuditEntityType.User, id: userId },
          payload: { path, result: 'found', userId },
        },
      };
    });
    if (answer === undefined) return reply;
    if (answer === null) {
      return reply.code(404).send({ error: AdminErrorCode.NotFound });
    }
    return reply.send(answer);
  });

  // --- Intents (#108, docs/admin-pages.md) -------------------------------------------------------

  app.get('/admin/intents', async (request, reply) => {
    // before the session: a query outside the schema costs no transaction and leaves no row
    const parsed = safeParseAdminIntentsQuery(request.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: AdminErrorCode.Validation, issues: parsed.error.issues });
    }
    const { status, mode, user, session, cursor } = parsed.data;
    const answer = await asStaff(request, reply, async (tx, ctx) => {
      const page = await listIntentsForAdmin(tx, {
        filters: { status, mode, userId: user, tradingSessionId: session },
        cursor,
        limit: ADMIN_PAGE_SIZE,
      });
      return {
        result: {
          me: meOf(ctx),
          intents: page.rows.map(toAdminTradeIntentView),
          nextCursor: page.nextCursor,
        },
        audit: {
          action: AuditAction.IntentsViewed,
          payload: {
            path: '/admin/intents',
            ...(status === undefined ? {} : { status }),
            ...(mode === undefined ? {} : { mode }),
            ...(user === undefined ? {} : { userId: user }),
            // not `sessionId`: in staff_sessions_viewed that names a staff session
            ...(session === undefined ? {} : { tradingSessionId: session }),
            ...(cursor === undefined ? {} : { cursor }),
          },
        },
      };
    });
    if (answer === undefined) return reply;
    return reply.send(answer);
  });

  app.get('/admin/intents/:id', async (request, reply) => {
    const intentId = (request.params as { id?: unknown }).id;
    const path = '/admin/intents/:id';
    const answer = await asStaff(request, reply, async (tx, ctx) => {
      // inside the session, as the user card does: the attempt leaves a row, and an id that is
      // not a uuid is arbitrary input, so it is not recorded
      if (typeof intentId !== 'string' || !UUID_PATTERN.test(intentId)) {
        return {
          result: null,
          audit: { action: AuditAction.IntentViewed, payload: { path, result: 'not_found' } },
        };
      }
      const row = await readIntentForAdmin(tx, intentId);
      if (row === undefined) {
        return {
          result: null,
          audit: {
            action: AuditAction.IntentViewed,
            payload: { path, result: 'not_found', intentId },
          },
        };
      }
      return {
        result: { me: meOf(ctx), intent: toAdminTradeIntentView(row) },
        audit: {
          action: AuditAction.IntentViewed,
          entity: { type: AuditEntityType.TradeIntent, id: intentId },
          payload: { path, result: 'found', intentId },
        },
      };
    });
    if (answer === undefined) return reply;
    if (answer === null) {
      return reply.code(404).send({ error: AdminErrorCode.NotFound });
    }
    return reply.send(answer);
  });

  // --- Trading sessions (#330, docs/admin-pages.md) ----------------------------------------------

  app.get('/admin/trading-sessions', async (request, reply) => {
    // before the session: a query outside the schema costs no transaction and leaves no row
    const parsed = safeParseAdminTradingSessionsQuery(request.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: AdminErrorCode.Validation, issues: parsed.error.issues });
    }
    const { cursor } = parsed.data;
    const answer = await asStaff(request, reply, async (tx, ctx) => {
      const page = await listTradingSessionsForAdmin(tx, { cursor, limit: ADMIN_PAGE_SIZE });
      return {
        result: {
          me: meOf(ctx),
          sessions: page.rows.map(toAdminTradingSessionView),
          nextCursor: page.nextCursor,
        },
        audit: {
          action: AuditAction.TradingSessionsViewed,
          payload: {
            path: '/admin/trading-sessions',
            ...(cursor === undefined ? {} : { cursor }),
          },
        },
      };
    });
    if (answer === undefined) return reply;
    return reply.send(answer);
  });

  // --- Token ledger (#109, docs/admin-pages.md) --------------------------------------------------

  app.get('/admin/tokens', async (request, reply) => {
    // before the session: a query outside the schema costs no transaction and leaves no row
    const parsed = safeParseAdminTokensQuery(request.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: AdminErrorCode.Validation, issues: parsed.error.issues });
    }
    const { user, kind, cursor } = parsed.data;
    const answer = await asStaff(request, reply, async (tx, ctx) => {
      const page = await listLedgerForAdmin(tx, {
        filters: { userId: user, kind },
        cursor,
        limit: ADMIN_PAGE_SIZE,
      });
      return {
        result: {
          me: meOf(ctx),
          entries: page.rows.map(toAdminLedgerEntry),
          nextCursor: page.nextCursor,
        },
        audit: {
          action: AuditAction.TokensViewed,
          payload: {
            path: '/admin/tokens',
            ...(user === undefined ? {} : { userId: user }),
            ...(kind === undefined ? {} : { kind }),
            ...(cursor === undefined ? {} : { cursor }),
          },
        },
      };
    });
    if (answer === undefined) return reply;
    return reply.send(answer);
  });

  // --- Audit log (#110, docs/admin-pages.md) -----------------------------------------------------

  app.get('/admin/audit', async (request, reply) => {
    // before the session: a query outside the schema costs no transaction and leaves no row
    const parsed = safeParseAdminAuditQuery(request.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: AdminErrorCode.Validation, issues: parsed.error.issues });
    }
    const { action, entityType, entityId, actorId, from, to, cursor } = parsed.data;
    const answer = await asStaff(request, reply, async (tx, ctx) => {
      // runAsStaff writes this request's own row after this SELECT: it shows on the next page
      const page = await listAuditForAdmin(tx, {
        filters: { action, entityType, entityId, actorId, from, to },
        cursor,
        limit: ADMIN_PAGE_SIZE,
      });
      return {
        result: {
          me: meOf(ctx),
          entries: page.rows.map(toAdminAuditEntryView),
          nextCursor: page.nextCursor,
        },
        audit: {
          action: AuditAction.AuditLogViewed,
          payload: {
            path: '/admin/audit',
            ...(action === undefined ? {} : { action }),
            ...(entityType === undefined ? {} : { entityType }),
            ...(entityId === undefined ? {} : { entityId }),
            ...(actorId === undefined ? {} : { actorId }),
            ...(from === undefined ? {} : { from }),
            ...(to === undefined ? {} : { to }),
            ...(cursor === undefined ? {} : { cursor }),
          },
        },
      };
    });
    if (answer === undefined) return reply;
    return reply.send(answer);
  });

  // --- Deposits (#341, docs/admin-pages.md) ------------------------------------------------------

  app.get('/admin/deposits', async (request, reply) => {
    // before the session: a query outside the schema costs no transaction and leaves no row
    const parsed = safeParseAdminDepositsQuery(request.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: AdminErrorCode.Validation, issues: parsed.error.issues });
    }
    const { user, status, cursor } = parsed.data;
    const answer = await asStaff(request, reply, async (tx, ctx) => {
      const page = await listDepositsForAdmin(tx, {
        filters: { userId: user, status },
        cursor,
        limit: ADMIN_PAGE_SIZE,
      });
      return {
        result: {
          me: meOf(ctx),
          deposits: page.rows.map(toAdminDepositView),
          nextCursor: page.nextCursor,
        },
        audit: {
          action: AuditAction.DepositsViewed,
          payload: {
            path: '/admin/deposits',
            ...(user === undefined ? {} : { userId: user }),
            ...(status === undefined ? {} : { status }),
            ...(cursor === undefined ? {} : { cursor }),
          },
        },
      };
    });
    if (answer === undefined) return reply;
    return reply.send(answer);
  });

  // --- Broker accounts (#342, docs/admin-pages.md) -----------------------------------------------

  app.get('/admin/broker-accounts', async (request, reply) => {
    // before the session: a query outside the schema costs no transaction and leaves no row
    const parsed = safeParseAdminBrokerAccountsQuery(request.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: AdminErrorCode.Validation, issues: parsed.error.issues });
    }
    const { status, halted, cursor } = parsed.data;
    const answer = await asStaff(request, reply, async (tx, ctx) => {
      const page = await listBrokerAccountsForAdmin(tx, {
        filters: { status, ...(halted === undefined ? {} : { halted: true }) },
        cursor,
        limit: ADMIN_PAGE_SIZE,
      });
      return {
        result: {
          me: meOf(ctx),
          accounts: page.rows.map(toAdminBrokerAccountListItem),
          nextCursor: page.nextCursor,
        },
        audit: {
          action: AuditAction.BrokerAccountsViewed,
          payload: {
            path: '/admin/broker-accounts',
            ...(status === undefined ? {} : { status }),
            // the JSON true, not the query's string
            ...(halted === undefined ? {} : { halted: true }),
            ...(cursor === undefined ? {} : { cursor }),
          },
        },
      };
    });
    if (answer === undefined) return reply;
    return reply.send(answer);
  });

  // --- Bot texts (#300, docs/admin-pages.md → Bot texts) ----------------------------------------
  // Save and reset run inside runAsStaff without lockStaff (stated): they touch their own session
  // row, then lock bot_text_overrides; the row's FK takes KEY SHARE on staff, which the password
  // change's FOR NO KEY UPDATE does not block, so no writer waits on the other in a cycle.

  const textBody = { bodyLimit: ADMIN_BOT_TEXT_BODY_LIMIT_BYTES };
  const textEntity = { type: AuditEntityType.BotText };

  // the key as the URL has it: by pattern, recorded; in the catalog, known
  const textKeyOf = (request: FastifyRequest): { key?: string; known?: BotTextKey } => {
    const key = (request.params as { key?: unknown }).key;
    if (typeof key !== 'string' || !BOT_TEXT_KEY_PATTERN.test(key)) return {};
    return isBotTextKey(key) ? { key, known: key } : { key };
  };
  const readTexts = async (tx: Tx) => {
    const rows = await listBotTextOverridesForAdmin(tx);
    return { rows, resolved: resolveBotTextOverrides(rows) };
  };
  const textViewOf = async (tx: Tx, key: BotTextKey) => {
    const { rows, resolved } = await readTexts(tx);
    return toAdminBotTextView(key, rows, resolved);
  };
  const textAudit = (
    action: AuditAction,
    path: string,
    key: string | undefined,
    result: string,
  ): StaffAuditDescription => ({
    action,
    entity: textEntity,
    payload: { path, ...(key === undefined ? {} : { key }), result },
  });
  const badTextBody = (reply: FastifyReply, issues: unknown) =>
    reply.code(400).send({ error: AdminErrorCode.Validation, issues });

  // Admin publishes are one queue a process: each reads the rows after the previous publish has
  // been sent, so the last publish of a burst carries every admin save committed before its read
  // (#361 review m1). The read belongs inside the link: two reads finishing out of snapshot order
  // would send a stale menu last again. A failed link never blocks the next.
  let publishing: Promise<unknown> = Promise.resolve();
  const serialized = <T>(run: () => Promise<T>): Promise<T> => {
    const next = publishing.then(run);
    publishing = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  // After the commit, never inside it: a Bot API call of up to BOT_PROFILE_PUBLISH_TIMEOUT_MS
  // would hold the session row past the pool's query_timeout for the next request of the same
  // session. The log keeps each failure's identity as it is; the answer and the row carry it as
  // the wire takes it.
  const publishAfterCommit = (
    request: FastifyRequest,
    input: {
      staffId: string;
      path: string;
      trigger: 'save' | 'reset' | 'republish';
      key?: BotTextKey;
      methods: readonly BotProfileMethod[];
    },
  ): Promise<AdminBotProfileMethodResult[]> =>
    serialized(async () => {
      const results = await publishBotProfile(
        deps.botProfileApi,
        await readBotProfileSource(deps.db),
        input.methods,
      );
      for (const result of results) {
        if (!result.ok) request.log.warn({ ...result }, 'bot profile not published');
      }
      const published = results.map(toWirePublishResult);
      const { staffId, path, trigger, key } = input;
      await recordBotProfilePublish(deps.db, {
        staffId,
        path,
        trigger,
        ...(key === undefined ? {} : { key }),
        methods: published,
      });
      return published;
    });

  app.get('/admin/bot-texts', async (request, reply) => {
    const answer = await asStaff(request, reply, async (tx, ctx) => {
      const { rows, resolved } = await readTexts(tx);
      return {
        result: {
          me: meOf(ctx),
          overrides: rows.map((row) =>
            toAdminBotTextOverrideView(row, resolved.rejected.get(row.key)),
          ),
        },
        audit: { action: AuditAction.BotTextsViewed, payload: { path: '/admin/bot-texts' } },
      };
    });
    if (answer === undefined) return reply;
    return reply.send(answer);
  });

  app.get('/admin/bot-texts/:key', async (request, reply) => {
    const { key, known } = textKeyOf(request);
    const path = '/admin/bot-texts/:key';
    const answer = await asStaff(
      request,
      reply,
      async (tx, ctx): Promise<StaffActionResult<AdminBotTextResponse | null>> => {
        if (known === undefined) {
          const payload = { path, result: 'not_found', ...(key === undefined ? {} : { key }) };
          return { result: null, audit: { action: AuditAction.BotTextViewed, payload } };
        }
        return {
          result: { me: meOf(ctx), text: await textViewOf(tx, known) },
          audit: textAudit(AuditAction.BotTextViewed, path, known, 'found'),
        };
      },
    );
    if (answer === undefined) return reply;
    if (answer === null) return reply.code(404).send({ error: AdminErrorCode.NotFound });
    return reply.send(answer);
  });

  // nothing is written and nothing locked: a save in between is caught by the version on save
  app.post('/admin/bot-texts/:key/preview', textBody, async (request, reply) => {
    const parsed = safeParseAdminBotTextPreviewRequest(request.body);
    if (!parsed.success) return badTextBody(reply, parsed.error.issues);
    const { source } = parsed.data;
    const { key, known } = textKeyOf(request);
    const path = '/admin/bot-texts/:key/preview';
    const answer = await asStaff(
      request,
      reply,
      async (tx, ctx): Promise<StaffActionResult<AdminBotTextPreviewResponse | null>> => {
        const audit = (result: AdminBotTextPreviewResponse['outcome'] | 'not_found') =>
          textAudit(AuditAction.BotTextPreviewed, path, key, result);
        if (known === undefined) return { result: null, audit: audit('not_found') };
        const { rows, resolved } = await readTexts(tx);
        const base = { me: meOf(ctx), text: toAdminBotTextView(known, rows, resolved) };
        const problems = botTextChangeProblems(known, source, rows);
        if (problems.length > 0) {
          return {
            result: { ...base, outcome: 'refused', problems: adminBotTextProblems(problems) },
            audit: audit('refused'),
          };
        }
        const after = resolveBotTextOverrides([
          ...rows.filter((row) => row.key !== known),
          { key: known, source },
        ]);
        return {
          result: {
            ...base,
            outcome: 'rendered',
            rendered: renderBotTextPreview(known, after.source),
          },
          audit: audit('rendered'),
        };
      },
    );
    if (answer === undefined) return reply;
    if (answer === null) return reply.code(404).send({ error: AdminErrorCode.NotFound });
    return reply.send(answer);
  });

  app.post('/admin/bot-texts/:key/save', textBody, async (request, reply) => {
    const parsed = safeParseAdminBotTextSaveRequest(request.body);
    if (!parsed.success) return badTextBody(reply, parsed.error.issues);
    const { source, expectedVersion } = parsed.data;
    const { key, known } = textKeyOf(request);
    const path = '/admin/bot-texts/:key/save';
    const answer = await asStaff(
      request,
      reply,
      async (tx, ctx): Promise<StaffActionResult<Unpublished<AdminBotTextSaveResponse> | null>> => {
        const audit = (result: AdminBotTextSaveResponse['outcome'] | 'not_found') =>
          textAudit(AuditAction.BotTextSaved, path, key, result);
        if (known === undefined) return { result: null, audit: audit('not_found') };
        const applied = await applyBotTextSave(tx, {
          key: known,
          source,
          expectedVersion,
          staffId: ctx.staffId,
        });
        // after the write: the same transaction reads its own row
        const base = { me: meOf(ctx), text: await textViewOf(tx, known) };
        if (applied.ok) {
          return {
            result: { ...base, outcome: 'saved', version: applied.version },
            audit: { ...audit('saved'), payload: { path, result: 'saved', ...applied.audit } },
          };
        }
        switch (applied.reason) {
          case 'version_conflict':
            return {
              result: {
                ...base,
                outcome: 'version_conflict',
                currentVersion: applied.currentVersion,
                currentSource: applied.currentSource,
              },
              audit: audit('version_conflict'),
            };
          case 'unchanged':
            return { result: { ...base, outcome: 'unchanged' }, audit: audit('unchanged') };
          case 'refused':
            return {
              result: {
                ...base,
                outcome: 'refused',
                problems: adminBotTextProblems(applied.problems),
              },
              audit: audit('refused'),
            };
          case 'already_default':
            throw new UnexpectedBotTextOutcome();
        }
      },
    );
    if (answer === undefined) return reply;
    if (answer === null) return reply.code(404).send({ error: AdminErrorCode.NotFound });
    if (answer.outcome !== 'saved') return reply.send(answer);
    const methods = known === undefined ? [] : botProfileMethodsOf(known);
    const published =
      methods.length === 0
        ? []
        : await publishAfterCommit(request, {
            staffId: answer.me.staffId,
            path,
            trigger: 'save',
            key: known,
            methods,
          });
    return reply.send({ ...answer, published } satisfies AdminBotTextSaveResponse);
  });

  // a key outside the catalog can be reset: a row left behind by a renamed key
  app.post('/admin/bot-texts/:key/reset', textBody, async (request, reply) => {
    const parsed = safeParseAdminBotTextResetRequest(request.body);
    if (!parsed.success) return badTextBody(reply, parsed.error.issues);
    const { expectedVersion } = parsed.data;
    const { key, known } = textKeyOf(request);
    const path = '/admin/bot-texts/:key/reset';
    const answer = await asStaff(
      request,
      reply,
      async (
        tx,
        ctx,
      ): Promise<StaffActionResult<Unpublished<AdminBotTextResetResponse> | null>> => {
        const audit = (result: AdminBotTextResetResponse['outcome'] | 'not_found') =>
          textAudit(AuditAction.BotTextReset, path, key, result);
        if (key === undefined) return { result: null, audit: audit('not_found') };
        const viewNow = () => (known === undefined ? null : textViewOf(tx, known));
        const applied = await applyBotTextReset(tx, { key, expectedVersion });
        const base = { me: meOf(ctx), text: await viewNow() };
        if (applied.ok) {
          return {
            result: { ...base, outcome: 'reset' },
            audit: { ...audit('reset'), payload: { path, result: 'reset', ...applied.audit } },
          };
        }
        switch (applied.reason) {
          case 'version_conflict':
            return {
              result: {
                ...base,
                outcome: 'version_conflict',
                currentVersion: applied.currentVersion,
                currentSource: applied.currentSource,
              },
              audit: audit('version_conflict'),
            };
          case 'already_default':
            return {
              result: { ...base, outcome: 'already_default' },
              audit: audit('already_default'),
            };
          case 'refused':
            return {
              result: {
                ...base,
                outcome: 'refused',
                problems: adminBotTextProblems(applied.problems),
              },
              audit: audit('refused'),
            };
          case 'unchanged':
            throw new UnexpectedBotTextOutcome();
        }
      },
    );
    if (answer === undefined) return reply;
    if (answer === null) return reply.code(404).send({ error: AdminErrorCode.NotFound });
    if (answer.outcome !== 'reset') return reply.send(answer);
    const methods = known === undefined ? [] : botProfileMethodsOf(known);
    const published =
      methods.length === 0
        ? []
        : await publishAfterCommit(request, {
            staffId: answer.me.staffId,
            path,
            trigger: 'reset',
            key: known,
            methods,
          });
    return reply.send({ ...answer, published } satisfies AdminBotTextResetResponse);
  });

  // «Опубликовать заново» (#361): the one admin route outside asStaff. Its Bot API calls cannot
  // run inside the transaction, and its row has to carry their result, so it checks the session
  // by the same predicate without the touch, publishes, and writes its row after.
  app.post('/admin/bot-texts/publish', async (request, reply) => {
    const token = tokenOf(request);
    const ctx =
      token === undefined ? undefined : await readLiveStaffContext(deps.db, { token, idleMs });
    if (ctx === undefined) {
      request.log.info('a staff session was refused');
      return reply.code(401).send({ error: AdminErrorCode.SessionInvalid });
    }
    const published = await publishAfterCommit(request, {
      staffId: ctx.staffId,
      path: '/admin/bot-texts/publish',
      trigger: 'republish',
      methods: BOT_PROFILE_METHODS,
    });
    return reply.send({ me: meOf(ctx), published } satisfies AdminBotProfilePublishResponse);
  });

  // --- Token adjustment (#246, docs/admin-pages.md → Корректировка токенов) ---------------------

  // 200 on every outcome, as the bot text save: web picks the status. No lockStaff — only the
  // caller's own session row is touched and `staff` is not written; adjustTokens then locks the
  // users row (Rule 5).
  app.post(
    '/admin/users/:id/tokens',
    { bodyLimit: ADMIN_BODY_LIMIT_BYTES },
    async (request, reply) => {
      // before the session: a body outside the schema costs no transaction and leaves no row
      const parsed = safeParseAdminTokenAdjustmentRequest(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: AdminErrorCode.Validation, issues: parsed.error.issues });
      }
      const { delta, note, expectedBalance } = parsed.data;
      const userId = (request.params as { id?: unknown }).id;
      const path = '/admin/users/:id/tokens';
      const answer = await asStaff(
        request,
        reply,
        async (tx, ctx): Promise<StaffActionResult<AdminTokenAdjustmentResponse | null>> => {
          const audit = (payload: Record<string, unknown>, entityId?: string) => ({
            action: AuditAction.TokenAdjusted,
            ...(entityId === undefined
              ? {}
              : { entity: { type: AuditEntityType.User, id: entityId } }),
            payload: { path, ...payload },
          });
          // an id that is not a uuid is arbitrary input, so it is not recorded (as user_viewed)
          if (typeof userId !== 'string' || !UUID_PATTERN.test(userId)) {
            return { result: null, audit: audit({ result: 'not_found' }) };
          }
          const applied = await adjustTokens(tx, {
            userId,
            delta: BigInt(delta),
            note,
            expectedBalance: BigInt(expectedBalance),
          });
          switch (applied.outcome) {
            case 'not_found':
              return { result: null, audit: audit({ result: 'not_found', userId }) };
            case 'adjusted': {
              const { entry, balanceBefore, balanceAfter, reserved } = applied;
              return {
                result: {
                  me: meOf(ctx),
                  outcome: 'adjusted',
                  entry: toAdminLedgerEntry(entry),
                  tokens: {
                    balance: balanceAfter.toString(),
                    reserved: reserved.toString(),
                    available: (balanceAfter - reserved).toString(),
                  },
                },
                // amounts as strings, never JSON numbers (Rule 2)
                audit: audit(
                  {
                    result: 'adjusted',
                    userId,
                    ledgerEntryId: entry.id,
                    delta,
                    note,
                    balanceBefore: balanceBefore.toString(),
                    balanceAfter: balanceAfter.toString(),
                    reserved: reserved.toString(),
                  },
                  userId,
                ),
              };
            }
            case 'insufficient_available':
            case 'balance_changed': {
              // the row is under this transaction's lock, so it is there
              const card = await readUserForAdmin(tx, userId);
              if (card === undefined) throw new Error('the adjusted user disappeared under lock');
              // the note is not recorded on a refusal: it was written nowhere
              return {
                result: { me: meOf(ctx), outcome: applied.outcome, ...toAdminUserCard(card) },
                audit: audit(
                  {
                    result: applied.outcome,
                    userId,
                    delta,
                    expectedBalance,
                    balance: applied.balance.toString(),
                    reserved: applied.reserved.toString(),
                  },
                  userId,
                ),
              };
            }
          }
        },
      );
      if (answer === undefined) return reply;
      if (answer === null) return reply.code(404).send({ error: AdminErrorCode.NotFound });
      return reply.send(answer);
    },
  );
};

// The user card's projection: the page's answer and a refused token adjustment's (#246).
function toAdminUserCard(card: AdminUserCard) {
  return {
    user: toAdminUserDetail(card.user),
    brokerAccounts: card.brokerAccounts.map(toAdminBrokerAccountView),
    intents: {
      recent: card.intents.recent.map(toAdminTradeIntentView),
      total: card.intents.total,
      active: card.intents.active,
    },
    ledger: { recent: card.ledger.map(toAdminLedgerEntry) },
    deposits: { recent: card.deposits.map(toAdminDepositView) },
  };
}

// a save's or a reset's answer as the transaction builds it: what it published is added after
type Unpublished<T> = T extends { published: unknown } ? Omit<T, 'published'> : T;

function toWirePublishResult(result: BotProfileMethodResult): AdminBotProfileMethodResult {
  if (result.ok) return { method: result.method, ok: true };
  const { telegramErrorCode } = result;
  return {
    method: result.method,
    ok: false,
    err: adminBotProfileIdentity(result.err),
    ...(result.cause === undefined ? {} : { cause: adminBotProfileIdentity(result.cause) }),
    // a code the wire refuses is left out, as an identity is held to it: the log has it
    ...(telegramErrorCode !== undefined && isAdminTelegramErrorCode(telegramErrorCode)
      ? { telegramErrorCode }
      : {}),
  };
}

// The allowlist that keeps a column added to staff_sessions from reaching the browser. The
// token hash, the owner's staff id and their Telegram id are not here, and the shape is the
// one packages/shared declares.
function toStaffSessionView(row: StaffSessionRow, currentSessionId: string): StaffSessionView {
  return {
    id: row.id,
    login: row.login,
    displayName: row.displayName,
    ip: row.ip,
    userAgent: row.userAgent,
    createdAt: row.createdAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    current: row.id === currentSessionId,
  };
}
