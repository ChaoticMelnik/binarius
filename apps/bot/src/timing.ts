// Every bound the bot runs under, and what each one bounds. The chain is checked at import, so
// a constant edited into an impossible order stops the process instead of producing a shutdown
// that silently loses updates.

// Server-side wait for one getUpdates call (grammY's PollingOptions.timeout, default 30).
// It has to stay below the client timeout, or every long poll would be aborted by our own
// client and retried.
export const POLLING_TIMEOUT_S = 5;
// Each Bot API call (grammY's ApiClientOptions.timeoutSeconds, default 500), including the
// confirming getUpdates that bot.stop() issues.
export const TELEGRAM_API_TIMEOUT_MS = 8_000;
// One call to the backend's internal API (AbortSignal.timeout in backend-client.ts).
export const BACKEND_REQUEST_TIMEOUT_MS = 5_000;
// The longest handler: the CTA answers the callback query while it starts the login, then sends
// one message. /start is shorter — one backend call, then one send.
export const HANDLER_BUDGET_MS =
  Math.max(BACKEND_REQUEST_TIMEOUT_MS, TELEGRAM_API_TIMEOUT_MS) + TELEGRAM_API_TIMEOUT_MS;
// bot.stop() plus whatever middleware is still in flight.
export const SHUTDOWN_BUDGET_MS = 20_000;
// stop_grace_period of the compose service `bot`, kept in step by timing.test.ts.
export const COMPOSE_STOP_GRACE_PERIOD_MS = 25_000;

export const TIMING_CHAIN_HOLDS =
  POLLING_TIMEOUT_S * 1000 < TELEGRAM_API_TIMEOUT_MS &&
  HANDLER_BUDGET_MS < SHUTDOWN_BUDGET_MS &&
  TELEGRAM_API_TIMEOUT_MS < SHUTDOWN_BUDGET_MS &&
  SHUTDOWN_BUDGET_MS < COMPOSE_STOP_GRACE_PERIOD_MS;
if (!TIMING_CHAIN_HOLDS) {
  throw new Error('bot timing constants are out of order (see timing.ts)');
}
