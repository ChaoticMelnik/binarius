import type { FastifyPluginAsync } from 'fastify';
import {
  errorIdentity,
  OAuthErrorCode,
  safeParseConfirmLoginRequest,
  safeParseOAuthCallbackRequest,
  safeParseStartLoginRequest,
} from '@binarius/shared';
import {
  confirmBrokerAccount,
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
const OAUTH_STATE_TTL_MS = 600_000;
const CALLBACK_RATE_WINDOW_MS = 60_000;
// The ceiling on everything the public callback accepts, taken before the body is parsed and
// before any query runs: it is what bounds how much work an anonymous request can trigger.
// Real logins are orders of magnitude rarer than this, so it only ever catches a flood.
const CALLBACK_MAX_PER_MINUTE = 3000;
// Spent only by a state that resolved to no row. High enough that closing the callback for a
// minute costs a real flood rather than one request per second: a 32-byte state cannot be
// guessed, so this window only has to bound junk, and the ceiling above already bounds the work.
const CALLBACK_MAX_FAILURES_PER_MINUTE = 600;
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

interface Ticket {
  over: boolean;
  generation: number;
}

// One fixed window per process, rolled forward lazily. A distributed limit would need Redis and
// is follow-up work; this one bounds a single backend, which is what the deployment runs.
function createWindow(limit: number) {
  let startedAt = Date.now();
  let count = 0;
  let generation = 0;
  const roll = (): void => {
    if (Date.now() - startedAt < CALLBACK_RATE_WINDOW_MS) return;
    startedAt = Date.now();
    count = 0;
    generation += 1;
  };
  return {
    // Reserves the slot before the work it limits, not after: a counter incremented once the
    // work has finished lets a concurrent burst through while every request is still in flight.
    take: (): Ticket => {
      roll();
      count += 1;
      return { over: count > limit, generation };
    },
    // returns a reservation that turned out not to be the thing being limited; a window that
    // has rolled since is a different window, and its count is not ours to touch
    release: (generation_: number): void => {
      roll();
      if (generation_ === generation && count > 0) count -= 1;
    },
    isOver: (): boolean => {
      roll();
      return count > limit;
    },
  };
}

export const authRoutes: FastifyPluginAsync<AuthRoutesDeps> = async (app, deps) => {
  // the bot starts and confirms a login, so this half keeps the internal-token pattern its
  // neighbours use
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

    // The link an account becomes usable through. The callback proves that someone authorized
    // at the broker; this proves the Telegram user who started the login agrees it was them.
    scope.post('/auth/binodex/confirm', async (request, reply) => {
      const parsed = safeParseConfirmLoginRequest(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'validation', issues: parsed.error.issues });
      }
      const confirmed = await confirmBrokerAccount(deps.db, {
        telegramUserId: BigInt(parsed.data.telegramUserId),
        accountId: parsed.data.accountId,
      });
      if (!confirmed.ok) {
        if (confirmed.reason === 'not_found') {
          return reply.code(404).send({ error: OAuthErrorCode.BrokerAccountNotFound });
        }
        return reply.code(409).send({
          error:
            confirmed.reason === 'user_blocked'
              ? OAuthErrorCode.UserBlocked
              : OAuthErrorCode.AccountNotPending,
        });
      }
      return reply.send({ account: toBrokerAccountView(confirmed.account) });
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
      const ticket = all.take();
      if (ticket.over || failures.isOver()) {
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

        // reserved before the lookup and given back unless the state turned out to be junk:
        // checking in the hook alone lets a concurrent burst through, because none of them has
        // counted yet when the others are admitted
        const ticket = failures.take();
        if (ticket.over) {
          return reply.code(429).send({ error: OAuthErrorCode.TooManyRequests });
        }
        // consumed before the broker is called at all, and everything below comes from the
        // row this returns — never from the request body
        let consumed;
        try {
          consumed = await consumeOAuthState(deps.db, parsed.data.state);
        } catch (error) {
          // a database failure is not a guess; keeping the reservation would let an outage
          // close the callback for a minute after it recovers
          failures.release(ticket.generation);
          throw error;
        }
        if (consumed === undefined) {
          return reply.code(400).send({ error: OAuthErrorCode.InvalidState });
        }
        failures.release(ticket.generation);

        let tokens;
        try {
          tokens = await deps.broker.exchangeCode({
            code: parsed.data.code,
            redirectUri: consumed.redirectUri,
          });
        } catch (error) {
          const { status, code } = exchangeOutcome(error);
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
// did nothing it could do differently. One function, so the status and the code cannot drift.
function exchangeOutcome(error: unknown): { status: number; code: string } {
  if (!(error instanceof BrokerOAuthError)) {
    return { status: 502, code: OAuthErrorCode.BrokerUnavailable };
  }
  switch (error.code) {
    case BrokerOAuthErrorCode.InvalidGrant:
      return { status: 400, code: OAuthErrorCode.InvalidCode };
    case BrokerOAuthErrorCode.ContractViolation:
    case BrokerOAuthErrorCode.Rejected:
      return { status: 502, code: OAuthErrorCode.BrokerContractViolation };
    default:
      return { status: 502, code: OAuthErrorCode.BrokerUnavailable };
  }
}
