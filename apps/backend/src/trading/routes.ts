import type { FastifyPluginAsync } from 'fastify';
import * as z from 'zod';
import {
  ACCESS_TOKEN_PATH,
  errorIdentity,
  TradeIntentErrorCode,
  safeParseAccessTokenRequest,
  safeParseCreateTradeIntentRequest,
  telegramUserIdSchema,
  type AccessTokenRefusal,
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
import type { AccessTokenOptions, AccessTokenResult } from '../auth/token-service';
import { registerTradingAccess, type TradingAccessDeps } from './access';

export interface TradingRoutesDeps {
  db: Db;
  internalApiToken: string;
  // called after the creating transaction committed; a throw is logged, never surfaced
  onIntentQueued: () => void;
  // POST /trading/access refreshes the broker balance through it
  balance: TradingAccessDeps['balance'];
  // REAL_TRADING_ENABLED: whether a real intent may be created at all (#134)
  realTradingEnabled: boolean;
  // POST /trading/accounts/:id/access-token hands the worker a token through it (#90)
  accessToken: (accountId: string, options: AccessTokenOptions) => Promise<AccessTokenResult>;
}

type Refusal = Extract<AccessTokenResult, { ok: false }>['reason'];

// annotated by the backend's union and checked against the wire enum: a code added on either side
// alone fails the typecheck
const REFUSAL_STATUS: Record<Refusal, 404 | 409> = {
  account_not_found: 404,
  user_blocked: 409,
  account_pending: 409,
  account_revoked: 409,
  key_unavailable: 409,
  refresh_needed: 409,
} satisfies Record<AccessTokenRefusal, 404 | 409>;

const NOT_FOUND_CODES: ReadonlySet<ErrorCode> = new Set([
  TradeIntentErrorCode.UserNotFound,
  TradeIntentErrorCode.BrokerAccountNotFound,
]);

const statusOf = (code: ErrorCode): number => (NOT_FOUND_CODES.has(code) ? 404 : 409);

const idParamSchema = z.uuid();
// the owner of the intent (#127): the bot reads an id it took from a button's callback data
const readIntentQuerySchema = z.object({ telegramUserId: telegramUserIdSchema });

// Registered as an encapsulated plugin so the auth hook covers exactly these routes
export const tradingRoutes: FastifyPluginAsync<TradingRoutesDeps> = async (
  app,
  { db, internalApiToken, onIntentQueued, balance, realTradingEnabled, accessToken },
) => {
  app.addHook('onRequest', internalBearerAuth(internalApiToken));
  registerTradingAccess(app, { db, balance, realTradingEnabled });

  app.post('/trading/intents', async (request, reply) => {
    const parsed = safeParseCreateTradeIntentRequest(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation', issues: parsed.error.issues });
    }
    let result;
    try {
      result = await createTradeIntent(db, parsed.data, { realTradingEnabled });
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

  // Neither body is logged: the answer is a live broker token (docs/binodex-oauth.md -> Refresh).
  app.post(ACCESS_TOKEN_PATH, async (request, reply) => {
    const id = idParamSchema.safeParse((request.params as { id?: unknown }).id);
    if (!id.success) return reply.code(404).send({ error: 'account_not_found' });
    const parsed = safeParseAccessTokenRequest(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation', issues: parsed.error.issues });
    }
    const result = await accessToken(id.data, { mayRefresh: parsed.data.mayRefresh });
    if (!result.ok) return reply.code(REFUSAL_STATUS[result.reason]).send({ error: result.reason });
    return reply.send({ accessToken: result.accessToken });
  });

  app.get('/trading/intents/:id', async (request, reply) => {
    const id = idParamSchema.safeParse((request.params as { id?: unknown }).id);
    if (!id.success) return reply.code(404).send({ error: 'not_found' });
    const query = readIntentQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: 'validation', issues: query.error.issues });
    }
    // another user's id answers exactly as a missing one, so an id's existence is not answerable
    const view = await getTradeIntentView(db, id.data, BigInt(query.data.telegramUserId));
    if (view === undefined) return reply.code(404).send({ error: 'not_found' });
    return reply.send({ intent: view });
  });
};
