import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import * as z from 'zod';
import {
  AdminErrorCode,
  errorLogFields,
  STAFF_PASSWORD_MAX_LENGTH,
  STAFF_SESSION_TOKEN_PATTERN,
  staffLoginCodeSchema,
  staffLoginSchema,
  UUID_PATTERN,
} from '@binarius/shared';
import { sendHtml } from '../html';
import { BackendError, BackendErrorCode, type BackendClient } from '../backend-client';
import { confirmPage, loginPage, noticePage, sessionsPage } from './pages';
import { APP_CSS } from './static';
import { TEXTS } from './texts';

export const SESSION_COOKIE = 'admin_session';
export const CHALLENGE_COOKIE = 'admin_login';
const SESSION_COOKIE_PATH = '/admin';
const CHALLENGE_COOKIE_PATH = '/admin/login';
// a user agent longer than this is not one the column accepts, and truncating here keeps the
// backend's validation from turning a long header into a failed login
const USER_AGENT_MAX = 512;
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

/** What the backend records as the client's own facts; it trusts this process for them. */
const clientFacts = (request: FastifyRequest) => ({
  ip: request.ip,
  userAgent: (request.headers['user-agent'] ?? '').slice(0, USER_AGENT_MAX),
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
  // someone out over our own bug.
  const internalFailure = (request: FastifyRequest, reply: FastifyReply, error: unknown): FastifyReply => {
    request.log.error(errorLogFields(error), 'the admin backend call could not be used');
    return sendHtml(reply, 500, noticePage(TEXTS.errorTitle, TEXTS.errorBody));
  };

  /** The (status, code) pair, or undefined when the failure was not an answered request. */
  const outcome = (error: unknown): { status: number; code?: string } | undefined =>
    error instanceof BackendError && error.code === BackendErrorCode.HttpStatus
      ? { status: error.status ?? 0, ...(error.reason === undefined ? {} : { code: error.reason }) }
      : undefined;

  app.get('/admin', async (_request, reply) => reply.redirect('/admin/sessions', 302));

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
      if (answered?.status === 429) {
        return sendHtml(reply, 429, confirmPage(TEXTS.tooManyCodeAttempts));
      }
      return internalFailure(request, reply, error);
    }
  });

  app.get('/admin/sessions', async (request, reply) => {
    const token = cookieMatching(request, SESSION_COOKIE, STAFF_SESSION_TOKEN_PATTERN);
    if (token === undefined) return clearSession(reply).redirect('/admin/login', 302);
    try {
      const { me, sessions } = await backend.sessions(token);
      return sendHtml(reply, 200, sessionsPage(sessions, me.login));
    } catch (error) {
      if (isSessionGone(error)) return clearSession(reply).redirect('/admin/login', 302);
      return internalFailure(request, reply, error);
    }
  });

  app.post('/admin/sessions/:id/revoke', async (request, reply) => {
    const token = cookieMatching(request, SESSION_COOKIE, STAFF_SESSION_TOKEN_PATTERN);
    if (token === undefined) return clearSession(reply).redirect('/admin/login', 302);
    const { id } = request.params as { id: string };
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
