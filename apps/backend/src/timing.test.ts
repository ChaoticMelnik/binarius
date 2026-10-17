import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BROKER_REST_TIMEOUT_MS } from '@binarius/broker-rest';
import {
  BROKER_SOCKET_AUTH_TIMEOUT_MS,
  BROKER_SOCKET_CONNECT_TIMEOUT_MS,
  BROKER_SOCKET_RECONNECT_DELAY_MS,
  BROKER_SOCKET_RECONNECT_JITTER,
} from '@binarius/broker-socket';
import { SIGNAL_FETCH_LIMIT, SIGNAL_PACER_RETRY_SEC, TICK_MAX_SKEW_MS } from '@binarius/signal';
import {
  BOT_PROFILE_PUBLISH_BUDGET_MS,
  BOT_TEXTS_REFRESH_MS,
  ANALYSIS_UNUSED_AFTER_MS,
  ANALYSIS_UNUSED_UNTIL_MS,
  REFERRAL_REWARDED_AFTER_MS,
  MAILING_MIN_OFFSET_MS,
  STARS_PRECHECKOUT_BUDGET_MS,
} from '@binarius/shared';
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
import {
  DEPOSIT_CREDITED_BUDGET_MS,
  DEPOSIT_WIDGET_SESSION_BUDGET_MS,
} from '@binarius/shared/deposit';
import { OAUTH_CALLBACK_BUDGET_MS } from '@binarius/shared/oauth';
import {
  SIGNAL_CHART_INTERVAL_MS,
  SIGNAL_SCAN_INTERVALS,
  TRADING_SIGNAL_BUDGET_MS,
} from '@binarius/shared/signal';
import {
  TRADING_SESSION_START_BUDGET_MS,
  TRADING_SESSION_VIEW_BUDGET_MS,
} from '@binarius/shared/trading-session';
import {
  composeDurationMs,
  composeServiceEnvValue,
  composeServiceValue,
} from '@binarius/shared/testing';
import { BROKER_HTTP_TIMEOUT_MS } from './broker/oauth-client';
import { DEFAULT_PUBLISHER_CONFIG } from './outbox/publisher';
import {
  ADMIN_TELEGRAM_API_TIMEOUT_MS,
  BALANCE_STALLED_RETRY_MS,
  BOT_PROFILE_PUBLISH_CALLS,
  BOT_PROFILE_PUBLISH_TIMEOUT_MS,
  BOT_TEXTS_LOAD_BUDGET_MS,
  COMPOSE_STOP_GRACE_PERIOD_MS,
  DEPOSIT_BROKER_CALL_BUDGET_MS,
  DEPOSIT_CREDITED_REFRESH_BUDGET_MS,
  CLIENT_PUSH_TELEGRAM_API_TIMEOUT_MS,
  MAILING_PLAN_TICK_MS,
  MAILING_SEND_BATCH,
  MAILING_SEND_PER_SECOND,
  MAILING_SEND_TICK_MS,
  SESSION_NOTICE_SEND_PER_SECOND,
  MAX_BALANCE_POLL_PER_MINUTE,
  MAX_BALANCE_RECONCILE_INTERVAL_MS,
  MARKET_DATA_ACCOUNT_RETRY_MS,
  MARKET_DATA_BACKFILL_ATTEMPTS,
  MARKET_DATA_BACKFILL_BUDGET_MS,
  MARKET_DATA_BACKFILL_CONCURRENCY,
  MARKET_DATA_BACKFILL_POLL_MS,
  MARKET_DATA_BACKFILL_RETRY_MS,
  MARKET_DATA_BACKFILL_SCAN_MS,
  MARKET_DATA_FAILOVER_GRACE_MS,
  MARKET_DATA_LOG_MS,
  MARKET_DATA_PENDING_MAX,
  MARKET_DATA_RESERVE_READY_MS,
  MARKET_DATA_RING_CANDLES,
  MARKET_DATA_SKEW_MARGIN_MS,
  MARKET_DATA_TICK_MS,
  MAX_SIGNAL_SCAN_PER_MINUTE,
  MIN_BALANCE_RECONCILE_INTERVAL_MS,
  MIN_SIGNAL_SCAN_PER_MINUTE,
  SERVICE_ACCOUNTS_TICK_MS,
  SERVICE_RENEWALS_PER_TICK,
  SERVICE_STALLED_RETRY_MS,
  SERVICE_TOKEN_RENEW_AHEAD_MS,
  SERVICE_TOKEN_ROTATION_GAP_MS,
  SHUTDOWN_PHASE1_BUDGET_MS,
  SHUTDOWN_PHASE2_BUDGET_MS,
  SIGNAL_CACHE_MAX_TTL_MS,
  SIGNAL_FETCH_BUDGET_MS,
  SIGNAL_SCAN_BACKOFF_MAX_MS,
  SIGNAL_SCAN_BACKOFF_MIN_MS,
  SIGNAL_SCAN_SLACK_MS,
  signalRestCapacity,
  signalRestWorstWindow,
  STARS_RECONCILE_MAX_PAGES,
  STARS_RECONCILE_PAGE_SIZE,
  STARS_RECONCILE_TICK_MS,
  STARS_RECONCILE_WINDOW_S,
  STARS_TELEGRAM_API_TIMEOUT_MS,
  TELEGRAM_BOT_SENDS_PER_SECOND,
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
    expect(BROKER_HTTP_TIMEOUT_MS + CLIENT_PUSH_TELEGRAM_API_TIMEOUT_MS).toBeLessThanOrEqual(
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

  // the staff bot's login link (#448) must name the origin `web` checks a POST's Origin against:
  // two defaults that drift apart make every link a 403
  it('gives the backend the same WEB_PUBLIC_URL as web', () => {
    const backend = composeServiceEnvValue(composeYaml, 'backend', 'WEB_PUBLIC_URL');
    expect(backend).toMatch(/^\$\{WEB_PUBLIC_URL:-[^}]+\}$/);
    expect(backend).toBe(composeServiceEnvValue(composeYaml, 'web', 'WEB_PUBLIC_URL'));
  });

  // #141: forwarded only when set, so the route is off unless the host sets it; the worker never
  // receives it (not in the shared broker anchor)
  it('forwards POSTBACK_URL_SECRET to the backend only, without a default', () => {
    expect(composeServiceEnvValue(composeYaml, 'backend', 'POSTBACK_URL_SECRET')).toBe('');
    expect(
      composeServiceEnvValue(composeYaml, 'trading-worker', 'POSTBACK_URL_SECRET'),
    ).toBeUndefined();
  });
});

describe('the cashier credited timing (#112)', () => {
  it('fits the refresh and the push inside the route budget, inside phase 1', () => {
    expect(
      DEPOSIT_CREDITED_REFRESH_BUDGET_MS + CLIENT_PUSH_TELEGRAM_API_TIMEOUT_MS,
    ).toBeLessThanOrEqual(DEPOSIT_CREDITED_BUDGET_MS);
    expect(DEPOSIT_CREDITED_BUDGET_MS).toBeLessThan(SHUTDOWN_PHASE1_BUDGET_MS);
  });
});

describe('the cashier widget session timing (#11)', () => {
  it('fits an exchange and the broker call inside the route budget, inside phase 1', () => {
    expect(BROKER_HTTP_TIMEOUT_MS + DEPOSIT_BROKER_CALL_BUDGET_MS).toBeLessThanOrEqual(
      DEPOSIT_WIDGET_SESSION_BUDGET_MS,
    );
    expect(DEPOSIT_WIDGET_SESSION_BUDGET_MS).toBeLessThan(SHUTDOWN_PHASE1_BUDGET_MS);
  });

  // the route's signal fires first, so a slow broker reads as our budget (aborted)
  it('ends the broker call before the REST client times out', () => {
    expect(DEPOSIT_BROKER_CALL_BUDGET_MS).toBeLessThan(BROKER_REST_TIMEOUT_MS);
  });

  // forwarded only when the host sets it: the default is the broker platform's origin (env.ts);
  // web's cashier page names the same list in its frame-src (#111), so one .env line feeds both
  it('forwards DEPOSIT_WIDGET_ORIGINS to the backend and web only, without a default', () => {
    expect(composeServiceEnvValue(composeYaml, 'backend', 'DEPOSIT_WIDGET_ORIGINS')).toBe('');
    expect(composeServiceEnvValue(composeYaml, 'web', 'DEPOSIT_WIDGET_ORIGINS')).toBe('');
    expect(
      composeServiceEnvValue(composeYaml, 'trading-worker', 'DEPOSIT_WIDGET_ORIGINS'),
    ).toBeUndefined();
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

  it('fits the signal GET inside the session start budget beside the balance GET (#509)', () => {
    expect(SIGNAL_FETCH_BUDGET_MS).toBeLessThan(TRADING_SESSION_START_BUDGET_MS);
  });

  it('fits the balance GET inside the session view budget and the budget inside phase 1 (#337)', () => {
    expect(TRADING_ACCESS_REFRESH_BUDGET_MS).toBeLessThan(TRADING_SESSION_VIEW_BUDGET_MS);
    expect(TRADING_SESSION_VIEW_BUDGET_MS).toBeLessThan(SHUTDOWN_PHASE1_BUDGET_MS);
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
  });

  it('keeps the scanner backoff bounds in order', () => {
    expect(SIGNAL_SCAN_BACKOFF_MIN_MS).toBeLessThanOrEqual(SIGNAL_SCAN_BACKOFF_MAX_MS);
  });

  // #405: one pacer for every signal chart GET; its bucket is one 5 s candle of on-demand GETs
  // plus a spare token (#382 review M1)
  it('sizes the signal pacer bucket to a 5 s candle of the ceiling plus one spare token', () => {
    expect(signalRestCapacity(DEFAULT_SIGNAL_SCAN_PER_MINUTE)).toBe(10);
    expect(signalRestCapacity(MAX_SIGNAL_SCAN_PER_MINUTE)).toBe(18);
    expect(signalRestCapacity(MIN_SIGNAL_SCAN_PER_MINUTE)).toBe(4);
    expect(signalRestCapacity(MIN_SIGNAL_SCAN_PER_MINUTE)).toBeGreaterThanOrEqual(2);
    expect(MIN_SIGNAL_SCAN_PER_MINUTE).toBe(25);
  });

  // the overflow token is the backfill's (#590, pacer.test.ts P11)
  it("keeps the signal pacer's worst 60 s window at the highest ceiling below the broker window", () => {
    expect(signalRestWorstWindow(MAX_SIGNAL_SCAN_PER_MINUTE)).toBe(219);
    expect(signalRestWorstWindow(MAX_SIGNAL_SCAN_PER_MINUTE)).toBeLessThan(
      BROKER_RATE_LIMIT_PER_MINUTE,
    );
  });

  it('holds a pacer refusal no longer than the cache holds anything', () => {
    expect(SIGNAL_PACER_RETRY_SEC).toBe(1);
    expect(SIGNAL_PACER_RETRY_SEC * 1000).toBeLessThanOrEqual(SIGNAL_CACHE_MAX_TTL_MS);
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

  // S9 (#117): restated so a change to the chain's conjuncts shows in review next to its test
  it('keeps the pre-checkout route and a reconciler stop inside phase 1, a tick inside its interval and the window over many ticks (#117)', () => {
    expect(STARS_PRECHECKOUT_BUDGET_MS).toBeLessThan(SHUTDOWN_PHASE1_BUDGET_MS);
    expect(STARS_TELEGRAM_API_TIMEOUT_MS + CLIENT_PUSH_TELEGRAM_API_TIMEOUT_MS).toBeLessThan(
      SHUTDOWN_PHASE1_BUDGET_MS,
    );
    expect(STARS_RECONCILE_MAX_PAGES * STARS_TELEGRAM_API_TIMEOUT_MS).toBeLessThan(
      STARS_RECONCILE_TICK_MS,
    );
    expect(STARS_RECONCILE_TICK_MS).toBeLessThan(STARS_RECONCILE_WINDOW_S * 1000);
    expect(STARS_RECONCILE_PAGE_SIZE).toBeLessThanOrEqual(100);
  });

  // T1 (#391): restated so a change to the chain's conjuncts shows in review next to its test
  it('fits a keeper tick inside its interval and nests the hold-back, the gap and the window (#391)', () => {
    expect({
      SERVICE_ACCOUNTS_TICK_MS,
      SERVICE_TOKEN_RENEW_AHEAD_MS,
      SERVICE_TOKEN_ROTATION_GAP_MS,
      SERVICE_RENEWALS_PER_TICK,
      SERVICE_STALLED_RETRY_MS,
    }).toEqual({
      SERVICE_ACCOUNTS_TICK_MS: 60_000,
      SERVICE_TOKEN_RENEW_AHEAD_MS: 86_400_000,
      SERVICE_TOKEN_ROTATION_GAP_MS: 3_600_000,
      SERVICE_RENEWALS_PER_TICK: 5,
      SERVICE_STALLED_RETRY_MS: 300_000,
    });
    expect(SERVICE_RENEWALS_PER_TICK * BROKER_HTTP_TIMEOUT_MS).toBeLessThan(
      SERVICE_ACCOUNTS_TICK_MS,
    );
    expect(SERVICE_ACCOUNTS_TICK_MS).toBeLessThan(SERVICE_STALLED_RETRY_MS);
    expect(SERVICE_STALLED_RETRY_MS).toBeLessThan(SERVICE_TOKEN_ROTATION_GAP_MS);
    expect(SERVICE_TOKEN_ROTATION_GAP_MS).toBeLessThan(SERVICE_TOKEN_RENEW_AHEAD_MS);
    expect(ADMIN_TELEGRAM_API_TIMEOUT_MS).toBeLessThan(SHUTDOWN_PHASE1_BUDGET_MS);
  });

  // restated so a change to the chain's conjuncts shows in review next to its test
  it('switches to the reserve after the start of the client’s first reconnection attempt and within one 5s candle (#404)', () => {
    expect({
      MARKET_DATA_TICK_MS,
      MARKET_DATA_LOG_MS,
      MARKET_DATA_FAILOVER_GRACE_MS,
      MARKET_DATA_RESERVE_READY_MS,
      MARKET_DATA_SKEW_MARGIN_MS,
      MARKET_DATA_ACCOUNT_RETRY_MS,
      MARKET_DATA_RING_CANDLES,
      MARKET_DATA_PENDING_MAX,
    }).toEqual({
      MARKET_DATA_TICK_MS: 30_000,
      MARKET_DATA_LOG_MS: 60_000,
      MARKET_DATA_FAILOVER_GRACE_MS: 2_000,
      MARKET_DATA_RESERVE_READY_MS: 25_000,
      MARKET_DATA_SKEW_MARGIN_MS: 2_000,
      MARKET_DATA_ACCOUNT_RETRY_MS: 300_000,
      MARKET_DATA_RING_CANDLES: SIGNAL_FETCH_LIMIT,
      MARKET_DATA_PENDING_MAX: 288,
    });
    expect(BROKER_SOCKET_RECONNECT_DELAY_MS * (1 + BROKER_SOCKET_RECONNECT_JITTER)).toBeLessThan(
      MARKET_DATA_FAILOVER_GRACE_MS,
    );
    expect(MARKET_DATA_FAILOVER_GRACE_MS).toBeLessThan(SIGNAL_CHART_INTERVAL_MS['5s']);
    expect(
      BROKER_HTTP_TIMEOUT_MS + BROKER_SOCKET_CONNECT_TIMEOUT_MS + BROKER_SOCKET_AUTH_TIMEOUT_MS,
    ).toBeLessThan(MARKET_DATA_RESERVE_READY_MS);
    expect(MARKET_DATA_SKEW_MARGIN_MS).toBeLessThan(SIGNAL_CHART_INTERVAL_MS['5s']);
    expect(MARKET_DATA_SKEW_MARGIN_MS).toBeLessThan(TICK_MAX_SKEW_MS);
    expect(MARKET_DATA_TICK_MS).toBeLessThanOrEqual(MARKET_DATA_LOG_MS);
    expect(SERVICE_ACCOUNTS_TICK_MS).toBeLessThan(MARKET_DATA_ACCOUNT_RETRY_MS);
  });

  it('ends a backfill GET by its own budget, inside phase 1 (#590)', () => {
    expect({
      MARKET_DATA_BACKFILL_BUDGET_MS,
      MARKET_DATA_BACKFILL_ATTEMPTS,
      MARKET_DATA_BACKFILL_RETRY_MS,
      MARKET_DATA_BACKFILL_SCAN_MS,
      MARKET_DATA_BACKFILL_POLL_MS,
      MARKET_DATA_BACKFILL_CONCURRENCY,
    }).toEqual({
      MARKET_DATA_BACKFILL_BUDGET_MS: 3_000,
      MARKET_DATA_BACKFILL_ATTEMPTS: 3,
      MARKET_DATA_BACKFILL_RETRY_MS: SIGNAL_CHART_INTERVAL_MS['15s'],
      MARKET_DATA_BACKFILL_SCAN_MS: SIGNAL_CHART_INTERVAL_MS['5s'],
      MARKET_DATA_BACKFILL_POLL_MS: 250,
      MARKET_DATA_BACKFILL_CONCURRENCY: 2,
    });
    expect(MARKET_DATA_BACKFILL_BUDGET_MS).toBeLessThan(BROKER_REST_TIMEOUT_MS);
    expect(MARKET_DATA_BACKFILL_BUDGET_MS).toBeLessThan(SHUTDOWN_PHASE1_BUDGET_MS);
    expect(MARKET_DATA_BACKFILL_POLL_MS * MAX_SIGNAL_SCAN_PER_MINUTE).toBeLessThanOrEqual(60_000);
    expect(MARKET_DATA_BACKFILL_SCAN_MS).toBeLessThanOrEqual(SIGNAL_CHART_INTERVAL_MS['5s']);
  });

  // the anchor forwards it valueless (intents/config.test.ts): unset leaves the source off
  it('gives the backend BROKER_WS_URL only through the broker anchor (#404)', () => {
    expect(composeServiceEnvValue(composeYaml, 'backend', 'BROKER_WS_URL')).toBeUndefined();
  });

  it('ends a mailing stop inside phase 1 and a send inside its tick, and keeps the rate under Telegram’s (#202)', () => {
    expect(1000 / MAILING_SEND_PER_SECOND + CLIENT_PUSH_TELEGRAM_API_TIMEOUT_MS).toBeLessThan(
      SHUTDOWN_PHASE1_BUDGET_MS,
    );
    expect(CLIENT_PUSH_TELEGRAM_API_TIMEOUT_MS).toBeLessThan(MAILING_SEND_TICK_MS);
    expect((MAILING_SEND_BATCH * 1000) / MAILING_SEND_PER_SECOND).toBeLessThanOrEqual(
      MAILING_SEND_TICK_MS,
    );
    expect(MAILING_SEND_PER_SECOND).toBeLessThan(TELEGRAM_BOT_SENDS_PER_SECOND);
    expect(MAILING_PLAN_TICK_MS).toBeLessThan(MAILING_MIN_OFFSET_MS);
    // #484: the earliest offset is the analysis reminder's, and a due one reaches the sender
    // before its window closes (600 + 60 + 5 s < 3 600 s)
    expect(MAILING_MIN_OFFSET_MS).toBeLessThanOrEqual(ANALYSIS_UNUSED_AFTER_MS);
    expect(ANALYSIS_UNUSED_AFTER_MS + MAILING_PLAN_TICK_MS + MAILING_SEND_TICK_MS).toBeLessThan(
      ANALYSIS_UNUSED_UNTIL_MS,
    );
    // #576: the reward notification is due at the reward and not counted in the earliest offset,
    // so its delay is the two ticks (≤ 65 s)
    expect(REFERRAL_REWARDED_AFTER_MS).toBe(0);
    expect(MAILING_MIN_OFFSET_MS).toBeGreaterThan(0);
    expect(MAILING_PLAN_TICK_MS + MAILING_SEND_TICK_MS).toBe(65_000);
    // #464: the session notices share the bot's rate with the mailings; stop() waits for the gap,
    // a summary's balance refresh and its send
    expect(MAILING_SEND_PER_SECOND + SESSION_NOTICE_SEND_PER_SECOND).toBeLessThan(
      TELEGRAM_BOT_SENDS_PER_SECOND,
    );
    expect(
      1000 / SESSION_NOTICE_SEND_PER_SECOND +
        TRADING_ACCESS_REFRESH_BUDGET_MS +
        CLIENT_PUSH_TELEGRAM_API_TIMEOUT_MS,
    ).toBeLessThan(SHUTDOWN_PHASE1_BUDGET_MS);
  });

  // the step's worst path ends with the next trade's pace; a summary does not start after stop()
  // (D22 in session-notices.db.test.ts), so the summary's link above is not added to this one
  it('ends a session notice cycle step inside phase 1: the edit, then the waiting message deleted and the new message when it is gone (#551, #536)', () => {
    expect(
      3 * (1000 / SESSION_NOTICE_SEND_PER_SECOND + CLIENT_PUSH_TELEGRAM_API_TIMEOUT_MS),
    ).toBeLessThan(SHUTDOWN_PHASE1_BUDGET_MS);
  });

  it.each([
    'BALANCE_RECONCILE_INTERVAL_MS',
    'BALANCE_POLL_MAX_PER_MINUTE',
    'SIGNAL_SCAN_MAX_PER_MINUTE',
  ])('forwards %s to the backend without a default of its own', (name) => {
    expect(composeServiceEnvValue(composeYaml, 'backend', name)).toBe('');
  });
});
