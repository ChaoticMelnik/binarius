import type { PairsCatalog } from '@binarius/broker-rest';
import type { FastifyPluginAsync } from 'fastify';
import {
  safeParseTradingSignalRequest,
  SignalFeedOutcome,
  TRADING_SIGNAL_PATH,
  TradingSignalErrorCode,
  type TradingSignalResponse,
} from '@binarius/shared';
import type { CachedSignalFeed, SignalEvaluation } from '@binarius/signal';
import { internalBearerAuth } from '../auth/internal';

export interface SignalRoutesDeps {
  feed: Pick<CachedSignalFeed, 'evaluate'>;
  // the pair's digits for the tick floor (#379)
  catalog: Pick<PairsCatalog, 'read'>;
  internalApiToken: string;
}

// Named fields only: the evaluation also carries the journal series and the request facts, which
// stay in the feed's log lines.
export function toTradingSignalResponse(evaluation: SignalEvaluation): TradingSignalResponse {
  if (evaluation.outcome === SignalFeedOutcome.Decided) {
    return {
      outcome: SignalFeedOutcome.Decided,
      params: evaluation.entry.params,
      decision: evaluation.entry.decision,
    };
  }
  return {
    outcome: SignalFeedOutcome.FetchFailed,
    code: evaluation.code,
    ...(evaluation.retryAfterSec === undefined ? {} : { retryAfterSec: evaluation.retryAfterSec }),
  };
}

// An encapsulated plugin so the auth hook covers exactly this route. A broker failure is a 200
// with an outcome (docs/signal.md -> POST /trading/signal); a throw is the app's opaque 500. The
// pair is looked up in the pairs cache before any chart GET, for its digits; whether it is open or
// accepts a duration is the caller's check (an analysis of a closed pair stays allowed).
export const signalRoutes: FastifyPluginAsync<SignalRoutesDeps> = async (
  app,
  { feed, catalog, internalApiToken },
) => {
  app.addHook('onRequest', internalBearerAuth(internalApiToken));

  app.post(TRADING_SIGNAL_PATH, async (request, reply) => {
    const parsed = safeParseTradingSignalRequest(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation', issues: parsed.error.issues });
    }
    const view = catalog.read();
    if (view === undefined || !view.fresh) {
      return reply.code(503).send({ error: TradingSignalErrorCode.CatalogUnavailable });
    }
    const pair = view.pairs.find((candidate) => candidate.id === parsed.data.assetId);
    if (pair === undefined) {
      return reply.code(409).send({ error: TradingSignalErrorCode.PairUnknown });
    }
    const evaluation = await feed.evaluate({
      assetId: parsed.data.assetId,
      interval: parsed.data.interval,
      digits: pair.digits,
    });
    return reply.send(toTradingSignalResponse(evaluation));
  });
};
