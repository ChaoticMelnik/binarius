import { DEFAULT_PUBLISHER_CONFIG } from './outbox/publisher';

// Phase 1 waits for app.close() (requests in flight) and publisher.stop() (the row in flight:
// claim, add under its deadline, outcome, commit). The budget covers that Redis deadline plus
// ordinary database latency. It does not bound a database that times out every statement
// (query_timeout 1.8 s each) or a request that hangs: those end in exit(1) with the transaction
// rolled back and the outbox row replayed on the next start. compose's stop_grace_period for
// the backend sits above both phases together.
export const SHUTDOWN_PHASE1_BUDGET_MS = 10_000;
export const SHUTDOWN_PHASE2_BUDGET_MS = 4_000;
export const COMPOSE_STOP_GRACE_PERIOD_MS = 20_000;

export const TIMING_CHAIN_HOLDS =
  DEFAULT_PUBLISHER_CONFIG.publishTimeoutMs < SHUTDOWN_PHASE1_BUDGET_MS &&
  SHUTDOWN_PHASE1_BUDGET_MS + SHUTDOWN_PHASE2_BUDGET_MS < COMPOSE_STOP_GRACE_PERIOD_MS;
if (!TIMING_CHAIN_HOLDS) {
  throw new Error('backend shutdown timing constants are out of order (see timing.ts)');
}
