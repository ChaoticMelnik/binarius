import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { composeDurationMs, composeServiceValue } from '@binarius/shared/testing';
import { BROKER_HTTP_TIMEOUT_MS } from './broker/oauth-client';
import { DEFAULT_PUBLISHER_CONFIG } from './outbox/publisher';
import {
  COMPOSE_STOP_GRACE_PERIOD_MS,
  SHUTDOWN_PHASE1_BUDGET_MS,
  SHUTDOWN_PHASE2_BUDGET_MS,
  TIMING_CHAIN_HOLDS,
} from './timing';

const composeYaml = readFileSync(
  fileURLToPath(new URL('../../../compose.yaml', import.meta.url)),
  'utf8',
);

describe('backend shutdown timing', () => {
  it('keeps the publish deadline under phase 1 and both phases under the stop grace period', () => {
    expect(TIMING_CHAIN_HOLDS).toBe(true);
    expect(DEFAULT_PUBLISHER_CONFIG.publishTimeoutMs).toBeLessThan(SHUTDOWN_PHASE1_BUDGET_MS);
    expect(BROKER_HTTP_TIMEOUT_MS).toBeLessThan(SHUTDOWN_PHASE1_BUDGET_MS);
    expect(SHUTDOWN_PHASE1_BUDGET_MS + SHUTDOWN_PHASE2_BUDGET_MS).toBeLessThan(
      COMPOSE_STOP_GRACE_PERIOD_MS,
    );
  });

  it('matches the stop_grace_period compose gives the backend service', () => {
    expect(
      composeDurationMs(composeServiceValue(composeYaml, 'backend', 'stop_grace_period')),
    ).toBe(COMPOSE_STOP_GRACE_PERIOD_MS);
  });
});
