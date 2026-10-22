import { describe, expect, it } from 'vitest';
import {
  CANDLE_CLOSE_SLACK_MS,
  SESSION_MAX_DURATION_MS,
  SESSION_NO_SIGNAL_CANDLES,
  SIGNAL_CHART_INTERVAL_MS,
  SIGNAL_SCAN_INTERVALS,
  SIGNAL_SHORTEST_INTERVAL_MS,
  TRADING_SIGNAL_BUDGET_MS,
} from '@binarius/shared';
import { MAX_TIMER_MS } from '@binarius/broker-socket';
import {
  sessionOrchestratorConfigHolds,
  TRADING_SESSION_ATTEMPT_TIMEOUT_MS,
  TRADING_SESSION_CHAIN_HOLDS,
  TRADING_SESSION_CONFIG,
  TRADING_SESSION_H1_CHECK_MS,
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
    // K-H1 (#670): an H1 session's hold, between a tick and a hold-back
    expect(TRADING_SESSION_CONFIG.h1CheckMs).toBe(TRADING_SESSION_H1_CHECK_MS);
    expect(TRADING_SESSION_TICK_MS).toBeLessThanOrEqual(TRADING_SESSION_H1_CHECK_MS);
    expect(TRADING_SESSION_H1_CHECK_MS).toBeLessThan(TRADING_SESSION_RETRY_MS);
    // #697: the session asks at the scanner's moment
    expect(TRADING_SESSION_CONFIG.candleSlackMs).toBe(CANDLE_CLOSE_SLACK_MS);
    expect(TRADING_SESSION_CONFIG.candleSlackMs).toBeLessThan(SIGNAL_SHORTEST_INTERVAL_MS);
    expect(TRADING_SESSION_RETRY_MS).toBeLessThan(SESSION_MAX_DURATION_MS);
    // the deadline is the shared one the start route and the CLI check against
    expect(TRADING_SESSION_CONFIG.maxDurationMs).toBe(SESSION_MAX_DURATION_MS);
    // #509, #637: the shared count the bot's stop line prints
    expect(TRADING_SESSION_CONFIG.noSignalCandles).toBe(SESSION_NO_SIGNAL_CANDLES);
    expect(TRADING_SESSION_RETRY_MS).toBeLessThan(
      SESSION_NO_SIGNAL_CANDLES * SIGNAL_CHART_INTERVAL_MS['5s'],
    );
    // on the scanner's longest candle (5 s since #685)
    expect(
      SESSION_NO_SIGNAL_CANDLES *
        Math.max(...SIGNAL_SCAN_INTERVALS.map((interval) => SIGNAL_CHART_INTERVAL_MS[interval])),
    ).toBeLessThan(SESSION_MAX_DURATION_MS);
  });

  it.each<[string, Partial<SessionOrchestratorConfig>]>([
    ['an attempt that cannot hold both calls', { attemptTimeoutMs: 8_000 }],
    ['a hold-back no longer than a tick', { retryMs: TRADING_SESSION_TICK_MS }],
    [
      'a candle slack of a whole shortest candle',
      { candleSlackMs: SIGNAL_CHART_INTERVAL_MS['5s'] },
    ],
    [
      'a hold-back as long as the deadline, past 20 candles of 5 s (#637)',
      { retryMs: SESSION_MAX_DURATION_MS },
    ],
    ['a fractional tick', { tickMs: 1.5 }],
    ['K-H1 an H1 hold shorter than a tick (#670)', { h1CheckMs: TRADING_SESSION_TICK_MS - 1 }],
    ['K-H1 an H1 hold as long as a hold-back (#670)', { h1CheckMs: TRADING_SESSION_RETRY_MS }],
    ['K-H1 a fractional H1 hold (#670)', { h1CheckMs: 5_000.5 }],
    ['a wait past the timer limit', { maxDurationMs: MAX_TIMER_MS + 1 }],
    ['no session per tick', { batchSize: 0 }],
    [
      'one candle (#637) - with a tick and a hold-back below one 5 s candle, so only the count refuses it',
      { noSignalCandles: 1, tickMs: 1_000, retryMs: 2_000 },
    ],
    ['12.5 candles (#637)', { noSignalCandles: 12.5 }],
    ['12 candles of 5 s, the hold-back (#637)', { noSignalCandles: 12 }],
    ['720 candles of 5 s, the deadline (#637, #685)', { noSignalCandles: 720 }],
    [
      '597 candles of 1h past the timer bound, under the largest timer-safe deadline (#637)',
      {
        noSignalCandles: Math.ceil(MAX_TIMER_MS / SIGNAL_CHART_INTERVAL_MS['1h']),
        maxDurationMs: MAX_TIMER_MS,
      },
    ],
  ])('refuses %s', (_label, patch) => {
    expect(sessionOrchestratorConfigHolds({ ...TRADING_SESSION_CONFIG, ...patch })).toBe(false);
  });

  // #696: 13 candles of 5 s is 65 s, the SLA plus one REST GET; the hold-back (60 s) and the
  // deadline still fit, so only the balance wait's link refuses it
  it('refuses a no-signal limit the balance refresh does not fit before (#696)', () => {
    expect(sessionOrchestratorConfigHolds({ ...TRADING_SESSION_CONFIG, noSignalCandles: 13 })).toBe(
      false,
    );
    expect(sessionOrchestratorConfigHolds({ ...TRADING_SESSION_CONFIG, noSignalCandles: 14 })).toBe(
      true,
    );
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
