import type { BrokerTrade } from '@binarius/shared';
import type { TradeIntentRow } from '@binarius/db';

export const ReconcileUnavailableReason = {
  // nothing that can answer is wired behind the reconciler (a stub in the pass's own tests)
  NotConfigured: 'not_configured',
  // the backend refused the token (blocked user, revoked account, ...) or the broker answered 401
  TokenUnavailable: 'token_unavailable',
  BrokerUnavailable: 'broker_unavailable',
  // ends the pass's tick: the rest of the candidates would only be refused too
  RateLimited: 'rate_limited',
  // produced by the pass itself when an attempt outlives its deadline
  Timeout: 'timeout',
  // the backend's token route did not answer usefully (#90)
  BackendUnavailable: 'backend_unavailable',
  // the broker refused the list request or its pages break the newest-first order
  BrokerContract: 'broker_contract',
  // no candidate yet, and the window is still open by the database clock
  WindowOpen: 'window_open',
  // the page cap ran out before the pages reached past the window's start
  WindowNotCovered: 'window_not_covered',
} as const;
export type ReconcileUnavailableReason =
  (typeof ReconcileUnavailableReason)[keyof typeof ReconcileUnavailableReason];

export type ReconcileResult =
  // the broker's own record of this intent's trade, open or closed, as parsed by shared
  | { outcome: 'found'; trade: BrokerTrade }
  // confidently absent: this releases the token. No reconciler in main answers it; proving
  // absence at the broker is #274
  | { outcome: 'not_found' }
  // no candidate once the window closed, absence not proven: parked for the operator (#90)
  | { outcome: 'unresolved' }
  // more than one candidate trade
  | { outcome: 'ambiguous' }
  // nothing learned; the intent stays reconciling and is retried after the lease
  | { outcome: 'unavailable'; reason: ReconcileUnavailableReason };

// Learns what became of an unknown intent's order. Only reads: it never opens a trade, so a
// reconciliation can never become the second order of the two-cases rule (#91).
export interface IntentReconciler {
  reconcile(intent: TradeIntentRow, signal: AbortSignal): Promise<ReconcileResult>;
}
