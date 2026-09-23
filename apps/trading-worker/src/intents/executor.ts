import { TradeIntentFailureReason, type TradeTransport } from '@binarius/shared';
import type { TradeIntentRow } from '@binarius/db';

export type SubmitResult =
  | { outcome: 'accepted'; transport?: TradeTransport }
  | { outcome: 'rejected'; reason: TradeIntentFailureReason; detail?: string }
  | { outcome: 'unknown'; reason: TradeIntentFailureReason; detail?: string };

// The port ARCH-01 (#40) implements with the broker socket client. Contract:
// - resolve with an explicit outcome; `rejected` only when the order certainly did not open,
//   `unknown` whenever it may have (sent, then no answer);
// - stop waiting when `signal` aborts (the processor enforces its own deadline regardless);
// - `detail` is for logs only: no tokens, no raw broker payloads.
// A throw is treated as `unknown`: the processor cannot know whether the order went out.
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
