import { TRADING_ACCESS_BUDGET_MS, TRADING_SIGNAL_BUDGET_MS } from '@binarius/shared';

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
// round trip per update, accepted at this bot's volume. Both of those are premises of the
// shutdown budget rather than preferences, which is why this is not a tuning knob: the chain
// below pins it to 1, and any other value stops the process at import.
export const POLLING_BATCH_LIMIT = 1;
// Each Bot API call (grammY's ApiClientOptions.timeoutSeconds, default 500), including the
// confirming getUpdates that bot.stop() issues.
export const TELEGRAM_API_TIMEOUT_MS = 8_000;
// One call to the backend's internal API (AbortSignal.timeout in backend-client.ts).
export const BACKEND_REQUEST_TIMEOUT_MS = 5_000;

// The Bot API calls onStart makes one after another before the first getUpdates: the command
// menu, the description, the short description (lifecycle.ts). Not a handler path — no update is
// in flight while they run — but grammY awaits onStart to completion and bot.stop() cancels none
// of them, so a signal during the registration waits for all of them. lifecycle.test.ts compares
// this number with the calls the real start makes.
export const STARTUP_CALLS = 3;
export const STARTUP_BUDGET_MS = STARTUP_CALLS * TELEGRAM_API_TIMEOUT_MS;

// What each handler does on its longest path — declared, not described in prose, because the
// budget below is computed from these numbers and timing.test.ts compares them against the
// calls the handlers actually make. A new handler, or a new terminal branch of one, has to be
// added here and to that test by hand: grammY keeps no registry of handlers to enumerate.
export const HANDLER_CALLS = {
  // recordStart, readTradingAccess for an active account, then the status card: sendPhoto
  // refused by Telegram (GrammyError) → sendMessage, unpinAllChatMessages, pinChatMessage. The
  // welcome (sendVideo refused → sendMessage) is shorter.
  start: { backend: 2, telegram: 4 },
  // /menu: /start's path without a payload
  menu: { backend: 2, telegram: 4 },
  // the status card's button (#125): answerCallbackQuery ∥ readPairs — counted the same way as
  // oauth — then sendMessage with the asset types
  demo: { backend: 1, telegram: 2 },
  // each demo screen edited in place (#125: «↩️ Типы», a type's page, a pair, a duration):
  // answerCallbackQuery ∥ readPairs, then editMessageText refused as gone → sendMessage
  demoGroups: { backend: 1, telegram: 3 },
  demoPage: { backend: 1, telegram: 3 },
  demoAsset: { backend: 1, telegram: 3 },
  demoDuration: { backend: 1, telegram: 3 },
  // «📊 Анализ» (#126): answerCallbackQuery ∥ readPairs, the «⏳» edit refused as gone →
  // sendMessage, evaluateSignal, the result by sendMessage; or «⏳» edited, evaluateSignal, the
  // result's edit refused as gone → sendMessage. Both are 2 / 4.
  demoAnalysis: { backend: 2, telegram: 4 },
  // the stake button (#127): answerCallbackQuery ∥ readPairs ∥ readTradingAccess — the reads
  // counted as sequential, as in oauth — then createIntent and its one retry on an unknown
  // outcome, then sendMessage
  stake: { backend: 4, telegram: 2 },
  // «🔄 Обновить статус» (#127): answerCallbackQuery ∥ readIntent ∥ readPairs — counted the same
  // way — then editMessageText refused as gone → sendMessage
  intentRefresh: { backend: 2, telegram: 3 },
  // answerCallbackQuery, then sendMessage asking for the address
  connect: { backend: 0, telegram: 2 },
  // answerCallbackQuery ∥ startLogin, then sendMessage — the parallel pair is counted as
  // sequential, so this bound is loose by BACKEND_REQUEST_TIMEOUT_MS (accepted)
  oauth: { backend: 1, telegram: 2 },
  // answerCallbackQuery ∥ confirmLogin — counted the same way as oauth — then the account card:
  // sendPhoto refused by Telegram (GrammyError) → sendMessage, unpinAllChatMessages, pinChatMessage
  confirm: { backend: 1, telegram: 5 },
  // a text on the address step: sendEmailCode, then sendMessage
  emailStep: { backend: 1, telegram: 1 },
  // a text on the code step: emailLogin, the recheck through recordStart when its outcome is
  // not a definite refusal and the recheck finds the account active, then the account card as
  // in confirm: sendPhoto refused → sendMessage, unpinAllChatMessages, pinChatMessage
  codeStep: { backend: 2, telegram: 4 },
  // answerCallbackQuery ∥ sendEmailCode, then sendMessage — counted the same way as oauth
  resend: { backend: 1, telegram: 2 },
  // my_chat_member in a private chat: recordChatMember; nothing is sent
  myChatMember: { backend: 1, telegram: 0 },
  // /account: readAccount, then sendMessage
  account: { backend: 1, telegram: 1 },
  // /settings: recordStart, then sendMessage
  settings: { backend: 1, telegram: 1 },
  // a level pressed: answerCallbackQuery ∥ setNotificationLevel — counted the same way as oauth —
  // then editMessageText refused by Telegram (GrammyError) → sendMessage
  level: { backend: 1, telegram: 3 },
  // the selected level pressed: answerCallbackQuery only
  levelCurrent: { backend: 0, telegram: 1 },
  // /support: sendMessage; no backend call
  support: { backend: 0, telegram: 1 },
  // /help: sendMessage; no backend call
  help: { backend: 0, telegram: 1 },
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
export const SHUTDOWN_BUDGET_MS = 50_000;
// How long grammY sleeps before retrying a failed getUpdates (out/bot.js, handlePollingError).
// Nothing of ours configures it and bot.stop() does not interrupt the sleep, so a SIGTERM
// during a backoff waits it out — with no update in flight, which is why an overrun there
// costs the exit code and not an update. After a 429 the server's retry_after replaces this
// value and can exceed any budget. timing.test.ts reads the number back out of grammY rather
// than trusting this line.
export const GRAMMY_POLLING_BACKOFF_MS = 3_000;
// stop_grace_period of the compose service `bot`, kept in step by timing.test.ts.
export const COMPOSE_STOP_GRACE_PERIOD_MS = 55_000;

// The demo trade's status tracker (#127, intent-tracker.ts). Its polls run between updates, like
// the profile registration, so they are not in HANDLER_CALLS; what shutdown waits for is the
// drain below. The first poll comes a second after the status message: the worker usually
// answers within that. The deadline is the worker's INTENT_MAX_AGE_MS (60 s) plus its
// SUBMIT_ACK_TIMEOUT_MS (10 s) with room — the worker's constants, not importable here, so the
// relation is stated, not checked: past it, a live intent is still polled by nobody, and the
// message says so and points at its refresh button.
export const INTENT_TRACK_FIRST_POLL_MS = 1_000;
export const INTENT_TRACK_POLL_MS = 3_000;
export const INTENT_TRACK_DEADLINE_MS = 120_000;
// what tracker.stop() waits for: one readIntent in flight, then one edit
export const INTENT_TRACK_DRAIN_MS = BACKEND_REQUEST_TIMEOUT_MS + TELEGRAM_API_TIMEOUT_MS;

// TRADING_ACCESS_BUDGET_MS and TRADING_SIGNAL_BUDGET_MS are the backend's upper estimates of POST
// /trading/access and POST /trading/signal (#126): waiting at least that long keeps a broker GET
// inside its budget from reading as an outage here.
export const TIMING_CHAIN_HOLDS =
  POLLING_BATCH_LIMIT === 1 &&
  TRADING_ACCESS_BUDGET_MS <= BACKEND_REQUEST_TIMEOUT_MS &&
  TRADING_SIGNAL_BUDGET_MS <= BACKEND_REQUEST_TIMEOUT_MS &&
  POLLING_TIMEOUT_S * 1000 < TELEGRAM_API_TIMEOUT_MS &&
  HANDLER_BUDGET_MS < SHUTDOWN_BUDGET_MS &&
  TELEGRAM_API_TIMEOUT_MS < SHUTDOWN_BUDGET_MS &&
  STARTUP_BUDGET_MS < SHUTDOWN_BUDGET_MS &&
  GRAMMY_POLLING_BACKOFF_MS < SHUTDOWN_BUDGET_MS &&
  INTENT_TRACK_FIRST_POLL_MS < INTENT_TRACK_POLL_MS &&
  INTENT_TRACK_POLL_MS < INTENT_TRACK_DEADLINE_MS &&
  INTENT_TRACK_DRAIN_MS < SHUTDOWN_BUDGET_MS &&
  SHUTDOWN_BUDGET_MS < COMPOSE_STOP_GRACE_PERIOD_MS;
if (!TIMING_CHAIN_HOLDS) {
  throw new Error(
    'bot timing constants are out of order, or POLLING_BATCH_LIMIT is not 1 (see timing.ts)',
  );
}
