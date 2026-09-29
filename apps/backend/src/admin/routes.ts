import type { FastifyPluginAsync } from 'fastify';
import {
  AdminErrorCode,
  errorIdentity,
  errorLogFields,
  safeParseAdminConfirmRequest,
  safeParseAdminLoginRequest,
  STAFF_SESSION_TOKEN_PATTERN,
  type StaffSessionView,
} from '@binarius/shared';
import {
  AuditAction,
  AuditEntityType,
  completeLogin,
  DUMMY_PASSWORD_HASH,
  endStaffSession,
  failChallengeDelivery,
  findStaffForLogin,
  listLiveStaffSessions,
  markChallengePromptSent,
  recordLoginLockout,
  recordLoginRefusal,
  registerPasswordFailure,
  revokeStaffSession,
  runAsStaff,
  StaffLoginChallengeStatus,
  StaffStatus,
  startLoginChallenge,
  STAFF_SESSION_IDLE_MS,
  verifyPassword,
  type Db,
  type StaffSessionRow,
} from '@binarius/db';
import { internalBearerAuth } from '../auth/internal';
import { createKeyedWindow, createWindow } from '../auth/rate-window';
import { createPasswordQueue, PasswordQueueOverflow, type PasswordQueue } from './password-queue';
import { telegramErrorFields } from './telegram-logging';
import type { AdminTelegram } from './telegram';

// Ceilings on the two unauthenticated routes, taken before the body is read: they bound how
// much work an anonymous caller can ask this process for. Real staff logins are orders of
// magnitude rarer, so these only ever catch a flood.
const LOGIN_MAX_PER_MINUTE = 120;
const CONFIRM_MAX_PER_MINUTE = 300;
const ADMIN_BODY_LIMIT_BYTES = 4 * 1024;

// Per-login attempts at a name that has no live account. The lockout in `staff` covers a real
// account; this covers the rest, so guessing names costs the same as guessing passwords.
const UNKNOWN_LOGIN_MAX = 5;
const UNKNOWN_LOGIN_WINDOW_MS = 15 * 60_000;
// bounded on purpose: the keys come from request bodies
const UNKNOWN_LOGIN_MAX_KEYS = 10_000;

/** A UUID as PostgreSQL prints one; anything else is answered 404 rather than 400. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AdminRoutesDeps {
  db: Db;
  adminWebToken: string;
  telegram: AdminTelegram;
  // the seams the tests need; production takes every default
  passwordQueue?: PasswordQueue;
  verify?: (stored: string, password: string) => Promise<boolean>;
  loginMaxPerMinute?: number;
  confirmMaxPerMinute?: number;
  sessionIdleMs?: number;
}

export const ADMIN_ROUTE_PREFIX = '/admin';

export const adminRoutes: FastifyPluginAsync<AdminRoutesDeps> = async (app, deps) => {
  const queue = deps.passwordQueue ?? createPasswordQueue();
  const verify = deps.verify ?? verifyPassword;
  const idleMs = deps.sessionIdleMs ?? STAFF_SESSION_IDLE_MS;
  const loginCeiling = createWindow(deps.loginMaxPerMinute ?? LOGIN_MAX_PER_MINUTE);
  const confirmCeiling = createWindow(deps.confirmMaxPerMinute ?? CONFIRM_MAX_PER_MINUTE);
  const unknownLogins = createKeyedWindow(
    UNKNOWN_LOGIN_MAX,
    UNKNOWN_LOGIN_WINDOW_MS,
    UNKNOWN_LOGIN_MAX_KEYS,
  );

  // The narrow bearer covers the whole prefix. It is not the internal token: it opens /admin/*
  // and nothing else, and every route below it except the two login steps additionally needs a
  // staff session.
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

      if (staff.lockedUntil !== null && staff.lockedUntil.getTime() > Date.now()) {
        await recordLoginLockout(deps.db, { staffId: staff.id, ip, lockedUntil: staff.lockedUntil });
        return reply.code(429).send({ error: AdminErrorCode.TooManyAttempts });
      }

      const correct = await hash(staff.passwordHash, password);
      if (correct === 'refused') {
        return reply.code(429).send({ error: AdminErrorCode.TooManyAttempts });
      }
      if (!correct) {
        await registerPasswordFailure(deps.db, { staffId: staff.id, ip });
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

      if (started.sendPrompt) {
        const delivered = await deliverPrompt(started.challengeId, staff, { ip, userAgent });
        if (!delivered) {
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
  ): Promise<boolean> {
    const close = (reason: 'polling_down' | 'prompt_send_failed', error: unknown) =>
      failChallengeDelivery(deps.db, {
        challengeId,
        staffId: staff.id,
        from: StaffLoginChallengeStatus.Pending,
        reason,
        err: errorIdentity(error),
        telegram: { ...telegramErrorFields(error, 'sendMessage') },
      });

    if (!deps.telegram.isPolling()) {
      // fail closed: with polling down the button cannot arrive, so leaving the challenge open
      // would be five minutes of a staff member waiting for a message nobody will send
      app.log.error({ challengeId }, 'a staff login arrived while the bot was not polling');
      await close('polling_down', new Error('the staff login bot is not polling'));
      return false;
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
      await close('prompt_send_failed', error);
      return false;
    }
    await markChallengePromptSent(deps.db, challengeId);
    return true;
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
      if (completed.reason === 'wrong_code') {
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

  /** The session token, checked for shape before the database is asked anything. */
  const tokenOf = (request: { headers: Record<string, unknown> }): string | undefined => {
    const header = request.headers['x-staff-session'];
    if (typeof header !== 'string' || !STAFF_SESSION_TOKEN_PATTERN.test(header)) return undefined;
    return header;
  };

  app.get('/admin/sessions', async (request, reply) => {
    const token = tokenOf(request);
    if (token === undefined) {
      return reply.code(401).send({ error: AdminErrorCode.SessionInvalid });
    }
    const answer = await runAsStaff(
      deps.db,
      { token, idleMs, path: '/admin/sessions' },
      async (tx, ctx) => {
        const rows = await listLiveStaffSessions(tx, idleMs);
        return {
          result: {
            me: { staffId: ctx.staffId, login: ctx.login, sessionId: ctx.sessionId },
            sessions: rows.map((row) => toStaffSessionView(row, ctx.sessionId)),
          },
          audit: {
            action: AuditAction.StaffSessionsViewed,
            payload: { path: '/admin/sessions', sessionId: ctx.sessionId },
          },
        };
      },
    );
    if (answer === undefined) {
      request.log.info('a staff session was refused');
      return reply.code(401).send({ error: AdminErrorCode.SessionInvalid });
    }
    return reply.send(answer);
  });

  app.post('/admin/sessions/:id/revoke', async (request, reply) => {
    const token = tokenOf(request);
    if (token === undefined) {
      return reply.code(401).send({ error: AdminErrorCode.SessionInvalid });
    }
    const targetSessionId = (request.params as { id?: unknown }).id;
    // an id that is not a uuid is indistinguishable from one nobody was issued
    if (typeof targetSessionId !== 'string' || !UUID_PATTERN.test(targetSessionId)) {
      return reply.code(404).send({ error: AdminErrorCode.NotFound });
    }
    const answer = await runAsStaff(
      deps.db,
      { token, idleMs, path: '/admin/sessions/revoke' },
      async (tx, ctx) => {
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
    );
    if (answer === undefined) {
      return reply.code(401).send({ error: AdminErrorCode.SessionInvalid });
    }
    if (!answer.revoked) {
      return reply.code(404).send({ error: AdminErrorCode.NotFound });
    }
    return reply.send({ revoked: true, current: answer.current });
  });

  app.post('/admin/auth/logout', async (request, reply) => {
    const token = tokenOf(request);
    if (token === undefined) {
      return reply.code(401).send({ error: AdminErrorCode.SessionInvalid });
    }
    const answer = await runAsStaff(
      deps.db,
      { token, idleMs, path: '/admin/auth/logout' },
      async (tx, ctx) => {
        await endStaffSession(tx, ctx.sessionId);
        return {
          result: { loggedOut: true as const },
          audit: {
            action: AuditAction.StaffLogout,
            entity: { type: AuditEntityType.StaffSession, id: ctx.sessionId },
            payload: {},
          },
        };
      },
    );
    if (answer === undefined) {
      return reply.code(401).send({ error: AdminErrorCode.SessionInvalid });
    }
    return reply.send(answer);
  });
};

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
