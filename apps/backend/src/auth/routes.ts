import type { FastifyPluginAsync } from 'fastify';
import {
  errorIdentity,
  OAuthErrorCode,
  safeParseOAuthCallbackRequest,
  safeParseStartLoginRequest,
} from '@binarius/shared';
import {
  consumeOAuthState,
  createOAuthState,
  isUserBlocked,
  linkBrokerAccount,
  toBrokerAccountView,
  type Db,
  type TokenCipher,
} from '@binarius/db';
import {
  BrokerOAuthError,
  BrokerOAuthErrorCode,
  type BrokerOAuthClient,
} from '../broker/oauth-client';
import { internalBearerAuth } from './internal';

// a state has to outlive the user typing their credentials, unlike the 120 s code it leads to
export const OAUTH_STATE_TTL_MS = 600_000;
export const CALLBACK_RATE_WINDOW_MS = 60_000;
// The ceiling on everything the public callback accepts, checked before the body is parsed and
// before any query runs: it is what bounds how much work an anonymous request can trigger.
// Real logins are orders of magnitude rarer than this, so it only ever catches a flood.
export const CALLBACK_MAX_PER_MINUTE = 3000;
// The narrow limit, spent only by a state that did not resolve to a row. A successful login
// never consumes it, so a burst of real users cannot close the door the way a single global
// counter would; sixty misses in a minute is a guessing client, not a working one.
export const CALLBACK_MAX_FAILURES_PER_MINUTE = 60;
const CALLBACK_BODY_LIMIT_BYTES = 4 * 1024;

export interface AuthRoutesDeps {
  db: Db;
  cipher: TokenCipher;
  broker: BrokerOAuthClient;
  internalApiToken: string;
  authorizeUrl: string;
  clientId: string;
  redirectUri: string;
  partnerRef: string;
  // lowered by tests; production runs on the constants above
  callbackMaxPerMinute?: number;
  callbackMaxFailuresPerMinute?: number;
}

// One window per process, rolled forward lazily. A distributed limit would need Redis and is
// follow-up work; this one bounds a single backend, which is what the deployment runs.
function createWindow(limit: number) {
  let startedAt = Date.now();
  let count = 0;
  const roll = (): void => {
    if (Date.now() - startedAt < CALLBACK_RATE_WINDOW_MS) return;
    startedAt = Date.now();
    count = 0;
  };
  return {
    record: (): void => {
      roll();
      count += 1;
    },
    // the limit is how many fit in a window, so the request after the last one is refused
    isFull: (): boolean => {
      roll();
      return count >= limit;
    },
  };
}

export const authRoutes: FastifyPluginAsync<AuthRoutesDeps> = async (app, deps) => {
  // the bot starts a login, so this half keeps the internal-token pattern its neighbours use
  await app.register(async (scope) => {
    scope.addHook('onRequest', internalBearerAuth(deps.internalApiToken));
    scope.post('/auth/binodex/start', async (request, reply) => {
      const parsed = safeParseStartLoginRequest(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'validation', issues: parsed.error.issues });
      }
      const telegramUserId = BigInt(parsed.data.telegramUserId);
      // a blocked user would be refused at the end of the flow anyway, after burning a state
      // and an authorization code
      if (await isUserBlocked(deps.db, telegramUserId)) {
        return reply.code(409).send({ error: OAuthErrorCode.UserBlocked });
      }
      const { state, expiresAt } = await createOAuthState(deps.db, {
        telegramUserId,
        redirectUri: deps.redirectUri,
        ttlMs: OAUTH_STATE_TTL_MS,
      });
      const url = new URL(deps.authorizeUrl);
      url.searchParams.set('client_id', deps.clientId);
      url.searchParams.set('redirect_uri', deps.redirectUri);
      url.searchParams.set('state', state);
      url.searchParams.set('ref', deps.partnerRef);
      url.searchParams.set('response_mode', 'web_message');
      return reply.send({
        authorizeUrl: url.toString(),
        state,
        expiresAt: expiresAt.toISOString(),
      });
    });
  });

  // the browser finishes the login, and it cannot hold the internal token: the single-use
  // state is what authorizes this call
  await app.register(async (scope) => {
    const all = createWindow(deps.callbackMaxPerMinute ?? CALLBACK_MAX_PER_MINUTE);
    const failures = createWindow(
      deps.callbackMaxFailuresPerMinute ?? CALLBACK_MAX_FAILURES_PER_MINUTE,
    );
    scope.addHook('onRequest', async (_request, reply) => {
      if (all.isFull() || failures.isFull()) {
        return reply.code(429).send({ error: OAuthErrorCode.TooManyRequests });
      }
      all.record();
      return undefined;
    });

    scope.post(
      '/auth/binodex/callback',
      { bodyLimit: CALLBACK_BODY_LIMIT_BYTES },
      async (request, reply) => {
        const parsed = safeParseOAuthCallbackRequest(request.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: 'validation', issues: parsed.error.issues });
        }
        // consumed before the broker is called at all, and everything below comes from the
        // row this returns — never from the request body
        const consumed = await consumeOAuthState(deps.db, parsed.data.state);
        if (consumed === undefined) {
          failures.record();
          return reply.code(400).send({ error: OAuthErrorCode.InvalidState });
        }

        let tokens;
        try {
          tokens = await deps.broker.exchangeCode({
            code: parsed.data.code,
            redirectUri: consumed.redirectUri,
          });
        } catch (error) {
          const status = exchangeStatus(error);
          const code = exchangeErrorCode(error);
          // the only place the broker's own verdict is visible: the response carries a code,
          // not a reason
          request.log.warn(
            { status, outcome: code, err: errorIdentity(error) },
            'the authorization code could not be exchanged',
          );
          return reply.code(status).send({ error: code });
        }

        const linked = await linkBrokerAccount(deps.db, {
          telegramUserId: consumed.telegramUserId,
          tokens,
          cipher: deps.cipher,
        });
        if (!linked.ok) {
          return reply.code(409).send({
            error:
              linked.reason === 'user_blocked'
                ? OAuthErrorCode.UserBlocked
                : OAuthErrorCode.BrokerAccountTaken,
          });
        }
        return reply.send({ account: toBrokerAccountView(linked.account) });
      },
    );
  });
};

// 400 belongs to the caller's own mistake, and only a bad code is one. A rejection or a
// malformed body means our client id, secret or contract is wrong, which is a 502: the browser
// did nothing it could do differently.
function exchangeStatus(error: unknown): number {
  if (!(error instanceof BrokerOAuthError)) return 502;
  return error.code === BrokerOAuthErrorCode.InvalidGrant ? 400 : 502;
}

function exchangeErrorCode(error: unknown): string {
  if (!(error instanceof BrokerOAuthError)) return OAuthErrorCode.BrokerUnavailable;
  switch (error.code) {
    case BrokerOAuthErrorCode.InvalidGrant:
      return OAuthErrorCode.InvalidCode;
    case BrokerOAuthErrorCode.ContractViolation:
    case BrokerOAuthErrorCode.Rejected:
      return OAuthErrorCode.BrokerContractViolation;
    default:
      return OAuthErrorCode.BrokerUnavailable;
  }
}
