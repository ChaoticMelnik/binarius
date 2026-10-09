import { SESSION_TICK_MS } from '../broker/session-config';
import {
  BROKER_SOCKET_AUTH_TIMEOUT_MS,
  BROKER_SOCKET_CONNECT_TIMEOUT_MS,
  BROKER_SOCKET_RECONNECT_DELAY_MAX_MS,
  BROKER_SOCKET_RECONNECT_JITTER,
} from '../broker/socket-config';

// The circuit breaker's constants (#96, docs/runbook-broker-outage.md), each bounding one thing:
//   CIRCUIT_BREAKER_WINDOW_MS       — how far back failures count (env CIRCUIT_BREAKER_WINDOW_MS)
//   CIRCUIT_BREAKER_MIN_FAILURES    — the absolute floor: fewer failed keys never trip
//                                     (env CIRCUIT_BREAKER_MIN_FAILURES)
//   CIRCUIT_BREAKER_FAILURE_PERCENT — the share of failed keys in the window that trips
//                                     (env CIRCUIT_BREAKER_FAILURE_PERCENT, integer 1-100)
//   SOCKET_LOSS_GRACE_MS            — how long a session that was ready may stay not ready
//                                     before it counts as lost (no env)
// The chain: one full worst-case reconnect never counts as a loss, so a broker restart that
// reconnects everyone does not trip (ONE_RECONNECT_MS < SOCKET_LOSS_GRACE_MS); the manager's tick
// sees a loss within the grace, and a loss counts inside the window
// (SESSION_TICK_MS < SOCKET_LOSS_GRACE_MS < CIRCUIT_BREAKER_WINDOW_MS); an env override is held to
// the same chain (env.ts).
export const CIRCUIT_BREAKER_WINDOW_MS = 120_000;
export const CIRCUIT_BREAKER_MIN_FAILURES = 10;
export const CIRCUIT_BREAKER_FAILURE_PERCENT = 50;
export const SOCKET_LOSS_GRACE_MS = 45_000;
// the env bounds: an hour of window, a floor no deployment needs above
export const MAX_CIRCUIT_BREAKER_WINDOW_MS = 3_600_000;
export const MAX_CIRCUIT_BREAKER_MIN_FAILURES = 10_000;

// the longest wait before the next attempt, then that attempt's connect and auth
export const ONE_RECONNECT_MS =
  BROKER_SOCKET_RECONNECT_DELAY_MAX_MS * (1 + BROKER_SOCKET_RECONNECT_JITTER) +
  BROKER_SOCKET_CONNECT_TIMEOUT_MS +
  BROKER_SOCKET_AUTH_TIMEOUT_MS;

// the numeric bounds of the three thresholds are env.ts's; the chain is the ordering
const chainHolds =
  ONE_RECONNECT_MS < SOCKET_LOSS_GRACE_MS &&
  SESSION_TICK_MS < SOCKET_LOSS_GRACE_MS &&
  SOCKET_LOSS_GRACE_MS < CIRCUIT_BREAKER_WINDOW_MS;
if (!chainHolds) {
  throw new Error('circuit breaker constants are out of order (see circuit-breaker/config.ts)');
}
