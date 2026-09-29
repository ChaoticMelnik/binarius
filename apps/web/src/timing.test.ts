import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ADMIN_LOGIN_BUDGET_MS } from '@binarius/shared';
import { composeDurationMs, composeServiceValue } from '@binarius/shared/testing';
import {
  BACKEND_REQUEST_TIMEOUT_MS,
  COMPOSE_STOP_GRACE_PERIOD_MS,
  SHUTDOWN_BUDGET_MS,
  TIMING_CHAIN_HOLDS,
} from './timing';

const composeYaml = readFileSync(
  fileURLToPath(new URL('../../../compose.yaml', import.meta.url)),
  'utf8',
);

describe('web timing', () => {
  it('waits longer than the backend may spend, and shuts down inside the grace period', () => {
    expect(TIMING_CHAIN_HOLDS).toBe(true);
    // the cross-process link: the backend's own chain fits inside this same number
    expect(ADMIN_LOGIN_BUDGET_MS).toBeLessThan(BACKEND_REQUEST_TIMEOUT_MS);
    expect(BACKEND_REQUEST_TIMEOUT_MS).toBeLessThan(SHUTDOWN_BUDGET_MS);
    expect(SHUTDOWN_BUDGET_MS).toBeLessThan(COMPOSE_STOP_GRACE_PERIOD_MS);
  });

  it('matches the stop_grace_period compose gives the web service', () => {
    expect(composeDurationMs(composeServiceValue(composeYaml, 'web', 'stop_grace_period'))).toBe(
      COMPOSE_STOP_GRACE_PERIOD_MS,
    );
  });

  // Two defaults that have to agree or a fresh clone serves its pages on one port and compares
  // the Origin header against another, which fails every POST with a 403.
  it('publishes the web port the default ADMIN_PUBLIC_URL points at', () => {
    const publicUrl = /ADMIN_PUBLIC_URL: \$\{ADMIN_PUBLIC_URL:-([^}]+)\}/.exec(composeYaml)?.[1];
    const webPort = /"127\.0\.0\.1:\$\{WEB_PORT:-(\d+)\}:3000"/.exec(composeYaml)?.[1];
    expect(webPort).toBeDefined();
    expect(publicUrl).toBe(`http://127.0.0.1:${webPort}`);
  });
});
