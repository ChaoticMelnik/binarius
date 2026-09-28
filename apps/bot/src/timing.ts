// Every bound the bot runs under, and what each one bounds. The chain is checked at import, so
// a constant edited into an impossible order stops the process instead of producing a shutdown
// that silently loses updates.

// Server-side wait for one getUpdates call (grammY's PollingOptions.timeout, default 30).
// It has to stay below the client timeout, or every long poll would be aborted by our own
// client and retried.
export const POLLING_TIMEOUT_S = 5;
// Updates per getUpdates (grammY's PollingOptions.limit, default 100). One, because grammY
// runs a batch through the middleware sequentially and bot.stop() neither interrupts the batch
// nor confirms the updates behind the current one: with a batch of one, the drain waits for at
// most one handler and the confirmed offset is exactly the update in flight. The cost is one
// round trip per update, accepted at this bot's volume.
export const POLLING_BATCH_LIMIT = 1;
// Each Bot API call (grammY's ApiClientOptions.timeoutSeconds, default 500), including the
// confirming getUpdates that bot.stop() issues.
export const TELEGRAM_API_TIMEOUT_MS = 8_000;
// One call to the backend's internal API (AbortSignal.timeout in backend-client.ts).
export const BACKEND_REQUEST_TIMEOUT_MS = 5_000;

// What each handler does on its longest path — declared, not described in prose, because the
// budget below is computed from these numbers and timing.test.ts compares them against the
// calls the handlers actually make. A new handler, or a new terminal branch of one, has to be
// added here and to that test by hand: grammY keeps no registry of handlers to enumerate.
export const HANDLER_CALLS = {
  // recordStart, then sendVideo refused by Telegram (GrammyError) → sendMessage
  start: { backend: 1, telegram: 2 },
  // answerCallbackQuery ∥ startLogin, then sendMessage — the parallel pair is counted as
  // sequential, so this bound is loose by BACKEND_REQUEST_TIMEOUT_MS (accepted)
  connect: { backend: 1, telegram: 2 },
} as const;

export const handlerBudgetMs = ({
  backend,
  telegram,
}: {
  backend: number;
  telegram: number;
}): number => backend * BACKEND_REQUEST_TIMEOUT_MS + telegram * TELEGRAM_API_TIMEOUT_MS;

// The longest declared handler path, in milliseconds.
export const HANDLER_BUDGET_MS = Math.max(...Object.values(HANDLER_CALLS).map(handlerBudgetMs));
// bot.stop() plus whatever middleware is still in flight.
export const SHUTDOWN_BUDGET_MS = 25_000;
// How long grammY sleeps before retrying a failed getUpdates (out/bot.js, handlePollingError).
// Nothing of ours configures it and bot.stop() does not interrupt the sleep, so a SIGTERM
// during a backoff waits it out — with no update in flight, which is why an overrun there
// costs the exit code and not an update. After a 429 the server's retry_after replaces this
// value and can exceed any budget. timing.test.ts reads the number back out of grammY rather
// than trusting this line.
export const GRAMMY_POLLING_BACKOFF_MS = 3_000;
// stop_grace_period of the compose service `bot`, kept in step by timing.test.ts.
export const COMPOSE_STOP_GRACE_PERIOD_MS = 30_000;

export const TIMING_CHAIN_HOLDS =
  POLLING_TIMEOUT_S * 1000 < TELEGRAM_API_TIMEOUT_MS &&
  HANDLER_BUDGET_MS < SHUTDOWN_BUDGET_MS &&
  TELEGRAM_API_TIMEOUT_MS < SHUTDOWN_BUDGET_MS &&
  GRAMMY_POLLING_BACKOFF_MS < SHUTDOWN_BUDGET_MS &&
  SHUTDOWN_BUDGET_MS < COMPOSE_STOP_GRACE_PERIOD_MS;
if (!TIMING_CHAIN_HOLDS) {
  throw new Error('bot timing constants are out of order (see timing.ts)');
}
