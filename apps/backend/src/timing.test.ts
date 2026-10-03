import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OAUTH_CALLBACK_BUDGET_MS } from '@binarius/shared/oauth';
import {
  composeDurationMs,
  composeServiceEnvValue,
  composeServiceValue,
} from '@binarius/shared/testing';
import { BROKER_HTTP_TIMEOUT_MS } from './broker/oauth-client';
import { DEFAULT_PUBLISHER_CONFIG } from './outbox/publisher';
import {
  COMPOSE_STOP_GRACE_PERIOD_MS,
  LINK_PUSH_TELEGRAM_API_TIMEOUT_MS,
  SHUTDOWN_PHASE1_BUDGET_MS,
  SHUTDOWN_PHASE2_BUDGET_MS,
} from './timing';

const composeYaml = readFileSync(
  fileURLToPath(new URL('../../../compose.yaml', import.meta.url)),
  'utf8',
);

// The chain is enforced at import: timing.ts throws when it does not hold, so a violation
// takes this file down before the first test runs. An expectation here could only ever see true.
describe('backend shutdown timing', () => {
  it('keeps the publish deadline under phase 1 and both phases under the stop grace period', () => {
    expect(DEFAULT_PUBLISHER_CONFIG.publishTimeoutMs).toBeLessThan(SHUTDOWN_PHASE1_BUDGET_MS);
    expect(BROKER_HTTP_TIMEOUT_MS).toBeLessThan(SHUTDOWN_PHASE1_BUDGET_MS);
    expect(BROKER_HTTP_TIMEOUT_MS + LINK_PUSH_TELEGRAM_API_TIMEOUT_MS).toBeLessThanOrEqual(
      OAUTH_CALLBACK_BUDGET_MS,
    );
    expect(OAUTH_CALLBACK_BUDGET_MS).toBeLessThan(SHUTDOWN_PHASE1_BUDGET_MS);
    expect(SHUTDOWN_PHASE1_BUDGET_MS + SHUTDOWN_PHASE2_BUDGET_MS).toBeLessThan(
      COMPOSE_STOP_GRACE_PERIOD_MS,
    );
  });

  it('matches the stop_grace_period compose gives the backend service', () => {
    expect(
      composeDurationMs(composeServiceValue(composeYaml, 'backend', 'stop_grace_period')),
    ).toBe(COMPOSE_STOP_GRACE_PERIOD_MS);
  });

  // forwarded without a value: compose passes it only when the host sets it, and the code's
  // default (DEFAULT_BROKER_PAIRS_TTL_MS) applies otherwise
  it('forwards BROKER_PAIRS_TTL_MS to the backend without a default of its own', () => {
    expect(composeServiceEnvValue(composeYaml, 'backend', 'BROKER_PAIRS_TTL_MS')).toBe('');
  });
});
