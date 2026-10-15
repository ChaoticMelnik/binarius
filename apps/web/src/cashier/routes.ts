import { isIP } from 'node:net';
import type { FastifyError, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import * as z from 'zod';
import {
  createKeyedWindow,
  DEPOSIT_BODY_LIMIT_BYTES,
  DepositErrorCode,
  depositWidgetSessionRequestSchema,
  errorLogFields,
} from '@binarius/shared';
import { BackendError, BackendErrorCode, type BackendClient } from '../backend-client';
import { sendHtml } from '../html';
import { miniAppCsp } from '../mini-app';
import { CASHIER_CLIENT_JS } from './client';
import { ipKey } from './ip-key';
import {
  CASHIER_CREDITED_PATH,
  CASHIER_PAGE_PATH,
  CASHIER_READY,
  CASHIER_SCRIPT_PATH,
  CASHIER_SESSION_PATH,
  cashierPage,
  CashierState,
} from './pages';

const SCRIPT_MAX_AGE_S = 3600;

// The per-IP window in front of both forwards (the session and the credited event, #112: one
// object, so neither route adds to what one address may send). The backend's route ceiling (600/min) is global and
// taken before initData is checked, so one address could fill it for everybody; 60 is ~20 people
// behind one address re-minting about once a minute, and filling the backend's ceiling then takes
// ten addresses (or ten IPv6 /64s). Per process and in memory, like every window here.
export const CASHIER_SESSION_PER_IP_PER_MINUTE = 60;
const CASHIER_SESSION_WINDOW_MS = 60_000;
const CASHIER_SESSION_MAX_KEYS = 10_000;

// What the page sends: the launch data and nothing else. The client IP is ours to add.
const pageRequestSchema = z.strictObject({
  initData: depositWidgetSessionRequestSchema.shape.initData,
});

export interface CashierRoutesOptions {
  backend: BackendClient;
  /** DEPOSIT_WIDGET_ORIGINS: the page's frame-src and the check of the backend's answer */
  widgetOrigins: readonly string[];
}

// Every (status, code) the backend's route answers that the page has a definite state for
// (docs/deposit.md -> The page). Anything else is a drift or an outage, never a guess.
const OUTCOMES: Record<string, CashierState> = {
  [`401 ${DepositErrorCode.InvalidTelegramAuth}`]: CashierState.OpenFromTelegram,
  [`429 ${DepositErrorCode.TooManyRequests}`]: CashierState.Busy,
  [`409 ${DepositErrorCode.DemoOnly}`]: CashierState.DemoOnly,
  [`409 ${DepositErrorCode.NoActiveAccount}`]: CashierState.ConnectFirst,
  [`409 ${DepositErrorCode.AmbiguousAccount}`]: CashierState.Ambiguous,
  [`409 ${DepositErrorCode.UserBlocked}`]: CashierState.Blocked,
  [`409 ${DepositErrorCode.TokenUnavailable}`]: CashierState.Relogin,
  [`502 ${DepositErrorCode.BrokerUnavailable}`]: CashierState.Unavailable,
  [`502 ${DepositErrorCode.BrokerRejected}`]: CashierState.Rejected,
};

// The client's address, only when a trusted proxy said what it is (app.ts -> trustProxy): with no
// forwarded header, request.ip is the proxy's or the socket's own address, which is nobody's.
const clientIpOf = (request: FastifyRequest): string | undefined =>
  request.ips !== undefined && request.ips.length > 1 && isIP(request.ip) !== 0
    ? request.ip
    : undefined;

export const cashierRoutes: FastifyPluginAsync<CashierRoutesOptions> = async (
  app,
  { backend, widgetOrigins },
) => {
  const csp = miniAppCsp(widgetOrigins);
  const perIp = createKeyedWindow(
    CASHIER_SESSION_PER_IP_PER_MINUTE,
    CASHIER_SESSION_WINDOW_MS,
    CASHIER_SESSION_MAX_KEYS,
  );
  // after the app's Origin check, before the body is read; a slot is never given back
  const takePerIp = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!perIp.take(ipKey(request.ip))) return undefined;
    request.log.warn('the cashier per-IP window is full');
    return reply.code(429).send({ outcome: CashierState.Busy });
  };

  // Set before the handler, so an error page Fastify sends for these routes carries them too.
  // strict-origin, not the OAuth pages' no-referrer: this URL carries no secret (Telegram's launch
  // data is in the fragment, never sent), and the widget may read document.referrer to learn its
  // embedder, as it can under the browser default the broker's own cashier runs with.
  app.addHook('onRequest', async (_request, reply) => {
    void reply.header('content-security-policy', csp);
    void reply.header('referrer-policy', 'strict-origin');
  });

  app.get(CASHIER_PAGE_PATH, async (_request, reply) => sendHtml(reply, 200, cashierPage()));

  app.get(CASHIER_SCRIPT_PATH, async (_request, reply) =>
    reply
      .code(200)
      .type('text/javascript; charset=utf-8')
      .header('cache-control', `public, max-age=${SCRIPT_MAX_AGE_S}`)
      .send(CASHIER_CLIENT_JS),
  );

  app.post(
    CASHIER_SESSION_PATH,
    {
      bodyLimit: DEPOSIT_BODY_LIMIT_BYTES,
      onRequest: takePerIp,
      // a body Fastify itself refuses — over the limit, not JSON — is the page's drift, not an
      // outage: the page shows «Повторить» either way, and the app's HTML error page would not parse
      errorHandler: (error: FastifyError, request, reply) => {
        const { statusCode } = error;
        if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
          request.log.warn({ code: error.code }, 'a cashier session request was refused');
          return reply.code(400).send({ outcome: CashierState.Unavailable });
        }
        request.log.error(errorLogFields(error), 'unhandled cashier session error');
        return reply.code(500).send({ outcome: CashierState.Unavailable });
      },
    },
    async (request, reply) => {
      const parsed = pageRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        request.log.warn('a cashier session request was refused');
        return reply.code(400).send({ outcome: CashierState.Unavailable });
      }
      const clientIp = clientIpOf(request);
      let answer;
      try {
        answer = await backend.depositWidgetSession({
          initData: parsed.data.initData,
          ...(clientIp === undefined ? {} : { clientIp }),
        });
      } catch (error) {
        return failed(request, reply, error);
      }
      // The page's frame-src is this process's list; a widget outside it would be blocked by the
      // browser anyway, and a postMessage target outside it is never ours to choose. One variable
      // feeds both processes, so this fires only when they read different values.
      const outside = [new URL(answer.widgetUrl).origin, answer.widgetOrigin].find(
        (origin) => !widgetOrigins.includes(origin),
      );
      if (outside !== undefined) {
        request.log.error(
          { origin: outside },
          'the backend returned a widget origin outside DEPOSIT_WIDGET_ORIGINS',
        );
        return reply.send({ outcome: CashierState.Rejected });
      }
      return reply.send({
        outcome: CASHIER_READY,
        session: answer.session,
        expiresInSec: answer.expiresInSec,
        widgetUrl: answer.widgetUrl,
        widgetOrigin: answer.widgetOrigin,
      });
    },
  );

  // The widget's credited event (#112, docs/deposit.md -> After a deposit): initData alone goes on
  // to the backend, which reads the balance from the broker. The page reads nothing of this
  // answer, so it is 204 whatever the forward did; only the log tells the outcomes apart.
  app.post(
    CASHIER_CREDITED_PATH,
    {
      bodyLimit: DEPOSIT_BODY_LIMIT_BYTES,
      onRequest: takePerIp,
      errorHandler: (error: FastifyError, request, reply) => {
        const { statusCode } = error;
        if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
          request.log.warn({ code: error.code }, 'a cashier credited request was refused');
          return reply.code(400).send();
        }
        request.log.error(errorLogFields(error), 'unhandled cashier credited error');
        return reply.code(500).send();
      },
    },
    async (request, reply) => {
      const parsed = pageRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        request.log.warn('a cashier credited request was refused');
        return reply.code(400).send();
      }
      try {
        await backend.depositCredited({ initData: parsed.data.initData });
      } catch (error) {
        logCreditedFailure(request, error);
      }
      return reply.code(204).send();
    },
  );

  // An answered request the table names gets its state. Anything else — no answer, a 2xx outside
  // the contract, the backend refusing our own body, a status the table does not list — is logged
  // by name and status and shown as «Касса недоступна» with «Повторить».
  function failed(request: FastifyRequest, reply: FastifyReply, error: unknown): FastifyReply {
    if (error instanceof BackendError && error.code === BackendErrorCode.HttpStatus) {
      const outcome = OUTCOMES[`${String(error.status)} ${error.reason ?? ''}`];
      if (outcome !== undefined) return reply.send({ outcome });
    }
    const answered =
      error instanceof BackendError ? { status: error.status, reason: error.reason } : {};
    request.log.error(
      { ...errorLogFields(error), ...answered },
      'the cashier session could not be minted',
    );
    return reply.code(500).send({ outcome: CashierState.Unavailable });
  }
};

// A refusal the backend's contract names (401, 409, 429 with a DepositErrorCode) is an ordinary
// day — a stale initData, the per-user window, an account gone; anything else is a drift or an
// outage.
const CREDITED_REFUSAL_STATUSES: ReadonlySet<number | undefined> = new Set([401, 409, 429]);
const DEPOSIT_ERROR_CODES: ReadonlySet<string | undefined> = new Set(
  Object.values(DepositErrorCode),
);

function logCreditedFailure(request: FastifyRequest, error: unknown): void {
  if (!(error instanceof BackendError)) {
    request.log.error(errorLogFields(error), 'the cashier credited event could not be forwarded');
    return;
  }
  const answered = { status: error.status, reason: error.reason };
  if (
    error.code === BackendErrorCode.HttpStatus &&
    CREDITED_REFUSAL_STATUSES.has(error.status) &&
    DEPOSIT_ERROR_CODES.has(error.reason)
  ) {
    request.log.warn(answered, 'the backend refused a cashier credited event');
    return;
  }
  request.log.error(
    { ...errorLogFields(error), ...answered },
    'the cashier credited event could not be forwarded',
  );
}
