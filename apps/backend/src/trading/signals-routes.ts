import type { FastifyPluginAsync } from 'fastify';
import {
  H1_EXPIRY_SEC,
  intervalForDuration,
  TRADING_SIGNALS_PATH,
  type TradingSignalsResponse,
} from '@binarius/shared';
import { internalBearerAuth } from '../auth/internal';
import { EMPTY_H1_SCANNER_LIST, type H1Scanner } from '../h1/scanner';

export interface SignalsRoutesDeps {
  // the H1 scanner (#828); undefined without the data socket (no BROKER_WS_URL): an empty list
  scanner: Pick<H1Scanner, 'fresh'> | undefined;
  internalApiToken: string;
  now?: () => number;
}

// Named fields only (Rule 9). One list, keyed by the H1 trade's interval, which is the list the
// bot reads for its one duration (#685).
function toTradingSignalsResponse(
  scanner: SignalsRoutesDeps['scanner'],
  nowMs: number,
): TradingSignalsResponse {
  const list = scanner?.fresh(nowMs) ?? EMPTY_H1_SCANNER_LIST;
  return {
    asOf: nowMs,
    lists: [
      {
        interval: intervalForDuration(H1_EXPIRY_SEC),
        scanned: list.scanned,
        summary: {
          streaming: list.summary.streaming,
          scanning: list.summary.scanning,
          closeness: list.summary.closeness.map(({ assetId, pct }) => ({ assetId, pct })),
        },
        signals: list.signals.map(({ assetId, action, second, decidedAt, ageMs }) => ({
          assetId,
          action,
          second,
          decidedAt,
          ageMs,
        })),
      },
    ],
  };
}

// docs/signal.md -> GET /trading/signals, docs/h1.md -> The scanner and the signals list. An
// encapsulated plugin so the auth hook covers exactly this route.
export const signalsRoutes: FastifyPluginAsync<SignalsRoutesDeps> = async (
  app,
  { scanner, internalApiToken, now = Date.now },
) => {
  app.addHook('onRequest', internalBearerAuth(internalApiToken));

  app.get(TRADING_SIGNALS_PATH, async (_request, reply) =>
    reply.send(toTradingSignalsResponse(scanner, now())),
  );
};
