import { MAX_TIMER_MS } from '@binarius/broker-socket';
import { describe, expect, it } from 'vitest';
import {
  CAPACITY_LOG_MS,
  FLEET_CHAIN_HOLDS,
  FLEET_CONFIG,
  fleetConfigHolds,
  WORKER_HEARTBEAT_MS,
  WORKER_HEARTBEAT_TIMEOUT_MS,
  WORKER_LIVE_FENCE_MS,
  WORKER_PROCESS_PRUNE_MS,
  WORKER_PROCESS_TTL_MS,
  type FleetConfig,
} from './config';

describe('the fleet constants (#94)', () => {
  it('hold the chain', () => {
    expect(FLEET_CHAIN_HOLDS).toBe(true);
    expect(FLEET_CONFIG).toEqual({
      heartbeatMs: WORKER_HEARTBEAT_MS,
      heartbeatTimeoutMs: WORKER_HEARTBEAT_TIMEOUT_MS,
      liveFenceMs: WORKER_LIVE_FENCE_MS,
      processTtlMs: WORKER_PROCESS_TTL_MS,
      processPruneMs: WORKER_PROCESS_PRUNE_MS,
      capacityLogMs: CAPACITY_LOG_MS,
    });
  });

  it.each<[string, Partial<FleetConfig>]>([
    ['a timeout as long as the interval', { heartbeatTimeoutMs: WORKER_HEARTBEAT_MS }],
    [
      'a fence within two heartbeats and two timeouts',
      { liveFenceMs: 2 * WORKER_HEARTBEAT_MS + 2 * WORKER_HEARTBEAT_TIMEOUT_MS },
    ],
    ['a fence as long as the TTL', { liveFenceMs: WORKER_PROCESS_TTL_MS }],
    ['a TTL as long as the prune', { processTtlMs: WORKER_PROCESS_PRUNE_MS }],
    ['a fractional value', { capacityLogMs: 1.5 }],
    ['a value past the timer limit', { processPruneMs: MAX_TIMER_MS + 1 }],
  ])('refuses %s', (_label, patch) => {
    expect(fleetConfigHolds({ ...FLEET_CONFIG, ...patch })).toBe(false);
  });
});
