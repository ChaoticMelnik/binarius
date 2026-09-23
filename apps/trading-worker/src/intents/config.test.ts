import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { composeDurationMs, composeServiceValue } from '@binarius/shared/testing';
import {
  COMPOSE_STOP_GRACE_PERIOD_MS,
  LOCK_DURATION_MS,
  MAX_SUBMIT_ACK_TIMEOUT_MS,
  SHUTDOWN_PHASE1_BUDGET_MS,
  SHUTDOWN_PHASE2_BUDGET_MS,
  STALE_SUBMITTING_MS,
  TIMING_CHAIN_HOLDS,
} from './config';

const composeYaml = readFileSync(
  fileURLToPath(new URL('../../../../compose.yaml', import.meta.url)),
  'utf8',
);

describe('timing constants', () => {
  it('keep the ack timeout, both shutdown phases, stop grace, lock and stale threshold in order', () => {
    expect(TIMING_CHAIN_HOLDS).toBe(true);
    expect(MAX_SUBMIT_ACK_TIMEOUT_MS).toBeLessThan(SHUTDOWN_PHASE1_BUDGET_MS);
    expect(SHUTDOWN_PHASE1_BUDGET_MS + SHUTDOWN_PHASE2_BUDGET_MS).toBeLessThan(
      COMPOSE_STOP_GRACE_PERIOD_MS,
    );
    expect(COMPOSE_STOP_GRACE_PERIOD_MS).toBeLessThan(LOCK_DURATION_MS);
    expect(LOCK_DURATION_MS).toBeLessThanOrEqual(STALE_SUBMITTING_MS);
  });

  it('matches the stop_grace_period compose gives the trading-worker service', () => {
    expect(
      composeDurationMs(composeServiceValue(composeYaml, 'trading-worker', 'stop_grace_period')),
    ).toBe(COMPOSE_STOP_GRACE_PERIOD_MS);
  });
});
