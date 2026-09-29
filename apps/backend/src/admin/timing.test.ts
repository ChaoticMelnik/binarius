import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ADMIN_LOGIN_BUDGET_MS } from '@binarius/shared';
import {
  ADMIN_HANDLER_BUDGET_MS,
  ADMIN_HANDLER_CALLS,
  ADMIN_POLLING_BATCH_LIMIT,
  ADMIN_POLLING_TIMEOUT_S,
  ADMIN_TELEGRAM_API_TIMEOUT_MS,
  GRAMMY_POLLING_BACKOFF_MS,
  PASSWORD_VERIFY_COST_CEILING_MS,
  PASSWORD_VERIFY_MAX_WAIT_MS,
  SHUTDOWN_PHASE1_BUDGET_MS,
  TIMING_CHAIN_HOLDS,
} from '../timing';

// ADMIN_HANDLER_BUDGET_MS is computed from ADMIN_HANDLER_CALLS, so nothing here recomputes it.
// That the declared call counts still describe the handlers is asserted in telegram.db.test.ts,
// which counts the calls each terminal branch actually makes.

const grammyBotJs = fileURLToPath(
  new URL('../../node_modules/grammy/out/bot.js', import.meta.url),
);

describe('the staff-login timing chain', () => {
  it('holds', () => {
    expect(TIMING_CHAIN_HOLDS).toBe(true);
  });

  // the one bound that crosses a process: apps/web waits longer than this, apps/backend fits
  // inside it, and neither knows the other's numbers
  it('fits the login route inside the budget both processes size against', () => {
    expect(
      PASSWORD_VERIFY_MAX_WAIT_MS +
        PASSWORD_VERIFY_COST_CEILING_MS +
        ADMIN_TELEGRAM_API_TIMEOUT_MS,
    ).toBeLessThanOrEqual(ADMIN_LOGIN_BUDGET_MS);
    expect(ADMIN_LOGIN_BUDGET_MS).toBeLessThan(SHUTDOWN_PHASE1_BUDGET_MS);
  });

  it('keeps the long poll under the client timeout, and the batch at one', () => {
    expect(ADMIN_POLLING_TIMEOUT_S * 1000).toBeLessThan(ADMIN_TELEGRAM_API_TIMEOUT_MS);
    expect(ADMIN_POLLING_BATCH_LIMIT).toBe(1);
  });

  it('keeps the longest handler and the polling backoff inside the drain', () => {
    expect(ADMIN_HANDLER_BUDGET_MS).toBeLessThan(SHUTDOWN_PHASE1_BUDGET_MS);
    expect(GRAMMY_POLLING_BACKOFF_MS).toBeLessThan(SHUTDOWN_PHASE1_BUDGET_MS);
    expect(ADMIN_HANDLER_BUDGET_MS).toBe(
      Math.max(...Object.values(ADMIN_HANDLER_CALLS)) * ADMIN_TELEGRAM_API_TIMEOUT_MS,
    );
  });

  // a number this project does not own, read back out of the dependency rather than trusted
  it('still matches the sleep grammY takes after a failed getUpdates', () => {
    const match = /let sleepSeconds = (\d+);/.exec(readFileSync(grammyBotJs, 'utf8'));
    expect(
      match === null ? null : Number(match[1]) * 1000,
      'grammY changed the sleep in handlePollingError (node_modules/grammy/out/bot.js). This is ' +
        'a grammY upgrade, not a broken test: stop() does not interrupt that sleep, so phase 1 ' +
        'waits it out. Update GRAMMY_POLLING_BACKOFF_MS in timing.ts and re-check it against ' +
        'SHUTDOWN_PHASE1_BUDGET_MS before touching this assertion.',
    ).toBe(GRAMMY_POLLING_BACKOFF_MS);
  });
});
