// Test-only: imported by the worker's own tests and by packages/e2e through ./e2e, never by a
// runtime module. One copy, so a new WorkerTuning field reaches every composition a test builds.

import type { MockBroker } from '@binarius/mock-broker';
import { SESSION_MAX_DURATION_MS, SESSION_NO_SIGNAL_CANDLES } from '@binarius/shared';
import type { WorkerTuning } from './worker';

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
    // above the command timeout below, as production's 6 s is above its 5 s
    shedGraceMs: 1_000,
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
    // above the handoff's held socket submit (HELD_SOCKET_MS 800), below the shed grace
    commandTimeoutMs: 900,
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
    candleSlackMs: 0,
    h1CheckMs: 100,
    maxDurationMs: SESSION_MAX_DURATION_MS,
    noSignalCandles: SESSION_NO_SIGNAL_CANDLES,
  },
  // above the longest submit a test holds (handoff H3): the sweeper never overtakes a call still
  // in flight
  staleSubmittingMs: 3_000,
  sweepIntervalMs: 100,
  reconcileTickMs: 100,
  reconcileRetryMs: 1_000,
  catchupTickMs: 1_000,
  catchupGraceMs: 10_000,
  phase1BudgetMs: 10_000,
  phase2BudgetMs: 4_000,
};

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
