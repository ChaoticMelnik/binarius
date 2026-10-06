import {
  TradeIntentFailureReason,
  TradeMode,
  type OpenTrade,
  type TradeTransport,
} from '@binarius/shared';
import type { TradeIntentRow, TradePolicy } from '@binarius/db';
import type { Env } from '../env';

export type SubmitResult =
  | { outcome: 'accepted'; transport: TradeTransport; trade: OpenTrade }
  | { outcome: 'rejected'; reason: TradeIntentFailureReason; detail?: string }
  | { outcome: 'unknown'; reason: TradeIntentFailureReason; detail?: string };

// The port createTradeCommandExecutor (#100) implements. Contract:
// - resolve with an explicit outcome; `rejected` only when the order certainly did not open,
//   `unknown` whenever it may have (sent, then no answer);
// - `accepted` carries the broker's open trade as received (open_trade.success or the REST
//   body), never a locally built one: the processor checks it against the intent and stores it
//   (#17), and a trade that does not match turns the intent unknown (trade_mismatch);
// - stop waiting when `signal` aborts (the processor enforces its own deadline regardless);
// - `detail` is for logs only: no tokens, no raw broker payloads.
// A throw is treated as `unknown`: the processor cannot know whether the order went out. Only
// the error's name and code reach the log, never its message or stack — a client library's
// error can embed headers or a response body — so a throw carries no diagnostic detail; put
// that in `detail` of an explicit `unknown` result instead.
export interface TradeExecutor {
  submit(intent: TradeIntentRow, signal: AbortSignal): Promise<SubmitResult>;
}

// until ARCH-01 lands, every intent is refused before anything reaches a broker
export const notConfiguredExecutor: TradeExecutor = {
  submit: async () => ({
    outcome: 'rejected',
    reason: TradeIntentFailureReason.ExecutorNotConfigured,
  }),
};

// The outermost layer over any executor (#134): with the grant off,
// a real intent is rejected without the inner executor being called. `rejected`, because nothing
// was sent to the broker.
export function realTradingGate(inner: TradeExecutor, policy: TradePolicy): TradeExecutor {
  return {
    submit: async (intent, signal) => {
      if (intent.mode === TradeMode.Real && !policy.realTradingEnabled) {
        return { outcome: 'rejected', reason: TradeIntentFailureReason.RealTradingDisabled };
      }
      return inner.submit(intent, signal);
    },
  };
}

// The worker's one production composition and the one place the parsed env becomes a policy:
// the gate stays outside the trade command executor (#134 review, Minor 2).
export function buildExecutor(
  env: Pick<Env, 'realTradingEnabled'>,
  inner: TradeExecutor,
): TradeExecutor {
  return realTradingGate(inner, { realTradingEnabled: env.realTradingEnabled });
}
