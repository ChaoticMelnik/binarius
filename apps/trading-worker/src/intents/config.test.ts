import { describe, expect, it } from 'vitest';
import {
  COMPOSE_STOP_GRACE_PERIOD_MS,
  LOCK_DURATION_MS,
  MAX_SUBMIT_ACK_TIMEOUT_MS,
  SHUTDOWN_BUDGET_MS,
  STALE_SUBMITTING_MS,
  TIMING_CHAIN_HOLDS,
} from './config';

describe('timing constants', () => {
  it('keep the ack timeout, shutdown budget, stop grace, lock and stale threshold in order', () => {
    expect(TIMING_CHAIN_HOLDS).toBe(true);
    expect(MAX_SUBMIT_ACK_TIMEOUT_MS).toBeLessThan(SHUTDOWN_BUDGET_MS);
    expect(SHUTDOWN_BUDGET_MS).toBeLessThan(COMPOSE_STOP_GRACE_PERIOD_MS);
    expect(COMPOSE_STOP_GRACE_PERIOD_MS).toBeLessThan(LOCK_DURATION_MS);
    expect(LOCK_DURATION_MS).toBeLessThanOrEqual(STALE_SUBMITTING_MS);
  });
});
