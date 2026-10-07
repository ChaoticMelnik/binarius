import type { FastifyPluginAsync } from 'fastify';
import { BOT_TEXTS_PATH, type BotTextOverridesResponse } from '@binarius/shared';
import { listBotTextOverrides } from '@binarius/db';
import { internalBearerAuth } from '../auth/internal';
import type { UsersRoutesDeps } from '../users/routes';

// The bot's read of the text overrides (#299, docs/bot-texts.md → Loading): every row, as the
// three fields the resolver needs, and the bot resolves them itself.
export const botTextsRoutes: FastifyPluginAsync<UsersRoutesDeps> = async (
  app,
  { db, internalApiToken },
) => {
  app.addHook('onRequest', internalBearerAuth(internalApiToken));
  app.get(BOT_TEXTS_PATH, async (): Promise<BotTextOverridesResponse> => {
    const rows = await listBotTextOverrides(db);
    return { overrides: rows.map(({ key, source, version }) => ({ key, source, version })) };
  });
};
