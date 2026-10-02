import type { FastifyPluginAsync } from 'fastify';
import {
  TelegramChatMemberStatus,
  safeParseChatMemberRequest,
  safeParseUserStartRequest,
} from '@binarius/shared';
import {
  markTelegramBlocked,
  markTelegramReachable,
  recordUserStart,
  toUserStartView,
  type Db,
} from '@binarius/db';
import { internalBearerAuth } from '../auth/internal';

export interface UsersRoutesDeps {
  db: Db;
  internalApiToken: string;
}

// Registered as an encapsulated plugin so the auth hook covers exactly this route
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
};
