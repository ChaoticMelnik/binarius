import type { BrokerTrade } from '@binarius/shared';
import type { TradeIntentRow } from '@binarius/db';

export const ReconcileUnavailableReason = {
  // no reconciler is wired yet (#90 replaces notConfiguredReconciler)
  NotConfigured: 'not_configured',
  TokenUnavailable: 'token_unavailable',
  BrokerUnavailable: 'broker_unavailable',
  // ends the pass's tick: the rest of the candidates would only be refused too
  RateLimited: 'rate_limited',
  // produced by the pass itself when an attempt outlives its deadline
  Timeout: 'timeout',
} as const;
export type ReconcileUnavailableReason =
  (typeof ReconcileUnavailableReason)[keyof typeof ReconcileUnavailableReason];

export type ReconcileResult =
  // the broker's own record of this intent's trade, open or closed, as parsed by shared
  | { outcome: 'found'; trade: BrokerTrade }
  // confidently absent: this releases the token, so it is answered only when the absence is
  // certain (the rule is the implementation's, #90)
  | { outcome: 'not_found' }
  // more than one candidate trade
  | { outcome: 'ambiguous' }
  // nothing learned; the intent stays reconciling and is retried after the lease
  | { outcome: 'unavailable'; reason: ReconcileUnavailableReason };

// Learns what became of an unknown intent's order. Only reads: it never opens a trade, so a
// reconciliation can never become the second order of the two-cases rule (#91).
export interface IntentReconciler {
  reconcile(intent: TradeIntentRow, signal: AbortSignal): Promise<ReconcileResult>;
}

export const notConfiguredReconciler: IntentReconciler = {
  reconcile: () =>
    Promise.resolve({ outcome: 'unavailable', reason: ReconcileUnavailableReason.NotConfigured }),
};
