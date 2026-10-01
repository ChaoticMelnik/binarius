import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ADMIN_LOGIN_BUDGET_MS } from '@binarius/shared';
import { OAUTH_CALLBACK_BUDGET_MS, OAUTH_CALLBACK_PATH } from '@binarius/shared/oauth';
import { composeDurationMs, composeServiceValue } from '@binarius/shared/testing';
import {
  BACKEND_REQUEST_TIMEOUT_MS,
  COMPOSE_STOP_GRACE_PERIOD_MS,
  OAUTH_CALLBACK_REQUEST_TIMEOUT_MS,
  SHUTDOWN_BUDGET_MS,
} from './timing';

const composeYaml = readFileSync(
  fileURLToPath(new URL('../../../compose.yaml', import.meta.url)),
  'utf8',
);

// One environment entry of one compose service; composeServiceValue reads only the keys directly
// under the service.
function composeEnvValue(service: string, key: string): string | undefined {
  const lines = composeYaml.split('\n');
  const start = lines.indexOf(`  ${service}:`);
  if (start === -1) return undefined;
  for (const line of lines.slice(start + 1)) {
    if (/^ {2}\S/.test(line)) break;
    const match = /^ {6}([A-Z_]+):\s*(.*?)\s*$/.exec(line);
    if (match?.[1] === key) return match[2];
  }
  return undefined;
}

// The chain is enforced at import: timing.ts throws when it does not hold, so a violation
// takes this file down before the first test runs. An expectation here could only ever see true.
describe('web timing', () => {
  it('waits longer than the backend may spend, and shuts down inside the grace period', () => {
    // the cross-process link: the backend's own chain fits inside this same number
    expect(ADMIN_LOGIN_BUDGET_MS).toBeLessThan(BACKEND_REQUEST_TIMEOUT_MS);
    expect(OAUTH_CALLBACK_BUDGET_MS).toBeLessThan(OAUTH_CALLBACK_REQUEST_TIMEOUT_MS);
    expect(BACKEND_REQUEST_TIMEOUT_MS).toBeLessThan(SHUTDOWN_BUDGET_MS);
    expect(OAUTH_CALLBACK_REQUEST_TIMEOUT_MS).toBeLessThan(SHUTDOWN_BUDGET_MS);
    expect(SHUTDOWN_BUDGET_MS).toBeLessThan(COMPOSE_STOP_GRACE_PERIOD_MS);
  });

  it('matches the stop_grace_period compose gives the web service', () => {
    expect(composeDurationMs(composeServiceValue(composeYaml, 'web', 'stop_grace_period'))).toBe(
      COMPOSE_STOP_GRACE_PERIOD_MS,
    );
  });

  // Two defaults that have to agree or a fresh clone serves its pages on one port and compares
  // the Origin header against another, which fails every POST with a 403.
  it('publishes the web port the default WEB_PUBLIC_URL points at', () => {
    const publicUrl = /WEB_PUBLIC_URL: \$\{WEB_PUBLIC_URL:-([^}]+)\}/.exec(composeYaml)?.[1];
    const webPort = /"127\.0\.0\.1:\$\{WEB_PORT:-(\d+)\}:3000"/.exec(composeYaml)?.[1];
    expect(webPort).toBeDefined();
    expect(publicUrl).toBe(`http://127.0.0.1:${webPort}`);
  });

  // the broker redirects to the callback page this process serves, so the backend's default
  // redirect has to be this process's default origin plus that path
  it('derives the default BROKER_OAUTH_REDIRECT_URI from the default WEB_PUBLIC_URL', () => {
    const publicUrl = /^\$\{WEB_PUBLIC_URL:-([^}]+)\}$/.exec(
      composeEnvValue('web', 'WEB_PUBLIC_URL') ?? '',
    )?.[1];
    const redirect =
      /^\$\{BROKER_OAUTH_REDIRECT_URI:-\$\{WEB_PUBLIC_URL:-([^}]+)\}([^}]*)\}$/.exec(
        composeEnvValue('backend', 'BROKER_OAUTH_REDIRECT_URI') ?? '',
      );
    expect(publicUrl).toBeDefined();
    expect(redirect?.[1]).toBe(publicUrl);
    expect(redirect?.[2]).toBe(OAUTH_CALLBACK_PATH);
  });

  // GET /oauth/login checks the authorize URL the backend built against this value, so the two
  // processes have to read one default
  it('gives the web the backend\'s BROKER_OAUTH_AUTHORIZE_URL through the shared anchor', () => {
    expect(composeEnvValue('backend', 'BROKER_OAUTH_AUTHORIZE_URL')).toMatch(
      /^&broker-authorize-url \$\{BROKER_OAUTH_AUTHORIZE_URL:-https:\/\/[^}]+\}$/,
    );
    expect(composeEnvValue('web', 'BROKER_OAUTH_AUTHORIZE_URL')).toBe(
      '*broker-authorize-url',
    );
  });
});
