import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BROKER_REST_TIMEOUT_MS } from '@binarius/broker-rest';
import { BOT_PROFILE_PUBLISH_BUDGET_MS, BOT_TEXTS_REFRESH_MS } from '@binarius/shared';
import { ACCESS_TOKEN_ROUTE_BUDGET_MS } from '@binarius/shared/access-token';
import {
  BALANCE_WATCH_WINDOW_MS,
  BROKER_BALANCE_SLA_MS,
  TRADING_ACCESS_BUDGET_MS,
} from '@binarius/shared/broker-balance';
import {
  BROKER_RATE_LIMIT_PER_MINUTE,
  DEFAULT_SIGNAL_SCAN_PER_MINUTE,
} from '@binarius/shared/broker-budget';
import { OAUTH_CALLBACK_BUDGET_MS } from '@binarius/shared/oauth';
import {
  SIGNAL_CHART_INTERVAL_MS,
  SIGNAL_SCAN_INTERVALS,
  TRADING_SIGNAL_BUDGET_MS,
} from '@binarius/shared/signal';
import { TRADING_SESSION_START_BUDGET_MS } from '@binarius/shared/trading-session';
import {
  composeDurationMs,
  composeServiceEnvValue,
  composeServiceValue,
} from '@binarius/shared/testing';
import { BROKER_HTTP_TIMEOUT_MS } from './broker/oauth-client';
import { DEFAULT_PUBLISHER_CONFIG } from './outbox/publisher';
import {
  BALANCE_STALLED_RETRY_MS,
  BOT_PROFILE_PUBLISH_CALLS,
  BOT_PROFILE_PUBLISH_TIMEOUT_MS,
  BOT_TEXTS_LOAD_BUDGET_MS,
  COMPOSE_STOP_GRACE_PERIOD_MS,
  LINK_PUSH_TELEGRAM_API_TIMEOUT_MS,
  MAX_BALANCE_POLL_PER_MINUTE,
  MAX_BALANCE_RECONCILE_INTERVAL_MS,
  MAX_SIGNAL_SCAN_PER_MINUTE,
  MIN_BALANCE_RECONCILE_INTERVAL_MS,
  MIN_SIGNAL_SCAN_PER_MINUTE,
  SHUTDOWN_PHASE1_BUDGET_MS,
  SHUTDOWN_PHASE2_BUDGET_MS,
  SIGNAL_CACHE_MAX_TTL_MS,
  SIGNAL_FETCH_BUDGET_MS,
  SIGNAL_SCAN_BACKOFF_MAX_MS,
  SIGNAL_SCAN_BACKOFF_MIN_MS,
  SIGNAL_SCAN_SHARES_PERCENT,
  SIGNAL_SCAN_SLACK_MS,
  scanDecisionsPerMinute,
  signalScanPairs,
  signalScanPerMinute,
  TRADING_ACCESS_REFRESH_BUDGET_MS,
} from './timing';

const composeYaml = readFileSync(
  fileURLToPath(new URL('../../../compose.yaml', import.meta.url)),
  'utf8',
);

// The chain is enforced at import: timing.ts throws when it does not hold, so a violation
// takes this file down before the first test runs. An expectation here could only ever see true.
describe('backend shutdown timing', () => {
  it('keeps the publish deadline under phase 1 and both phases under the stop grace period', () => {
    expect(DEFAULT_PUBLISHER_CONFIG.publishTimeoutMs).toBeLessThan(SHUTDOWN_PHASE1_BUDGET_MS);
    expect(BROKER_HTTP_TIMEOUT_MS).toBeLessThan(SHUTDOWN_PHASE1_BUDGET_MS);
    expect(BROKER_HTTP_TIMEOUT_MS + LINK_PUSH_TELEGRAM_API_TIMEOUT_MS).toBeLessThanOrEqual(
      OAUTH_CALLBACK_BUDGET_MS,
    );
    expect(OAUTH_CALLBACK_BUDGET_MS).toBeLessThan(SHUTDOWN_PHASE1_BUDGET_MS);
    expect(BROKER_HTTP_TIMEOUT_MS).toBeLessThan(ACCESS_TOKEN_ROUTE_BUDGET_MS);
    expect(ACCESS_TOKEN_ROUTE_BUDGET_MS).toBeLessThan(SHUTDOWN_PHASE1_BUDGET_MS);
    expect(SHUTDOWN_PHASE1_BUDGET_MS + SHUTDOWN_PHASE2_BUDGET_MS).toBeLessThan(
      COMPOSE_STOP_GRACE_PERIOD_MS,
    );
  });

  it('matches the stop_grace_period compose gives the backend service', () => {
    expect(
      composeDurationMs(composeServiceValue(composeYaml, 'backend', 'stop_grace_period')),
    ).toBe(COMPOSE_STOP_GRACE_PERIOD_MS);
  });

  // forwarded without a value: compose passes it only when the host sets it, and the code's
  // default (DEFAULT_BROKER_PAIRS_TTL_MS) applies otherwise
  it('forwards BROKER_PAIRS_TTL_MS to the backend without a default of its own', () => {
    expect(composeServiceEnvValue(composeYaml, 'backend', 'BROKER_PAIRS_TTL_MS')).toBe('');
  });

  // #144: trading is the trading_switch row now; a REAL_TRADING_ENABLED left in .env reaches no
  // process (docs/kill-switch.md -> Deploy). The trading-worker side is in intents/config.test.ts.
  it('no longer forwards REAL_TRADING_ENABLED to the backend', () => {
    expect(composeServiceEnvValue(composeYaml, 'backend', 'REAL_TRADING_ENABLED')).toBeUndefined();
  });
});

describe('broker balance timing', () => {
  it('orders the reconcile interval between one GET and the SLA', () => {
    expect(BROKER_REST_TIMEOUT_MS).toBeLessThan(MIN_BALANCE_RECONCILE_INTERVAL_MS);
    expect(MAX_BALANCE_RECONCILE_INTERVAL_MS).toBeLessThanOrEqual(BROKER_BALANCE_SLA_MS);
  });

  it('keeps the poll ceiling under the broker window', () => {
    expect(MAX_BALANCE_POLL_PER_MINUTE).toBeLessThan(BROKER_RATE_LIMIT_PER_MINUTE);
  });

  it('skips a stalled account for at least one tick and retries it inside the watch window', () => {
    expect(MAX_BALANCE_RECONCILE_INTERVAL_MS).toBeLessThan(BALANCE_STALLED_RETRY_MS);
    expect(BALANCE_STALLED_RETRY_MS).toBeLessThan(BALANCE_WATCH_WINDOW_MS);
  });

  it('fits the route GET inside the route budget and the budget inside phase 1', () => {
    expect(TRADING_ACCESS_REFRESH_BUDGET_MS).toBeLessThan(TRADING_ACCESS_BUDGET_MS);
    expect(TRADING_ACCESS_BUDGET_MS).toBeLessThan(SHUTDOWN_PHASE1_BUDGET_MS);
  });

  it('fits the balance GET inside the session start budget and the budget inside phase 1', () => {
    expect(TRADING_ACCESS_REFRESH_BUDGET_MS).toBeLessThan(TRADING_SESSION_START_BUDGET_MS);
    expect(TRADING_SESSION_START_BUDGET_MS).toBeLessThan(SHUTDOWN_PHASE1_BUDGET_MS);
  });

  it('ends the signal route chart GET by its own budget, inside the route budget and phase 1', () => {
    expect(SIGNAL_FETCH_BUDGET_MS).toBeLessThan(BROKER_REST_TIMEOUT_MS);
    expect(SIGNAL_FETCH_BUDGET_MS).toBeLessThan(TRADING_SIGNAL_BUDGET_MS);
    expect(TRADING_SIGNAL_BUDGET_MS).toBeLessThan(SHUTDOWN_PHASE1_BUDGET_MS);
    expect(SIGNAL_CACHE_MAX_TTL_MS).toBeLessThan(SIGNAL_CHART_INTERVAL_MS['1m']);
  });

  it.each(SIGNAL_SCAN_INTERVALS)('starts and ends a scan inside its %s candle', (interval) => {
    expect(SIGNAL_SCAN_SLACK_MS).toBeLessThan(SIGNAL_CHART_INTERVAL_MS[interval]);
    expect(SIGNAL_FETCH_BUDGET_MS + SIGNAL_SCAN_SLACK_MS).toBeLessThan(
      SIGNAL_CHART_INTERVAL_MS[interval],
    );
    expect(Number.isInteger(scanDecisionsPerMinute(interval))).toBe(true);
  });

  it('keeps the scanner backoff bounds in order', () => {
    expect(SIGNAL_SCAN_BACKOFF_MIN_MS).toBeLessThanOrEqual(SIGNAL_SCAN_BACKOFF_MAX_MS);
  });

  it('splits the scan ceiling into 13 pairs on 15s and 4 on 5s at the default (#382)', () => {
    expect(signalScanPairs(DEFAULT_SIGNAL_SCAN_PER_MINUTE, '15s')).toBe(13);
    expect(signalScanPairs(DEFAULT_SIGNAL_SCAN_PER_MINUTE, '5s')).toBe(4);
    expect(signalScanPairs(MAX_SIGNAL_SCAN_PER_MINUTE, '15s')).toBe(26);
    expect(signalScanPairs(MAX_SIGNAL_SCAN_PER_MINUTE, '5s')).toBe(8);
    expect(signalScanPerMinute(DEFAULT_SIGNAL_SCAN_PER_MINUTE, '15s')).toBe(52);
    expect(signalScanPerMinute(DEFAULT_SIGNAL_SCAN_PER_MINUTE, '5s')).toBe(48);
    expect(
      SIGNAL_SCAN_INTERVALS.reduce(
        (sum, interval) => sum + SIGNAL_SCAN_SHARES_PERCENT[interval],
        0,
      ),
    ).toBe(100);
    expect(
      SIGNAL_SCAN_INTERVALS.reduce(
        (sum, interval) =>
          sum +
          signalScanPairs(DEFAULT_SIGNAL_SCAN_PER_MINUTE, interval) *
            scanDecisionsPerMinute(interval),
        0,
      ),
    ).toBeLessThanOrEqual(DEFAULT_SIGNAL_SCAN_PER_MINUTE);
  });

  it('keeps the scan ceiling between one pair on every interval and the broker window', () => {
    expect(MIN_SIGNAL_SCAN_PER_MINUTE).toBe(25);
    expect(signalScanPairs(MIN_SIGNAL_SCAN_PER_MINUTE, '15s')).toBe(3);
    expect(signalScanPairs(MIN_SIGNAL_SCAN_PER_MINUTE, '5s')).toBe(1);
    expect(signalScanPairs(MIN_SIGNAL_SCAN_PER_MINUTE - 1, '5s')).toBe(0);
    expect(MAX_SIGNAL_SCAN_PER_MINUTE).toBeLessThan(BROKER_RATE_LIMIT_PER_MINUTE);
  });

  it('ends a bot texts load before the next one starts and inside phase 1', () => {
    expect(BOT_TEXTS_LOAD_BUDGET_MS).toBeLessThan(BOT_TEXTS_REFRESH_MS);
    expect(BOT_TEXTS_LOAD_BUDGET_MS).toBeLessThan(SHUTDOWN_PHASE1_BUDGET_MS);
  });

  // web's link, BOT_PROFILE_PUBLISH_BUDGET_MS < its BACKEND_REQUEST_TIMEOUT_MS, is in
  // apps/web/src/timing.ts (#361)
  it('fits one publish of the menu and the profile in its budget and inside phase 1 (#301)', () => {
    expect(BOT_PROFILE_PUBLISH_CALLS * BOT_PROFILE_PUBLISH_TIMEOUT_MS).toBeLessThanOrEqual(
      BOT_PROFILE_PUBLISH_BUDGET_MS,
    );
    expect(BOT_PROFILE_PUBLISH_BUDGET_MS).toBeLessThan(SHUTDOWN_PHASE1_BUDGET_MS);
  });

  it.each([
    'BALANCE_RECONCILE_INTERVAL_MS',
    'BALANCE_POLL_MAX_PER_MINUTE',
    'SIGNAL_SCAN_MAX_PER_MINUTE',
  ])('forwards %s to the backend without a default of its own', (name) => {
    expect(composeServiceEnvValue(composeYaml, 'backend', name)).toBe('');
  });
});
