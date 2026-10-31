import { BROKER_REST_TIMEOUT_MS } from '@binarius/broker-rest';
import {
  BROKER_SOCKET_AUTH_TIMEOUT_MS,
  BROKER_SOCKET_CONNECT_TIMEOUT_MS,
  BROKER_SOCKET_RECONNECT_DELAY_MS,
  BROKER_SOCKET_RECONNECT_JITTER,
} from '@binarius/broker-socket';
import {
  H1_SHADOW_MAX_WINDOW_SEC,
  SIGNAL_FETCH_LIMIT,
  SIGNAL_PACER_RETRY_SEC,
  TICK_MAX_SKEW_MS,
} from '@binarius/signal';
import { ACCESS_TOKEN_ROUTE_BUDGET_MS } from '@binarius/shared/access-token';
import { ADMIN_LOGIN_BUDGET_MS } from '@binarius/shared/admin';
import {
  BROKER_RATE_LIMIT_PER_MINUTE,
  DEFAULT_BALANCE_POLL_PER_MINUTE,
  DEFAULT_SIGNAL_SCAN_PER_MINUTE,
} from '@binarius/shared/broker-budget';
import {
  BOT_PROFILE_PUBLISH_BUDGET_MS,
  STARS_REFUND_BUDGET_MS,
  BOT_TEXTS_REFRESH_MS,
  ANALYSIS_UNUSED_AFTER_MS,
  CANDLE_CLOSE_SLACK_MS,
  ANALYSIS_UNUSED_UNTIL_MS,
  H1_ENTRY_WINDOW_SEC,
  H1_EXPIRY_SEC,
  H1_SECOND_CLOSE_MARGIN_MS,
  H1_START_SECOND_MAX_AGE_MS,
  MAILING_MIN_OFFSET_MS,
  SESSION_FIRST_NOTICE_GRACE_MS,
  SESSION_SUMMARY_FALLBACK_MS,
  STARS_PRECHECKOUT_BUDGET_MS,
} from '@binarius/shared';
import {
  BALANCE_WATCH_WINDOW_MS,
  BROKER_BALANCE_SLA_MS,
  TRADING_ACCESS_BUDGET_MS,
} from '@binarius/shared/broker-balance';
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
  // the reply: the login button, or the refusal carrying the sender's own Telegram id
  start: 1,
  // sendMessage(code), then answerCallbackQuery with the outcome
  confirm: 2,
  // answerCallbackQuery
  deny: 1,
  // sendMessage(link or refusal), then answerCallbackQuery (#448)
  link: 2,
} as const;

// The longest declared handler path. The database work inside a handler is ordinary latency by
// this file's convention, not a bounded operation.
export const ADMIN_HANDLER_BUDGET_MS =
  Math.max(...Object.values(ADMIN_HANDLER_CALLS)) * ADMIN_TELEGRAM_API_TIMEOUT_MS;

// --- The client push (#128, #202) -------------------------------------------------------------
// Each sendMessage of auth/client-push.ts (grammY's ApiClientOptions.timeoutSeconds): the one
// POST /auth/binodex/callback starts after its response (#874; app.close() waits for it), and
// each mailing. One attempt: a lost link push is made up for by the confirm button on the user's
// next /start, and a mailing whose send ended without Telegram's answer is never sent again
// (docs/mailing.md).
export const CLIENT_PUSH_TELEGRAM_API_TIMEOUT_MS = 3_000;

// --- The mailing engine (#202) -----------------------------------------------------------------
// docs/mailing.md. The planner's tick: shorter than the earliest offset of any scenario that waits
// (the analysis reminder's 10 minutes, #484; the help push's 2 hours, #879, is longer), so no job
// is planned a whole offset late. The inviter's reward notification (#576) waits for nothing: its
// delay is this tick and the sender's, at most MAILING_PLAN_TICK_MS + MAILING_SEND_TICK_MS after
// the reward.
export const MAILING_PLAN_TICK_MS = 60_000;
// The sender's tick, and how many jobs one tick claims and sends, one after another.
export const MAILING_SEND_TICK_MS = 5_000;
export const MAILING_SEND_BATCH = 100;
// The due jobs one claim looks at: the earliest applying one is sent, those whose scenario no
// longer applies are canceled.
export const MAILING_CLAIM_SCAN = 50;
// The mailings a second, for every kind together, under Telegram's limit for one bot's messages
// to different users (core.telegram.org/bots/faq, about 30 a second; stated, not measured).
export const MAILING_SEND_PER_SECOND = 20;
export const TELEGRAM_BOT_SENDS_PER_SECOND = 30;
// A send Telegram refused (not 403 or 429) is tried again this much later, up to the attempts.
export const MAILING_RETRY_MS = 300_000;
export const MAILING_MAX_ATTEMPTS = 3;

// --- The switch to real after a deposit (#686) --------------------------------------------------
// docs/trading-mode.md → The automatic switch after a deposit. The pass over the attributed
// deposits with no outcome: a deposit switches the mode at most this much after it is attributed,
// then wakes the planner, and the sender's tick sends the message.
export const DEPOSIT_MODE_SWITCH_SCAN_MS = 5_000;
// the candidates one tick takes, oldest first; the rest wait for the next tick
export const DEPOSIT_MODE_SWITCH_SCAN_LIMIT = 50;
// a candidate whose attempt threw is skipped this long, so one broken row does not run every tick
export const DEPOSIT_MODE_SWITCH_RETRY_MS = 60_000;

// --- The session notices (#464) ----------------------------------------------------------------
// docs/bot-session.md → Trade messages. The sender's tick: a settled trade's message comes at most
// this much after the settle, plus the pacing.
export const SESSION_NOTICE_TICK_MS = 3_000;
// the sessions one tick looks at, oldest first, each with something to send
export const SESSION_NOTICE_SCAN = 200;
// the notices a second, on the same bot token as the mailings: both together stay under
// Telegram's limit (checked below)
export const SESSION_NOTICE_SEND_PER_SECOND = 9;
// a send Telegram refused (not 403 or 429) is tried again on later ticks, up to the attempts, then
// left claimed, so a deterministic refusal cannot hold the session's later trades forever
export const SESSION_NOTICE_MAX_ATTEMPTS = 3;
// one step of a session's turn per chat within this gap (#660): Telegram asks for no more than about
// one message a second in one chat (Bot API FAQ; stated, not measured). It counts the sends and the
// edits, not the deletes; a step whose chat is cooling is skipped to a later tick, never slept on,
// so stop() waits for no more than before (checked below)
export const SESSION_NOTICE_CHAT_GAP_MS = 1_000;
// a session whose turn threw is left out of the sender's lists this long (#660), in memory, so a
// row that throws every tick cannot hold the head of the list
export const SESSION_NOTICE_HOLD_MS = 60_000;
// The wake (#723): a trade opened or settled wakes the sender through Postgres NOTIFY. The
// listener's pause before it connects again after a refusal or a lost connection - a notification
// sent meanwhile is lost, and the tick serves it
export const SESSION_NOTICE_LISTEN_RETRY_MS = 1_000;
// the least time between the start of a tick and a woken tick after it, so a storm of
// notifications (two a trade) runs at most a few ticks a second, each two list reads
export const SESSION_NOTICE_WAKE_GAP_MS = 250;
// The wake's links of the chain (#723), a function so a test can show which value breaks them: a
// lost LISTEN connection costs no more than one tick of wakes (the tick is the safety net), and the
// end of a chat's gap is served with a delay below the gap - and so below the tick, since the gap
// per chat is no longer than the tick (#660, below).
export const sessionNoticeWakeBoundsHold = ({
  listenRetryMs = SESSION_NOTICE_LISTEN_RETRY_MS,
  wakeGapMs = SESSION_NOTICE_WAKE_GAP_MS,
}: { listenRetryMs?: number; wakeGapMs?: number } = {}): boolean =>
  listenRetryMs <= SESSION_NOTICE_TICK_MS && wakeGapMs < SESSION_NOTICE_CHAT_GAP_MS;

// The first message's hold (#911): a held session is seen by at least one tick before the grace
// ends, which arms its timer even when no wake came - the tick is the safety net. A function so a
// test can show which value breaks it.
export const sessionFirstNoticeBoundsHold = ({
  tickMs = SESSION_NOTICE_TICK_MS,
  graceMs = SESSION_FIRST_NOTICE_GRACE_MS,
}: { tickMs?: number; graceMs?: number } = {}): boolean => tickMs < graceMs;

// The waiting message's caption (#860, docs/bot-session.md → The waiting message): the sender's
// pass that edits it to the scanner's newer figures, this often - the owner's «every 3 to 5 s»
export const SESSION_WAIT_CAPTION_MS = 4_000;
// the sessions one pass edits at most, round by id, inside the sender's pace
export const SESSION_WAIT_CAPTION_EDITS_PER_PASS = 9;
// The pass's links of the chain (#860), a function so a test can show which value breaks them: it
// runs no more often than the tick, so the captions never outrun the real steps, and its edits
// take at most a quarter of the pace over its period - the captions yield the budget first.
export const sessionWaitCaptionBoundsHold = ({
  captionMs = SESSION_WAIT_CAPTION_MS,
  editsPerPass = SESSION_WAIT_CAPTION_EDITS_PER_PASS,
}: { captionMs?: number; editsPerPass?: number } = {}): boolean =>
  SESSION_NOTICE_TICK_MS <= captionMs &&
  editsPerPass * (1000 / SESSION_NOTICE_SEND_PER_SECOND) <= captionMs / 4;

// --- The Stars reconciler (#117) --------------------------------------------------------------
// docs/stars.md → Reconciliation. Long polling confirms an update's offset even when its handler
// failed, so a successful_payment the backend never heard of is lost to the bot; the reconciler
// reads the bot's Star transactions and credits what is missing. Each getStarTransactions call
// (grammY's ApiClientOptions.timeoutSeconds), one attempt: the next tick reads the same pages.
export const STARS_TELEGRAM_API_TIMEOUT_MS = 3_000;
export const STARS_RECONCILE_TICK_MS = 300_000;
// Bot API: 1-100 transactions a call
export const STARS_RECONCILE_PAGE_SIZE = 100;
// A tick reads at most this many pages, whatever their order (accepted risk 2 of the plan: past
// it the tick logs an error and a cursor becomes a follow-up).
export const STARS_RECONCILE_MAX_PAGES = 50;
// Only transactions this recent are credited: older ones are a staff member's to look at.
export const STARS_RECONCILE_WINDOW_S = 172_800;

// --- The service accounts (#391) ---------------------------------------------------------------
// docs/service-accounts.md → The keeper. The keeper's period: renewals, then the count.
export const SERVICE_ACCOUNTS_TICK_MS = 60_000;
// How long before its expiry a service token is exchanged: the broker's token lives 7 days, and a
// day ahead leaves a 429 a day of retries a minute apart.
export const SERVICE_TOKEN_RENEW_AHEAD_MS = 86_400_000;
// A timer exchanges one account at most once an hour, whatever lifetime the broker answers: the
// guard against a shortened expires_in turning every tick into an exchange.
export const SERVICE_TOKEN_ROTATION_GAP_MS = 3_600_000;
// Exchanges a tick, one after another, each bounded by BROKER_HTTP_TIMEOUT_MS.
export const SERVICE_RENEWALS_PER_TICK = 5;
// The hold-back of an account after key_unavailable or a throw.
export const SERVICE_STALLED_RETRY_MS = 300_000;

// --- The market data source (#404) -------------------------------------------------------------
// docs/market-data.md. The manager's tick: the service accounts read again, the roles filled, the
// catalog's new pairs subscribed on the active socket.
export const MARKET_DATA_TICK_MS = 30_000;
// the period of the `market data` log line
export const MARKET_DATA_LOG_MS = 60_000;
// How long the active may be out of ready in any state (its start, connecting, reconnecting) while
// a ready reserve waits, before the reserve takes over (owner's answer, 2026-10-17); a terminal
// state switches at once.
export const MARKET_DATA_FAILOVER_GRACE_MS = 2_000;
// How long the reserve may be out of ready, from its start or from leaving ready, before it gives
// way to the next account.
export const MARKET_DATA_RESERVE_READY_MS = 25_000;
// A bucket closes by the process clock this long after its end when no tick moves the watermark
// past it (a quiet stream: closed markets); the live tick delay's p95 was 268 ms.
export const MARKET_DATA_SKEW_MARGIN_MS = 2_000;
// the hold-back of a service account after a refusal, a server disconnect or a foreign user.data
export const MARKET_DATA_ACCOUNT_RETRY_MS = 300_000;
// candles kept per (pair, interval): the feed's window, MA200 included (#482)
export const MARKET_DATA_RING_CANDLES = SIGNAL_FETCH_LIMIT;
// the most (pair, interval) refill requests waiting for the backfill: every pair on two intervals
// (#590, when the scanner had `15s` and `5s`; one interval since #685 leaves it spare)
export const MARKET_DATA_PENDING_MAX = 288;
// docs/market-data.md -> Backfill (#590). One backfill GET, by the call's own signal: below the
// REST client's timeout, so that this, not the client, ends a slow chart.
export const MARKET_DATA_BACKFILL_BUDGET_MS = 3_000;
// failed attempts in a row on one (pair, interval) before it gives up
export const MARKET_DATA_BACKFILL_ATTEMPTS = 3;
// the hold-back of a (pair, interval) after any finished attempt: one GET in a 15s candle (owner,
// 2026-10-17)
export const MARKET_DATA_BACKFILL_RETRY_MS = 15_000;
// the queue is rebuilt this often: a new hole or a cold pair is seen within one 5s candle
export const MARKET_DATA_BACKFILL_SCAN_MS = 5_000;
// how often a non-empty queue asks for a spare token: under one overflow token's refill at the
// highest ceiling, so that no overflow token is lost between two polls
export const MARKET_DATA_BACKFILL_POLL_MS = 250;
// backfill GETs in flight at once
export const MARKET_DATA_BACKFILL_CONCURRENCY = 2;

// --- The H1 second series (#669, docs/h1.md -> The second series) ---------------------------------
// H1_SECOND_CLOSE_MARGIN_MS and H1_START_SECOND_MAX_AGE_MS live in packages/shared (h1.ts) since
// #828: the bot's wait polls on them. Re-exported for this process's readers.
export { H1_SECOND_CLOSE_MARGIN_MS, H1_START_SECOND_MAX_AGE_MS };
// the period of the series' clock rule, the driver's tick (series.advance()): a clock close lags at
// most this
export const H1_SERIES_TICK_MS = 100;
// seconds of closes kept per pair: the longest window, the latest exit and a margin
export const H1_SERIES_CAPACITY_SEC = 320;

// --- The H1 driver (#707, docs/h1.md -> The driver) -----------------------------------------------
// H1_SUBMIT_BUDGET_MS: an intent's submit_deadline_at is max(submit_not_before_at, its decision's
// taken_at_ms) + this (#836: the budget runs from the later of the hold's end and the decision,
// never from the creation); the worker's take after it rejects the intent entry_window_missed
// without a broker call. It bounds only the wait before the take; the submit after the take runs
// under the worker's own timeouts. The cap is the entry window's width: a take at the budget's end
// comes at most that width after the hold's end (closedAtMs + entryDelaySec); the close's lag
// past f (a clock close at f + H1_SECOND_CLOSE_MARGIN_MS plus up to one H1_SERIES_TICK_MS) comes
// on top (docs/h1.md -> The entry)
export const DEFAULT_H1_SUBMIT_BUDGET_MS = 700;
export const MIN_H1_SUBMIT_BUDGET_MS = 100;
export const MAX_H1_SUBMIT_BUDGET_MS = (H1_ENTRY_WINDOW_SEC.to - H1_ENTRY_WINDOW_SEC.from) * 1_000;
// how often the driver reads the active H1 sessions: a new one trades, a stopped one is dropped
// within this
export const H1_DRIVER_SCAN_MS = 5_000;
// the `h1 driver` line
export const H1_DRIVER_LOG_MS = 60_000;
// the `h1 scanner` line (#828, docs/h1.md -> The scanner and the signals list)
export const H1_SCANNER_LOG_MS = 60_000;

// --- The ticks around a decision and the trade log's retention (#668, docs/trade-log.md) ----------
// the window's start before decided_at_ms (owner, #668 В4)
export const TRADE_TICKS_BEFORE_MS = 60_000;
// the window's end after the broker trade's close, or after a rejected intent's updated_at
export const TRADE_TICKS_AFTER_CLOSE_MS = 5_000;
// from decided_at_ms: a decision whose trade has not closed by then is captured `truncated`
export const TRADE_TICKS_MAX_WAIT_MS = 170_000;
// the capture tick
export const TRADE_TICKS_SCAN_MS = 5_000;
// the ticks kept per pair behind its watermark
export const TRADE_TICKS_BUFFER_MS = 240_000;
// candidates by recorded_at (the database clock)
export const TRADE_TICKS_HORIZON_MS = TRADE_TICKS_BUFFER_MS;
// ticks kept per pair at most: about 40 ticks/s for the whole buffer, ten times the mean;
// 144 pairs x 10 000 ticks x 24 B is 35 MB at the worst
export const TRADE_TICKS_MAX_PER_PAIR = 10_000;
// how far past its receipt a tick may move its pair's watermark: it caps a watermark, while
// H1_SECOND_CLOSE_MARGIN_MS (the same value) decides the series' drop and clock close
export const TRADE_TICKS_AHEAD_MS = 500;
// candidates read a tick; rows an INSERT
export const TRADE_TICKS_SCAN_LIMIT = 500;
export const TRADE_TICKS_INSERT_CHUNK = 50;
// decisions without a trade (owner, #668 В2): shadow rows a week, the rest a month
export const SIGNAL_DECISION_RETENTION_DAYS = 30;
export const SIGNAL_DECISION_SHADOW_RETENTION_DAYS = 7;
export const SIGNAL_DECISION_SWEEP_MS = 3_600_000;
// rows a DELETE statement, statements a sweep tick; one statement runs under the pool's
// query_timeout (HEALTH_TIMEOUT_MS - 200, index.ts), which 500 wide rows overran on the pilot (#845)
export const SIGNAL_DECISION_SWEEP_BATCH = 100;
export const SIGNAL_DECISION_SWEEP_MAX_BATCHES = 20;
// the next tick after one that ended at the statement cap with a full batch: a backlog is caught
// up at the cap's rows a minute, not an hour (#845)
export const SIGNAL_DECISION_SWEEP_CATCHUP_MS = 60_000;

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

// --- The first tick of the broker loops (#874) ------------------------------------------------
// docs/broker-balance.md → Start and shutdown. The balance reconciler and the service-account
// keeper tick first at firstTickAtMs after start(): no sooner than the jitter, and no sooner than
// one interval after the newest attempt any process recorded (by the database clock), so a
// restart puts no two ticks of the old and the new process closer than an interval. The interval
// runs from the first tick. The jitter's floor leaves the worker's own start burst (its
// reconnections and catch-up) the first seconds.
export const BALANCE_FIRST_TICK_MIN_MS = 5_000;
export const SERVICE_ACCOUNTS_FIRST_TICK_MIN_MS = 5_000;
// in [minMs, intervalMs) for random() in [0, 1)
export const firstTickDelayMs = (minMs: number, intervalMs: number, random: () => number) =>
  minMs + random() * (intervalMs - minMs);
// in [jitterMs, intervalMs]; a mark in the future (a clock step) counts as age 0
export const firstTickAtMs = (
  jitterMs: number,
  intervalMs: number,
  lastAttemptAgeMs: number | null,
): number =>
  lastAttemptAgeMs === null
    ? jitterMs
    : Math.max(jitterMs, intervalMs - Math.max(0, lastAttemptAgeMs));
// The links of the chain, a function so a test can show which value breaks them: each floor is
// below the shortest interval of its loop, so the jitter's range is never empty.
export const firstTickBoundsHold = ({
  balanceMinMs = BALANCE_FIRST_TICK_MIN_MS,
  serviceAccountsMinMs = SERVICE_ACCOUNTS_FIRST_TICK_MIN_MS,
}: { balanceMinMs?: number; serviceAccountsMinMs?: number } = {}): boolean =>
  balanceMinMs < MIN_BALANCE_RECONCILE_INTERVAL_MS &&
  serviceAccountsMinMs < SERVICE_ACCOUNTS_TICK_MS;

// The one broker GET POST /trading/access may wait for (the route's signal; the client ends at
// the earlier of it and BROKER_REST_TIMEOUT_MS).
export const TRADING_ACCESS_REFRESH_BUDGET_MS = 3_000;

// --- POST /deposit/widget-session (#11) ---------------------------------------------------------
// docs/deposit.md -> Budgets. The broker call the route waits for, passed as the call's signal, so
// it ends before the REST client's own timeout and reads as aborted, not as the broker's outage.
// The token exchange before it is bounded by BROKER_HTTP_TIMEOUT_MS.
export const DEPOSIT_BROKER_CALL_BUDGET_MS = 3_000;

// --- POST /deposit/credited (#112) --------------------------------------------------------------
// docs/deposit.md -> After a deposit. How long the route waits for the balance refresh (its
// signal); a flight it joined or started goes on by the reconciler's own rules. The push after it
// is bounded by CLIENT_PUSH_TELEGRAM_API_TIMEOUT_MS.
export const DEPOSIT_CREDITED_REFRESH_BUDGET_MS = 3_000;

// --- POST /trading/signal (#258) ---------------------------------------------------------------
// docs/signal.md -> Budgets. The one chart GET the route may wait for: the cache's own deadline on
// every fetch, below the REST client's timeout so that this, not the client, ends a slow chart.
export const SIGNAL_FETCH_BUDGET_MS = 3_000;
// The longest the cache holds an answer. Below 1m, or it would never bind on a minute candle; on
// the 5s and 15s candles (#313; the bot offers 5 s since #685) the candle's end binds first.
export const SIGNAL_CACHE_MAX_TTL_MS = 30_000;

// --- The signal REST (#405) -----------------------------------------------------------------
// The candle scanner (#343) was removed by #828; the names below keep its SIGNAL_SCAN_ prefix
// because SIGNAL_SCAN_MAX_PER_MINUTE is an operator's env variable.
// the signal pacer's pause after a 429 without Retry-After: doubles from the first to the second;
// a Retry-After is held to the same bounds
export const SIGNAL_SCAN_BACKOFF_MIN_MS = 15_000;
export const SIGNAL_SCAN_BACKOFF_MAX_MS = 120_000;
// docs/signal.md -> The budget. The one pacer of the signal chart GETs (SIGNAL_SCAN_MAX_PER_MINUTE a
// minute): its bucket holds one 5 s candle's batch of on-demand GETs - the steps of every session
// on 5s decide at one boundary - plus a spare token, so a fire a few ms earlier relative to its
// boundary than the one before does not find it a fraction of a token short (#382 review M1).
export const signalRestCapacity = (ceiling: number): number =>
  Math.ceil((ceiling * SIGNAL_CHART_INTERVAL_MS['5s']) / 60_000) + 1;
// the one pacer's worst 60 s window: the ceiling, its bucket and the overflow token the backfill
// may take (pacer.test.ts P11)
export const signalRestWorstWindow = (ceiling: number): number =>
  ceiling + signalRestCapacity(ceiling) + 1;
// SIGNAL_SCAN_MAX_PER_MINUTE's bounds: the lowest value .env files carry since #382, and below the
// whole per-IP window
export const MIN_SIGNAL_SCAN_PER_MINUTE = 25;
export const MAX_SIGNAL_SCAN_PER_MINUTE = 200;

// --- Bot text overrides (#299) ------------------------------------------------------------------
// docs/bot-texts.md → Loading. One SELECT of bot_text_overrides; a slower one counts as failed and
// the push keeps the texts it had. The SELECT itself is bounded by the pool's query_timeout.
export const BOT_TEXTS_LOAD_BUDGET_MS = 3_000;

// --- Publishing the command menu and the profile (#301) ---------------------------------------
// docs/bot-texts.md → Publishing. Each Bot API call of publishBotProfile (grammY's
// ApiClientOptions.timeoutSeconds), one attempt; the methods one after another, the two languages
// of a method side by side (#508), so a method is one slot of the timeout. The slots of one
// publish, which bot-texts/publish.test.ts compares with BOT_PROFILE_METHODS (@binarius/shared).
export const BOT_PROFILE_PUBLISH_TIMEOUT_MS = 2_000;
export const BOT_PROFILE_PUBLISH_CALLS = 3;

// the broker call is the other bounded operation phase 1 can be waiting on: a login handler
// holds no lock, but a refresh does, and its transaction must fit in the budget
const TIMING_CHAIN_HOLDS =
  DEFAULT_PUBLISHER_CONFIG.publishTimeoutMs < SHUTDOWN_PHASE1_BUDGET_MS &&
  BROKER_HTTP_TIMEOUT_MS < SHUTDOWN_PHASE1_BUDGET_MS &&
  // the callback's longest path: the code exchange; its push runs after the response (#874) and
  // app.close() waits for it. The contract constant lives in packages/shared because apps/web
  // sizes its forward's timeout above the same number.
  BROKER_HTTP_TIMEOUT_MS <= OAUTH_CALLBACK_BUDGET_MS &&
  OAUTH_CALLBACK_BUDGET_MS < SHUTDOWN_PHASE1_BUDGET_MS &&
  CLIENT_PUSH_TELEGRAM_API_TIMEOUT_MS < SHUTDOWN_PHASE1_BUDGET_MS &&
  // app.close() waits for the callback's exchange, then onClose waits for its push
  BROKER_HTTP_TIMEOUT_MS + CLIENT_PUSH_TELEGRAM_API_TIMEOUT_MS < SHUTDOWN_PHASE1_BUDGET_MS &&
  // the first tick of the broker loops (#874)
  firstTickBoundsHold() &&
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
  // and on the pair's signal beside it (#509): the two run in parallel, so each fits on its own
  SIGNAL_FETCH_BUDGET_MS < TRADING_SESSION_START_BUDGET_MS &&
  TRADING_SESSION_START_BUDGET_MS < SHUTDOWN_PHASE1_BUDGET_MS &&
  // a finished session's view refreshes the balance with the same GET (#337)
  TRADING_ACCESS_REFRESH_BUDGET_MS < TRADING_SESSION_VIEW_BUDGET_MS &&
  TRADING_SESSION_VIEW_BUDGET_MS < SHUTDOWN_PHASE1_BUDGET_MS &&
  // the chart GET inside the signal route, the route inside what the bot waits for (#126), and
  // inside phase 1; the hold's cap below the 1m candle
  SIGNAL_FETCH_BUDGET_MS < BROKER_REST_TIMEOUT_MS &&
  SIGNAL_FETCH_BUDGET_MS < TRADING_SIGNAL_BUDGET_MS &&
  TRADING_SIGNAL_BUDGET_MS < SHUTDOWN_PHASE1_BUDGET_MS &&
  SIGNAL_CACHE_MAX_TTL_MS < SIGNAL_CHART_INTERVAL_MS['1m'] &&
  // per interval the ring builds: an on-demand GET asked at the boundary by a v3 session's step,
  // bounded by the cache, ends inside its candle
  SIGNAL_SCAN_INTERVALS.every(
    (interval) =>
      SIGNAL_FETCH_BUDGET_MS + CANDLE_CLOSE_SLACK_MS < SIGNAL_CHART_INTERVAL_MS[interval],
  ) &&
  SIGNAL_SCAN_BACKOFF_MIN_MS <= SIGNAL_SCAN_BACKOFF_MAX_MS &&
  MIN_SIGNAL_SCAN_PER_MINUTE <= DEFAULT_SIGNAL_SCAN_PER_MINUTE &&
  DEFAULT_SIGNAL_SCAN_PER_MINUTE <= MAX_SIGNAL_SCAN_PER_MINUTE &&
  // the bucket keeps one token and the spare at the lowest ceiling
  signalRestCapacity(MIN_SIGNAL_SCAN_PER_MINUTE) >= 2 &&
  // the signal REST's worst 60 s window at the highest ceiling, below the broker's
  signalRestWorstWindow(MAX_SIGNAL_SCAN_PER_MINUTE) < BROKER_RATE_LIMIT_PER_MINUTE &&
  // the cache holds a pacer refusal as long as its retryAfterSec
  SIGNAL_PACER_RETRY_SEC * 1000 <= SIGNAL_CACHE_MAX_TTL_MS &&
  // the worker's token route (#90): its longest path is one exchange under the account's row
  // lock, or the wait for another caller's flight of the same length (#868), and the worker
  // waits ACCESS_TOKEN_ROUTE_BUDGET_MS for it
  BROKER_HTTP_TIMEOUT_MS < ACCESS_TOKEN_ROUTE_BUDGET_MS &&
  ACCESS_TOKEN_ROUTE_BUDGET_MS < SHUTDOWN_PHASE1_BUDGET_MS &&
  // the cashier's widget session (#11): an exchange, then the broker call, inside the contract
  // constant web sizes its forward above (#111), and inside phase 1
  BROKER_HTTP_TIMEOUT_MS + DEPOSIT_BROKER_CALL_BUDGET_MS <= DEPOSIT_WIDGET_SESSION_BUDGET_MS &&
  DEPOSIT_BROKER_CALL_BUDGET_MS < BROKER_REST_TIMEOUT_MS &&
  DEPOSIT_WIDGET_SESSION_BUDGET_MS < SHUTDOWN_PHASE1_BUDGET_MS &&
  // the cashier's credited event (#112): the refresh the route waits for, then the push, inside the
  // contract constant web sizes its forward above, and inside phase 1
  DEPOSIT_CREDITED_REFRESH_BUDGET_MS + CLIENT_PUSH_TELEGRAM_API_TIMEOUT_MS <=
    DEPOSIT_CREDITED_BUDGET_MS &&
  DEPOSIT_CREDITED_BUDGET_MS < SHUTDOWN_PHASE1_BUDGET_MS &&
  // a load ends before the next one starts, and inside phase 1
  BOT_TEXTS_LOAD_BUDGET_MS < BOT_TEXTS_REFRESH_MS &&
  BOT_TEXTS_LOAD_BUDGET_MS < SHUTDOWN_PHASE1_BUDGET_MS &&
  // one publish of the menu and the profile inside its contract constant, which web sizes its
  // request timeout above (the admin routes publish inside a request, #361), and inside phase 1
  BOT_PROFILE_PUBLISH_CALLS * BOT_PROFILE_PUBLISH_TIMEOUT_MS <= BOT_PROFILE_PUBLISH_BUDGET_MS &&
  BOT_PROFILE_PUBLISH_BUDGET_MS < SHUTDOWN_PHASE1_BUDGET_MS &&
  // the admin's Stars refund (#510): one refundStarPayment under withinDeadline, whose grammY
  // timeout fits inside it; the route ends inside phase 1 (web's link is in apps/web/src/timing.ts)
  STARS_TELEGRAM_API_TIMEOUT_MS <= STARS_REFUND_BUDGET_MS &&
  STARS_REFUND_BUDGET_MS < SHUTDOWN_PHASE1_BUDGET_MS &&
  // the mailing engine: stop() waits for the job in flight — the pace's gap, then the claim, the
  // one send, the settle and the 403 mark — and for a planner tick (one statement per kind); the
  // statements are ordinary latency, as phase 1's own comment counts them, so the gap and the
  // send are the bound. The send ends inside its tick; a tick's batch at the rate takes the tick
  // exactly (equality, no headroom: the claims and sends push a full batch past it, and the tick
  // that overlaps it is a no-op); the rate is under Telegram's; the planner runs within the
  // earliest offset; a due analysis reminder (#484) is planned and sent before its window closes
  1000 / MAILING_SEND_PER_SECOND + CLIENT_PUSH_TELEGRAM_API_TIMEOUT_MS <
    SHUTDOWN_PHASE1_BUDGET_MS &&
  CLIENT_PUSH_TELEGRAM_API_TIMEOUT_MS < MAILING_SEND_TICK_MS &&
  (MAILING_SEND_BATCH * 1000) / MAILING_SEND_PER_SECOND <= MAILING_SEND_TICK_MS &&
  MAILING_SEND_PER_SECOND < TELEGRAM_BOT_SENDS_PER_SECOND &&
  MAILING_PLAN_TICK_MS < MAILING_MIN_OFFSET_MS &&
  ANALYSIS_UNUSED_AFTER_MS + MAILING_PLAN_TICK_MS + MAILING_SEND_TICK_MS <
    ANALYSIS_UNUSED_UNTIL_MS &&
  // the session notices (#464): with the mailings under Telegram's rate for one bot; stop() waits
  // for the step in flight (the three-call link below)
  MAILING_SEND_PER_SECOND + SESSION_NOTICE_SEND_PER_SECOND < TELEGRAM_BOT_SENDS_PER_SECOND &&
  // the switch after a deposit (#686): a thrown candidate is skipped for whole ticks; the pass's
  // tick is no longer than the sender's, so a deposit's message comes within the two ticks
  DEPOSIT_MODE_SWITCH_SCAN_MS < DEPOSIT_MODE_SWITCH_RETRY_MS &&
  DEPOSIT_MODE_SWITCH_SCAN_MS <= MAILING_SEND_TICK_MS &&
  // the fallback's grace (#537) spans ticks: a session the bot tracks is listed only after it
  SESSION_NOTICE_TICK_MS < SESSION_SUMMARY_FALLBACK_MS &&
  // the gap per chat (#660) is coarser than the sender's pace, or it would change nothing, and no
  // longer than the tick, so a deferred step goes on the next tick; a hold spans whole ticks
  1000 / SESSION_NOTICE_SEND_PER_SECOND < SESSION_NOTICE_CHAT_GAP_MS &&
  SESSION_NOTICE_CHAT_GAP_MS <= SESSION_NOTICE_TICK_MS &&
  SESSION_NOTICE_TICK_MS < SESSION_NOTICE_HOLD_MS &&
  sessionNoticeWakeBoundsHold() &&
  sessionFirstNoticeBoundsHold() &&
  sessionWaitCaptionBoundsHold() &&
  // the fallback summary's balance refresh is not waited for (#870): one started in a tick has
  // normally answered, or its signal aborted it, before the tick after next starts: the budget
  // starts after the account's read, and a later tick may reach the session sooner in its run
  TRADING_ACCESS_REFRESH_BUDGET_MS <= SESSION_NOTICE_TICK_MS &&
  // a trade's step of a cycle (#551) may make three calls (#536): the edit of the cycle message,
  // and when Telegram answers it is gone, the delete of the waiting message and the new message,
  // each after its own pace; then the next trade's pace. The waiting message's own steps and the
  // fallback summary start with their pace and a check of stop() (session-notices.ts), so this path and
  // theirs never add up
  3 * (1000 / SESSION_NOTICE_SEND_PER_SECOND + CLIENT_PUSH_TELEGRAM_API_TIMEOUT_MS) <
    SHUTDOWN_PHASE1_BUDGET_MS &&
  // the pre-checkout route reads only, inside phase 1 (the bot's chain holds it under Telegram's
  // 10 s, apps/bot/src/timing.ts)
  STARS_PRECHECKOUT_BUDGET_MS < SHUTDOWN_PHASE1_BUDGET_MS &&
  // the reconciler's stop waits for the call in flight, then a credit and its push; a full tick
  // ends before the next one starts; the window spans many ticks
  STARS_TELEGRAM_API_TIMEOUT_MS + CLIENT_PUSH_TELEGRAM_API_TIMEOUT_MS < SHUTDOWN_PHASE1_BUDGET_MS &&
  STARS_RECONCILE_MAX_PAGES * STARS_TELEGRAM_API_TIMEOUT_MS < STARS_RECONCILE_TICK_MS &&
  STARS_RECONCILE_TICK_MS < STARS_RECONCILE_WINDOW_S * 1000 &&
  STARS_RECONCILE_PAGE_SIZE <= 100 &&
  // the service-account keeper (#391): a tick's exchanges end before the next tick; a held
  // account sits out at least one tick; the hold-back, the rotation gap and the renewal window
  // nest; stop() waits for one exchange (above) or one staff-bot send in flight
  SERVICE_RENEWALS_PER_TICK * BROKER_HTTP_TIMEOUT_MS < SERVICE_ACCOUNTS_TICK_MS &&
  SERVICE_ACCOUNTS_TICK_MS < SERVICE_STALLED_RETRY_MS &&
  SERVICE_STALLED_RETRY_MS < SERVICE_TOKEN_ROTATION_GAP_MS &&
  SERVICE_TOKEN_ROTATION_GAP_MS < SERVICE_TOKEN_RENEW_AHEAD_MS &&
  ADMIN_TELEGRAM_API_TIMEOUT_MS < SHUTDOWN_PHASE1_BUDGET_MS &&
  // the market data source (#404): the client's first reconnection attempt, at its longest
  // jitter, starts inside the grace (its handshake, connect and user.auth, is not bounded here: a
  // slower one ends in the switch), and the grace ends inside one 5s candle; the clock rule's margin closes a 5s
  // bucket before the next one ends, and stays far inside the builder's skew bound; the line
  // spans at least one tick; the keeper gets a tick to repair an account before it is retried.
  // a fresh start on a broker that answers (the token with an exchange, the first engine open,
  // user.auth) ends before the reserve's rotation. stop() waits for the accessToken calls in
  // flight, at most two at once (BROKER_HTTP_TIMEOUT_MS, above); the clients' stop() is synchronous
  BROKER_SOCKET_RECONNECT_DELAY_MS * (1 + BROKER_SOCKET_RECONNECT_JITTER) <
    MARKET_DATA_FAILOVER_GRACE_MS &&
  BROKER_HTTP_TIMEOUT_MS + BROKER_SOCKET_CONNECT_TIMEOUT_MS + BROKER_SOCKET_AUTH_TIMEOUT_MS <
    MARKET_DATA_RESERVE_READY_MS &&
  MARKET_DATA_FAILOVER_GRACE_MS < SIGNAL_CHART_INTERVAL_MS['5s'] &&
  MARKET_DATA_SKEW_MARGIN_MS < SIGNAL_CHART_INTERVAL_MS['5s'] &&
  MARKET_DATA_SKEW_MARGIN_MS < TICK_MAX_SKEW_MS &&
  MARKET_DATA_TICK_MS <= MARKET_DATA_LOG_MS &&
  // the backfill (#590): its GET ends by its own budget, inside phase 1 (stop() waits for at most
  // one GET a worker, in parallel)
  MARKET_DATA_BACKFILL_BUDGET_MS < BROKER_REST_TIMEOUT_MS &&
  MARKET_DATA_BACKFILL_BUDGET_MS < SHUTDOWN_PHASE1_BUDGET_MS &&
  MARKET_DATA_BACKFILL_POLL_MS * MAX_SIGNAL_SCAN_PER_MINUTE <= 60_000 &&
  MARKET_DATA_BACKFILL_SCAN_MS <= SIGNAL_CHART_INTERVAL_MS['5s'] &&
  SERVICE_ACCOUNTS_TICK_MS < MARKET_DATA_ACCOUNT_RETRY_MS &&
  // the H1 second series (#669): the clock rule runs inside its own margin; a second closes before
  // the ring's clock rule would close its 5s bucket; the series' bound on a tick ahead of its
  // receipt (the same margin) is tighter than the tick filter's skew bound; a pair holds the
  // longest window of a reader (every set has moveSec <= sdStepSec) plus the latest exit
  H1_SERIES_TICK_MS <= H1_SECOND_CLOSE_MARGIN_MS &&
  H1_SECOND_CLOSE_MARGIN_MS < MARKET_DATA_SKEW_MARGIN_MS &&
  H1_SECOND_CLOSE_MARGIN_MS < TICK_MAX_SKEW_MS &&
  H1_SERIES_CAPACITY_SEC >= H1_SHADOW_MAX_WINDOW_SEC + H1_ENTRY_WINDOW_SEC.to + H1_EXPIRY_SEC + 1 &&
  // the H1 driver (#707): the default sits inside its bounds; the budget is at most the entry
  // window's width, counted from the entry's hold's end (#836), not from f; the series' clock (the
  // driver's tick) is no slower than the scan, the scan ends inside phase 1 and the line spans
  // scans. stop() waits for the intent creations in flight, ordinary database latency (above)
  MIN_H1_SUBMIT_BUDGET_MS <= DEFAULT_H1_SUBMIT_BUDGET_MS &&
  DEFAULT_H1_SUBMIT_BUDGET_MS <= MAX_H1_SUBMIT_BUDGET_MS &&
  H1_ENTRY_WINDOW_SEC.from * 1_000 + MAX_H1_SUBMIT_BUDGET_MS <= H1_ENTRY_WINDOW_SEC.to * 1_000 &&
  H1_SERIES_TICK_MS <= H1_DRIVER_SCAN_MS &&
  H1_DRIVER_SCAN_MS < SHUTDOWN_PHASE1_BUDGET_MS &&
  H1_DRIVER_SCAN_MS <= H1_DRIVER_LOG_MS &&
  // the H1 start's reading (#796): a healthy series always has a current second, and a current
  // reading plus the driver's path opens inside the backtest's entry window
  1_000 + H1_SECOND_CLOSE_MARGIN_MS + H1_SERIES_TICK_MS <= H1_START_SECOND_MAX_AGE_MS &&
  H1_START_SECOND_MAX_AGE_MS < H1_ENTRY_WINDOW_SEC.to * 1_000 &&
  // the H1 scanner (#828): its line spans the series' clock ticks
  H1_SERIES_TICK_MS <= H1_SCANNER_LOG_MS &&
  // the ticks around a decision (#668): at the latest capture (decided + max wait, closed by the
  // clock rule, seen a scan later) the pair's watermark, at most the receipt clock + the clamp, has
  // not pruned the window's start; a watermark close precedes the clock close by at most the
  // clamp; a capture tick ends inside phase 1 (stop() waits for one statement) and the horizon spans
  // many of them; a row is never swept inside its capture horizon, and the sweep runs many times in
  // the shortest retention
  TRADE_TICKS_BEFORE_MS +
    TRADE_TICKS_MAX_WAIT_MS +
    MARKET_DATA_SKEW_MARGIN_MS +
    TRADE_TICKS_SCAN_MS +
    TRADE_TICKS_AHEAD_MS <=
    TRADE_TICKS_BUFFER_MS &&
  TRADE_TICKS_AHEAD_MS < MARKET_DATA_SKEW_MARGIN_MS &&
  TRADE_TICKS_AFTER_CLOSE_MS < TRADE_TICKS_MAX_WAIT_MS &&
  TRADE_TICKS_SCAN_MS < SHUTDOWN_PHASE1_BUDGET_MS &&
  TRADE_TICKS_SCAN_MS < TRADE_TICKS_HORIZON_MS &&
  SIGNAL_DECISION_SHADOW_RETENTION_DAYS <= SIGNAL_DECISION_RETENTION_DAYS &&
  TRADE_TICKS_HORIZON_MS < SIGNAL_DECISION_SWEEP_MS &&
  SIGNAL_DECISION_SWEEP_CATCHUP_MS < SIGNAL_DECISION_SWEEP_MS &&
  SIGNAL_DECISION_SWEEP_MS < SIGNAL_DECISION_SHADOW_RETENTION_DAYS * 86_400_000;
if (!TIMING_CHAIN_HOLDS) {
  throw new Error('backend shutdown timing constants are out of order (see timing.ts)');
}
