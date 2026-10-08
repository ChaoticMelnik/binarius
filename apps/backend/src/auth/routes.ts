import type { FastifyBaseLogger, FastifyPluginAsync, FastifyReply } from 'fastify';
import {
  BrokerAccountStatus,
  errorIdentity,
  errorLogFields,
  OAUTH_CALLBACK_BODY_LIMIT_BYTES,
  OAuthErrorCode,
  safeParseConfirmLoginRequest,
  safeParseEmailLoginRequest,
  safeParseEmailSendCodeRequest,
  safeParseOAuthCallbackRequest,
} from '@binarius/shared';
import {
  confirmBrokerAccount,
  consumeOAuthState,
  hashToken,
  isUserBlocked,
  linkBrokerAccount,
  toBrokerAccountView,
  toLinkBonusGrantView,
  type Db,
  type TokenCipher,
} from '@binarius/db';
import {
  BrokerOAuthError,
  BrokerOAuthErrorCode,
  type BrokerOAuthClient,
} from '../broker/oauth-client';
import { telegramErrorFields } from '../telegram-logging';
import { recordTelegramSendFailure } from '../users/telegram-delivery';
import { internalBearerAuth } from './internal';
import { LinkPushKind, type LinkNotifier, type LinkPushOutcome } from './link-notifier';
import { createKeyedWindow, createWindow, type RateWindow } from './rate-window';
import type { InitDataVerifier } from './telegram-init-data';

// The ceiling on everything the public callback accepts, taken before the body is parsed and
// before any query runs: it is what bounds how much work an anonymous request can trigger.
// Real logins are orders of magnitude rarer than this, so it only ever catches a flood.
const CALLBACK_MAX_PER_MINUTE = 3000;
// Spent only by a state that resolved to no row. High enough that closing the callback for a
// minute costs a real flood rather than one request per second: a 32-byte state cannot be
// guessed, so this window only has to bound junk, and the ceiling above already bounds the work.
const CALLBACK_MAX_FAILURES_PER_MINUTE = 600;

// Route ceilings, taken before the body is parsed. Every send-code is a real letter, so it is
// held far lower than the login.
const EMAIL_SEND_CODE_MAX_PER_MINUTE = 60;
const EMAIL_LOGIN_MAX_PER_MINUTE = 300;
// Per Telegram user and per address. The address window is what stops a brute force of one
// address's code spread across several Telegram accounts. Neither depends on the broker's own
// code TTL or lockout, which are unknown: whoever runs out waits and asks for a new code, and
// every send-code is a new code.
const EMAIL_KEY_WINDOW_MS = 10 * 60_000;
const EMAIL_KEY_MAX_KEYS = 10_000;
const EMAIL_SEND_CODE_PER_KEY = 3;
const EMAIL_LOGIN_ATTEMPTS_PER_KEY = 5;

export interface AuthRoutesDeps {
  db: Db;
  cipher: TokenCipher;
  broker: BrokerOAuthClient;
  internalApiToken: string;
  // the OAuth client's authorize request; no route builds one since #314 disabled
  // POST /auth/binodex/start
  authorizeUrl: string;
  clientId: string;
  redirectUri: string;
  partnerRef: string;
  // the push after the callback; required, so no caller gets a callback that tells nobody
  linkNotifier: LinkNotifier;
  // proves which Telegram user finished the login on the callback
  initDataVerifier: InitDataVerifier;
  // lowered by tests; production runs on the constants above
  callbackMaxPerMinute?: number;
  callbackMaxFailuresPerMinute?: number;
  emailSendCodeMaxPerMinute?: number;
  emailLoginMaxPerMinute?: number;
}

export const authRoutes: FastifyPluginAsync<AuthRoutesDeps> = async (app, deps) => {
  // One attempt, after the link has committed and outside any transaction. Its outcome never
  // changes the response: a push that never arrives is made up for by the confirm button on the
  // user's next /start (#10). A 403 writes one fact, the Telegram block (#119).
  const push = async (
    log: FastifyBaseLogger,
    telegramUserId: bigint,
    outcome: LinkPushOutcome,
  ): Promise<void> => {
    try {
      await deps.linkNotifier.send(telegramUserId, outcome);
    } catch (error) {
      // identity only: grammY's HttpError wraps a message with the token in its URL, and the
      // payload holds the email on the button
      log.warn(
        {
          ...errorLogFields(error),
          ...telegramErrorFields(error, 'sendMessage'),
          push: outcome.kind,
        },
        'the link outcome could not be pushed to Telegram',
      );
      await recordTelegramSendFailure({ db: deps.db, log }, telegramUserId, error);
    }
  };

  // the bot confirms a login and runs the email login, so this half keeps the internal-token
  // pattern its neighbours use
  await app.register(async (scope) => {
    scope.addHook('onRequest', internalBearerAuth(deps.internalApiToken));

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
      return reply.send({
        account: toBrokerAccountView(confirmed.account),
        grant: toLinkBonusGrantView(confirmed.grant),
      });
    });

    // A route-level hook runs after the scope's bearer check, so a caller without the internal
    // token cannot spend the ceiling.
    const ceiling = (window: RateWindow) => async (_request: unknown, reply: FastifyReply) => {
      if (window.take().over) {
        return reply.code(429).send({ error: OAuthErrorCode.TooManyRequests });
      }
      return undefined;
    };
    const keyedWindows = (perKey: number) => {
      const byUser = createKeyedWindow(perKey, EMAIL_KEY_WINDOW_MS, EMAIL_KEY_MAX_KEYS);
      const byAddress = createKeyedWindow(perKey, EMAIL_KEY_WINDOW_MS, EMAIL_KEY_MAX_KEYS);
      // Reserved before the broker is called and never given back, even when the broker fails:
      // a sixth attempt is refused even with the right code. The user is taken first, so one
      // already over their own allowance does not spend the address's. The map keeps a hash,
      // not the address.
      return (telegramUserId: string, email: string): boolean =>
        byUser.take(telegramUserId) || byAddress.take(hashToken(email.toLowerCase()));
    };
    const sendCodeOver = keyedWindows(EMAIL_SEND_CODE_PER_KEY);
    const loginOver = keyedWindows(EMAIL_LOGIN_ATTEMPTS_PER_KEY);

    scope.post(
      '/auth/binodex/email/send-code',
      {
        onRequest: ceiling(
          createWindow(deps.emailSendCodeMaxPerMinute ?? EMAIL_SEND_CODE_MAX_PER_MINUTE),
        ),
      },
      async (request, reply) => {
        const parsed = safeParseEmailSendCodeRequest(request.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: 'validation', issues: parsed.error.issues });
        }
        const { telegramUserId, email } = parsed.data;
        if (await isUserBlocked(deps.db, BigInt(telegramUserId))) {
          return reply.code(409).send({ error: OAuthErrorCode.UserBlocked });
        }
        if (sendCodeOver(telegramUserId, email)) {
          return reply.code(429).send({ error: OAuthErrorCode.TooManyAttempts });
        }
        try {
          await deps.broker.sendEmailCode({ email });
        } catch (error) {
          const { status, code } = brokerOutcome(error, OAuthErrorCode.InvalidEmail);
          request.log.warn(
            { status, outcome: code, err: errorIdentity(error) },
            'the email code could not be sent',
          );
          return reply.code(status).send({ error: code });
        }
        return reply.send({ codeSent: true });
      },
    );

    scope.post(
      '/auth/binodex/email/login',
      {
        onRequest: ceiling(createWindow(deps.emailLoginMaxPerMinute ?? EMAIL_LOGIN_MAX_PER_MINUTE)),
      },
      async (request, reply) => {
        const parsed = safeParseEmailLoginRequest(request.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: 'validation', issues: parsed.error.issues });
        }
        const { telegramUserId, email, code } = parsed.data;
        if (await isUserBlocked(deps.db, BigInt(telegramUserId))) {
          return reply.code(409).send({ error: OAuthErrorCode.UserBlocked });
        }
        if (loginOver(telegramUserId, email)) {
          return reply.code(429).send({ error: OAuthErrorCode.TooManyAttempts });
        }
        let tokens;
        try {
          tokens = await deps.broker.emailLogin({ email, code, partnerCode: deps.partnerRef });
        } catch (error) {
          const outcome = brokerOutcome(error, OAuthErrorCode.InvalidCode);
          request.log.warn(
            { status: outcome.status, outcome: outcome.code, err: errorIdentity(error) },
            'the email code could not be redeemed',
          );
          return reply.code(outcome.status).send({ error: outcome.code });
        }

        // The Telegram user typing the code is the one who gets the account, so there is no
        // confirmation step: the link is active and the starter pack is paid in this transaction.
        const linked = await linkBrokerAccount(deps.db, {
          telegramUserId: BigInt(telegramUserId),
          tokens,
          cipher: deps.cipher,
          activate: true,
        });
        if (!linked.ok) {
          return reply.code(409).send({
            error:
              linked.reason === 'user_blocked'
                ? OAuthErrorCode.UserBlocked
                : OAuthErrorCode.BrokerAccountTaken,
          });
        }
        if (linked.grant === null) throw new Error('an activating link returned no grant');
        return reply.send({
          account: toBrokerAccountView(linked.account),
          grant: toLinkBonusGrantView(linked.grant),
        });
      },
    );
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
      { bodyLimit: OAUTH_CALLBACK_BODY_LIMIT_BYTES },
      async (request, reply) => {
        const parsed = safeParseOAuthCallbackRequest(request.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: 'validation', issues: parsed.error.issues });
        }

        // Before any query: a forged or stale proof costs a hash, not a row lookup, and spends
        // neither the state nor the failures window. Nobody is pushed — the owner is not known yet.
        const proof = deps.initDataVerifier.verify(parsed.data.initData, Date.now());
        if (!proof.ok) {
          request.log.warn(
            { reason: proof.reason },
            'the callback carried no valid Telegram proof',
          );
          return reply.code(401).send({ error: OAuthErrorCode.InvalidTelegramAuth });
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

        // The state is spent either way: a link that reached another Telegram account is not
        // handed back. The code never reaches the broker, and the state's owner learns it from
        // the push, not from this response, which tells the other browser nothing about them.
        if (proof.telegramUserId !== consumed.telegramUserId) {
          request.log.warn(
            { outcome: OAuthErrorCode.TelegramUserMismatch },
            "the callback came from a Telegram user other than the state's owner",
          );
          await push(request.log, consumed.telegramUserId, { kind: LinkPushKind.Mismatch });
          return reply.code(403).send({ error: OAuthErrorCode.TelegramUserMismatch });
        }

        let tokens;
        try {
          tokens = await deps.broker.exchangeCode({
            code: parsed.data.code,
            redirectUri: consumed.redirectUri,
          });
        } catch (error) {
          const { status, code } = brokerOutcome(error, OAuthErrorCode.InvalidCode);
          // the only place the broker's own verdict is visible: the response carries a code,
          // not a reason
          request.log.warn(
            { status, outcome: code, err: errorIdentity(error) },
            'the authorization code could not be exchanged',
          );
          // the state is spent, so the message says to start over rather than to retry
          await push(request.log, consumed.telegramUserId, { kind: LinkPushKind.ExchangeFailed });
          return reply.code(status).send({ error: code });
        }

        const linked = await linkBrokerAccount(deps.db, {
          telegramUserId: consumed.telegramUserId,
          tokens,
          cipher: deps.cipher,
          activate: false,
        });
        if (!linked.ok) {
          const blocked = linked.reason === 'user_blocked';
          // to the Telegram user who started this login, never to the account's owner
          await push(request.log, consumed.telegramUserId, {
            kind: blocked ? LinkPushKind.Blocked : LinkPushKind.Taken,
          });
          return reply.code(409).send({
            error: blocked ? OAuthErrorCode.UserBlocked : OAuthErrorCode.BrokerAccountTaken,
          });
        }
        // the push and the response read one projection of the row, so they agree on the address
        const account = toBrokerAccountView(linked.account);
        // one button, for the account this login linked; any other waiting link is /start's
        await push(
          request.log,
          consumed.telegramUserId,
          account.status === BrokerAccountStatus.Pending
            ? { kind: LinkPushKind.Pending, account: { id: account.id, email: account.email } }
            : { kind: LinkPushKind.Active },
        );
        return reply.send({ account });
      },
    );
  });
};

// 400 belongs to the caller's own mistake, and only a refused grant is one: a bad code, or an
// address the broker will not take. A rejection or a malformed body means our client id, secret
// or contract is wrong, which is a 502: the caller did nothing it could do differently. One
// function for every route, so the status and the code cannot drift.
function brokerOutcome(
  error: unknown,
  invalidGrantCode: OAuthErrorCode,
): { status: number; code: string } {
  if (!(error instanceof BrokerOAuthError)) {
    return { status: 502, code: OAuthErrorCode.BrokerUnavailable };
  }
  switch (error.code) {
    case BrokerOAuthErrorCode.InvalidGrant:
      return { status: 400, code: invalidGrantCode };
    case BrokerOAuthErrorCode.ContractViolation:
    case BrokerOAuthErrorCode.Rejected:
      return { status: 502, code: OAuthErrorCode.BrokerContractViolation };
    default:
      return { status: 502, code: OAuthErrorCode.BrokerUnavailable };
  }
}
