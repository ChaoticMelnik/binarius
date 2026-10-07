import type { FastifyPluginAsync } from 'fastify';
import {
  TelegramChatMemberStatus,
  UserErrorCode,
  safeParseChatMemberRequest,
  safeParseNotificationLevelRequest,
  safeParseUserAccountRequest,
  safeParseUserStartRequest,
} from '@binarius/shared';
import {
  markTelegramBlocked,
  markTelegramReachable,
  readUserAccounts,
  recordUserStart,
  setNotificationLevel,
  toUserAccountView,
  toUserStartView,
  type Db,
} from '@binarius/db';
import { internalBearerAuth } from '../auth/internal';

export interface UsersRoutesDeps {
  db: Db;
  internalApiToken: string;
}

// Registered as an encapsulated plugin so the auth hook covers exactly these routes
export const usersRoutes: FastifyPluginAsync<UsersRoutesDeps> = async (
  app,
  { db, internalApiToken },
) => {
  app.addHook('onRequest', internalBearerAuth(internalApiToken));

  // What the bot calls on every /start: it records the user (and, on the first payload, where
  // they came from) and answers with what the welcome screen branches on.
  app.post('/users/start', async (request, reply) => {
    const parsed = safeParseUserStartRequest(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation', issues: parsed.error.issues });
    }
    const { row, hasActiveBrokerAccount, pendingBrokerAccounts } = await recordUserStart(db, {
      telegramUserId: BigInt(parsed.data.telegramUserId),
      displayName: parsed.data.displayName,
      languageCode: parsed.data.languageCode,
      startPayload: parsed.data.startPayload,
    });
    return reply.send({
      user: toUserStartView(row, hasActiveBrokerAccount, pendingBrokerAccounts),
    });
  });

  // The bot forwards a private-chat my_chat_member update: `kicked` when the user blocked it,
  // `member` when they unblocked it (#119). An id with no users row is answered, not inserted.
  // The log line carries no Telegram id, as the push's does not.
  app.post('/users/chat-member', async (request, reply) => {
    const parsed = safeParseChatMemberRequest(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation', issues: parsed.error.issues });
    }
    const telegramUserId = BigInt(parsed.data.telegramUserId);
    if (parsed.data.status === TelegramChatMemberStatus.Kicked) {
      const marked = await markTelegramBlocked(db, telegramUserId);
      const recorded = marked !== undefined;
      request.log.info(
        { recorded, canceledJobs: marked?.canceledJobs ?? 0 },
        'the user blocked the bot',
      );
      return reply.send({ recorded });
    }
    const recorded = await markTelegramReachable(db, telegramUserId);
    request.log.info({ recorded }, 'the user unblocked the bot');
    return reply.send({ recorded });
  });

  // The user picked a level in /settings (#120). Like the chat-member route, the log line carries
  // no Telegram id.
  app.post('/users/notification-level', async (request, reply) => {
    const parsed = safeParseNotificationLevelRequest(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation', issues: parsed.error.issues });
    }
    const set = await setNotificationLevel(
      db,
      BigInt(parsed.data.telegramUserId),
      parsed.data.level,
    );
    if (set === undefined) {
      return reply.code(404).send({ error: UserErrorCode.UserNotFound });
    }
    // not `level`: that key is pino's own, and a second one would replace it in the JSON line
    request.log.info(
      { notificationLevel: set.level, canceledJobs: set.canceledJobs },
      'notification level set',
    );
    return reply.send({ level: set.level, demoStake: set.demoStake });
  });

  // What the bot's /account shows; reads only. An unknown user is a 404 of its own code, so the
  // bot can tell "no row yet" from a backend without this route (a bare 404 `not_found`).
  app.post('/users/account', async (request, reply) => {
    const parsed = safeParseUserAccountRequest(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation', issues: parsed.error.issues });
    }
    const snapshot = await readUserAccounts(db, BigInt(parsed.data.telegramUserId));
    if (snapshot === undefined) {
      return reply.code(404).send({ error: UserErrorCode.UserNotFound });
    }
    return reply.send({ user: toUserAccountView(snapshot) });
  });
};
