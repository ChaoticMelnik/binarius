import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { composeDurationMs, composeServiceValue } from '@binarius/shared/testing';
import {
  BACKEND_REQUEST_TIMEOUT_MS,
  COMPOSE_STOP_GRACE_PERIOD_MS,
  HANDLER_BUDGET_MS,
  POLLING_TIMEOUT_S,
  SHUTDOWN_BUDGET_MS,
  TELEGRAM_API_TIMEOUT_MS,
  TIMING_CHAIN_HOLDS,
} from './timing';

const composeYaml = readFileSync(
  fileURLToPath(new URL('../../../compose.yaml', import.meta.url)),
  'utf8',
);

describe('bot timing chain', () => {
  it('keeps every bound inside the one above it', () => {
    expect(TIMING_CHAIN_HOLDS).toBe(true);
    // a long poll must end on the server's clock, not be aborted by our own client and retried
    expect(POLLING_TIMEOUT_S * 1000).toBeLessThan(TELEGRAM_API_TIMEOUT_MS);
    expect(HANDLER_BUDGET_MS).toBe(
      Math.max(BACKEND_REQUEST_TIMEOUT_MS, TELEGRAM_API_TIMEOUT_MS) + TELEGRAM_API_TIMEOUT_MS,
    );
    expect(HANDLER_BUDGET_MS).toBeLessThan(SHUTDOWN_BUDGET_MS);
    expect(TELEGRAM_API_TIMEOUT_MS).toBeLessThan(SHUTDOWN_BUDGET_MS);
    expect(SHUTDOWN_BUDGET_MS).toBeLessThan(COMPOSE_STOP_GRACE_PERIOD_MS);
  });

  it('matches the stop_grace_period compose gives the bot service', () => {
    expect(composeDurationMs(composeServiceValue(composeYaml, 'bot', 'stop_grace_period'))).toBe(
      COMPOSE_STOP_GRACE_PERIOD_MS,
    );
  });
});
