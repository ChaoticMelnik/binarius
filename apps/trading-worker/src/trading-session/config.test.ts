import { describe, expect, it } from 'vitest';
import {
  SESSION_MAX_DURATION_MS,
  SESSION_NO_SIGNAL_TIMEOUT_MS,
  SIGNAL_CHART_INTERVAL_MS,
  SIGNAL_SHORTEST_INTERVAL_MS,
  TRADING_SIGNAL_BUDGET_MS,
} from '@binarius/shared';
import { MAX_TIMER_MS } from '@binarius/broker-socket';
import {
  sessionOrchestratorConfigHolds,
  TRADING_SESSION_ATTEMPT_TIMEOUT_MS,
  TRADING_SESSION_CANDLE_SLACK_MS,
  TRADING_SESSION_CHAIN_HOLDS,
  TRADING_SESSION_CONFIG,
  TRADING_SESSION_PAIRS_TIMEOUT_MS,
  TRADING_SESSION_RETRY_MS,
  TRADING_SESSION_TICK_MS,
  type SessionOrchestratorConfig,
} from './config';

describe('the trading session constants', () => {
  it('hold the chain', () => {
    expect(TRADING_SESSION_CHAIN_HOLDS).toBe(true);
    expect(TRADING_SESSION_PAIRS_TIMEOUT_MS + TRADING_SIGNAL_BUDGET_MS).toBeLessThan(
      TRADING_SESSION_ATTEMPT_TIMEOUT_MS,
    );
    expect(TRADING_SESSION_TICK_MS).toBeLessThan(TRADING_SESSION_RETRY_MS);
    expect(TRADING_SESSION_CANDLE_SLACK_MS).toBeLessThan(SIGNAL_SHORTEST_INTERVAL_MS);
    expect(TRADING_SESSION_RETRY_MS).toBeLessThan(SESSION_MAX_DURATION_MS);
    // the deadline is the shared one the start route and the CLI check against
    expect(TRADING_SESSION_CONFIG.maxDurationMs).toBe(SESSION_MAX_DURATION_MS);
    // #509: the shared limit the bot's stop line prints
    expect(TRADING_SESSION_CONFIG.noSignalTimeoutMs).toBe(SESSION_NO_SIGNAL_TIMEOUT_MS);
    expect(TRADING_SESSION_RETRY_MS).toBeLessThan(SESSION_NO_SIGNAL_TIMEOUT_MS);
    expect(SESSION_NO_SIGNAL_TIMEOUT_MS).toBeLessThan(SESSION_MAX_DURATION_MS);
    expect(SIGNAL_CHART_INTERVAL_MS['15s']).toBeLessThan(SESSION_NO_SIGNAL_TIMEOUT_MS);
  });

  it.each<[string, Partial<SessionOrchestratorConfig>]>([
    ['an attempt that cannot hold both calls', { attemptTimeoutMs: 8_000 }],
    ['a hold-back no longer than a tick', { retryMs: TRADING_SESSION_TICK_MS }],
    [
      'a candle slack of a whole shortest candle',
      { candleSlackMs: SIGNAL_CHART_INTERVAL_MS['5s'] },
    ],
    ['a retry as long as the deadline', { retryMs: SESSION_MAX_DURATION_MS }],
    ['a fractional tick', { tickMs: 1.5 }],
    ['a wait past the timer limit', { maxDurationMs: MAX_TIMER_MS + 1 }],
    ['no session per tick', { batchSize: 0 }],
    ['a no-signal limit no longer than the hold-back (#509)', { noSignalTimeoutMs: 60_000 }],
    [
      'a no-signal limit as long as the deadline (#509)',
      { noSignalTimeoutMs: SESSION_MAX_DURATION_MS },
    ],
    [
      "a no-signal limit inside the bot's longest candle (#509)",
      { noSignalTimeoutMs: SIGNAL_CHART_INTERVAL_MS['15s'], retryMs: 10_000 },
    ],
  ])('refuses %s', (_label, patch) => {
    expect(sessionOrchestratorConfigHolds({ ...TRADING_SESSION_CONFIG, ...patch })).toBe(false);
  });

  it('refuses a pairs timeout that leaves no room for the signal call', () => {
    expect(
      sessionOrchestratorConfigHolds(
        TRADING_SESSION_CONFIG,
        TRADING_SESSION_ATTEMPT_TIMEOUT_MS - TRADING_SIGNAL_BUDGET_MS,
      ),
    ).toBe(false);
  });
});
