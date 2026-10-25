import { isTimerMs } from '@binarius/broker-socket';

// The fleet registry's constants (#94, docs/worker-capacity.md → Constants), each bounding one
// thing:
//   WORKER_HEARTBEAT_MS         — the heartbeat interval: one statement that moves our row and
//                                 answers the live set
//   WORKER_HEARTBEAT_TIMEOUT_MS — how long one heartbeat may take before it counts as failed
//   WORKER_LIVE_FENCE_MS        — how long after sending a heartbeat the process trusts its view;
//                                 past it the process owns no account
//   WORKER_PROCESS_TTL_MS       — how long a row outlives its last heartbeat in the database:
//                                 past it the others leave the process out of the live set
//   WORKER_PROCESS_PRUNE_MS     — how long a lapsed row is kept for an operator before a heartbeat
//                                 deletes it
//   CAPACITY_LOG_MS             — the `worker capacity` line's interval
// The chain: a stuck heartbeat ends before the next is due (TIMEOUT < HEARTBEAT); one failed
// heartbeat does not fence — a view sent at s is refreshed by s + HEARTBEAT + TIMEOUT, and if that
// one fails the next answers by s + 2 × HEARTBEAT + 2 × TIMEOUT, before the fence
// (2 × HEARTBEAT + 2 × TIMEOUT < LIVE_FENCE); a process stops claiming accounts before the others
// may take them (LIVE_FENCE < PROCESS_TTL); a row lapses before it is pruned (PROCESS_TTL <
// PRUNE); every *_MS is an integer in [1, MAX_TIMER_MS].
export const WORKER_HEARTBEAT_MS = 6_000;
// 2 s, not the lease renewal's 3 s: the deregister at shutdown is bounded by it and follows the
// manager's stop in one phase-1 step (intents/config.ts)
export const WORKER_HEARTBEAT_TIMEOUT_MS = 2_000;
export const WORKER_LIVE_FENCE_MS = 25_000;
export const WORKER_PROCESS_TTL_MS = 30_000;
export const WORKER_PROCESS_PRUNE_MS = 3_600_000;
export const CAPACITY_LOG_MS = 60_000;

export interface FleetConfig {
  heartbeatMs: number;
  heartbeatTimeoutMs: number;
  liveFenceMs: number;
  processTtlMs: number;
  processPruneMs: number;
  capacityLogMs: number;
}

export const FLEET_CONFIG: Readonly<FleetConfig> = {
  heartbeatMs: WORKER_HEARTBEAT_MS,
  heartbeatTimeoutMs: WORKER_HEARTBEAT_TIMEOUT_MS,
  liveFenceMs: WORKER_LIVE_FENCE_MS,
  processTtlMs: WORKER_PROCESS_TTL_MS,
  processPruneMs: WORKER_PROCESS_PRUNE_MS,
  capacityLogMs: CAPACITY_LOG_MS,
};

export function fleetConfigHolds(config: FleetConfig): boolean {
  return (
    isTimerMs(config.heartbeatMs) &&
    isTimerMs(config.heartbeatTimeoutMs) &&
    isTimerMs(config.liveFenceMs) &&
    isTimerMs(config.processTtlMs) &&
    isTimerMs(config.processPruneMs) &&
    isTimerMs(config.capacityLogMs) &&
    config.heartbeatTimeoutMs < config.heartbeatMs &&
    2 * config.heartbeatMs + 2 * config.heartbeatTimeoutMs < config.liveFenceMs &&
    config.liveFenceMs < config.processTtlMs &&
    config.processTtlMs < config.processPruneMs
  );
}

// a constant edited out of order fails at import, not in production
export const FLEET_CHAIN_HOLDS = fleetConfigHolds(FLEET_CONFIG);
if (!FLEET_CHAIN_HOLDS) {
  throw new Error('worker fleet constants are out of order (see fleet/config.ts)');
}
