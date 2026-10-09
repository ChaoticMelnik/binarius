import type { FastifyPluginAsync } from 'fastify';
import {
  SIGNAL_SCAN_INTERVALS,
  TRADING_SIGNALS_PATH,
  type TradingSignalsResponse,
} from '@binarius/shared';
import { internalBearerAuth } from '../auth/internal';
import { freshSignals, type ScanSnapshot, type SignalScanner } from '../signal/scanner';

export interface SignalsRoutesDeps {
  // one per interval of SIGNAL_SCAN_INTERVALS (#382)
  scanners: readonly Pick<SignalScanner, 'snapshot'>[];
  internalApiToken: string;
  now?: () => number;
}

// Named fields only (Rule 9): the snapshot also carries no_signal entries, which stay inside. The
// lists follow SIGNAL_SCAN_INTERVALS, whatever order the scanners came in.
function toTradingSignalsResponse(
  snapshots: readonly ScanSnapshot[],
  nowMs: number,
): TradingSignalsResponse {
  return {
    asOf: nowMs,
    lists: SIGNAL_SCAN_INTERVALS.flatMap((interval) =>
      snapshots
        .filter((snapshot) => snapshot.interval === interval)
        .map((snapshot) => ({
          interval,
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
        })),
    ),
  };
}

// docs/signal.md -> GET /trading/signals. An encapsulated plugin so the auth hook covers exactly
// this route.
export const signalsRoutes: FastifyPluginAsync<SignalsRoutesDeps> = async (
  app,
  { scanners, internalApiToken, now = Date.now },
) => {
  app.addHook('onRequest', internalBearerAuth(internalApiToken));

  app.get(TRADING_SIGNALS_PATH, async (_request, reply) =>
    reply.send(
      toTradingSignalsResponse(
        scanners.map((scanner) => scanner.snapshot()),
        now(),
      ),
    ),
  );
};
