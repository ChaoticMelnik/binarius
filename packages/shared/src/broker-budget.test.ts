import { describe, expect, it } from 'vitest';
import {
  BROKER_BUDGET_HOLDS,
  BROKER_RATE_LIMIT_PER_MINUTE,
  brokerGetsPerMinute,
  DEFAULT_BALANCE_POLL_PER_MINUTE,
  DEFAULT_SIGNAL_SCAN_PER_MINUTE,
  WORKER_BROKER_GETS_PER_MINUTE,
} from './broker-budget';

describe('broker budget', () => {
  it('B1 the default shares fit the per-IP limit', () => {
    expect(BROKER_BUDGET_HOLDS).toBe(true);
    expect(
      WORKER_BROKER_GETS_PER_MINUTE +
        DEFAULT_BALANCE_POLL_PER_MINUTE +
        DEFAULT_SIGNAL_SCAN_PER_MINUTE,
    ).toBeLessThanOrEqual(BROKER_RATE_LIMIT_PER_MINUTE);
  });

  it('B2 the configured sum adds the worker share to the two backend ceilings', () => {
    expect(brokerGetsPerMinute({ balancePollPerMinute: 100, signalScanPerMinute: 100 })).toBe(600);
    expect(brokerGetsPerMinute({ balancePollPerMinute: 200, signalScanPerMinute: 100 })).toBe(700);
  });
});
