import type { FastifyPluginAsync } from 'fastify';
import {
  OAuthErrorCode,
  safeParseOAuthCallbackRequest,
  safeParseStartLoginRequest,
} from '@binarius/shared';
import {
  consumeOAuthState,
  createOAuthState,
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
// the callback is public, so it gets a cheap barrier against turning an anonymous request into
// an indexed UPDATE. Global rather than per-IP: trustProxy is not configured, so behind a
// reverse proxy every request would share one address and keying by it would be meaningless.
export const CALLBACK_RATE_LIMIT = 300;
export const CALLBACK_RATE_WINDOW_MS = 60_000;
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
      const { state, expiresAt } = await createOAuthState(deps.db, {
        telegramUserId: BigInt(parsed.data.telegramUserId),
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
    let windowStartedAt = Date.now();
    let inWindow = 0;
    scope.addHook('onRequest', async (_request, reply) => {
      const now = Date.now();
      if (now - windowStartedAt >= CALLBACK_RATE_WINDOW_MS) {
        windowStartedAt = now;
        inWindow = 0;
      }
      inWindow += 1;
      if (inWindow > CALLBACK_RATE_LIMIT) {
        return reply.code(429).send({ error: OAuthErrorCode.TooManyRequests });
      }
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
          return reply.code(400).send({ error: OAuthErrorCode.InvalidState });
        }

        let tokens;
        try {
          tokens = await deps.broker.exchangeCode({
            code: parsed.data.code,
            redirectUri: consumed.redirectUri,
          });
        } catch (error) {
          return reply.code(exchangeStatus(error)).send({ error: exchangeErrorCode(error) });
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

function exchangeStatus(error: unknown): number {
  if (!(error instanceof BrokerOAuthError)) return 502;
  return error.code === BrokerOAuthErrorCode.Unavailable ? 502 : 400;
}

function exchangeErrorCode(error: unknown): string {
  if (!(error instanceof BrokerOAuthError)) return OAuthErrorCode.BrokerUnavailable;
  switch (error.code) {
    case BrokerOAuthErrorCode.InvalidGrant:
      return OAuthErrorCode.InvalidCode;
    case BrokerOAuthErrorCode.ContractViolation:
      return OAuthErrorCode.BrokerContractViolation;
    case BrokerOAuthErrorCode.Rejected:
      return OAuthErrorCode.BrokerContractViolation;
    default:
      return OAuthErrorCode.BrokerUnavailable;
  }
}
