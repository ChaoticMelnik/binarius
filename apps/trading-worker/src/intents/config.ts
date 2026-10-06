import { BROKER_REST_TIMEOUT_MS } from '@binarius/broker-rest';

// The worker's time constants form one chain, and every link has a reason:
//   SUBMIT_ACK_TIMEOUT_MS ≤ MAX_SUBMIT_ACK_TIMEOUT_MS  — env cap on how long one submit may wait
//   < SHUTDOWN_PHASE1_BUDGET_MS                         — a SIGTERM during a submit waits it out
//   + SHUTDOWN_PHASE2_BUDGET_MS < stop_grace_period     — the process is never SIGKILLed mid-write
//   < LOCK_DURATION_MS                                  — a live job never loses its BullMQ lock
//   ≤ STALE_SUBMITTING_MS                               — nobody calls a live job's intent unknown
// A job holds its lock for LOCK_DURATION_MS (renewed while the processor runs); a worker that
// dies mid-job has its job redelivered after the lock lapses, and the redelivery — like the
// sweeper — declares the intent unknown only once it has been submitting for STALE_SUBMITTING_MS.
// The phase-1 budget covers the ack deadline plus the outcome write; a database that times out
// every statement is the exit(1) path (intent left submitting, resolved by the sweeper).
// A side link: BROKER_REST_TIMEOUT_MS < SHUTDOWN_PHASE1_BUDGET_MS, so a job that makes a broker
// REST call without a deadline of its own still finishes inside the drain. It is deliberately not
// ordered against SUBMIT_ACK_TIMEOUT_MS: the processor passes its own signal, and a REST call ends
// at the earlier of the two (docs/broker-rest.md). The constant is the REST client's own
// (packages/broker-rest/src/rest.ts).
// The reconciliation pass (#89) adds three links:
//   BROKER_REST_TIMEOUT_MS < RECONCILE_ATTEMPT_TIMEOUT_MS < RECONCILE_RETRY_MS — one REST call fits
//     an attempt, and a live attempt is never re-claimed by another replica's lease check
//   RECONCILE_ATTEMPT_TIMEOUT_MS < SHUTDOWN_PHASE1_BUDGET_MS — phase 1 waits for pass.stop(), the
//     attempt in flight plus its outcome write
//   RECONCILE_TICK_MS ≤ RECONCILE_RETRY_MS — a lapsed lease is picked up within one interval
export const MAX_SUBMIT_ACK_TIMEOUT_MS = 30_000;
export const SHUTDOWN_PHASE1_BUDGET_MS = 35_000;
export const SHUTDOWN_PHASE2_BUDGET_MS = 4_000;
export const COMPOSE_STOP_GRACE_PERIOD_MS = 40_000;
export const LOCK_DURATION_MS = 60_000;
export const STALLED_INTERVAL_MS = 30_000;
export const MAX_STALLED_COUNT = 1;
export const STALE_SUBMITTING_MS = 60_000;

export const SWEEP_INTERVAL_MS = 15_000;
export const SWEEP_BATCH_SIZE = 50;

// bounds one IntentReconciler.reconcile() call
export const RECONCILE_ATTEMPT_TIMEOUT_MS = 20_000;
// the lease: how long a claimed reconciling intent is not a candidate again
export const RECONCILE_RETRY_MS = 60_000;
// the pass interval
export const RECONCILE_TICK_MS = 15_000;
// candidates per tick, attempted one after another
export const RECONCILE_BATCH_SIZE = 50;

// the chain above is the invariant; a constant edited out of order fails at import, not in prod
export const TIMING_CHAIN_HOLDS =
  MAX_SUBMIT_ACK_TIMEOUT_MS < SHUTDOWN_PHASE1_BUDGET_MS &&
  SHUTDOWN_PHASE1_BUDGET_MS + SHUTDOWN_PHASE2_BUDGET_MS < COMPOSE_STOP_GRACE_PERIOD_MS &&
  COMPOSE_STOP_GRACE_PERIOD_MS < LOCK_DURATION_MS &&
  LOCK_DURATION_MS <= STALE_SUBMITTING_MS &&
  BROKER_REST_TIMEOUT_MS < SHUTDOWN_PHASE1_BUDGET_MS &&
  BROKER_REST_TIMEOUT_MS < RECONCILE_ATTEMPT_TIMEOUT_MS &&
  RECONCILE_ATTEMPT_TIMEOUT_MS < RECONCILE_RETRY_MS &&
  RECONCILE_ATTEMPT_TIMEOUT_MS < SHUTDOWN_PHASE1_BUDGET_MS &&
  RECONCILE_TICK_MS <= RECONCILE_RETRY_MS;
if (!TIMING_CHAIN_HOLDS) {
  throw new Error('trading-worker timing constants are out of order (see intents/config.ts)');
}
