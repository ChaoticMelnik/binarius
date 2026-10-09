import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { composeServiceEnvValue } from '@binarius/shared/testing';
import { SESSION_TICK_MS } from '../broker/session-config';
import {
  CIRCUIT_BREAKER_CHAIN_HOLDS,
  CIRCUIT_BREAKER_FAILURE_PERCENT,
  CIRCUIT_BREAKER_MIN_FAILURES,
  CIRCUIT_BREAKER_WINDOW_MS,
  ONE_RECONNECT_MS,
  SOCKET_LOSS_GRACE_MS,
} from './config';

const composeYaml = readFileSync(
  fileURLToPath(new URL('../../../../compose.yaml', import.meta.url)),
  'utf8',
);

describe('the circuit breaker constants (#96)', () => {
  it('hold the chain: a full reconnect never counts, a loss counts inside the window', () => {
    expect(CIRCUIT_BREAKER_CHAIN_HOLDS).toBe(true);
    // 10 s × 1.5 + 10 s + 5 s
    expect(ONE_RECONNECT_MS).toBe(30_000);
    expect(ONE_RECONNECT_MS).toBeLessThan(SOCKET_LOSS_GRACE_MS);
    expect(SESSION_TICK_MS).toBeLessThan(SOCKET_LOSS_GRACE_MS);
    expect(SOCKET_LOSS_GRACE_MS).toBeLessThan(CIRCUIT_BREAKER_WINDOW_MS);
    expect(CIRCUIT_BREAKER_MIN_FAILURES).toBe(10);
    expect(CIRCUIT_BREAKER_FAILURE_PERCENT).toBe(50);
  });

  it.each([
    'CIRCUIT_BREAKER_WINDOW_MS',
    'CIRCUIT_BREAKER_MIN_FAILURES',
    'CIRCUIT_BREAKER_FAILURE_PERCENT',
  ])('compose forwards %s valueless, only when the host sets it', (name) => {
    expect(composeServiceEnvValue(composeYaml, 'trading-worker', name)).toBe('');
  });
});
