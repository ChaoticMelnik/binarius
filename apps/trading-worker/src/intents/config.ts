import { BROKER_REST_TIMEOUT_MS } from '@binarius/broker-rest';
import { H1_ENTRY_WINDOW_SEC } from '@binarius/shared';
import {
  ACCESS_SKEW_MS,
  ACCESS_TOKEN_CACHE_TTL_MS,
  ACCESS_TOKEN_ROUTE_BUDGET_MS,
} from '@binarius/shared/access-token';
import { WORKER_BROKER_GETS_PER_MINUTE } from '@binarius/shared/broker-budget';
import {
  BROKER_SOCKET_COMMAND_TIMEOUT_MS,
  BROKER_SOCKET_CONNECT_TIMEOUT_MS,
  isTimerMs,
} from '@binarius/broker-socket';
import { SESSION_STOP_BUDGET_MS, SESSION_TICK_MS } from '../broker/session-config';
import { WORKER_HEARTBEAT_MS, WORKER_HEARTBEAT_TIMEOUT_MS } from '../fleet/config';
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
// The entry's hold (#836, docs/h1.md -> The entry) runs inside the same job before the take, so
// every link that waits out a submit counts INTENT_HOLD_MAX_MS ahead of it:
//   INTENT_HOLD_MAX_MS + MAX_SUBMIT_ACK_TIMEOUT_MS < SHUTDOWN_PHASE1_BUDGET_MS
// A side link: BROKER_REST_TIMEOUT_MS < SHUTDOWN_PHASE1_BUDGET_MS, so a job that makes a broker
// REST call without a deadline of its own still finishes inside the drain. The constant is the
// REST client's own (packages/broker-rest/src/rest.ts).
// The submit deadline's floor (#96):
//   BROKER_SOCKET_COMMAND_TIMEOUT_MS < MIN_SUBMIT_ACK_TIMEOUT_MS and BROKER_REST_TIMEOUT_MS
//     < MIN_SUBMIT_ACK_TIMEOUT_MS ≤ MAX_SUBMIT_ACK_TIMEOUT_MS — the transports' own timeouts end a
//     submit the broker left unanswered before the processor's deadline can: the circuit breaker
//     counts the broker's silence only as the transport's own result, and a submit cut by the
//     deadline's signal is not counted (circuit-breaker/observe-executor.ts)
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
//   2 × ACCESS_TOKEN_ROUTE_BUDGET_MS + BROKER_REST_TIMEOUT_MS < RECONCILE_ATTEMPT_TIMEOUT_MS and
//     < CATCHUP_ATTEMPT_TIMEOUT_MS - a 401 on the first page and the report of its token (#281)
//     fit one attempt. A 401 on a later page (the token refused mid-attempt) can outlast it
//     (34 s and 24 s): the report is cut by the attempt's signal, and the next attempt meets the
//     401 on its first page and reports in time (stated)
//   RECONCILE_GETS_PER_ATTEMPT + BALANCE_CHECK_GETS + CATCHUP_GETS_PER_ATTEMPT
//     ≤ WORKER_BROKER_GETS_PER_MINUTE - one attempt of each loop and one balance check fit the
//     runtime GET budget's window (#872, below), or a loop would never start
// The balance check after a reconciliation outcome (#92) adds these:
//   2 × ACCESS_TOKEN_ROUTE_BUDGET_MS + BROKER_REST_TIMEOUT_MS < BALANCE_CHECK_TIMEOUT_MS - the
//     token, the one GET and, on a 401, the report of the refused token (#281) fit a check
//   BALANCE_CHECK_TIMEOUT_MS < SHUTDOWN_PHASE1_BUDGET_MS - phase 1 waits for pass.stop(); no
//     check starts after stop(), so it waits for the attempt or the check in flight, never both
// The token cache (#868, broker/access-token.ts) adds one:
//   ACCESS_TOKEN_CACHE_TTL_MS < ACCESS_SKEW_MS - the backend hands out a token only with more than
//     ACCESS_SKEW_MS left, so a cached one still has ACCESS_SKEW_MS - ACCESS_TOKEN_CACHE_TTL_MS left
//     by its stored expiry when it goes out
// The session manager (#101, broker/session-config.ts) adds these:
//   INTENT_HOLD_MAX_MS + MAX_SUBMIT_ACK_TIMEOUT_MS + SESSION_STOP_BUDGET_MS
//     + WORKER_HEARTBEAT_TIMEOUT_MS < SHUTDOWN_PHASE1_BUDGET_MS — the manager stops after the intents consumer drained, and the
//     fleet registry deregisters after it (#94, its own bound), inside the same phase-1 step
//   BROKER_SOCKET_CONNECT_TIMEOUT_MS < SHUTDOWN_PHASE1_BUDGET_MS and ACCESS_TOKEN_ROUTE_BUDGET_MS
//     < SHUTDOWN_PHASE1_BUDGET_MS — a connection attempt or a token fetch that stop() could not
//     cut still ends inside phase 1 (stop() aborts the fetches and closes the clients at once:
//     the worst case, not the normal one)
//   SESSION_TICK_MS < SHUTDOWN_PHASE1_BUDGET_MS — the scan in flight ends inside phase 1
// The trading session orchestrator (#287, trading-session/config.ts) adds one:
//   TRADING_SESSION_ATTEMPT_TIMEOUT_MS < SHUTDOWN_PHASE1_BUDGET_MS — phase 1 waits for its stop()
//     alongside the other steps: one batch at most (#871)
// The intent router (#347, intents/router.ts) adds these:
//   INTENT_HOLD_MAX_MS + MAX_SUBMIT_ACK_TIMEOUT_MS + 2 × INTENT_ROUTER_STOP_BUDGET_MS
//     < SHUTDOWN_PHASE1_BUDGET_MS — the own queue's consumer waits out a hold and a submit, and the drain starts before its cut (notAfter =
//     the phase-1 start + SHUTDOWN_PHASE1_BUDGET_MS - 2 × INTENT_ROUTER_STOP_BUDGET_MS), so one
//     move pass and the final one always run
//   2 × INTENT_ROUTER_STOP_BUDGET_MS < SHUTDOWN_PHASE1_BUDGET_MS — the router's stop ends by
//     notAfter + INTENT_ROUTER_STOP_BUDGET_MS, inside phase 1, whatever the deregister does
//   WORKER_HEARTBEAT_MS + WORKER_HEARTBEAT_TIMEOUT_MS + INTENT_ROUTER_DRAIN_POLL_MS
//     < INTENT_ROUTER_DRAIN_TAIL_MS — the tail after our deregister outlasts every peer's view of
//     us, and its last pass sees a forward that landed up to a poll before it ends
//   INTENT_ROUTER_DRAIN_POLL_MS < INTENT_ROUTER_STOP_BUDGET_MS — a poll's sleep never outlives the
//     final pass's budget
//   the whole tail fits before notAfter for SUBMIT_ACK_TIMEOUT_MS ≤ 16 s (the default 10 s with
//     the hold: 2 + 10 + 2 + 2 + 9 ≤ 31, stated, pinned by literal in intents/config.test.ts); above that, a stop
//     that meets a submit waiting out nearly its deadline cuts the tail with a warn line
//   INTENT_RECOVERY_DELAY_MS, INTENT_ROUTER_STOP_BUDGET_MS, INTENT_ROUTER_DRAIN_POLL_MS and
//     INTENT_ROUTER_DRAIN_TAIL_MS are timer delays (BullMQ's delay, a timer)
//   INTENT_RECOVERY_DELAY_MS < the backend publisher's staleQueuedMs (30 s) and < INTENT_MAX_AGE_MS's
//     default (60 s) — stated across processes, pinned by literal in intents/config.test.ts
export const MIN_SUBMIT_ACK_TIMEOUT_MS = 6_000;
export const MAX_SUBMIT_ACK_TIMEOUT_MS = 28_000;
export const SHUTDOWN_PHASE1_BUDGET_MS = 35_000;
export const SHUTDOWN_PHASE2_BUDGET_MS = 4_000;
export const COMPOSE_STOP_GRACE_PERIOD_MS = 40_000;
export const LOCK_DURATION_MS = 60_000;
export const STALLED_INTERVAL_MS = 30_000;
export const MAX_STALLED_COUNT = 1;
export const STALE_SUBMITTING_MS = 60_000;
// the longest entry's hold before the take (#836): the entry delay (1 s) plus room for the clock
// difference between the backend and the worker; a longer wait is a wrong row, clamped with a warn
export const INTENT_HOLD_MAX_MS = H1_ENTRY_WINDOW_SEC.to * 1_000;

// how long a forwarded intent may wait in its owner's queue before the forwarder takes it itself
// (#347, the insurance job in the forwarder's own queue)
export const INTENT_RECOVERY_DELAY_MS = 20_000;
// bounds router.stop() after its drain was cut: the final move pass, the obliterate of the own
// queue and the queues' close
export const INTENT_ROUTER_STOP_BUDGET_MS = 2_000;
// the drain's interval between move passes of the own queue at a clean stop
export const INTENT_ROUTER_DRAIN_POLL_MS = 250;
// how long the drain goes on after our deregister settled
export const INTENT_ROUTER_DRAIN_TAIL_MS = 9_000;

export const SWEEP_INTERVAL_MS = 15_000;
export const SWEEP_BATCH_SIZE = 50;

// bounds one IntentReconciler.reconcile() call: the token, then up to two pages of each list
export const RECONCILE_ATTEMPT_TIMEOUT_MS = 30_000;
// the lease: how long a claimed reconciling intent is not a candidate again
export const RECONCILE_RETRY_MS = 60_000;
// the pass interval
export const RECONCILE_TICK_MS = 15_000;
// candidates per tick, attempted one after another: the cap on a tick's length; the broker GETs
// are bounded by the runtime budget (broker/get-budget.ts), not by the batch
export const RECONCILE_BATCH_SIZE = 16;
// one balance check after a reconciliation outcome (#92): the token, one GET /v1/broker/user, the
// report of a refused token on a 401, and three autocommit statements
export const BALANCE_CHECK_TIMEOUT_MS = 20_000;

// The matching window on a trade's open_timestamp around the intent's submitted_at, inclusive on
// both sides (docs/trade-intent-transport.md -> Reconciliation matching)
export const RECONCILE_WINDOW_BEFORE_MS = 60_000;
export const RECONCILE_WINDOW_AFTER_MS = 90_000;
export const RECONCILE_TRADES_PAGE_SIZE = 50;
export const RECONCILE_MAX_TRADE_PAGES = 2;

// The settlement catch-up (#90): accepted intents past their expected close + the grace. Sized
// for the demo's 5 and 15 s trades (#313): with no close event a trade settles 10-15 s after its
// close. 16 accounts a tick (one accepted intent per account, Rule 7); the broker GETs are bounded
// by the runtime budget (broker/get-budget.ts).
export const CATCHUP_TICK_MS = 5_000;
export const CATCHUP_GRACE_MS = 10_000;
export const CATCHUP_BATCH_SIZE = 16;
export const CATCHUP_TRADES_PAGE_SIZE = 50;
export const CATCHUP_MAX_TRADE_PAGES = 2;
export const CATCHUP_ATTEMPT_TIMEOUT_MS = 20_000;
// asking 10 s after the close can find the trade still open at the broker; a longer hold-back
// would make the user wait minutes for a 5 s trade
export const CATCHUP_STALLED_RETRY_MS = 30_000;

// The broker allows 600 requests a minute per IP; the worker's share, WORKER_BROKER_GETS_PER_MINUTE,
// sits with the backend's two in packages/shared/src/broker-budget.ts. The worker keeps to its
// share at runtime (#872, broker/get-budget.ts): the catch-up and the reconciliation pass reserve
// an attempt's worst case before its first GET, and a reservation that does not fit the last 60 s
// ends the tick. The reservations follow the page caps: an attempt reads at most maxPages pages of
// each list (readTradePages), and a balance check makes one GET /v1/broker/user. A 429 ends a tick,
// and the attempt is retried on the lease or the next tick. A 429 on /user-auth/refresh during an
// exchange on the backend is the refusal refresh_rate_limited: nothing is revoked, the caller asks
// again later (#275). The worker's share keeps its own traffic from driving the IP to 429; the sum
// with the backend's configured ceilings above their defaults is a warning at the backend's start,
// not enforced.
export const RECONCILE_GETS_PER_ATTEMPT = 2 * RECONCILE_MAX_TRADE_PAGES;
export const BALANCE_CHECK_GETS = 1;
export const CATCHUP_GETS_PER_ATTEMPT = CATCHUP_MAX_TRADE_PAGES;

// the chain above is the invariant; a constant edited out of order fails at import, not in prod
const TIMING_CHAIN_HOLDS =
  BROKER_SOCKET_COMMAND_TIMEOUT_MS < MIN_SUBMIT_ACK_TIMEOUT_MS &&
  BROKER_REST_TIMEOUT_MS < MIN_SUBMIT_ACK_TIMEOUT_MS &&
  MIN_SUBMIT_ACK_TIMEOUT_MS <= MAX_SUBMIT_ACK_TIMEOUT_MS &&
  MAX_SUBMIT_ACK_TIMEOUT_MS < SHUTDOWN_PHASE1_BUDGET_MS &&
  INTENT_HOLD_MAX_MS + MAX_SUBMIT_ACK_TIMEOUT_MS < SHUTDOWN_PHASE1_BUDGET_MS &&
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
  2 * ACCESS_TOKEN_ROUTE_BUDGET_MS + BROKER_REST_TIMEOUT_MS < RECONCILE_ATTEMPT_TIMEOUT_MS &&
  2 * ACCESS_TOKEN_ROUTE_BUDGET_MS + BROKER_REST_TIMEOUT_MS < CATCHUP_ATTEMPT_TIMEOUT_MS &&
  RECONCILE_GETS_PER_ATTEMPT + BALANCE_CHECK_GETS + CATCHUP_GETS_PER_ATTEMPT <=
    WORKER_BROKER_GETS_PER_MINUTE &&
  2 * ACCESS_TOKEN_ROUTE_BUDGET_MS + BROKER_REST_TIMEOUT_MS < BALANCE_CHECK_TIMEOUT_MS &&
  BALANCE_CHECK_TIMEOUT_MS < SHUTDOWN_PHASE1_BUDGET_MS &&
  INTENT_HOLD_MAX_MS +
    MAX_SUBMIT_ACK_TIMEOUT_MS +
    SESSION_STOP_BUDGET_MS +
    WORKER_HEARTBEAT_TIMEOUT_MS <
    SHUTDOWN_PHASE1_BUDGET_MS &&
  BROKER_SOCKET_CONNECT_TIMEOUT_MS < SHUTDOWN_PHASE1_BUDGET_MS &&
  ACCESS_TOKEN_ROUTE_BUDGET_MS < SHUTDOWN_PHASE1_BUDGET_MS &&
  SESSION_TICK_MS < SHUTDOWN_PHASE1_BUDGET_MS &&
  TRADING_SESSION_ATTEMPT_TIMEOUT_MS < SHUTDOWN_PHASE1_BUDGET_MS &&
  INTENT_HOLD_MAX_MS + MAX_SUBMIT_ACK_TIMEOUT_MS + 2 * INTENT_ROUTER_STOP_BUDGET_MS <
    SHUTDOWN_PHASE1_BUDGET_MS &&
  2 * INTENT_ROUTER_STOP_BUDGET_MS < SHUTDOWN_PHASE1_BUDGET_MS &&
  WORKER_HEARTBEAT_MS + WORKER_HEARTBEAT_TIMEOUT_MS + INTENT_ROUTER_DRAIN_POLL_MS <
    INTENT_ROUTER_DRAIN_TAIL_MS &&
  INTENT_ROUTER_DRAIN_POLL_MS < INTENT_ROUTER_STOP_BUDGET_MS &&
  ACCESS_TOKEN_CACHE_TTL_MS < ACCESS_SKEW_MS &&
  isTimerMs(ACCESS_TOKEN_CACHE_TTL_MS) &&
  isTimerMs(INTENT_RECOVERY_DELAY_MS) &&
  isTimerMs(INTENT_ROUTER_STOP_BUDGET_MS) &&
  isTimerMs(INTENT_ROUTER_DRAIN_POLL_MS) &&
  isTimerMs(INTENT_ROUTER_DRAIN_TAIL_MS);
if (!TIMING_CHAIN_HOLDS) {
  throw new Error('trading-worker timing constants are out of order (see intents/config.ts)');
}
