import type { FastifyPluginAsync } from 'fastify';
import { safeParseUserStartRequest } from '@binarius/shared';
import { recordUserStart, toUserStartView, type Db } from '@binarius/db';
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
    const { row, hasActiveBrokerAccount } = await recordUserStart(db, {
      telegramUserId: BigInt(parsed.data.telegramUserId),
      displayName: parsed.data.displayName,
      languageCode: parsed.data.languageCode,
      startPayload: parsed.data.startPayload,
    });
    return reply.send({ user: toUserStartView(row, hasActiveBrokerAccount) });
  });
};
