import { ADMIN_LOGIN_BUDGET_MS } from '@binarius/shared/admin';
import { OAUTH_CALLBACK_BUDGET_MS } from '@binarius/shared/oauth';
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

// How long grammY sleeps before retrying a failed getUpdates (out/bot.js, handlePollingError).
// Nothing of ours configures it and stop() does not interrupt the sleep. admin/timing.test.ts
// reads the number back out of grammY rather than trusting this line.
export const GRAMMY_POLLING_BACKOFF_MS = 3_000;

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
  ADMIN_LOGIN_BUDGET_MS < SHUTDOWN_PHASE1_BUDGET_MS &&
  ADMIN_HANDLER_BUDGET_MS < SHUTDOWN_PHASE1_BUDGET_MS &&
  GRAMMY_POLLING_BACKOFF_MS < SHUTDOWN_PHASE1_BUDGET_MS &&
  SHUTDOWN_PHASE1_BUDGET_MS + SHUTDOWN_PHASE2_BUDGET_MS < COMPOSE_STOP_GRACE_PERIOD_MS;
if (!TIMING_CHAIN_HOLDS) {
  throw new Error('backend shutdown timing constants are out of order (see timing.ts)');
}
