import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  composeDurationMs,
  composeServiceEnvValue,
  composeServiceValue,
} from '@binarius/shared/testing';
import { BROKER_REST_TIMEOUT_MS } from '@binarius/broker-rest';
import {
  COMPOSE_STOP_GRACE_PERIOD_MS,
  LOCK_DURATION_MS,
  MAX_SUBMIT_ACK_TIMEOUT_MS,
  SHUTDOWN_PHASE1_BUDGET_MS,
  SHUTDOWN_PHASE2_BUDGET_MS,
  STALE_SUBMITTING_MS,
} from './config';

const composeYaml = readFileSync(
  fileURLToPath(new URL('../../../../compose.yaml', import.meta.url)),
  'utf8',
);

// The chain is enforced at import: `intents/config.ts` throws when it does not hold, so a
// violation takes this file down before the first test runs. An expectation here could only ever
// see true.
describe('timing constants', () => {
  it('keep the ack timeout, both shutdown phases, stop grace, lock and stale threshold in order', () => {
    expect(MAX_SUBMIT_ACK_TIMEOUT_MS).toBeLessThan(SHUTDOWN_PHASE1_BUDGET_MS);
    expect(SHUTDOWN_PHASE1_BUDGET_MS + SHUTDOWN_PHASE2_BUDGET_MS).toBeLessThan(
      COMPOSE_STOP_GRACE_PERIOD_MS,
    );
    expect(COMPOSE_STOP_GRACE_PERIOD_MS).toBeLessThan(LOCK_DURATION_MS);
    expect(LOCK_DURATION_MS).toBeLessThanOrEqual(STALE_SUBMITTING_MS);
    expect(BROKER_REST_TIMEOUT_MS).toBeLessThan(SHUTDOWN_PHASE1_BUDGET_MS);
  });

  it('matches the stop_grace_period compose gives the trading-worker service', () => {
    expect(
      composeDurationMs(composeServiceValue(composeYaml, 'trading-worker', 'stop_grace_period')),
    ).toBe(COMPOSE_STOP_GRACE_PERIOD_MS);
  });
});

// the same entry under backend is pinned in apps/backend/src/timing.test.ts
describe('the trading grant', () => {
  it('forwards REAL_TRADING_ENABLED to the trading-worker without a default of its own', () => {
    expect(composeServiceEnvValue(composeYaml, 'trading-worker', 'REAL_TRADING_ENABLED')).toBe('');
  });
});
