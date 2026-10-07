import { BROKER_REST_TIMEOUT_MS } from '@binarius/broker-rest';
import { ACCESS_TOKEN_ROUTE_BUDGET_MS } from '@binarius/shared/access-token';
import { SESSION_STOP_BUDGET_MS, SESSION_TICK_MS } from '../broker/session-config';
import { BROKER_SOCKET_CONNECT_TIMEOUT_MS } from '../broker/socket-config';
import { TRADING_SESSION_ATTEMPT_TIMEOUT_MS } from '../trading-session/config';

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
// The REST reconciler and the settlement catch-up (#90) add these:
//   ACCESS_TOKEN_ROUTE_BUDGET_MS + 2 lists × RECONCILE_MAX_TRADE_PAGES × BROKER_REST_TIMEOUT_MS
//     < RECONCILE_ATTEMPT_TIMEOUT_MS — the token and every page fit one attempt
//   MAX_SUBMIT_ACK_TIMEOUT_MS < RECONCILE_WINDOW_AFTER_MS and BROKER_REST_TIMEOUT_MS <
//     RECONCILE_WINDOW_AFTER_MS — a trade the broker opened on a late ack or a late REST answer
//     still falls inside the window
//   ACCESS_TOKEN_ROUTE_BUDGET_MS + CATCHUP_MAX_TRADE_PAGES × BROKER_REST_TIMEOUT_MS
//     < CATCHUP_ATTEMPT_TIMEOUT_MS < SHUTDOWN_PHASE1_BUDGET_MS — phase 1 waits for catchup.stop()
//     alongside pass.stop() (closeAll runs the steps at once)
//   BROKER_REST_TIMEOUT_MS < CATCHUP_GRACE_MS; CATCHUP_TICK_MS < CATCHUP_STALLED_RETRY_MS — a
//     held-back account misses at least one tick
//   the worst case of broker GETs a minute ≤ WORKER_BROKER_GETS_PER_MINUTE (below)
// The session manager (#101, broker/session-config.ts) adds these:
//   MAX_SUBMIT_ACK_TIMEOUT_MS + SESSION_STOP_BUDGET_MS < SHUTDOWN_PHASE1_BUDGET_MS — the manager
//     stops after the intents consumer drained, inside the same phase-1 step
//   BROKER_SOCKET_CONNECT_TIMEOUT_MS < SHUTDOWN_PHASE1_BUDGET_MS and ACCESS_TOKEN_ROUTE_BUDGET_MS
//     < SHUTDOWN_PHASE1_BUDGET_MS — a connection attempt or a token fetch that stop() could not
//     cut still ends inside phase 1 (stop() aborts the fetches and closes the clients at once:
//     the worst case, not the normal one)
//   SESSION_TICK_MS < SHUTDOWN_PHASE1_BUDGET_MS — the scan in flight ends inside phase 1
// The trading session orchestrator (#287, trading-session/config.ts) adds one:
//   TRADING_SESSION_ATTEMPT_TIMEOUT_MS < SHUTDOWN_PHASE1_BUDGET_MS — phase 1 waits for its stop()
//     alongside the other steps: one attempt at most
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

// bounds one IntentReconciler.reconcile() call: the token, then up to two pages of each list
export const RECONCILE_ATTEMPT_TIMEOUT_MS = 30_000;
// the lease: how long a claimed reconciling intent is not a candidate again
export const RECONCILE_RETRY_MS = 60_000;
// the pass interval
export const RECONCILE_TICK_MS = 15_000;
// candidates per tick, attempted one after another. 20, not 50: each attempt may make four broker
// GETs, and the worker's share of the IP's rate limit is WORKER_BROKER_GETS_PER_MINUTE
export const RECONCILE_BATCH_SIZE = 20;

// The matching window on a trade's open_timestamp around the intent's submitted_at, inclusive on
// both sides (docs/trade-intent-transport.md -> Reconciliation matching)
export const RECONCILE_WINDOW_BEFORE_MS = 60_000;
export const RECONCILE_WINDOW_AFTER_MS = 90_000;
export const RECONCILE_TRADES_PAGE_SIZE = 50;
export const RECONCILE_MAX_TRADE_PAGES = 2;

// The settlement catch-up (#90): accepted intents past their expected close + the grace
export const CATCHUP_TICK_MS = 30_000;
export const CATCHUP_GRACE_MS = 30_000;
export const CATCHUP_BATCH_SIZE = 20;
export const CATCHUP_TRADES_PAGE_SIZE = 50;
export const CATCHUP_MAX_TRADE_PAGES = 2;
export const CATCHUP_ATTEMPT_TIMEOUT_MS = 20_000;
export const CATCHUP_STALLED_RETRY_MS = 120_000;

// The broker allows 600 requests a minute per IP (BROKER_RATE_LIMIT_PER_MINUTE in
// apps/backend/src/timing.ts); the backend's balance refresh takes up to 200 by default. The worker
// keeps to the rest in the worst case: its passes tick only on their intervals (nothing starts an
// extra tick), and a tick never overlaps the next. A 429 ends a tick, and the attempt is retried on
// the lease or the next tick. Its one real cost is a refresh exchange in flight on the backend: a
// 429 on /user-auth/refresh is classified rejected → refresh_outcome_unknown → the account is
// revoked (Rule 12, one attempt). The worker's share keeps its own traffic from driving the IP to
// 429; the sum with the backend's with BALANCE_POLL_MAX_PER_MINUTE above 200 is stated, not
// enforced.
export const WORKER_BROKER_GETS_PER_MINUTE = 400;
export const WORKER_BROKER_GETS_WORST_CASE =
  RECONCILE_BATCH_SIZE * 2 * RECONCILE_MAX_TRADE_PAGES * (60_000 / RECONCILE_TICK_MS) +
  CATCHUP_BATCH_SIZE * CATCHUP_MAX_TRADE_PAGES * (60_000 / CATCHUP_TICK_MS);

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
  RECONCILE_TICK_MS <= RECONCILE_RETRY_MS &&
  ACCESS_TOKEN_ROUTE_BUDGET_MS + 2 * RECONCILE_MAX_TRADE_PAGES * BROKER_REST_TIMEOUT_MS <
    RECONCILE_ATTEMPT_TIMEOUT_MS &&
  MAX_SUBMIT_ACK_TIMEOUT_MS < RECONCILE_WINDOW_AFTER_MS &&
  BROKER_REST_TIMEOUT_MS < RECONCILE_WINDOW_AFTER_MS &&
  ACCESS_TOKEN_ROUTE_BUDGET_MS + CATCHUP_MAX_TRADE_PAGES * BROKER_REST_TIMEOUT_MS <
    CATCHUP_ATTEMPT_TIMEOUT_MS &&
  CATCHUP_ATTEMPT_TIMEOUT_MS < SHUTDOWN_PHASE1_BUDGET_MS &&
  BROKER_REST_TIMEOUT_MS < CATCHUP_GRACE_MS &&
  CATCHUP_TICK_MS < CATCHUP_STALLED_RETRY_MS &&
  WORKER_BROKER_GETS_WORST_CASE <= WORKER_BROKER_GETS_PER_MINUTE &&
  MAX_SUBMIT_ACK_TIMEOUT_MS + SESSION_STOP_BUDGET_MS < SHUTDOWN_PHASE1_BUDGET_MS &&
  BROKER_SOCKET_CONNECT_TIMEOUT_MS < SHUTDOWN_PHASE1_BUDGET_MS &&
  ACCESS_TOKEN_ROUTE_BUDGET_MS < SHUTDOWN_PHASE1_BUDGET_MS &&
  SESSION_TICK_MS < SHUTDOWN_PHASE1_BUDGET_MS &&
  TRADING_SESSION_ATTEMPT_TIMEOUT_MS < SHUTDOWN_PHASE1_BUDGET_MS;
if (!TIMING_CHAIN_HOLDS) {
  throw new Error('trading-worker timing constants are out of order (see intents/config.ts)');
}
