import { isIP } from 'node:net';
import type { FastifyPluginAsync } from 'fastify';
import {
  createKeyedWindow,
  createWindow,
  DEPOSIT_BODY_LIMIT_BYTES,
  DEPOSIT_WIDGET_SESSION_PATH,
  DepositErrorCode,
  UserStatus,
  assertExhausted,
  safeParseDepositWidgetSessionRequest,
} from '@binarius/shared';
import { resolveBalanceAccount, type Db } from '@binarius/db';
import type { InitDataVerifier } from '../auth/telegram-init-data';
import { registerDepositCredited, type DepositCreditedDeps } from './credited';
import {
  depositErrorFor,
  mintDepositWidgetSession,
  type DepositWidgetDeps,
} from './widget-session';

// The ceiling on everything the public routes accept, taken before the body is parsed: what bounds
// the work an anonymous request can trigger. A real cashier mints a session per open and per
// reauth and sends a credited event per deposit (#112), far below this.
const DEPOSIT_SESSION_MAX_PER_MINUTE = 600;
// Per Telegram user, taken after initData and never given back: one session per 6 s on average,
// above the widget's reauth cadence, below a loop.
const DEPOSIT_SESSION_PER_USER_PER_MINUTE = 10;
const PER_USER_WINDOW_MS = 60_000;
const PER_USER_MAX_KEYS = 10_000;

export interface DepositRoutesDeps extends Omit<DepositWidgetDeps, 'logger'>, DepositCreditedDeps {
  db: Db;
  // proves which Telegram user opened the cashier; its own max age (DEPOSIT_INIT_DATA_MAX_AGE_MS)
  initDataVerifier: InitDataVerifier;
  // the demo-only fuse (#396): required, so no caller gets a cashier that ignores it
  demoOnly: boolean;
  // lowered by tests; production runs on the constants above
  maxPerMinute?: number;
  perUserPerMinute?: number;
}

// POST /deposit/widget-session (#11, docs/deposit.md) and POST /deposit/credited (#112). Public, like the OAuth callback: apps/web
// forwards it on the internal network without a bearer, and the signed initData is the whole
// authorization. Not publicThroughProxy, so a request through Caddy gets the not-found answer.
export const depositRoutes: FastifyPluginAsync<DepositRoutesDeps> = async (app, deps) => {
  const all = createWindow(deps.maxPerMinute ?? DEPOSIT_SESSION_MAX_PER_MINUTE);
  const perUser = createKeyedWindow(
    deps.perUserPerMinute ?? DEPOSIT_SESSION_PER_USER_PER_MINUTE,
    PER_USER_WINDOW_MS,
    PER_USER_MAX_KEYS,
  );
  app.addHook('onRequest', async (_request, reply) => {
    if (all.take().over) {
      return reply.code(429).send({ error: DepositErrorCode.TooManyRequests });
    }
    return undefined;
  });

  app.post(
    DEPOSIT_WIDGET_SESSION_PATH,
    { bodyLimit: DEPOSIT_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const parsed = safeParseDepositWidgetSessionRequest(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'validation', issues: parsed.error.issues });
      }
      const refuse = (status: number, error: DepositErrorCode) =>
        reply.code(status).send({ error });

      // before any read: a DEMO_ONLY process neither exchanges a token nor calls the broker (#396)
      if (deps.demoOnly) return refuse(409, DepositErrorCode.DemoOnly);

      const proof = deps.initDataVerifier.verify(parsed.data.initData, Date.now());
      if (!proof.ok) {
        request.log.warn({ reason: proof.reason }, 'the cashier carried no valid Telegram proof');
        return refuse(401, DepositErrorCode.InvalidTelegramAuth);
      }
      const { telegramUserId } = proof;
      if (perUser.take(String(telegramUserId))) {
        return refuse(429, DepositErrorCode.TooManyRequests);
      }

      // the account /trading/access and /trading/mode act on: the user's only active one.
      // not_found comes only with an explicit account id, which this route never passes.
      const resolved = await resolveBalanceAccount(deps.db, { telegramUserId });
      switch (resolved.kind) {
        case 'no_user':
        case 'no_account':
        case 'not_found':
          return refuse(409, DepositErrorCode.NoActiveAccount);
        case 'ambiguous':
          return refuse(409, DepositErrorCode.AmbiguousAccount);
        case 'account':
          break;
        default:
          return assertExhausted(resolved, 'balance account resolution');
      }
      // ensureFreshAccessToken checks it again on its read or under the row lock; this one
      // spares the call
      if (resolved.account.userStatus === UserStatus.Blocked) {
        return refuse(409, DepositErrorCode.UserBlocked);
      }

      const clientIp = parsed.data.clientIp;
      const outcome = await mintDepositWidgetSession(
        { ...deps, logger: request.log },
        {
          accountId: resolved.account.id,
          mayRefresh: true,
          ...(clientIp !== undefined && isIP(clientIp) !== 0 ? { userIp: clientIp } : {}),
        },
      );
      if (outcome.ok) return reply.send(outcome.session);
      const error = depositErrorFor(outcome);
      return refuse(brokerSide(error) ? 502 : 409, error);
    },
  );

  registerDepositCredited(app, deps);
};

const brokerSide = (error: DepositErrorCode): boolean =>
  error === DepositErrorCode.BrokerUnavailable || error === DepositErrorCode.BrokerRejected;
