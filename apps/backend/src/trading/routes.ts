import type { FastifyPluginAsync } from 'fastify';
import * as z from 'zod';
import {
  errorIdentity,
  TradeIntentErrorCode,
  safeParseCreateTradeIntentRequest,
  type TradeIntentErrorCode as ErrorCode,
} from '@binarius/shared';
import {
  TradeIntentError,
  createTradeIntent,
  getTradeIntentView,
  toTradeIntentView,
  type Db,
} from '@binarius/db';
import { internalBearerAuth } from '../auth/internal';

export interface TradingRoutesDeps {
  db: Db;
  internalApiToken: string;
  // called after the creating transaction committed; a throw is logged, never surfaced
  onIntentQueued: () => void;
}

const NOT_FOUND_CODES: ReadonlySet<ErrorCode> = new Set([
  TradeIntentErrorCode.UserNotFound,
  TradeIntentErrorCode.BrokerAccountNotFound,
]);

const statusOf = (code: ErrorCode): number => (NOT_FOUND_CODES.has(code) ? 404 : 409);

const idParamSchema = z.uuid();

// Registered as an encapsulated plugin so the auth hook covers exactly these routes
export const tradingRoutes: FastifyPluginAsync<TradingRoutesDeps> = async (
  app,
  { db, internalApiToken, onIntentQueued },
) => {
  app.addHook('onRequest', internalBearerAuth(internalApiToken));

  app.post('/trading/intents', async (request, reply) => {
    const parsed = safeParseCreateTradeIntentRequest(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation', issues: parsed.error.issues });
    }
    let result;
    try {
      result = await createTradeIntent(db, parsed.data);
    } catch (error) {
      if (error instanceof TradeIntentError) {
        return reply.code(statusOf(error.code)).send({ error: error.code });
      }
      throw error;
    }
    if (result.created) {
      try {
        onIntentQueued();
      } catch (error) {
        request.log.warn(
          { err: errorIdentity(error) },
          'publisher wake failed, the poll will pick the row up',
        );
      }
    }
    return reply
      .code(result.created ? 201 : 200)
      .send({ intent: toTradeIntentView(result.intent, parsed.data.telegramUserId) });
  });

  app.get('/trading/intents/:id', async (request, reply) => {
    const id = idParamSchema.safeParse((request.params as { id?: unknown }).id);
    if (!id.success) return reply.code(404).send({ error: 'not_found' });
    const view = await getTradeIntentView(db, id.data);
    if (view === undefined) return reply.code(404).send({ error: 'not_found' });
    return reply.send({ intent: view });
  });
};
