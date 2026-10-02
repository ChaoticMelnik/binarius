import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import Fastify, { LogController, type FastifyError, type FastifyInstance } from 'fastify';
import { errorLogFields, LOG_REDACT_PATHS, type LogLevel } from '@binarius/shared';
import { adminRoutes } from './admin/routes';
import { TEXTS } from './admin/texts';
import { sendHtml } from './html';
import { noticePage } from './pages';
import type { BackendClient } from './backend-client';
import { oauthRoutes } from './oauth/routes';

export interface WebAppDeps {
  backend: BackendClient;
  /** the origin a POST's `Origin` header must equal */
  publicOrigin: string;
  /** the broker's authorize page, the only place the Mini App login page navigates to */
  brokerAuthorizeUrl: string;
  secureCookies: boolean;
  logLevel: LogLevel;
  // where the logger writes; production omits it. What these pages keep out of their log
  // lines is only provable by reading them, and pino writes to a file descriptor that
  // stubbing process.stdout does not reach.
  logDestination?: { write(line: string): void };
}

export const ADMIN_CSP = [
  "default-src 'none'",
  "style-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ');

export function buildWebApp({
  backend,
  publicOrigin,
  brokerAuthorizeUrl,
  secureCookies,
  logLevel,
  logDestination,
}: WebAppDeps): FastifyInstance {
  const app = Fastify({
    // An instance, not the class: Fastify validates `userController instanceof LogController`,
    // and options given to Fastify never reach a supplied controller. There are no access log
    // lines at all — a URL here carries a session id in its path and a login in its form, and
    // the durable record of who did what is audit_log, not this process's stdout.
    logController: new LogController({ disableRequestLogging: true }),
    logger: {
      level: logLevel,
      redact: [...LOG_REDACT_PATHS],
      ...(logDestination === undefined ? {} : { stream: logDestination }),
    },
  });

  void app.register(cookie);
  void app.register(formbody);

  // Only POST: a browser sends no Origin on a plain navigation, so requiring it on GET would
  // break every link. Together with SameSite=Lax on the cookie this is what stops another
  // site from submitting a form here with the staff member's session attached.
  app.addHook('onRequest', async (request, reply) => {
    if (request.method !== 'POST') return undefined;
    if (request.headers.origin === publicOrigin) return undefined;
    request.log.warn({ method: request.method }, 'a POST arrived from another origin');
    return sendHtml(reply, 403, noticePage(TEXTS.forbiddenTitle, TEXTS.forbiddenBody));
  });

  // The Mini App pages set a policy of their own (oauth/routes.ts), one that lets Telegram Web
  // frame them; every other reply gets the admin pages' policy and may not be framed at all.
  app.addHook('onSend', async (_request, reply, payload) => {
    if (reply.getHeader('content-security-policy') === undefined) {
      void reply.header('content-security-policy', ADMIN_CSP);
      void reply.header('x-frame-options', 'DENY');
    }
    void reply.header('x-content-type-options', 'nosniff');
    void reply.header('referrer-policy', 'no-referrer');
    // only where the cookie is Secure: the header is ignored over http anyway, and sending it
    // there would state a policy the deployment has not made
    if (secureCookies) void reply.header('strict-transport-security', 'max-age=31536000');
    // the stylesheet says its own; everything else is a page about one person's session
    if (reply.getHeader('cache-control') === undefined) {
      void reply.header('cache-control', 'no-store');
    }
    return payload;
  });

  void app.register(adminRoutes, { backend, secureCookies });
  void app.register(oauthRoutes, { backend, publicOrigin, brokerAuthorizeUrl });

  app.setNotFoundHandler(async (_request, reply) =>
    sendHtml(reply, 404, noticePage(TEXTS.notFoundTitle, TEXTS.notFoundBody)),
  );

  // Fastify's default handler echoes error.message, and a message here can carry a form value
  // or a backend diagnostic. 4xx keeps its status and gets a page; anything else is an opaque
  // 500 and one line naming the error, never describing it.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const { statusCode } = error;
    if (
      typeof statusCode === 'number' &&
      Number.isInteger(statusCode) &&
      statusCode >= 400 &&
      statusCode < 500
    ) {
      return sendHtml(reply, statusCode, noticePage(TEXTS.errorTitle, TEXTS.errorBody));
    }
    request.log.error(errorLogFields(error), 'unhandled request error');
    return sendHtml(reply, 500, noticePage(TEXTS.errorTitle, TEXTS.errorBody));
  });

  return app;
}
