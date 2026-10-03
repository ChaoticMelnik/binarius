import type { FastifyPluginAsync } from 'fastify';
import {
  PairsCatalogErrorCode,
  TRADING_PAIRS_PATH,
  toPairsCatalogResponse,
} from '@binarius/shared';
import type { PairsCatalog } from '@binarius/broker-rest';
import { internalBearerAuth } from '../auth/internal';

export interface PairsRoutesDeps {
  catalog: Pick<PairsCatalog, 'read'>;
  internalApiToken: string;
}

// Registered as an encapsulated plugin so the auth hook covers exactly this route. A read of the
// in-process cache: no database, no broker call on the request path.
export const pairsRoutes: FastifyPluginAsync<PairsRoutesDeps> = async (
  app,
  { catalog, internalApiToken },
) => {
  app.addHook('onRequest', internalBearerAuth(internalApiToken));

  app.get(TRADING_PAIRS_PATH, async (_request, reply) => {
    const view = catalog.read();
    if (view === undefined) {
      return reply.code(503).send({ error: PairsCatalogErrorCode.Unavailable });
    }
    return reply.send(toPairsCatalogResponse(view));
  });
};
