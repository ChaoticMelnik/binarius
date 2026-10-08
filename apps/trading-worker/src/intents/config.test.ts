import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  composeDurationMs,
  composeServiceEnvValue,
  composeServiceValue,
} from '@binarius/shared/testing';
import { BROKER_REST_TIMEOUT_MS } from '@binarius/broker-rest';
import { ACCESS_TOKEN_ROUTE_BUDGET_MS } from '@binarius/shared/access-token';
import { WORKER_BROKER_GETS_PER_MINUTE } from '@binarius/shared/broker-budget';
import { SESSION_STOP_BUDGET_MS, SESSION_TICK_MS } from '../broker/session-config';
import { BROKER_SOCKET_CONNECT_TIMEOUT_MS } from '../broker/socket-config';
import { TRADING_SESSION_ATTEMPT_TIMEOUT_MS } from '../trading-session/config';
import {
  CATCHUP_ATTEMPT_TIMEOUT_MS,
  CATCHUP_BATCH_SIZE,
  CATCHUP_GRACE_MS,
  CATCHUP_MAX_TRADE_PAGES,
  CATCHUP_STALLED_RETRY_MS,
  CATCHUP_TICK_MS,
  COMPOSE_STOP_GRACE_PERIOD_MS,
  LOCK_DURATION_MS,
  MAX_SUBMIT_ACK_TIMEOUT_MS,
  RECONCILE_ATTEMPT_TIMEOUT_MS,
  RECONCILE_BATCH_SIZE,
  RECONCILE_MAX_TRADE_PAGES,
  RECONCILE_RETRY_MS,
  RECONCILE_TICK_MS,
  RECONCILE_WINDOW_AFTER_MS,
  SHUTDOWN_PHASE1_BUDGET_MS,
  SHUTDOWN_PHASE2_BUDGET_MS,
  STALE_SUBMITTING_MS,
  WORKER_BROKER_GETS_WORST_CASE,
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

  it('keep one REST call inside a reconciliation attempt, the attempt inside its lease and phase 1', () => {
    expect(BROKER_REST_TIMEOUT_MS).toBeLessThan(RECONCILE_ATTEMPT_TIMEOUT_MS);
    expect(RECONCILE_ATTEMPT_TIMEOUT_MS).toBeLessThan(RECONCILE_RETRY_MS);
    expect(RECONCILE_ATTEMPT_TIMEOUT_MS).toBeLessThan(SHUTDOWN_PHASE1_BUDGET_MS);
    expect(RECONCILE_TICK_MS).toBeLessThanOrEqual(RECONCILE_RETRY_MS);
  });

  it('keep the token and every page inside an attempt, and the window past a late open (#90)', () => {
    expect(
      ACCESS_TOKEN_ROUTE_BUDGET_MS + 2 * RECONCILE_MAX_TRADE_PAGES * BROKER_REST_TIMEOUT_MS,
    ).toBeLessThan(RECONCILE_ATTEMPT_TIMEOUT_MS);
    expect(MAX_SUBMIT_ACK_TIMEOUT_MS).toBeLessThan(RECONCILE_WINDOW_AFTER_MS);
    expect(BROKER_REST_TIMEOUT_MS).toBeLessThan(RECONCILE_WINDOW_AFTER_MS);
    expect(
      ACCESS_TOKEN_ROUTE_BUDGET_MS + CATCHUP_MAX_TRADE_PAGES * BROKER_REST_TIMEOUT_MS,
    ).toBeLessThan(CATCHUP_ATTEMPT_TIMEOUT_MS);
    expect(CATCHUP_ATTEMPT_TIMEOUT_MS).toBeLessThan(SHUTDOWN_PHASE1_BUDGET_MS);
    expect(BROKER_REST_TIMEOUT_MS).toBeLessThan(CATCHUP_GRACE_MS);
    expect(CATCHUP_TICK_MS).toBeLessThan(CATCHUP_STALLED_RETRY_MS);
  });

  it('keep the worst case of broker GETs within the worker share of the IP limit (#90)', () => {
    expect(WORKER_BROKER_GETS_WORST_CASE).toBe(
      RECONCILE_BATCH_SIZE * 2 * RECONCILE_MAX_TRADE_PAGES * (60_000 / RECONCILE_TICK_MS) +
        CATCHUP_BATCH_SIZE * CATCHUP_MAX_TRADE_PAGES * (60_000 / CATCHUP_TICK_MS),
    );
    expect(WORKER_BROKER_GETS_WORST_CASE).toBeLessThanOrEqual(WORKER_BROKER_GETS_PER_MINUTE);
    expect(Number.isInteger(60_000 / CATCHUP_TICK_MS)).toBe(true);
    expect(Number.isInteger(60_000 / RECONCILE_TICK_MS)).toBe(true);
  });

  // #313: a 5 s trade with no close event settles by grace + one tick, not minutes later
  it('settles a short trade within 15 s of its close and retries a held-back one within 30 s', () => {
    expect(CATCHUP_GRACE_MS + CATCHUP_TICK_MS).toBeLessThanOrEqual(15_000);
    expect(CATCHUP_STALLED_RETRY_MS).toBeLessThanOrEqual(30_000);
  });

  it('matches the stop_grace_period compose gives the trading-worker service', () => {
    expect(
      composeDurationMs(composeServiceValue(composeYaml, 'trading-worker', 'stop_grace_period')),
    ).toBe(COMPOSE_STOP_GRACE_PERIOD_MS);
  });
});

// the same entry under backend is pinned in apps/backend/src/timing.test.ts
describe('the session manager in the shutdown budget (#101)', () => {
  it('stops after the drain inside phase 1, and nothing it cannot cut outlasts phase 1', () => {
    expect(MAX_SUBMIT_ACK_TIMEOUT_MS + SESSION_STOP_BUDGET_MS).toBeLessThan(
      SHUTDOWN_PHASE1_BUDGET_MS,
    );
    expect(BROKER_SOCKET_CONNECT_TIMEOUT_MS).toBeLessThan(SHUTDOWN_PHASE1_BUDGET_MS);
    expect(ACCESS_TOKEN_ROUTE_BUDGET_MS).toBeLessThan(SHUTDOWN_PHASE1_BUDGET_MS);
    expect(SESSION_TICK_MS).toBeLessThan(SHUTDOWN_PHASE1_BUDGET_MS);
  });

  it('keep the trading session attempt inside phase 1 (#287)', () => {
    expect(TRADING_SESSION_ATTEMPT_TIMEOUT_MS).toBeLessThan(SHUTDOWN_PHASE1_BUDGET_MS);
  });
});

describe('the trading switch (#144)', () => {
  it('no longer forwards REAL_TRADING_ENABLED to the trading-worker', () => {
    expect(
      composeServiceEnvValue(composeYaml, 'trading-worker', 'REAL_TRADING_ENABLED'),
    ).toBeUndefined();
  });
});

// The x-broker-environment anchor's own entries, read the way composeServiceEnvValue reads a
// service's: a two-space indented key directly under the anchor line.
function brokerAnchorValue(yaml: string, name: string): string | undefined {
  const lines = yaml.split('\n');
  const start = lines.findIndex((line) =>
    line.startsWith('x-broker-environment: &broker-environment'),
  );
  for (let index = start + 1; start !== -1 && index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (/^\S/.test(line)) break;
    const match = /^ {2}([A-Z_]+):\s*(.*?)\s*$/.exec(line);
    if (match !== null && match[1] === name) return match[2];
  }
  return undefined;
}

// the merge line of a service's environment block
function environmentMerge(yaml: string, service: string): string | undefined {
  const lines = yaml.split('\n');
  const start = lines.findIndex((line) => line === `  ${service}:`);
  const at = lines.findIndex(
    (line, index) => index > start && line.startsWith('      <<: ') && start !== -1,
  );
  return at === -1 ? undefined : lines[at];
}

// #90: the worker reaches the backend's token route and the broker's REST API
describe('the worker environment for the token route and the trade lists', () => {
  it('shares the broker API host with the backend through the broker anchor', () => {
    expect(brokerAnchorValue(composeYaml, 'BROKER_API_BASE_URL')).toMatch(
      /^\$\{BROKER_API_BASE_URL:-https:\/\/[^}]+\}$/,
    );
    for (const service of ['backend', 'trading-worker']) {
      expect(environmentMerge(composeYaml, service)).toContain('*broker-environment');
      // an entry of the service's own would shadow the anchor's
      expect(composeServiceEnvValue(composeYaml, service, 'BROKER_API_BASE_URL')).toBeUndefined();
    }
  });

  it('gives the worker the internal token the backend checks, with no default', () => {
    const worker = composeServiceEnvValue(composeYaml, 'trading-worker', 'INTERNAL_API_TOKEN');
    expect(worker).toBe(composeServiceEnvValue(composeYaml, 'backend', 'INTERNAL_API_TOKEN'));
    expect(worker?.startsWith('${INTERNAL_API_TOKEN:?')).toBe(true);
  });

  it('forwards BROKER_WS_URL valueless, so an unset variable leaves the sessions off', () => {
    expect(brokerAnchorValue(composeYaml, 'BROKER_WS_URL')).toBe('');
    for (const service of ['backend', 'trading-worker']) {
      expect(composeServiceEnvValue(composeYaml, service, 'BROKER_WS_URL')).toBeUndefined();
    }
  });

  it('points the worker at the backend the bot reaches', () => {
    expect(composeServiceEnvValue(composeYaml, 'trading-worker', 'BACKEND_URL')).toBe(
      composeServiceEnvValue(composeYaml, 'bot', 'BACKEND_URL'),
    );
    expect(composeServiceEnvValue(composeYaml, 'trading-worker', 'BACKEND_URL')).toBe(
      'http://backend:3000',
    );
  });
});
