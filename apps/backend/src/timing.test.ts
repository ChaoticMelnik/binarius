import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BROKER_REST_TIMEOUT_MS } from '@binarius/broker-rest';
import { ACCESS_TOKEN_ROUTE_BUDGET_MS } from '@binarius/shared/access-token';
import { BROKER_BALANCE_SLA_MS, TRADING_ACCESS_BUDGET_MS } from '@binarius/shared/broker-balance';
import { OAUTH_CALLBACK_BUDGET_MS } from '@binarius/shared/oauth';
import { SIGNAL_CHART_INTERVAL_MS, TRADING_SIGNAL_BUDGET_MS } from '@binarius/shared/signal';
import {
  composeDurationMs,
  composeServiceEnvValue,
  composeServiceValue,
} from '@binarius/shared/testing';
import { BROKER_HTTP_TIMEOUT_MS } from './broker/oauth-client';
import { DEFAULT_PUBLISHER_CONFIG } from './outbox/publisher';
import {
  BALANCE_STALLED_RETRY_MS,
  BALANCE_WATCH_WINDOW_MS,
  BROKER_RATE_LIMIT_PER_MINUTE,
  COMPOSE_STOP_GRACE_PERIOD_MS,
  LINK_PUSH_TELEGRAM_API_TIMEOUT_MS,
  MAX_BALANCE_POLL_PER_MINUTE,
  MAX_BALANCE_RECONCILE_INTERVAL_MS,
  MIN_BALANCE_RECONCILE_INTERVAL_MS,
  SHUTDOWN_PHASE1_BUDGET_MS,
  SHUTDOWN_PHASE2_BUDGET_MS,
  SIGNAL_CACHE_MAX_TTL_MS,
  SIGNAL_FETCH_BUDGET_MS,
  TRADING_ACCESS_REFRESH_BUDGET_MS,
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
    expect(BROKER_HTTP_TIMEOUT_MS).toBeLessThan(ACCESS_TOKEN_ROUTE_BUDGET_MS);
    expect(ACCESS_TOKEN_ROUTE_BUDGET_MS).toBeLessThan(SHUTDOWN_PHASE1_BUDGET_MS);
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

  // the same entry under trading-worker is pinned in its intents/config.test.ts
  it('forwards REAL_TRADING_ENABLED to the backend without a default of its own', () => {
    expect(composeServiceEnvValue(composeYaml, 'backend', 'REAL_TRADING_ENABLED')).toBe('');
  });
});

describe('broker balance timing', () => {
  it('orders the reconcile interval between one GET and the SLA', () => {
    expect(BROKER_REST_TIMEOUT_MS).toBeLessThan(MIN_BALANCE_RECONCILE_INTERVAL_MS);
    expect(MAX_BALANCE_RECONCILE_INTERVAL_MS).toBeLessThanOrEqual(BROKER_BALANCE_SLA_MS);
  });

  it('keeps the poll ceiling under the broker window', () => {
    expect(MAX_BALANCE_POLL_PER_MINUTE).toBeLessThan(BROKER_RATE_LIMIT_PER_MINUTE);
  });

  it('skips a stalled account for at least one tick and retries it inside the watch window', () => {
    expect(MAX_BALANCE_RECONCILE_INTERVAL_MS).toBeLessThan(BALANCE_STALLED_RETRY_MS);
    expect(BALANCE_STALLED_RETRY_MS).toBeLessThan(BALANCE_WATCH_WINDOW_MS);
  });

  it('fits the route GET inside the route budget and the budget inside phase 1', () => {
    expect(TRADING_ACCESS_REFRESH_BUDGET_MS).toBeLessThan(TRADING_ACCESS_BUDGET_MS);
    expect(TRADING_ACCESS_BUDGET_MS).toBeLessThan(SHUTDOWN_PHASE1_BUDGET_MS);
  });

  it('ends the signal route chart GET by its own budget, inside the route budget and phase 1', () => {
    expect(SIGNAL_FETCH_BUDGET_MS).toBeLessThan(BROKER_REST_TIMEOUT_MS);
    expect(SIGNAL_FETCH_BUDGET_MS).toBeLessThan(TRADING_SIGNAL_BUDGET_MS);
    expect(TRADING_SIGNAL_BUDGET_MS).toBeLessThan(SHUTDOWN_PHASE1_BUDGET_MS);
    expect(SIGNAL_CACHE_MAX_TTL_MS).toBeLessThan(SIGNAL_CHART_INTERVAL_MS['1m']);
  });

  it.each(['BALANCE_RECONCILE_INTERVAL_MS', 'BALANCE_POLL_MAX_PER_MINUTE'])(
    'forwards %s to the backend without a default of its own',
    (name) => {
      expect(composeServiceEnvValue(composeYaml, 'backend', name)).toBe('');
    },
  );
});
