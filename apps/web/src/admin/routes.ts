import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import * as z from 'zod';
import {
  AdminErrorCode,
  BOT_TEXT_KEY_PATTERN,
  botProfileMethodsOf,
  isBotTextKey,
  safeParseAdminBotTextResetRequest,
  safeParseAdminBotTextSaveRequest,
  UnexpectedBotTextOutcome,
  CLIENT_USER_AGENT_MAX_LENGTH,
  errorLogFields,
  safeParseAdminAuditQuery,
  safeParseAdminBrokerAccountsQuery,
  safeParseAdminChangePasswordRequest,
  safeParseAdminDepositsQuery,
  safeParseAdminIntentsQuery,
  safeParseAdminTokenAdjustmentRequest,
  safeParseAdminTokensQuery,
  safeParseAdminTradingSessionsQuery,
  safeParseAdminUsersQuery,
  STAFF_PASSWORD_MAX_LENGTH,
  STAFF_SESSION_TOKEN_PATTERN,
  staffLoginCodeSchema,
  TOKEN_ADJUSTMENT_MAX_TOKENS,
  TOKEN_LEDGER_NOTE_MAX,
  staffLoginSchema,
  UUID_PATTERN,
  type AdminBotProfileMethodResult,
  type AdminBotTextView,
  type AdminMe,
} from '@binarius/shared';
import { sendHtml } from '../html';
import { BackendError, BackendErrorCode, type BackendClient } from '../backend-client';
import { noticePage } from '../pages';
import {
  auditHref,
  BOT_TEXTS_PATH,
  botTextHref,
  botTextPage,
  botTextsHref,
  botTextsPage,
  type BotTextPageOptions,
  auditPage,
  brokerAccountsHref,
  brokerAccountsPage,
  confirmPage,
  depositsHref,
  depositsPage,
  intentPage,
  intentsHref,
  intentsPage,
  loginPage,
  overviewPage,
  PASSWORD_PATH,
  passwordHref,
  passwordPage,
  sessionsPage,
  tokensHref,
  tokensPage,
  tradingSessionsHref,
  tradingSessionsPage,
  userPage,
  usersHref,
  usersPage,
} from './pages';
import { decodePublishResults } from './publish-result';
import { APP_CSS } from './static';
import { TEXTS } from './texts';

export const SESSION_COOKIE = 'admin_session';
export const CHALLENGE_COOKIE = 'admin_login';
const SESSION_COOKIE_PATH = '/admin';
const CHALLENGE_COOKIE_PATH = '/admin/login';
const CSS_MAX_AGE_S = 3600;

// a remaining lifetime of zero or less is either a challenge that just expired by the backend's
// clock or two clocks that disagree; Max-Age=0 would delete the cookie and turn either into a
// silent bounce through a form that cannot work
class ExpiryInThePast extends Error {
  override readonly name = 'ExpiryInThePast';
}

export interface AdminWebDeps {
  backend: BackendClient;
  secureCookies: boolean;
}

const loginForm = z.object({
  login: staffLoginSchema,
  password: z.string().min(1).max(STAFF_PASSWORD_MAX_LENGTH),
});
const confirmForm = z.object({ code: staffLoginCodeSchema });
// Only the body's shape: a field sent twice arrives as an array. The bounds and "new differs from
// current" are the shared schema's, checked next, so web holds no second copy of them.
const passwordForm = z.object({
  currentPassword: z.string(),
  newPassword: z.string(),
  newPasswordRepeat: z.string(),
});

// The shared schema's refine runs even when a field failed, so "same as the current one" is
// told only when it is the one issue — two equal passwords that are also too long are a bad
// request, not a match.
const sameAsCurrentOnly = (issues: readonly { code: string; path: readonly PropertyKey[] }[]) =>
  issues.length === 1 && issues[0]?.code === 'custom' && issues[0].path[0] === 'newPassword';

/**
 * `?changed=` as an integer in exactly the domain of the response's `z.int().nonnegative()`,
 * [0, 2^53 − 1]; a repeated key arrives as an array and is no value.
 */
const changedOf = (query: unknown): number | undefined => {
  const value = (query as { changed?: unknown } | undefined)?.changed;
  return typeof value === 'string' &&
    /^\d{1,16}$/.test(value) &&
    Number.isSafeInteger(Number(value))
    ? Number(value)
    : undefined;
};

// A publish notice reads «…Публикация в Telegram:» over the result it names; without a result
// that decodes it falls back to the plain notice, and «Опубликовано заново:» has none (#361).
const PUBLISH_NOTICE_FALLBACK: Record<string, string | undefined> = {
  published: 'saved',
  reset_published: 'reset',
  republished: undefined,
};

/** `?notice=` with the `?publish=` result it carries; a result only under a publish notice. */
const noticeWithResult = <K extends string>(
  query: unknown,
  notices: Record<K, string>,
): { notice?: K; published?: AdminBotProfileMethodResult[] } => {
  const notice = noticeOf(query, notices);
  if (notice === undefined || !Object.hasOwn(PUBLISH_NOTICE_FALLBACK, notice)) return { notice };
  const published = decodePublishResults((query as { publish?: unknown } | undefined)?.publish);
  return published === undefined
    ? { notice: PUBLISH_NOTICE_FALLBACK[notice] as K | undefined }
    : { notice, published };
};

/** `?notice=` as one of the page's own notices; anything else, a repeated key included, is none. */
const noticeOf = <K extends string>(query: unknown, notices: Record<K, string>): K | undefined => {
  const value = (query as { notice?: unknown } | undefined)?.notice;
  return typeof value === 'string' && Object.hasOwn(notices, value) ? (value as K) : undefined;
};

// Only the body's shape (a field sent twice arrives as an array), then the shared schema. The
// browser sends a textarea with CRLF line breaks; one trailing line feed goes, as the CLI drops it
// from a file (docs/bot-texts.md → The CLI).
const VERSION_FIELD = z.string().regex(/^\d{1,16}$/);
const botTextForm = z.object({ source: z.string(), version: VERSION_FIELD });
const resetForm = z.object({ version: VERSION_FIELD });

const botTextFormOf = (body: unknown) => {
  const form = botTextForm.safeParse(body);
  if (!form.success) return undefined;
  const parsed = safeParseAdminBotTextSaveRequest({
    source: form.data.source.replace(/\r\n/g, '\n').replace(/\n$/, ''),
    expectedVersion: Number(form.data.version),
  });
  return parsed.success ? parsed.data : undefined;
};

const resetFormOf = (body: unknown) => {
  const form = resetForm.safeParse(body);
  if (!form.success) return undefined;
  const parsed = safeParseAdminBotTextResetRequest({ expectedVersion: Number(form.data.version) });
  return parsed.success ? parsed.data : undefined;
};

// Only the body's shape (a field sent twice arrives as an array), then the shared schema: the
// limit and the note's bounds live there, so web holds no second copy of them.
const adjustForm = z.object({
  direction: z.enum(['credit', 'debit']),
  amount: z.string().regex(/^[1-9]\d{0,18}$/),
  note: z.string(),
  balance: z.string().regex(/^\d{1,19}$/),
});

/**
 * A query string before its schema: a key whose value is the empty string is no key — an
 * emptied search box submits `q=`, and that is a request for the whole list, not a refusal.
 * Shared by every list page.
 */
export const compactQuery = (query: unknown): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries((query ?? {}) as Record<string, unknown>).filter(([, value]) => value !== ''),
  );

/** What the backend records as the client's own facts; it trusts this process for them. */
const clientFacts = (request: FastifyRequest) => ({
  ip: request.ip,
  // truncated to the bound the backend's schema enforces — the same constant — so a long
  // header is not a failed login
  userAgent: (request.headers['user-agent'] ?? '').slice(0, CLIENT_USER_AGENT_MAX_LENGTH),
});

export const adminRoutes: FastifyPluginAsync<AdminWebDeps> = async (app, { backend, secureCookies }) => {
  const cookieOptions = (path: string, maxAgeSeconds?: number) => ({
    httpOnly: true,
    secure: secureCookies,
    sameSite: 'lax' as const,
    path,
    ...(maxAgeSeconds === undefined ? {} : { maxAge: maxAgeSeconds }),
  });

  // The only source of a cookie's lifetime is the expiry the backend reported for the thing
  // the cookie carries: a hardcoded duration would outlive a revoked session in the browser.
  const secondsUntil = (isoExpiry: string): number | undefined => {
    const seconds = Math.floor((Date.parse(isoExpiry) - Date.now()) / 1000);
    return seconds > 0 ? seconds : undefined;
  };

  const clearSession = (reply: FastifyReply): FastifyReply =>
    reply.clearCookie(SESSION_COOKIE, cookieOptions(SESSION_COOKIE_PATH));
  const clearChallenge = (reply: FastifyReply): FastifyReply =>
    reply.clearCookie(CHALLENGE_COOKIE, cookieOptions(CHALLENGE_COOKIE_PATH));

  /**
   * A cookie of the wrong shape counts as no cookie. Forwarded as-is it would reach undici as
   * a header value it can refuse, and every /admin/* page would then be an opaque 500 that
   * never clears the thing causing it — the one loop a staff member cannot get out of.
   */
  const cookieMatching = (
    request: FastifyRequest,
    name: string,
    pattern: RegExp,
  ): string | undefined => {
    const value = request.cookies[name];
    return value !== undefined && pattern.test(value) ? value : undefined;
  };

  // A backend answer this process cannot act on is a misconfiguration of ours, not something
  // the staff member did: a rejected bearer, a body the contract forbids, an unreachable
  // backend. It is logged by identity and answered with an opaque 500, and no cookie is
  // touched — the session on the server is untouched too, so dropping it here would log
  // someone out over our own bug. The one exception is the confirm step's `400 validation`,
  // whose input is the challenge cookie itself (#152).
  const internalFailure = (request: FastifyRequest, reply: FastifyReply, error: unknown): FastifyReply => {
    request.log.error(errorLogFields(error), 'the admin backend call could not be used');
    return sendHtml(reply, 500, noticePage(TEXTS.errorTitle, TEXTS.errorBody));
  };

  /** The (status, code) pair, or undefined when the failure was not an answered request. */
  const outcome = (error: unknown): { status: number; code?: string } | undefined =>
    error instanceof BackendError && error.code === BackendErrorCode.HttpStatus
      ? { status: error.status ?? 0, ...(error.reason === undefined ? {} : { code: error.reason }) }
      : undefined;

  /**
   * Every page behind a staff session: a cookie of the wrong shape is no session, before the
   * backend is asked anything. A failure `fn` throws is answered here — a session the backend
   * calls gone clears the cookie and goes to login, anything else is our own failure. A route
   * handles its own outcomes inside `fn` and rethrows the rest.
   */
  const withStaffSession = async (
    request: FastifyRequest,
    reply: FastifyReply,
    fn: (token: string) => Promise<FastifyReply>,
  ): Promise<FastifyReply> => {
    const token = cookieMatching(request, SESSION_COOKIE, STAFF_SESSION_TOKEN_PATTERN);
    if (token === undefined) return clearSession(reply).redirect('/admin/login', 302);
    try {
      return await fn(token);
    } catch (error) {
      if (isSessionGone(error)) return clearSession(reply).redirect('/admin/login', 302);
      return internalFailure(request, reply, error);
    }
  };

  app.get('/admin', async (_request, reply) => reply.redirect('/admin/overview', 302));

  app.get('/admin/overview', async (request, reply) =>
    withStaffSession(request, reply, async (token) => {
      const { me, overview } = await backend.overview(token);
      return sendHtml(reply, 200, overviewPage(overview, me.login));
    }),
  );

  app.get('/admin/users', async (request, reply) =>
    withStaffSession(request, reply, async (token) => {
      const query = compactQuery(request.query);
      // the filter first, without the cursor: a refused search is a 400 whatever the cursor
      // says, rather than a redirect that would carry the refused value along
      const filters = safeParseAdminUsersQuery({ ...query, cursor: undefined });
      if (!filters.success) {
        return sendHtml(reply, 400, usersPage([], { nextCursor: null, message: TEXTS.badSearch }));
      }
      const { q } = filters.data;
      const cursor = query.cursor;
      if (cursor !== undefined && (typeof cursor !== 'string' || !UUID_PATTERN.test(cursor))) {
        // like a cookie of the wrong shape: dropped, and the search goes on without it
        return reply.redirect(usersHref({ q }), 302);
      }
      const { me, users, nextCursor } = await backend.users(token, { q, cursor });
      return sendHtml(reply, 200, usersPage(users, { q, cursor, nextCursor, login: me.login }));
    }),
  );

  app.get('/admin/users/:id', async (request, reply) =>
    withStaffSession(request, reply, async (token) => {
      const { id } = request.params as { id: string };
      // a shape it cannot be is refused here, before the backend is asked (see revoke below)
      if (!UUID_PATTERN.test(id)) {
        return sendHtml(reply, 404, noticePage(TEXTS.userNotFoundTitle, TEXTS.userNotFoundBody));
      }
      try {
        const { me, ...card } = await backend.user(token, id);
        const notice = noticeOf(request.query, TEXTS.userNotice);
        return sendHtml(reply, 200, userPage(card, me.login, { notice }));
      } catch (error) {
        const answered = outcome(error);
        if (answered?.status === 404 && answered.code === AdminErrorCode.NotFound) {
          return sendHtml(reply, 404, noticePage(TEXTS.userNotFoundTitle, TEXTS.userNotFoundBody));
        }
        throw error;
      }
    }),
  );

  app.get('/admin/intents', async (request, reply) =>
    withStaffSession(request, reply, async (token) => {
      const query = compactQuery(request.query);
      // the filters first, without the cursor, as on the users list: refused filters are a 400
      // whatever the cursor says, and the redirect below carries only parsed values
      const parsed = safeParseAdminIntentsQuery({ ...query, cursor: undefined });
      if (!parsed.success) {
        return sendHtml(
          reply,
          400,
          intentsPage([], { filters: {}, nextCursor: null, message: TEXTS.badFilter }),
        );
      }
      const filters = parsed.data;
      const cursor = query.cursor;
      if (cursor !== undefined && (typeof cursor !== 'string' || !UUID_PATTERN.test(cursor))) {
        return reply.redirect(intentsHref(filters), 302);
      }
      const { me, intents, nextCursor } = await backend.intents(token, { ...filters, cursor });
      return sendHtml(
        reply,
        200,
        intentsPage(intents, { filters, cursor, nextCursor, login: me.login }),
      );
    }),
  );

  app.get('/admin/trading-sessions', async (request, reply) =>
    withStaffSession(request, reply, async (token) => {
      // no filters, so nothing to refuse with a 400: a cursor of the wrong shape (or twice) is
      // dropped, as on the other lists
      const parsed = safeParseAdminTradingSessionsQuery(compactQuery(request.query));
      if (!parsed.success) return reply.redirect(tradingSessionsHref({}), 302);
      const { cursor } = parsed.data;
      const { me, sessions, nextCursor } = await backend.tradingSessions(token, { cursor });
      return sendHtml(
        reply,
        200,
        tradingSessionsPage(sessions, { cursor, nextCursor, login: me.login }),
      );
    }),
  );

  app.get('/admin/tokens', async (request, reply) =>
    withStaffSession(request, reply, async (token) => {
      const query = compactQuery(request.query);
      // the filters first, without the cursor, as on the intents list
      const parsed = safeParseAdminTokensQuery({ ...query, cursor: undefined });
      if (!parsed.success) {
        return sendHtml(
          reply,
          400,
          tokensPage([], { filters: {}, nextCursor: null, message: TEXTS.tokensBadFilter }),
        );
      }
      const filters = parsed.data;
      const cursor = query.cursor;
      if (cursor !== undefined && (typeof cursor !== 'string' || !UUID_PATTERN.test(cursor))) {
        return reply.redirect(tokensHref(filters), 302);
      }
      const { me, entries, nextCursor } = await backend.tokens(token, { ...filters, cursor });
      return sendHtml(
        reply,
        200,
        tokensPage(entries, { filters, cursor, nextCursor, login: me.login }),
      );
    }),
  );

  app.get('/admin/audit', async (request, reply) =>
    withStaffSession(request, reply, async (token) => {
      const query = compactQuery(request.query);
      // the filters first, without the cursor, as on the token ledger
      const parsed = safeParseAdminAuditQuery({ ...query, cursor: undefined });
      if (!parsed.success) {
        return sendHtml(
          reply,
          400,
          auditPage([], { filters: {}, nextCursor: null, message: TEXTS.auditBadFilter }),
        );
      }
      const filters = parsed.data;
      const cursor = query.cursor;
      if (cursor !== undefined && (typeof cursor !== 'string' || !UUID_PATTERN.test(cursor))) {
        return reply.redirect(auditHref(filters), 302);
      }
      const { me, entries, nextCursor } = await backend.audit(token, { ...filters, cursor });
      return sendHtml(
        reply,
        200,
        auditPage(entries, { filters, cursor, nextCursor, login: me.login }),
      );
    }),
  );

  app.get('/admin/deposits', async (request, reply) =>
    withStaffSession(request, reply, async (token) => {
      const query = compactQuery(request.query);
      // the filters first, without the cursor, as on the token ledger
      const parsed = safeParseAdminDepositsQuery({ ...query, cursor: undefined });
      if (!parsed.success) {
        return sendHtml(
          reply,
          400,
          depositsPage([], { filters: {}, nextCursor: null, message: TEXTS.depositsBadFilter }),
        );
      }
      const filters = parsed.data;
      const cursor = query.cursor;
      if (cursor !== undefined && (typeof cursor !== 'string' || !UUID_PATTERN.test(cursor))) {
        return reply.redirect(depositsHref(filters), 302);
      }
      const { me, deposits, nextCursor } = await backend.deposits(token, { ...filters, cursor });
      return sendHtml(
        reply,
        200,
        depositsPage(deposits, { filters, cursor, nextCursor, login: me.login }),
      );
    }),
  );

  app.get('/admin/broker-accounts', async (request, reply) =>
    withStaffSession(request, reply, async (token) => {
      // a blank `status=` or `halted=` is dropped here: no filter, as on the other lists
      const query = compactQuery(request.query);
      // the filters first, without the cursor, as on the token ledger
      const parsed = safeParseAdminBrokerAccountsQuery({ ...query, cursor: undefined });
      if (!parsed.success) {
        return sendHtml(
          reply,
          400,
          brokerAccountsPage([], {
            filters: {},
            nextCursor: null,
            message: TEXTS.brokerAccountsBadFilter,
          }),
        );
      }
      const filters = parsed.data;
      const cursor = query.cursor;
      if (cursor !== undefined && (typeof cursor !== 'string' || !UUID_PATTERN.test(cursor))) {
        return reply.redirect(brokerAccountsHref(filters), 302);
      }
      const { me, accounts, nextCursor } = await backend.brokerAccounts(token, {
        ...filters,
        cursor,
      });
      return sendHtml(
        reply,
        200,
        brokerAccountsPage(accounts, { filters, cursor, nextCursor, login: me.login }),
      );
    }),
  );

  app.get('/admin/intents/:id', async (request, reply) =>
    withStaffSession(request, reply, async (token) => {
      const { id } = request.params as { id: string };
      // a shape it cannot be is refused here, before the backend is asked (see revoke below)
      if (!UUID_PATTERN.test(id)) {
        return sendHtml(
          reply,
          404,
          noticePage(TEXTS.intentNotFoundTitle, TEXTS.intentNotFoundBody),
        );
      }
      try {
        const { me, intent } = await backend.intent(token, id);
        return sendHtml(reply, 200, intentPage(intent, me.login));
      } catch (error) {
        const answered = outcome(error);
        if (answered?.status === 404 && answered.code === AdminErrorCode.NotFound) {
          return sendHtml(
            reply,
            404,
            noticePage(TEXTS.intentNotFoundTitle, TEXTS.intentNotFoundBody),
          );
        }
        throw error;
      }
    }),
  );

  app.get('/admin/login', async (request, reply) => {
    const expired = (request.query as { reason?: unknown }).reason === 'expired';
    return sendHtml(reply, 200, loginPage(expired ? TEXTS.expiredChallenge : undefined));
  });

  app.post('/admin/login', async (request, reply) => {
    const form = loginForm.safeParse(request.body);
    if (!form.success) return sendHtml(reply, 400, loginPage(TEXTS.badRequest));

    try {
      const started = await backend.login({ ...form.data, ...clientFacts(request) });
      const lifetime = secondsUntil(started.expiresAt);
      if (lifetime === undefined) return internalFailure(request, reply, new ExpiryInThePast());
      return reply
        .setCookie(
          CHALLENGE_COOKIE,
          started.challengeId,
          cookieOptions(CHALLENGE_COOKIE_PATH, lifetime),
        )
        .redirect('/admin/login/confirm', 303);
    } catch (error) {
      const answered = outcome(error);
      // branched on the pair, not the status: 401 unauthorized is our bearer being refused,
      // which is nothing like 401 invalid_credentials
      if (answered?.status === 401 && answered.code === AdminErrorCode.InvalidCredentials) {
        return sendHtml(reply, 401, loginPage(TEXTS.invalidCredentials));
      }
      if (answered?.status === 429) return sendHtml(reply, 429, loginPage(TEXTS.tooManyAttempts));
      if (answered?.status === 503) {
        return sendHtml(reply, 503, loginPage(TEXTS.telegramUnavailable));
      }
      return internalFailure(request, reply, error);
    }
  });

  app.get('/admin/login/confirm', async (request, reply) => {
    if (cookieMatching(request, CHALLENGE_COOKIE, UUID_PATTERN) === undefined) {
      return clearChallenge(reply).redirect('/admin/login', 302);
    }
    return sendHtml(reply, 200, confirmPage());
  });

  app.post('/admin/login/confirm', async (request, reply) => {
    const challengeId = cookieMatching(request, CHALLENGE_COOKIE, UUID_PATTERN);
    if (challengeId === undefined) return clearChallenge(reply).redirect('/admin/login', 302);
    const form = confirmForm.safeParse(request.body);
    if (!form.success) return sendHtml(reply, 400, confirmPage(TEXTS.invalidCode));

    try {
      const session = await backend.confirm({
        challengeId,
        code: form.data.code,
        ...clientFacts(request),
      });
      const lifetime = secondsUntil(session.expiresAt);
      if (lifetime === undefined) return internalFailure(request, reply, new ExpiryInThePast());
      return clearChallenge(reply)
        .setCookie(
          SESSION_COOKIE,
          session.sessionToken,
          cookieOptions(SESSION_COOKIE_PATH, lifetime),
        )
        .redirect('/admin/sessions', 303);
    } catch (error) {
      const answered = outcome(error);
      if (answered?.status === 401 && answered.code === AdminErrorCode.InvalidCode) {
        return sendHtml(reply, 401, confirmPage(TEXTS.invalidCode));
      }
      if (answered?.status === 409) return sendHtml(reply, 409, confirmPage(TEXTS.awaitingTelegram));
      if (answered?.status === 410) {
        // this attempt is over: the cookie points at nothing, and keeping it would loop the
        // staff member through a form that can only fail
        return clearChallenge(reply).redirect('/admin/login?reason=expired', 303);
      }
      if (answered?.status === 400 && answered.code === AdminErrorCode.Validation) {
        // the backend refused our own body: the two processes disagree on its shape (#152). The
        // challenge cookie is the one input that comes back unchanged on every retry, so keeping
        // it would loop the staff member through a form that can only fail
        request.log.error(
          { ...errorLogFields(error), status: 400, reason: AdminErrorCode.Validation },
          'the backend refused the forwarded confirm as malformed',
        );
        return clearChallenge(reply).redirect('/admin/login?reason=expired', 303);
      }
      if (answered?.status === 429) {
        return sendHtml(reply, 429, confirmPage(TEXTS.tooManyCodeAttempts));
      }
      return internalFailure(request, reply, error);
    }
  });

  app.get('/admin/sessions', async (request, reply) =>
    withStaffSession(request, reply, async (token) => {
      const { me, sessions } = await backend.sessions(token);
      return sendHtml(reply, 200, sessionsPage(sessions, me.login));
    }),
  );

  app.get(PASSWORD_PATH, async (request, reply) =>
    withStaffSession(request, reply, async (token) => {
      const { me, sessions } = await backend.sessions(token);
      // the list holds every staff member's sessions; the change revokes only the caller's
      const others = sessions.filter((s) => s.login === me.login && !s.current).length;
      return sendHtml(
        reply,
        200,
        passwordPage({ login: me.login, others, changed: changedOf(request.query) }),
      );
    }),
  );

  // One backend call, like every other request of this process (timing.ts): a refusal is
  // rendered without the sessions read, so with no account block and no count.
  app.post(PASSWORD_PATH, async (request, reply) =>
    withStaffSession(request, reply, async (token) => {
      const form = passwordForm.safeParse(request.body);
      if (!form.success) return sendHtml(reply, 400, passwordPage({ message: TEXTS.badRequest }));
      const { currentPassword, newPassword, newPasswordRepeat } = form.data;
      if (newPassword !== newPasswordRepeat) {
        return sendHtml(reply, 400, passwordPage({ message: TEXTS.passwordMismatch }));
      }
      const body = safeParseAdminChangePasswordRequest({
        currentPassword,
        newPassword,
        ...clientFacts(request),
      });
      if (!body.success) {
        const message = sameAsCurrentOnly(body.error.issues)
          ? TEXTS.passwordSameAsCurrent
          : TEXTS.badRequest;
        return sendHtml(reply, 400, passwordPage({ message }));
      }
      try {
        const { revokedSessions } = await backend.changePassword(token, body.data);
        return reply.redirect(passwordHref(revokedSessions), 303);
      } catch (error) {
        const answered = outcome(error);
        // not answered (unreachable, a 2xx outside the contract, a throw) or a 5xx: the commit
        // may have happened, so the staff member learns the state by logging in, not by retrying
        if (answered === undefined || answered.status >= 500) {
          request.log.error(errorLogFields(error), 'the password change outcome is unknown');
          return sendHtml(
            reply,
            500,
            noticePage(TEXTS.outcomeUnknownTitle, TEXTS.outcomeUnknownBody),
          );
        }
        if (answered.status === 401 && answered.code === AdminErrorCode.InvalidCredentials) {
          return sendHtml(reply, 401, passwordPage({ message: TEXTS.invalidCurrentPassword }));
        }
        // on the pair, unlike the login form: this route has no ceiling, so a 429 without the
        // code is a contract drift, not a lockout
        if (answered.status === 429 && answered.code === AdminErrorCode.TooManyAttempts) {
          return sendHtml(reply, 429, passwordPage({ message: TEXTS.tooManyAttempts }));
        }
        // session_invalid clears the cookie in withStaffSession; anything else is our failure
        throw error;
      }
    }),
  );

  app.post('/admin/sessions/:id/revoke', async (request, reply) => {
    const token = cookieMatching(request, SESSION_COOKIE, STAFF_SESSION_TOKEN_PATTERN);
    if (token === undefined) return clearSession(reply).redirect('/admin/login', 302);
    const { id } = request.params as { id: string };
    // find-my-way hands `..` through as a param and encodeURIComponent leaves it alone, so the
    // client's URL join would leave /admin/sessions/ — the backend would answer for a route the
    // staff member never named, and write no row. A shape it cannot be is refused here, like a
    // cookie of the wrong shape: before the backend is asked, with no row.
    if (!UUID_PATTERN.test(id)) return reply.redirect('/admin/sessions', 303);
    try {
      const { current } = await backend.revoke(token, id);
      if (current) return clearSession(reply).redirect('/admin/login', 303);
      return reply.redirect('/admin/sessions', 303);
    } catch (error) {
      if (isSessionGone(error)) return clearSession(reply).redirect('/admin/login', 302);
      // a session that was already gone is not an error worth a page: the list is the answer
      if (outcome(error)?.status === 404) return reply.redirect('/admin/sessions', 303);
      return internalFailure(request, reply, error);
    }
  });

  app.post('/admin/logout', async (request, reply) => {
    const token = cookieMatching(request, SESSION_COOKIE, STAFF_SESSION_TOKEN_PATTERN);
    if (token === undefined) return clearSession(reply).redirect('/admin/login', 303);
    try {
      await backend.logout(token);
      return clearSession(reply).redirect('/admin/login', 303);
    } catch (error) {
      // a session the backend says is already gone is a successful logout
      if (isSessionGone(error)) return clearSession(reply).redirect('/admin/login', 303);
      // anything else leaves the cookie alone: the session is still live on the server, and
      // clearing it here would make the logout look done when it was not recorded
      return internalFailure(request, reply, error);
    }
  });

  // --- Bot texts (#300, docs/admin-pages.md → Bot texts) ----------------------------------------

  const textNotFound = (reply: FastifyReply) =>
    sendHtml(reply, 404, noticePage(TEXTS.botTextNotFoundTitle, TEXTS.botTextNotFoundBody));
  const textBadRequest = (reply: FastifyReply) =>
    sendHtml(reply, 400, noticePage(TEXTS.botTextsTitle, TEXTS.badRequest));
  const keyParamOf = (request: FastifyRequest): string => (request.params as { key: string }).key;
  const isNotFound = (error: unknown) => {
    const answered = outcome(error);
    return answered?.status === 404 && answered.code === AdminErrorCode.NotFound;
  };
  // Not answered or a 5xx: the write may have happened; the editor shows the version and the
  // text. A key whose write publishes may also have been published, or not (#361).
  const writeOutcomeUnknown = (
    request: FastifyRequest,
    reply: FastifyReply,
    error: unknown,
    key?: string,
  ) => {
    const answered = outcome(error);
    if (answered !== undefined && answered.status < 500) return undefined;
    request.log.error(errorLogFields(error), 'the bot text write outcome is unknown');
    const body =
      key !== undefined && isBotTextKey(key) && botProfileMethodsOf(key).length > 0
        ? TEXTS.botProfileWriteOutcomeUnknown
        : TEXTS.botTextOutcomeUnknown;
    return sendHtml(reply, 500, noticePage(TEXTS.outcomeUnknownTitle, body));
  };
  // «Опубликовать заново» (#361): not answered or a 5xx may have published; pressing it again is
  // harmless, it sends the texts in effect
  const publishBotProfile = async (
    request: FastifyRequest,
    reply: FastifyReply,
    token: string,
    href: (published: AdminBotProfileMethodResult[]) => string,
  ) => {
    let answer;
    try {
      answer = await backend.publishBotProfile(token);
    } catch (error) {
      const answered = outcome(error);
      if (answered !== undefined && answered.status < 500) throw error;
      request.log.error(errorLogFields(error), 'the bot profile publish outcome is unknown');
      return sendHtml(
        reply,
        500,
        noticePage(TEXTS.outcomeUnknownTitle, TEXTS.botProfileOutcomeUnknown),
      );
    }
    return reply.redirect(href(answer.published), 303);
  };
  // The editor after a POST: the draft and the version from the form, the rest from the answer.
  const editorAfterPost = (
    reply: FastifyReply,
    answer: { me: AdminMe; text: AdminBotTextView },
    form: { source?: string; expectedVersion: number },
    status: number,
    options: BotTextPageOptions,
  ) =>
    sendHtml(
      reply,
      status,
      botTextPage(answer.text, {
        login: answer.me.login,
        draft: form.source,
        version: form.expectedVersion,
        ...options,
      }),
    );

  app.get(BOT_TEXTS_PATH, async (request, reply) =>
    withStaffSession(request, reply, async (token) => {
      const { me, overrides } = await backend.botTexts(token);
      const { notice, published } = noticeWithResult(request.query, TEXTS.botTextsNotice);
      return sendHtml(reply, 200, botTextsPage(overrides, { login: me.login, notice, published }));
    }),
  );

  app.post(`${BOT_TEXTS_PATH}/publish`, async (request, reply) =>
    withStaffSession(request, reply, async (token) =>
      publishBotProfile(request, reply, token, (published) =>
        botTextsHref('republished', published),
      ),
    ),
  );

  app.get(`${BOT_TEXTS_PATH}/:key`, async (request, reply) =>
    withStaffSession(request, reply, async (token) => {
      const key = keyParamOf(request);
      if (!isBotTextKey(key)) return textNotFound(reply);
      try {
        const { me, text } = await backend.botText(token, key);
        const { notice, published } = noticeWithResult(request.query, TEXTS.botTextNotice);
        return sendHtml(reply, 200, botTextPage(text, { login: me.login, notice, published }));
      } catch (error) {
        // the backend's catalog lacks a key web's has: the two were deployed apart
        if (isNotFound(error)) return textNotFound(reply);
        throw error;
      }
    }),
  );

  app.post(`${BOT_TEXTS_PATH}/:key/preview`, async (request, reply) =>
    withStaffSession(request, reply, async (token) => {
      const key = keyParamOf(request);
      if (!isBotTextKey(key)) return textNotFound(reply);
      const form = botTextFormOf(request.body);
      if (form === undefined) return textBadRequest(reply);
      let answer;
      try {
        answer = await backend.previewBotText(token, key, { source: form.source });
      } catch (error) {
        if (isNotFound(error)) return textNotFound(reply);
        throw error;
      }
      switch (answer.outcome) {
        case 'rendered':
          return editorAfterPost(reply, answer, form, 200, { rendered: answer.rendered });
        case 'refused':
          return editorAfterPost(reply, answer, form, 400, { problems: answer.problems });
      }
    }),
  );

  app.post(`${BOT_TEXTS_PATH}/:key/save`, async (request, reply) =>
    withStaffSession(request, reply, async (token) => {
      const key = keyParamOf(request);
      if (!isBotTextKey(key)) return textNotFound(reply);
      const form = botTextFormOf(request.body);
      if (form === undefined) return textBadRequest(reply);
      let answer;
      try {
        answer = await backend.saveBotText(token, key, form);
      } catch (error) {
        if (isNotFound(error)) return textNotFound(reply);
        const unknown = writeOutcomeUnknown(request, reply, error, key);
        if (unknown !== undefined) return unknown;
        throw error;
      }
      switch (answer.outcome) {
        case 'saved':
          return reply.redirect(
            answer.published.length > 0
              ? botTextHref(key, 'published', answer.published)
              : botTextHref(key, 'saved'),
            303,
          );
        case 'unchanged':
          return editorAfterPost(reply, answer, form, 200, { notice: 'unchanged' });
        case 'version_conflict':
          return editorAfterPost(reply, answer, form, 409, {
            conflict: {
              currentVersion: answer.currentVersion,
              currentSource: answer.currentSource,
            },
          });
        case 'refused':
          return editorAfterPost(reply, answer, form, 400, { problems: answer.problems });
      }
    }),
  );

  // a key outside the catalog is a row left behind by a renamed key: «Удалить» on the list
  app.post(`${BOT_TEXTS_PATH}/:key/reset`, async (request, reply) =>
    withStaffSession(request, reply, async (token) => {
      const key = keyParamOf(request);
      if (!BOT_TEXT_KEY_PATTERN.test(key)) return textNotFound(reply);
      const form = resetFormOf(request.body);
      if (form === undefined) return textBadRequest(reply);
      let answer;
      try {
        answer = await backend.resetBotText(token, key, form);
      } catch (error) {
        const unknown = writeOutcomeUnknown(request, reply, error, key);
        if (unknown !== undefined) return unknown;
        throw error;
      }
      if (!isBotTextKey(key)) {
        switch (answer.outcome) {
          case 'reset':
            return reply.redirect(botTextsHref('removed'), 303);
          case 'already_default':
            return reply.redirect(botTextsHref('gone'), 303);
          case 'version_conflict':
            return reply.redirect(botTextsHref('changed'), 303);
          // a key outside the catalog takes no effect and is in no group
          case 'refused':
            throw new UnexpectedBotTextOutcome();
        }
      }
      const { text } = answer;
      if (text === null) throw new UnexpectedBotTextOutcome();
      const editor = { me: answer.me, text };
      switch (answer.outcome) {
        case 'reset':
          return reply.redirect(
            answer.published.length > 0
              ? botTextHref(key, 'reset_published', answer.published)
              : botTextHref(key, 'reset'),
            303,
          );
        case 'already_default':
          return reply.redirect(botTextHref(key, 'already_default'), 303);
        case 'version_conflict':
          return editorAfterPost(reply, editor, form, 409, {
            conflict: {
              currentVersion: answer.currentVersion,
              currentSource: answer.currentSource,
            },
          });
        case 'refused':
          return editorAfterPost(reply, editor, form, 400, { problems: answer.problems });
      }
    }),
  );

  // only on the editor of a key whose write publishes; the backend publishes all three
  app.post(`${BOT_TEXTS_PATH}/:key/publish`, async (request, reply) =>
    withStaffSession(request, reply, async (token) => {
      const key = keyParamOf(request);
      if (!isBotTextKey(key) || botProfileMethodsOf(key).length === 0) return textNotFound(reply);
      return publishBotProfile(request, reply, token, (published) =>
        botTextHref(key, 'republished', published),
      );
    }),
  );

  // --- Token adjustment (#246, docs/admin-pages.md → Корректировка токенов) ---------------------

  const userNotFound = (reply: FastifyReply) =>
    sendHtml(reply, 404, noticePage(TEXTS.userNotFoundTitle, TEXTS.userNotFoundBody));

  app.post('/admin/users/:id/tokens', async (request, reply) =>
    withStaffSession(request, reply, async (token) => {
      const { id } = request.params as { id: string };
      // a shape it cannot be is refused here, before the backend is asked (see revoke above)
      if (!UUID_PATTERN.test(id)) return userNotFound(reply);
      const form = adjustForm.safeParse(request.body);
      const parsed = form.success
        ? safeParseAdminTokenAdjustmentRequest({
            delta: form.data.direction === 'debit' ? `-${form.data.amount}` : form.data.amount,
            note: form.data.note,
            expectedBalance: form.data.balance,
          })
        : undefined;
      if (!form.success || parsed?.success !== true) {
        return sendHtml(
          reply,
          400,
          noticePage(
            TEXTS.userTitle,
            TEXTS.tokenAdjustBadForm(TOKEN_ADJUSTMENT_MAX_TOKENS, TOKEN_LEDGER_NOTE_MAX),
          ),
        );
      }
      let answer;
      try {
        answer = await backend.adjustTokens(token, id, parsed.data);
      } catch (error) {
        if (isNotFound(error)) return userNotFound(reply);
        const answered = outcome(error);
        // not answered (unreachable, a 2xx outside the contract) or a 5xx: the commit may have
        // happened, so the staff member reads the card rather than sending the form again
        if (answered === undefined || answered.status >= 500) {
          request.log.error(errorLogFields(error), 'the token adjustment outcome is unknown');
          return sendHtml(
            reply,
            500,
            noticePage(TEXTS.outcomeUnknownTitle, TEXTS.tokenAdjustOutcomeUnknown),
          );
        }
        // session_invalid clears the cookie in withStaffSession; anything else is our failure
        throw error;
      }
      if (answer.outcome === 'adjusted') {
        return reply.redirect(`/admin/users/${id}?notice=adjusted`, 303);
      }
      const { me, outcome: refusal, ...card } = answer;
      const message =
        refusal === 'insufficient_available'
          ? TEXTS.tokenAdjustInsufficient(card.user.tokens.available)
          : TEXTS.tokenAdjustBalanceChanged(card.user.tokens.balance);
      return sendHtml(
        reply,
        409,
        userPage(card, me.login, { adjustment: { message, form: form.data } }),
      );
    }),
  );

  app.get('/admin/static/app.css', async (_request, reply) =>
    reply
      .code(200)
      .type('text/css; charset=utf-8')
      .header('cache-control', `public, max-age=${CSS_MAX_AGE_S}`)
      .send(APP_CSS),
  );

  function isSessionGone(error: unknown): boolean {
    const answered = outcome(error);
    return answered?.status === 401 && answered.code === AdminErrorCode.SessionInvalid;
  }
};
