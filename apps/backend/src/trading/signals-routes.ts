import type { FastifyPluginAsync } from 'fastify';
import {
  SIGNAL_SCAN_INTERVAL,
  TRADING_SIGNALS_PATH,
  type TradingSignalsResponse,
} from '@binarius/shared';
import { internalBearerAuth } from '../auth/internal';
import { freshSignals, type ScanSnapshot, type SignalScanner } from '../signal/scanner';

export interface SignalsRoutesDeps {
  scanner: Pick<SignalScanner, 'snapshot'>;
  internalApiToken: string;
  now?: () => number;
}

// Named fields only (Rule 9): the snapshot also carries no_signal entries, which stay inside.
function toTradingSignalsResponse(snapshot: ScanSnapshot, nowMs: number): TradingSignalsResponse {
  return {
    asOf: nowMs,
    interval: SIGNAL_SCAN_INTERVAL,
    scanned: snapshot.scanned.length,
    signals: freshSignals(snapshot, nowMs).map(
      ({ assetId, action, lastCandleTimestamp, decidedAt, ageMs }) => ({
        assetId,
        action,
        lastCandleTimestamp,
        decidedAt,
        ageMs,
      }),
    ),
  };
}

// docs/signal.md -> GET /trading/signals. An encapsulated plugin so the auth hook covers exactly
// this route.
export const signalsRoutes: FastifyPluginAsync<SignalsRoutesDeps> = async (
  app,
  { scanner, internalApiToken, now = Date.now },
) => {
  app.addHook('onRequest', internalBearerAuth(internalApiToken));

  app.get(TRADING_SIGNALS_PATH, async (_request, reply) =>
    reply.send(toTradingSignalsResponse(scanner.snapshot(), now())),
  );
};
