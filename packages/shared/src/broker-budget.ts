// docs/signal.md -> The budget. The broker counts every request from one IP against one window,
// observed live without a token on 2026-10-03 and on /v1/broker/chart on 2026-10-08:
// x-ratelimit-limit 600 per 60 s. Three loops share it, each bounded on its own; nothing counts
// them together at run time, so their defaults are held to the limit here, at import.
export const BROKER_RATE_LIMIT_PER_MINUTE = 600;

// the trading worker's passes in their worst case (apps/trading-worker/src/intents/config.ts holds
// its own worst case under this)
export const WORKER_BROKER_GETS_PER_MINUTE = 400;
// the backend's balance refresh (BALANCE_POLL_MAX_PER_MINUTE overrides it)
export const DEFAULT_BALANCE_POLL_PER_MINUTE = 100;
// the backend's signal scanner (SIGNAL_SCAN_MAX_PER_MINUTE overrides it)
export const DEFAULT_SIGNAL_SCAN_PER_MINUTE = 100;

export const BROKER_BUDGET_HOLDS =
  WORKER_BROKER_GETS_PER_MINUTE +
    DEFAULT_BALANCE_POLL_PER_MINUTE +
    DEFAULT_SIGNAL_SCAN_PER_MINUTE <=
  BROKER_RATE_LIMIT_PER_MINUTE;
if (!BROKER_BUDGET_HOLDS) {
  throw new Error('the broker budget shares exceed the per-IP limit (see broker-budget.ts)');
}

// What the three loops may send a minute together under the backend's configured ceilings. Above
// BROKER_RATE_LIMIT_PER_MINUTE it is an operator's choice the backend warns about at start; the
// scanner's pause on a 429 is the backstop.
export function brokerGetsPerMinute(ceilings: {
  balancePollPerMinute: number;
  signalScanPerMinute: number;
}): number {
  return (
    WORKER_BROKER_GETS_PER_MINUTE + ceilings.balancePollPerMinute + ceilings.signalScanPerMinute
  );
}
