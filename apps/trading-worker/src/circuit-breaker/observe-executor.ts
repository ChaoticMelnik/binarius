import type { TradeIntentRow } from '@binarius/db';
import { TradeIntentFailureReason } from '@binarius/shared';
import type { TradeExecutor } from '../intents/executor';
import type { CircuitBreaker } from './breaker';

// The REST/submit signal (#96): every submit's answer goes to the breaker. Sent and left without
// an answer by the broker (unknown, broker_unavailable) is a failure; an accepted or a rejected
// order is an answer. A throw is a bug, not the broker: it passes on unchanged and counts nothing.
// The executor itself is not touched (Rule 15).
export function observeExecutor(
  executor: TradeExecutor,
  breaker: Pick<CircuitBreaker, 'rest'>,
): TradeExecutor {
  return {
    async submit(intent: TradeIntentRow, signal: AbortSignal) {
      const result = await executor.submit(intent, signal);
      if (result.outcome === 'unknown') {
        // another unknown reason is not the broker's silence; none exists today
        if (result.reason === TradeIntentFailureReason.BrokerUnavailable) {
          breaker.rest(intent.id, true);
        }
      } else {
        breaker.rest(intent.id, false);
      }
      return result;
    },
  };
}
