// Test-only: imported by the worker's own tests and by packages/e2e through ./e2e, never by a
// runtime module. One copy, so a new WorkerTuning field reaches every composition a test builds.

import { BROKER_REST_TIMEOUT_MS } from '@binarius/broker-rest';
import type { MockBroker } from '@binarius/mock-broker';
import { SESSION_MAX_DURATION_MS, SESSION_NO_SIGNAL_CANDLES } from '@binarius/shared';
import type { WorkerTuning } from './worker';

// a composition's submit deadline: above the socket command and the REST client's own timeout, below
// phase 1, as MAX_SUBMIT_ACK_TIMEOUT_MS < SHUTDOWN_PHASE1_BUDGET_MS in production (intents/config.ts),
// so a SIGTERM during a submit waits for it
export const TEST_SUBMIT_ACK_TIMEOUT_MS = 8_000;

// production's order and chains, with the waits a test can afford; the lease itself keeps
// production's TTL and fence, so no lease lapses inside a case
export const TEST_WORKER_TUNING: Partial<WorkerTuning> = {
  sessions: {
    tickMs: 100,
    idleGraceMs: 60_000,
    retryMs: 300,
    refusalRetryMs: 1_500,
    maxSessions: 50,
    startConcurrency: 4,
    stopBudgetMs: 1_000,
    watchWindowMs: 600_000,
    leaseTtlMs: 30_000,
    leaseRenewMs: 6_000,
    leaseRenewTimeoutMs: 3_000,
    leaseFenceMs: 25_000,
    lossGraceMs: 2_000,
    // above the socket command timeout below, as production's 6 s is above its 5 s
    shedGraceMs: 4_000,
  },
  // the production chain's shape with waits a handoff case can afford (#94): a membership change
  // reaches the other worker within 1 s, a dirty worker's row lapses in 6 s
  fleet: {
    heartbeatMs: 1_000,
    heartbeatTimeoutMs: 500,
    liveFenceMs: 5_000,
    processTtlMs: 6_000,
    processPruneMs: 60_000,
    capacityLogMs: 1_000,
  },
  // the insurance above the handoff's held socket submit (HELD_SOCKET_MS 800), so it never
  // overtakes one, and well inside a case's wait ceiling (#347); a short drain tail, so a clean
  // stop costs a case 0.3 s (handoff H18 lengthens it)
  intentRouter: { recoveryDelayMs: 1_500, stopBudgetMs: 2_000, drainPollMs: 20, drainTailMs: 300 },
  socketTiming: {
    // well above the handoff's held socket submit (HELD_SOCKET_MS 800), below the shed grace and
    // the submit deadline; still shorter than production's 5 s, which would lengthen H14 by 5 s
    commandTimeoutMs: 3_000,
    connectTimeoutMs: 1_000,
    authTimeoutMs: 500,
    reconnectDelayMs: 20,
    reconnectDelayMaxMs: 40,
    jitter: 0,
  },
  orchestrator: {
    tickMs: 100,
    batchSize: 50,
    attemptTimeoutMs: 2_000,
    retryMs: 1_000,
    h1CheckMs: 100,
    holdSlackMs: 10,
    maxDurationMs: SESSION_MAX_DURATION_MS,
    noSignalCandles: SESSION_NO_SIGNAL_CANDLES,
  },
  // at or above phase 1, as production's chain ends at STALE_SUBMITTING_MS: the sweeper never
  // overtakes a submit still in flight (handoff H3 and H9′ shorten it for B, whose mark they test)
  staleSubmittingMs: 10_000,
  sweepIntervalMs: 100,
  reconcileTickMs: 100,
  reconcileRetryMs: 1_000,
  catchupTickMs: 1_000,
  catchupGraceMs: 10_000,
  phase1BudgetMs: 10_000,
  phase2BudgetMs: 4_000,
};

// a tuning edited out of order fails at import, not as a flaky case
const TEST_WORKER_TUNING_HOLDS =
  TEST_WORKER_TUNING.socketTiming!.commandTimeoutMs! < TEST_WORKER_TUNING.sessions!.shedGraceMs! &&
  TEST_WORKER_TUNING.socketTiming!.commandTimeoutMs! < TEST_SUBMIT_ACK_TIMEOUT_MS &&
  BROKER_REST_TIMEOUT_MS < TEST_SUBMIT_ACK_TIMEOUT_MS &&
  TEST_SUBMIT_ACK_TIMEOUT_MS < TEST_WORKER_TUNING.phase1BudgetMs! &&
  TEST_WORKER_TUNING.phase1BudgetMs! <= TEST_WORKER_TUNING.staleSubmittingMs!;
if (!TEST_WORKER_TUNING_HOLDS) {
  throw new Error('TEST_WORKER_TUNING is out of order (see apps/trading-worker/src/testing.ts)');
}

// the handoff's H2 oracle: at every poll, at most one connected socket per broker user
export function watchSockets(broker: MockBroker) {
  let worst = 0;
  let polls = 0;
  const poll = () => {
    polls += 1;
    const perUser = new Map<number, number>();
    for (const socket of broker.socket.sockets()) {
      if (socket.userId === undefined) continue;
      perUser.set(socket.userId, (perUser.get(socket.userId) ?? 0) + 1);
    }
    for (const count of perUser.values()) worst = Math.max(worst, count);
  };
  const timer = setInterval(poll, 2);
  return {
    stop: () => {
      clearInterval(timer);
      poll();
      return { worst, polls };
    },
  };
}
