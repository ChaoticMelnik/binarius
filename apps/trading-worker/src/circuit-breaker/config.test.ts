import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { composeServiceEnvValue } from '@binarius/shared/testing';
import { ONE_RECONNECT_MS } from './config';

const composeYaml = readFileSync(
  fileURLToPath(new URL('../../../../compose.yaml', import.meta.url)),
  'utf8',
);

// The chain is enforced at import: circuit-breaker/config.ts throws when it does not hold, so a
// violation takes this file down before the first test runs.
describe('the circuit breaker constants (#96)', () => {
  it('count one full reconnect at its worst case', () => {
    // 10 s × 1.5 + 10 s + 5 s
    expect(ONE_RECONNECT_MS).toBe(30_000);
  });

  it.each([
    'CIRCUIT_BREAKER_WINDOW_MS',
    'CIRCUIT_BREAKER_MIN_FAILURES',
    'CIRCUIT_BREAKER_FAILURE_PERCENT',
  ])('compose forwards %s valueless, only when the host sets it', (name) => {
    expect(composeServiceEnvValue(composeYaml, 'trading-worker', name)).toBe('');
  });
});
