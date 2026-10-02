import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import {
  errorLogFields,
  MINI_APP_AUTHORIZE_PARAM,
  OAUTH_CALLBACK_BODY_LIMIT_BYTES,
  OAUTH_CALLBACK_PATH,
  OAUTH_LOGIN_PATH,
  OAuthErrorCode,
  oauthCallbackRequestSchema,
  safeParseOAuthCallbackRequest,
} from '@binarius/shared';
import { BackendError, BackendErrorCode, type BackendClient } from '../backend-client';
import { sendHtml } from '../html';
import { noticePage } from '../pages';
import { OAUTH_CLIENT_JS } from './client';
import { callbackPage, CallbackOutcome, loginPage, OAUTH_SCRIPT_PATH } from './pages';
import { OAUTH_TEXTS } from './texts';

// The admin pages' policy plus what a Mini App needs: Telegram's SDK, a fetch to this origin, and
// being framed by Telegram Web — the one parent origin the SDK itself trusts. No X-Frame-Options
// beside it: a browser that honours both would let DENY override frame-ancestors.
export const MINI_APP_CSP = [
  "default-src 'none'",
  "script-src 'self' https://telegram.org",
  "connect-src 'self'",
  "style-src 'self'",
  "form-action 'none'",
  'frame-ancestors https://web.telegram.org',
  "base-uri 'none'",
].join('; ');

// the broker's own URL is a few hundred characters; anything far longer is not one it built
const AUTHORIZE_MAX_LENGTH = 2048;
const SCRIPT_MAX_AGE_S = 3600;
// the backend's answer to a body its schema refuses
const BACKEND_VALIDATION_ERROR = 'validation';

export interface OAuthRoutesOptions {
  backend: BackendClient;
  /** the origin these pages are served from; the broker must redirect back to it */
  publicOrigin: string;
  /** the broker's authorize page, the only place the login page navigates to */
  brokerAuthorizeUrl: string;
}

// Every (status, code) the backend's callback answers that the page has a definite text for. The
// state column of docs/binodex-oauth.md -> The Mini App pages is why each lands where it does.
const OUTCOMES: Record<string, CallbackOutcome> = {
  [`401 ${OAuthErrorCode.InvalidTelegramAuth}`]: CallbackOutcome.OpenFromTelegram,
  [`429 ${OAuthErrorCode.TooManyRequests}`]: CallbackOutcome.Busy,
  [`400 ${OAuthErrorCode.InvalidState}`]: CallbackOutcome.StartOver,
  [`403 ${OAuthErrorCode.TelegramUserMismatch}`]: CallbackOutcome.StartOver,
  [`400 ${OAuthErrorCode.InvalidCode}`]: CallbackOutcome.StartOver,
  [`502 ${OAuthErrorCode.BrokerUnavailable}`]: CallbackOutcome.StartOver,
  [`502 ${OAuthErrorCode.BrokerContractViolation}`]: CallbackOutcome.StartOver,
  [`409 ${OAuthErrorCode.UserBlocked}`]: CallbackOutcome.Blocked,
  [`409 ${OAuthErrorCode.BrokerAccountTaken}`]: CallbackOutcome.Taken,
};

const callbackQuerySchema = oauthCallbackRequestSchema.pick({ state: true, code: true });

const redirectHrefOf = (value: string | null): string | undefined => {
  if (value === null) return undefined;
  try {
    return new URL(value).href;
  } catch {
    return undefined;
  }
};

export const oauthRoutes: FastifyPluginAsync<OAuthRoutesOptions> = async (
  app,
  { backend, publicOrigin, brokerAuthorizeUrl },
) => {
  const broker = new URL(brokerAuthorizeUrl);
  const callbackHref = new URL(OAUTH_CALLBACK_PATH, publicOrigin).href;

  // set before the handler, so an error page Fastify sends for these routes carries it too; the
  // app's onSend hook adds the admin policy only to a reply that has none
  app.addHook('onRequest', async (_request, reply) => {
    void reply.header('content-security-policy', MINI_APP_CSP);
  });

  // The parsed link, or which check refused it as one word: the value itself is never logged —
  // it carries a live state.
  const checkAuthorize = (raw: unknown): { reason: string } | { href: string } => {
    if (typeof raw !== 'string') return { reason: 'missing' };
    if (raw.length > AUTHORIZE_MAX_LENGTH) return { reason: 'too_long' };
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { reason: 'not_url' };
    }
    if (url.protocol !== 'https:') return { reason: 'protocol' };
    if (url.origin !== broker.origin || url.pathname !== broker.pathname) {
      return { reason: 'target' };
    }
    if (!callbackQuerySchema.shape.state.safeParse(url.searchParams.get('state')).success) {
      return { reason: 'state' };
    }
    // The callback must come back to this origin: the launch data the SDK stored lives here.
    // Compared parsed, because the backend sends the spelling registered with the broker byte
    // for byte: host case and a default port do not matter, anything else in the URL does.
    if (redirectHrefOf(url.searchParams.get('redirect_uri')) !== callbackHref) {
      return { reason: 'redirect_uri' };
    }
    return { href: url.href };
  };

  app.get(OAUTH_LOGIN_PATH, async (request, reply) => {
    const raw = (request.query as Record<string, unknown>)[MINI_APP_AUTHORIZE_PARAM];
    const checked = checkAuthorize(raw);
    if ('reason' in checked) {
      request.log.warn({ reason: checked.reason }, 'a Mini App login link was refused');
      return sendHtml(reply, 400, noticePage(OAUTH_TEXTS.refusedTitle, OAUTH_TEXTS.refusedLogin));
    }
    return sendHtml(reply, 200, loginPage(checked.href));
  });

  // The broker's redirect. Nothing is exchanged here: the page posts the code back with the
  // launch data the Mini App holds, and a cancelled login arrives without one.
  app.get(OAUTH_CALLBACK_PATH, async (request, reply) => {
    if (!callbackQuerySchema.safeParse(request.query).success) {
      return sendHtml(
        reply,
        400,
        noticePage(OAUTH_TEXTS.refusedCallbackTitle, OAUTH_TEXTS.refusedCallback),
      );
    }
    return sendHtml(reply, 200, callbackPage());
  });

  app.post(
    OAUTH_CALLBACK_PATH,
    { bodyLimit: OAUTH_CALLBACK_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const parsed = safeParseOAuthCallbackRequest(request.body);
      if (!parsed.success) return reply.code(400).send({ error: BACKEND_VALIDATION_ERROR });
      try {
        await backend.oauthCallback(parsed.data);
        return reply.send({ outcome: CallbackOutcome.Linked });
      } catch (error) {
        return failed(request, reply, error);
      }
    },
  );

  app.get(OAUTH_SCRIPT_PATH, async (_request, reply) =>
    reply
      .code(200)
      .type('text/javascript; charset=utf-8')
      .header('cache-control', `public, max-age=${SCRIPT_MAX_AGE_S}`)
      .send(OAUTH_CLIENT_JS),
  );

  // An answered request the table names gets its text. The backend refusing our own body is a
  // drift between the two processes, not the user's doing: logged, and the user starts over.
  // Anything else — no answer, a 2xx outside the contract, a status the table does not list —
  // never claims an outcome: the link may have happened, and the push says whether it did.
  function failed(request: FastifyRequest, reply: FastifyReply, error: unknown): FastifyReply {
    if (error instanceof BackendError && error.code === BackendErrorCode.HttpStatus) {
      const key = `${String(error.status)} ${error.reason ?? ''}`;
      const outcome = OUTCOMES[key];
      if (outcome !== undefined) return reply.send({ outcome });
      if (error.status === 400 && error.reason === BACKEND_VALIDATION_ERROR) {
        request.log.error(
          { status: error.status, reason: error.reason },
          'the backend refused the forwarded callback as malformed',
        );
        return reply.send({ outcome: CallbackOutcome.StartOver });
      }
    }
    const answered =
      error instanceof BackendError ? { status: error.status, reason: error.reason } : {};
    request.log.error(
      { ...errorLogFields(error), ...answered },
      'the callback could not be forwarded',
    );
    return reply.code(500).send({ outcome: CallbackOutcome.Unknown });
  }
};
