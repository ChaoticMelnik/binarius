import { BROKER_REST_TIMEOUT_MS } from '@binarius/broker-rest';
import { ACCESS_TOKEN_ROUTE_BUDGET_MS } from '@binarius/shared/access-token';
import { ADMIN_LOGIN_BUDGET_MS } from '@binarius/shared/admin';
import {
  BROKER_RATE_LIMIT_PER_MINUTE,
  DEFAULT_BALANCE_POLL_PER_MINUTE,
  DEFAULT_SIGNAL_SCAN_PER_MINUTE,
} from '@binarius/shared/broker-budget';
import { BOT_PROFILE_PUBLISH_BUDGET_MS, BOT_TEXTS_REFRESH_MS } from '@binarius/shared';
import {
  BALANCE_WATCH_WINDOW_MS,
  BROKER_BALANCE_SLA_MS,
  TRADING_ACCESS_BUDGET_MS,
} from '@binarius/shared/broker-balance';
import { OAUTH_CALLBACK_BUDGET_MS } from '@binarius/shared/oauth';
import {
  SIGNAL_CHART_INTERVAL_MS,
  SIGNAL_SCAN_INTERVAL,
  TRADING_SIGNAL_BUDGET_MS,
} from '@binarius/shared/signal';
import { TRADING_SESSION_START_BUDGET_MS } from '@binarius/shared/trading-session';
import { BROKER_HTTP_TIMEOUT_MS } from './broker/oauth-client';
import { DEFAULT_PUBLISHER_CONFIG } from './outbox/publisher';

// Phase 1 waits for app.close() (requests in flight) and publisher.stop() (the row in flight:
// claim, add under its deadline, outcome, commit). The budget covers that Redis deadline plus
// ordinary database latency. It does not bound a database that times out every statement
// (query_timeout 1.8 s each) or a request that hangs: those end in exit(1) with the transaction
// rolled back and the outbox row replayed on the next start. compose's stop_grace_period for
// the backend sits above both phases together.
export const SHUTDOWN_PHASE1_BUDGET_MS = 10_000;
export const SHUTDOWN_PHASE2_BUDGET_MS = 4_000;
export const COMPOSE_STOP_GRACE_PERIOD_MS = 20_000;

// --- The staff-login bot (#68) -----------------------------------------------------------------
// A second grammY instance inside this process, on its own token. Its numbers are separate from
// apps/bot's: this one carries a login that a person is waiting on, so its calls are bounded far
// more tightly than the welcome flow's.

// Each Bot API call of the admin bot (grammY's ApiClientOptions.timeoutSeconds, default 500):
// the sendMessage in POST /admin/auth/login, the answerCallbackQuery and sendMessage in the
// handlers, and the confirming getUpdates that stop() issues.
export const ADMIN_TELEGRAM_API_TIMEOUT_MS = 3_000;
// Server-side wait for one getUpdates (grammY's PollingOptions.timeout), below the client
// timeout so the long poll is never aborted by our own client and retried.
export const ADMIN_POLLING_TIMEOUT_S = 2;
// Updates per getUpdates. One, for the reason apps/bot/src/timing.ts gives: stop() neither
// interrupts a batch nor confirms the updates behind the one in flight.
export const ADMIN_POLLING_BATCH_LIMIT = 1;

// What each handler does on its longest path. The budget below is computed from these and
// admin/timing.test.ts compares them against the calls the handlers actually make.
export const ADMIN_HANDLER_CALLS = {
  // the reply carrying the sender's own Telegram id
  start: 1,
  // answerCallbackQuery ∥ sendMessage(code) — the parallel pair is counted as sequential
  confirm: 2,
  // answerCallbackQuery
  deny: 1,
} as const;

// The longest declared handler path. The database work inside a handler is ordinary latency by
// this file's convention, not a bounded operation.
export const ADMIN_HANDLER_BUDGET_MS =
  Math.max(...Object.values(ADMIN_HANDLER_CALLS)) * ADMIN_TELEGRAM_API_TIMEOUT_MS;

// --- The link push (#128) --------------------------------------------------------------------
// The one sendMessage POST /auth/binodex/callback makes after the link commits (grammY's
// ApiClientOptions.timeoutSeconds). One attempt: a lost push is made up for by the confirm
// button on the user's next /start.
export const LINK_PUSH_TELEGRAM_API_TIMEOUT_MS = 3_000;

// --- The scrypt queue --------------------------------------------------------------------------
// One hash is 128 MiB and about 250 ms of a threadpool thread. Without a limit, a burst of
// logins would be a way to spend the process's memory, so the concurrency is capped and the
// wait for a slot is bounded: over either, the request is refused with 429 and no KDF runs.
export const PASSWORD_VERIFY_CONCURRENCY = 2;
export const PASSWORD_VERIFY_QUEUE_MAX = 8;
export const PASSWORD_VERIFY_MAX_WAIT_MS = 2_000;
// Upper estimate of one scrypt at the parameters staff-password.ts writes (measured: 250 ms).
// A premise of the chain below, not a test: timing a KDF in CI would flake.
export const PASSWORD_VERIFY_COST_CEILING_MS = 1_000;
// POST /admin/auth/password runs verify and hash in one slot of the queue (admin/routes.ts →
// derive): two derivations per slot, one wait.
export const PASSWORD_CHANGE_DERIVATIONS = 2;

// How long grammY sleeps before retrying a failed getUpdates (out/bot.js, handlePollingError).
// Nothing of ours configures it and stop() does not interrupt the sleep. admin/timing.test.ts
// reads the number back out of grammY rather than trusting this line.
export const GRAMMY_POLLING_BACKOFF_MS = 3_000;

// --- The broker balance snapshot (#137) --------------------------------------------------------
// docs/broker-balance.md. The background refresh runs every BALANCE_RECONCILE_INTERVAL_MS (env,
// bounded here) over the accounts in work, at most BALANCE_POLL_MAX_PER_MINUTE GETs a minute.

// Above one GET's timeout, so a request ends before the next tick starts.
export const MIN_BALANCE_RECONCILE_INTERVAL_MS = 10_000;
// Not longer than the SLA: a longer interval would leave watched snapshots stale by configuration.
export const MAX_BALANCE_RECONCILE_INTERVAL_MS = BROKER_BALANCE_SLA_MS;
export const DEFAULT_BALANCE_RECONCILE_INTERVAL_MS = 60_000;

// The broker's per-IP window and the default share are in packages/shared/src/broker-budget.ts
// (docs/signal.md -> The budget); the default shares sum to the whole window, so OAuth, token
// refreshes and the pairs catalog from the same IP are outside every share.
export const MIN_BALANCE_POLL_PER_MINUTE = 1;
export const MAX_BALANCE_POLL_PER_MINUTE = 500;

// GETs of one tick in flight at once.
export const BALANCE_POLL_CONCURRENCY = 4;

// How long a tick leaves alone an account whose attempt left nothing in its row to move it
// down the queue (no snapshot to mark, or a token that needs an exchange).
export const BALANCE_STALLED_RETRY_MS = 300_000;

// The one broker GET POST /trading/access may wait for (the route's signal; the client ends at
// the earlier of it and BROKER_REST_TIMEOUT_MS).
export const TRADING_ACCESS_REFRESH_BUDGET_MS = 3_000;

// --- POST /trading/signal (#258) ---------------------------------------------------------------
// docs/signal.md -> Budgets. The one chart GET the route may wait for: the cache's own deadline on
// every fetch, below the REST client's timeout so that this, not the client, ends a slow chart.
export const SIGNAL_FETCH_BUDGET_MS = 3_000;
// The longest the cache holds an answer. Below 1m, or it would never bind on a minute candle; on
// the 5s and 15s candles (#313) the candle's end binds first.
export const SIGNAL_CACHE_MAX_TTL_MS = 30_000;

// --- The signal scanner (#343) ----------------------------------------------------------------
// docs/signal.md -> The scanner. One scan a 15s candle, this long after its boundary: the live
// broker returned the just-closed candle 150 ms after the boundary (2026-10-08), and the rest
// covers the host's clock against the broker's.
export const SIGNAL_SCAN_SLACK_MS = 500;
// chart GETs of one scan in flight at once
export const SIGNAL_SCAN_CONCURRENCY = 4;
// the scanner's pause after a 429 without Retry-After: doubles from the first to the second; a
// Retry-After is held to the same bounds
export const SIGNAL_SCAN_BACKOFF_MIN_MS = 15_000;
export const SIGNAL_SCAN_BACKOFF_MAX_MS = 120_000;
// the period of the scanner's `signal scanner` log line
export const SIGNAL_SCAN_LOG_MS = 60_000;
// decisions a minute for one scanned pair: one a candle
export const SIGNAL_SCAN_DECISIONS_PER_PAIR_PER_MINUTE =
  60_000 / SIGNAL_CHART_INTERVAL_MS[SIGNAL_SCAN_INTERVAL];
// SIGNAL_SCAN_MAX_PER_MINUTE's bounds: at least one pair, and below the whole per-IP window
export const MIN_SIGNAL_SCAN_PER_MINUTE = SIGNAL_SCAN_DECISIONS_PER_PAIR_PER_MINUTE;
export const MAX_SIGNAL_SCAN_PER_MINUTE = 200;

// the pairs scanned each candle under a ceiling of chart GETs a minute
export const signalScanMaxPairs = (perMinute: number): number =>
  Math.floor(perMinute / SIGNAL_SCAN_DECISIONS_PER_PAIR_PER_MINUTE);

// --- Bot text overrides (#299) ------------------------------------------------------------------
// docs/bot-texts.md → Loading. One SELECT of bot_text_overrides; a slower one counts as failed and
// the push keeps the texts it had. The SELECT itself is bounded by the pool's query_timeout.
export const BOT_TEXTS_LOAD_BUDGET_MS = 3_000;

// --- Publishing the command menu and the profile (#301) ---------------------------------------
// docs/bot-texts.md → Publishing. Each Bot API call of publishBotProfile (grammY's
// ApiClientOptions.timeoutSeconds), one attempt, made one after another; the calls of one
// publish, which bot-texts/publish.test.ts compares with BOT_PROFILE_METHODS (@binarius/shared).
export const BOT_PROFILE_PUBLISH_TIMEOUT_MS = 2_000;
export const BOT_PROFILE_PUBLISH_CALLS = 3;

// the broker call is the other bounded operation phase 1 can be waiting on: a login handler
// holds no lock, but a refresh does, and its transaction must fit in the budget
export const TIMING_CHAIN_HOLDS =
  DEFAULT_PUBLISHER_CONFIG.publishTimeoutMs < SHUTDOWN_PHASE1_BUDGET_MS &&
  BROKER_HTTP_TIMEOUT_MS < SHUTDOWN_PHASE1_BUDGET_MS &&
  // the callback's longest path: the code exchange, then the push. The contract constant lives
  // in packages/shared because apps/web sizes its forward's timeout above the same number.
  BROKER_HTTP_TIMEOUT_MS + LINK_PUSH_TELEGRAM_API_TIMEOUT_MS <= OAUTH_CALLBACK_BUDGET_MS &&
  OAUTH_CALLBACK_BUDGET_MS < SHUTDOWN_PHASE1_BUDGET_MS &&
  ADMIN_POLLING_BATCH_LIMIT === 1 &&
  ADMIN_POLLING_TIMEOUT_S * 1000 < ADMIN_TELEGRAM_API_TIMEOUT_MS &&
  // what POST /admin/auth/login may spend: the wait for a scrypt slot, the scrypt, and the one
  // Telegram call after it. The contract constant lives in packages/shared because apps/web
  // sizes its own client timeout above the same number.
  PASSWORD_VERIFY_MAX_WAIT_MS + PASSWORD_VERIFY_COST_CEILING_MS + ADMIN_TELEGRAM_API_TIMEOUT_MS <=
    ADMIN_LOGIN_BUDGET_MS &&
  // and what POST /admin/auth/password may spend on its KDF: the same wait, then two derivations
  // in that one slot. Its statements are bounded by the pool's query_timeout, not by this.
  PASSWORD_VERIFY_MAX_WAIT_MS + PASSWORD_CHANGE_DERIVATIONS * PASSWORD_VERIFY_COST_CEILING_MS <=
    ADMIN_LOGIN_BUDGET_MS &&
  ADMIN_LOGIN_BUDGET_MS < SHUTDOWN_PHASE1_BUDGET_MS &&
  ADMIN_HANDLER_BUDGET_MS < SHUTDOWN_PHASE1_BUDGET_MS &&
  GRAMMY_POLLING_BACKOFF_MS < SHUTDOWN_PHASE1_BUDGET_MS &&
  SHUTDOWN_PHASE1_BUDGET_MS + SHUTDOWN_PHASE2_BUDGET_MS < COMPOSE_STOP_GRACE_PERIOD_MS &&
  BROKER_REST_TIMEOUT_MS < MIN_BALANCE_RECONCILE_INTERVAL_MS &&
  MIN_BALANCE_RECONCILE_INTERVAL_MS <= DEFAULT_BALANCE_RECONCILE_INTERVAL_MS &&
  DEFAULT_BALANCE_RECONCILE_INTERVAL_MS <= MAX_BALANCE_RECONCILE_INTERVAL_MS &&
  MAX_BALANCE_RECONCILE_INTERVAL_MS <= BROKER_BALANCE_SLA_MS &&
  MIN_BALANCE_POLL_PER_MINUTE <= DEFAULT_BALANCE_POLL_PER_MINUTE &&
  DEFAULT_BALANCE_POLL_PER_MINUTE <= MAX_BALANCE_POLL_PER_MINUTE &&
  MAX_BALANCE_POLL_PER_MINUTE < BROKER_RATE_LIMIT_PER_MINUTE &&
  // a watched account is skipped by at least one tick, and retried within its watch window
  MAX_BALANCE_RECONCILE_INTERVAL_MS < BALANCE_STALLED_RETRY_MS &&
  BALANCE_STALLED_RETRY_MS < BALANCE_WATCH_WINDOW_MS &&
  // an account the bot asked about survives at least one tick
  MAX_BALANCE_RECONCILE_INTERVAL_MS < BALANCE_WATCH_WINDOW_MS &&
  // the GET inside the route, the route inside what the bot waits for (#24), and inside phase 1
  TRADING_ACCESS_REFRESH_BUDGET_MS < TRADING_ACCESS_BUDGET_MS &&
  TRADING_ACCESS_BUDGET_MS < SHUTDOWN_PHASE1_BUDGET_MS &&
  // the session start route (#283) waits on the same GET when the account has no snapshot
  TRADING_ACCESS_REFRESH_BUDGET_MS < TRADING_SESSION_START_BUDGET_MS &&
  TRADING_SESSION_START_BUDGET_MS < SHUTDOWN_PHASE1_BUDGET_MS &&
  // the chart GET inside the signal route, the route inside what the bot waits for (#126), and
  // inside phase 1; the hold's cap below the 1m candle
  SIGNAL_FETCH_BUDGET_MS < BROKER_REST_TIMEOUT_MS &&
  SIGNAL_FETCH_BUDGET_MS < TRADING_SIGNAL_BUDGET_MS &&
  TRADING_SIGNAL_BUDGET_MS < SHUTDOWN_PHASE1_BUDGET_MS &&
  SIGNAL_CACHE_MAX_TTL_MS < SIGNAL_CHART_INTERVAL_MS['1m'] &&
  // a scan starts inside its candle and a call made at the scan moment, bounded by the cache, ends
  // inside it too; the scanner takes no pair past the candle's end (scanner.ts)
  SIGNAL_SCAN_SLACK_MS < SIGNAL_CHART_INTERVAL_MS[SIGNAL_SCAN_INTERVAL] &&
  SIGNAL_FETCH_BUDGET_MS + SIGNAL_SCAN_SLACK_MS < SIGNAL_CHART_INTERVAL_MS[SIGNAL_SCAN_INTERVAL] &&
  SIGNAL_SCAN_BACKOFF_MIN_MS <= SIGNAL_SCAN_BACKOFF_MAX_MS &&
  Number.isInteger(SIGNAL_SCAN_DECISIONS_PER_PAIR_PER_MINUTE) &&
  MIN_SIGNAL_SCAN_PER_MINUTE <= DEFAULT_SIGNAL_SCAN_PER_MINUTE &&
  DEFAULT_SIGNAL_SCAN_PER_MINUTE <= MAX_SIGNAL_SCAN_PER_MINUTE &&
  MAX_SIGNAL_SCAN_PER_MINUTE < BROKER_RATE_LIMIT_PER_MINUTE &&
  signalScanMaxPairs(MIN_SIGNAL_SCAN_PER_MINUTE) >= 1 &&
  // the worker's token route (#90): its longest path is one exchange under the account's row
  // lock, and the worker waits ACCESS_TOKEN_ROUTE_BUDGET_MS for it
  BROKER_HTTP_TIMEOUT_MS < ACCESS_TOKEN_ROUTE_BUDGET_MS &&
  ACCESS_TOKEN_ROUTE_BUDGET_MS < SHUTDOWN_PHASE1_BUDGET_MS &&
  // a load ends before the next one starts, and inside phase 1
  BOT_TEXTS_LOAD_BUDGET_MS < BOT_TEXTS_REFRESH_MS &&
  BOT_TEXTS_LOAD_BUDGET_MS < SHUTDOWN_PHASE1_BUDGET_MS &&
  // one publish of the menu and the profile inside its contract constant, which web sizes its
  // request timeout above when the admin section publishes (#361), and inside phase 1
  BOT_PROFILE_PUBLISH_CALLS * BOT_PROFILE_PUBLISH_TIMEOUT_MS <= BOT_PROFILE_PUBLISH_BUDGET_MS &&
  BOT_PROFILE_PUBLISH_BUDGET_MS < SHUTDOWN_PHASE1_BUDGET_MS;
if (!TIMING_CHAIN_HOLDS) {
  throw new Error('backend shutdown timing constants are out of order (see timing.ts)');
}
