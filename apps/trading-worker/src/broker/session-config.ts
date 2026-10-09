import { BALANCE_WATCH_WINDOW_MS } from '@binarius/shared/broker-balance';
import { isTimerMs } from './socket-config';

// The session manager's constants (docs/broker-session.md → Constants), each bounding one thing:
//   SESSION_TICK_MS            — the candidate scan interval: one query and the bookkeeping; the
//                                starts run in the start pool, never inside a tick
//   SESSION_IDLE_GRACE_MS      — how long a session outlives its account's last appearance among
//                                the candidates
//   SESSION_RETRY_MS           — the hold-back after a transient failure: the backend unreachable
//                                or answering a status, refresh_needed, the same token after
//                                token_expired/auth_failed, disconnected_by_server, a throw out of
//                                a start
//   SESSION_REFUSAL_RETRY_MS   — the hold-back after a durable refusal: account_*, user_blocked,
//                                key_unavailable, a user.data whose id is not the account's
//   SESSION_START_CONCURRENCY  — token fetches in flight in the start pool
//   SESSION_STOP_BUDGET_MS     — how long stop() waits for the writes in flight
//   MAX_SESSIONS_PER_WORKER    — sessions (running + starting) one worker process holds; beyond
//                                it accounts trade over REST. A safety cap, not a measured limit
//                                (#94 replaces it with one and with sharding)
//   SESSION_LEASE_TTL_MS       — how long an account's lease outlives its last acquire or renewal
//                                in the database (#93, broker-session.md → The lease)
//   SESSION_LEASE_RENEW_MS     — the renewal interval
//   SESSION_LEASE_FENCE_MS     — how long after sending an acquire or a renewal the process trusts
//                                it; past it the socket is closed
// The chain: an account missing from one scan is not closed (TICK < IDLE_GRACE); a held-back
// account skips at least one tick (TICK < RETRY ≤ REFUSAL_RETRY); an account the bot asked about
// keeps its session for the whole watch window (IDLE_GRACE < BALANCE_WATCH_WINDOW_MS); one failed
// renewal does not fence, and the fence closes the socket before the database lets anyone else in
// (2 × LEASE_RENEW < LEASE_FENCE < LEASE_TTL); an account busy under another owner is asked again
// only once that lease could have lapsed (LEASE_TTL < RETRY); every *_MS is an integer in
// [1, MAX_TIMER_MS]. The links to the shutdown budget are in intents/config.ts.
export const SESSION_TICK_MS = 5_000;
export const SESSION_IDLE_GRACE_MS = 60_000;
export const SESSION_RETRY_MS = 60_000;
export const SESSION_REFUSAL_RETRY_MS = 300_000;
export const SESSION_START_CONCURRENCY = 4;
export const SESSION_STOP_BUDGET_MS = 2_000;
export const SESSION_LEASE_TTL_MS = 30_000;
export const SESSION_LEASE_RENEW_MS = 10_000;
export const SESSION_LEASE_FENCE_MS = 25_000;
// how long a session write that threw waits for its dead letter (#92): below the stop budget, so
// stop() never waits on Redis longer than on the write itself
export const DEAD_LETTER_WRITE_TIMEOUT_MS = 1_000;
export const MAX_SESSIONS_PER_WORKER = 500;

export interface SessionManagerConfig {
  tickMs: number;
  idleGraceMs: number;
  retryMs: number;
  refusalRetryMs: number;
  maxSessions: number;
  startConcurrency: number;
  stopBudgetMs: number;
  watchWindowMs: number;
  leaseTtlMs: number;
  leaseRenewMs: number;
  leaseFenceMs: number;
}

export const SESSION_MANAGER_CONFIG: Readonly<SessionManagerConfig> = {
  tickMs: SESSION_TICK_MS,
  idleGraceMs: SESSION_IDLE_GRACE_MS,
  retryMs: SESSION_RETRY_MS,
  refusalRetryMs: SESSION_REFUSAL_RETRY_MS,
  maxSessions: MAX_SESSIONS_PER_WORKER,
  startConcurrency: SESSION_START_CONCURRENCY,
  stopBudgetMs: SESSION_STOP_BUDGET_MS,
  watchWindowMs: BALANCE_WATCH_WINDOW_MS,
  leaseTtlMs: SESSION_LEASE_TTL_MS,
  leaseRenewMs: SESSION_LEASE_RENEW_MS,
  leaseFenceMs: SESSION_LEASE_FENCE_MS,
};

const isCount = (value: number) => Number.isSafeInteger(value) && value >= 1;

export function sessionManagerConfigHolds(config: SessionManagerConfig): boolean {
  return (
    isTimerMs(config.tickMs) &&
    isTimerMs(config.idleGraceMs) &&
    isTimerMs(config.retryMs) &&
    isTimerMs(config.refusalRetryMs) &&
    isTimerMs(config.stopBudgetMs) &&
    isTimerMs(config.watchWindowMs) &&
    isTimerMs(config.leaseTtlMs) &&
    isTimerMs(config.leaseRenewMs) &&
    isTimerMs(config.leaseFenceMs) &&
    isCount(config.maxSessions) &&
    isCount(config.startConcurrency) &&
    config.tickMs < config.idleGraceMs &&
    config.tickMs < config.retryMs &&
    config.retryMs <= config.refusalRetryMs &&
    config.idleGraceMs < config.watchWindowMs &&
    2 * config.leaseRenewMs < config.leaseFenceMs &&
    config.leaseFenceMs < config.leaseTtlMs &&
    config.leaseTtlMs < config.retryMs
  );
}

// a constant edited out of order fails at import, not in production
export const SESSION_CHAIN_HOLDS =
  sessionManagerConfigHolds(SESSION_MANAGER_CONFIG) &&
  DEAD_LETTER_WRITE_TIMEOUT_MS < SESSION_STOP_BUDGET_MS;
if (!SESSION_CHAIN_HOLDS) {
  throw new Error('broker session constants are out of order (see broker/session-config.ts)');
}
