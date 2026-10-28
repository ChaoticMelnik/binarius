import type { PairsCatalog } from '@binarius/broker-rest';
import type { FastifyPluginAsync } from 'fastify';
import {
  errorLogFields,
  safeParseTradingSignalRequest,
  SignalFeedOutcome,
  TRADING_SIGNAL_PATH,
  TradingSignalErrorCode,
  type H1SignalWire,
  type TradingSignalResponse,
} from '@binarius/shared';
import type { CachedSignalFeed, SignalEvaluation } from '@binarius/signal';
import { internalBearerAuth } from '../auth/internal';
import type { H1Scanner } from '../h1/scanner';

export interface SignalRoutesDeps {
  feed: Pick<CachedSignalFeed, 'evaluate'>;
  // the pair's digits for the tick floor (#379)
  catalog: Pick<PairsCatalog, 'read'>;
  internalApiToken: string;
  // the analysis reminder's fact (#484): setLastAnalysis; false = no users row
  lastAnalysis: {
    set(
      telegramUserId: bigint,
      analysis: { assetId: number; durationSec: number } | null,
    ): Promise<boolean>;
  };
  // the pair's H1 signal (#828); undefined without the data socket: `h1` is then always null
  h1: Pick<H1Scanner, 'current'> | undefined;
  now?: () => number;
}

// Named fields only: the evaluation also carries the journal series and the request facts, which
// stay in the feed's log lines.
export function toTradingSignalResponse(
  evaluation: SignalEvaluation,
  h1: H1SignalWire | null,
): TradingSignalResponse {
  if (evaluation.outcome === SignalFeedOutcome.Decided) {
    return {
      outcome: SignalFeedOutcome.Decided,
      params: evaluation.entry.params,
      decision: evaluation.entry.decision,
      ...(evaluation.indicators === undefined ? {} : { indicators: evaluation.indicators }),
      h1,
    };
  }
  return {
    outcome: SignalFeedOutcome.FetchFailed,
    code: evaluation.code,
    ...(evaluation.retryAfterSec === undefined ? {} : { retryAfterSec: evaluation.retryAfterSec }),
    h1,
  };
}

// An encapsulated plugin so the auth hook covers exactly this route. A broker failure is a 200
// with an outcome (docs/signal.md -> POST /trading/signal); a throw is the app's opaque 500. The
// pair is looked up in the pairs cache before any chart GET, for its digits; whether it is open or
// accepts a duration is the caller's check (an analysis of a closed pair stays allowed). Every
// answer carries `h1`, the pair's H1 signal read right after the feed answered (#828): an H1
// signal lives a second and the feed may take up to SIGNAL_FETCH_BUDGET_MS. With `analysis` (the
// bot's analysis card, #484) the answer is recorded as the user's last analysis by `h1`, on both
// outcomes: an H1 signal with its pair and duration, none as none - the card the bot draws is the
// H1 one. The record is best-effort: its failure is logged and the decision is answered all the
// same.
export const signalRoutes: FastifyPluginAsync<SignalRoutesDeps> = async (
  app,
  { feed, catalog, internalApiToken, lastAnalysis, h1: scanner, now = Date.now },
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
    // every decision this route answers is replayable from its own journal line (#405)
    const evaluation = await feed.evaluate(
      { assetId: parsed.data.assetId, interval: parsed.data.interval, digits: pair.digits },
      { journal: true },
    );
    const h1 = scanner?.current(parsed.data.assetId, now()) ?? null;
    const { analysis } = parsed.data;
    if (analysis !== undefined) {
      try {
        await lastAnalysis.set(
          BigInt(analysis.telegramUserId),
          h1 === null ? null : { assetId: parsed.data.assetId, durationSec: analysis.durationSec },
        );
      } catch (error) {
        request.log.warn(errorLogFields(error), 'last analysis not recorded');
      }
    }
    return reply.send(toTradingSignalResponse(evaluation, h1));
  });
};
