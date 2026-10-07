import { BALANCE_WATCH_WINDOW_MS } from '@binarius/shared/broker-balance';
import { describe, expect, it } from 'vitest';
import {
  MAX_SESSIONS_PER_WORKER,
  SESSION_CHAIN_HOLDS,
  SESSION_IDLE_GRACE_MS,
  SESSION_MANAGER_CONFIG,
  SESSION_REFUSAL_RETRY_MS,
  SESSION_RETRY_MS,
  SESSION_START_CONCURRENCY,
  SESSION_STOP_BUDGET_MS,
  SESSION_TICK_MS,
  sessionManagerConfigHolds,
  type SessionManagerConfig,
} from './session-config';
import { MAX_TIMER_MS } from './socket-config';

describe('the session constants', () => {
  it('hold the chain', () => {
    expect(SESSION_CHAIN_HOLDS).toBe(true);
    expect(SESSION_TICK_MS).toBeLessThan(SESSION_IDLE_GRACE_MS);
    expect(SESSION_TICK_MS).toBeLessThan(SESSION_RETRY_MS);
    expect(SESSION_RETRY_MS).toBeLessThanOrEqual(SESSION_REFUSAL_RETRY_MS);
    expect(SESSION_IDLE_GRACE_MS).toBeLessThan(BALANCE_WATCH_WINDOW_MS);
    expect(SESSION_MANAGER_CONFIG).toEqual({
      tickMs: SESSION_TICK_MS,
      idleGraceMs: SESSION_IDLE_GRACE_MS,
      retryMs: SESSION_RETRY_MS,
      refusalRetryMs: SESSION_REFUSAL_RETRY_MS,
      maxSessions: MAX_SESSIONS_PER_WORKER,
      startConcurrency: SESSION_START_CONCURRENCY,
      stopBudgetMs: SESSION_STOP_BUDGET_MS,
      watchWindowMs: BALANCE_WATCH_WINDOW_MS,
    });
  });

  it.each<[string, Partial<SessionManagerConfig>]>([
    ['a scan as long as the idle grace', { tickMs: SESSION_IDLE_GRACE_MS }],
    ['a hold-back no longer than a scan', { retryMs: SESSION_TICK_MS }],
    ['a refusal hold-back shorter than a retry', { refusalRetryMs: SESSION_RETRY_MS - 1 }],
    ['an idle grace as long as the watch window', { idleGraceMs: BALANCE_WATCH_WINDOW_MS }],
    ['a fractional wait', { stopBudgetMs: 1.5 }],
    ['a wait past the timer limit', { refusalRetryMs: MAX_TIMER_MS + 1 }],
    ['no session', { maxSessions: 0 }],
    ['no start worker', { startConcurrency: 0 }],
  ])('refuses %s', (_label, patch) => {
    expect(sessionManagerConfigHolds({ ...SESSION_MANAGER_CONFIG, ...patch })).toBe(false);
  });
});
