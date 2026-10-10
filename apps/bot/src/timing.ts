import {
  BOT_TEXTS_REFRESH_MS,
  SESSION_MAX_DURATION_MS,
  TRADING_ACCESS_BUDGET_MS,
  TRADING_SESSION_START_BUDGET_MS,
  TRADING_SESSION_VIEW_BUDGET_MS,
  TRADING_SIGNAL_BUDGET_MS,
} from '@binarius/shared';

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
// Before them onStart waits for the texts' first load (#301), which the refresher bounds by the
// budgetMs index.ts gives it — BACKEND_REQUEST_TIMEOUT_MS, a wiring premise this chain cannot
// see, like STARTUP_CALLS.
export const STARTUP_BUDGET_MS =
  BACKEND_REQUEST_TIMEOUT_MS + STARTUP_CALLS * TELEGRAM_API_TIMEOUT_MS;

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
  // «🏠 В меню» (#350): answerCallbackQuery, then /menu's path without the unpin and the pin, which
  // would make it 2 / 5 = 50 s, the shutdown budget itself
  menuButton: { backend: 2, telegram: 3 },
  // «🔄 Повторить» of /account, /settings or /invite (#350, #115): answerCallbackQuery, then the
  // command
  commandRetry: { backend: 1, telegram: 2 },
  // the status card's button, the main path's duration screen (#382): answerCallbackQuery, then
  // sendMessage; no read
  demo: { backend: 0, telegram: 2 },
  // «↩️ Длительность» and every old «🔄 Обновить», «↩️ К списку» and «📡 К сигналам» (`demo:sig`):
  // the same screen in place, answerCallbackQuery, then editMessageText refused as gone →
  // sendMessage
  demoDurations: { backend: 0, telegram: 3 },
  // a duration's list (#320, #382): answerCallbackQuery ∥ readSignals ∥ readPairs — the reads
  // counted as sequential, as in confirm — then editMessageText refused as gone → sendMessage
  demoSignals: { backend: 2, telegram: 3 },
  // a pair of the list (#320): answerCallbackQuery ∥ readPairs ∥ readTradingAccess — counted the
  // same way — then editMessageText refused as gone → sendMessage
  demoLaunch: { backend: 2, telegram: 3 },
  // each demo screen edited in place (#125: «↩️ Типы», a type's page, a pair, a duration):
  // answerCallbackQuery ∥ readPairs, then editMessageText refused as gone → sendMessage
  demoGroups: { backend: 1, telegram: 3 },
  demoPage: { backend: 1, telegram: 3 },
  demoAsset: { backend: 1, telegram: 3 },
  demoDuration: { backend: 1, telegram: 3 },
  // a button with a duration from before #313, or a launch screen's or its picker's from before
  // #382 (no duration): answerCallbackQuery, then editMessageReplyMarkup
  legacyDuration: { backend: 0, telegram: 2 },
  // «📊 Анализ» (#126): answerCallbackQuery ∥ readPairs ∥ readTradingAccess — the reads counted
  // as sequential, as in confirm; the access read gives the mode the session row depends on
  // (#121) — the «⏳» edit refused as gone → sendMessage, evaluateSignal, the result by
  // sendMessage; or «⏳» edited, the signal, the result's edit refused as gone → sendMessage.
  // Both are 3 / 4, 47 s: the longest handler, under SHUTDOWN_BUDGET_MS.
  demoAnalysis: { backend: 3, telegram: 4 },
  // «➕ Ещё» (#360): answerCallbackQuery ∥ readTradingAccess — counted as sequential, as in
  // confirm — then editMessageReplyMarkup; a refused edit sends nothing more
  analysisMore: { backend: 1, telegram: 2 },
  // the stake button (#127): answerCallbackQuery ∥ readPairs ∥ readTradingAccess — the reads
  // counted as sequential, as in confirm — then createIntent and its one retry on an unknown
  // outcome, then sendMessage; a fingerprint mismatch (#297) sends one message instead
  stake: { backend: 4, telegram: 2 },
  // the stake picker (#297, stake-picker.ts) opened, a preset and the reset: answerCallbackQuery
  // ∥ readTradingAccess or setDemoStake — counted as sequential — then, after a save opened from
  // a launch screen, readPairs for its symbol (#320) ∥ readTradingAccess for the mode (#121) —
  // counted the same way — then editMessageText refused as gone → sendMessage
  stakePickerOpen: { backend: 1, telegram: 3 },
  stakePreset: { backend: 3, telegram: 3 },
  stakeReset: { backend: 3, telegram: 3 },
  // «✏️ Своя сумма»: answerCallbackQuery, then the prompt's edit refused as gone → sendMessage
  stakeCustom: { backend: 0, telegram: 3 },
  // a text on the stake step: setDemoStake, readPairs ∥ readTradingAccess after a save opened
  // from a launch screen (#121), then sendMessage
  stakeText: { backend: 3, telegram: 1 },
  // the picker's way back to /settings: answerCallbackQuery ∥ recordStart — counted as
  // sequential — then editMessageText refused as gone → sendMessage
  settingsShow: { backend: 1, telegram: 3 },
  // «🔄 Обновить статус» (#127): answerCallbackQuery ∥ readIntent ∥ readPairs — counted the same
  // way — then editMessageText refused as gone → sendMessage
  intentRefresh: { backend: 2, telegram: 3 },
  // «🚀 Сессия из 5 сделок» (#284; the analysis, the row under a finished trade #360, «🔁 Ещё
  // сессия» #320 all land here): answerCallbackQuery ∥ readPairs — counted as sequential, as
  // in confirm — then startSession and its one retry on an unknown outcome, then sendMessage
  sessionStart: { backend: 3, telegram: 2 },
  // the session's «🔄 Обновить»: answerCallbackQuery ∥ readSession ∥ readPairs — counted the same
  // way — then editMessageText refused as gone → sendMessage
  sessionRefresh: { backend: 2, telegram: 3 },
  // «⏹ Остановить сессию»: answerCallbackQuery ∥ stopSession ∥ readPairs, readSession after a
  // 409 session_not_active, then editMessageText refused as gone → sendMessage
  sessionStop: { backend: 3, telegram: 3 },
  // answerCallbackQuery, then sendMessage asking for the address
  connect: { backend: 0, telegram: 2 },
  // an old site sign-in button (#314 hid it): answerCallbackQuery, then editMessageReplyMarkup,
  // as legacyDuration
  oauth: { backend: 0, telegram: 2 },
  // answerCallbackQuery ∥ confirmLogin — the parallel pair is counted as sequential, so this bound
  // is loose by BACKEND_REQUEST_TIMEOUT_MS (accepted) — then the account card:
  // sendPhoto refused by Telegram (GrammyError) → sendMessage, unpinAllChatMessages, pinChatMessage
  confirm: { backend: 1, telegram: 5 },
  // a text on the address step: sendEmailCode, then sendMessage
  emailStep: { backend: 1, telegram: 1 },
  // a text on the code step: emailLogin, the recheck through recordStart when its outcome is
  // not a definite refusal and the recheck finds the account active, then the account card as
  // in confirm: sendPhoto refused → sendMessage, unpinAllChatMessages, pinChatMessage
  codeStep: { backend: 2, telegram: 4 },
  // answerCallbackQuery ∥ sendEmailCode, then sendMessage — counted the same way as confirm
  resend: { backend: 1, telegram: 2 },
  // my_chat_member in a private chat: recordChatMember; nothing is sent
  myChatMember: { backend: 1, telegram: 0 },
  // /account: readAccount, then sendMessage
  account: { backend: 1, telegram: 1 },
  // /settings: recordStart, then sendMessage
  settings: { backend: 1, telegram: 1 },
  // /invite (#115): readReferral, then sendMessage
  invite: { backend: 1, telegram: 1 },
  // «👥 Пригласить друга» (#115): answerCallbackQuery, then /invite's path
  inviteButton: { backend: 1, telegram: 2 },
  // a level pressed: answerCallbackQuery ∥ setNotificationLevel — counted the same way as confirm —
  // then editMessageText refused by Telegram (GrammyError) → sendMessage
  level: { backend: 1, telegram: 3 },
  // the selected level pressed: answerCallbackQuery only
  levelCurrent: { backend: 0, telegram: 1 },
  // /stop (#122): stopSessions ∥ readPairs — counted as sequential, as in confirm — then
  // sendMessage
  stop: { backend: 2, telegram: 1 },
  // the mode screen (#121, trading-mode.ts) from the card: answerCallbackQuery ∥
  // readTradingAccess — counted as sequential — then sendMessage
  modeOpen: { backend: 1, telegram: 2 },
  // its confirm step: answerCallbackQuery ∥ readTradingAccess, then editMessageText refused as
  // gone → sendMessage
  modeConfirm: { backend: 1, telegram: 3 },
  // the screen redrawn in place (`mode:x`: «↩️ Отмена», «⚙️ Режим»): the same calls
  modeInPlace: { backend: 1, telegram: 3 },
  // a switch: answerCallbackQuery ∥ setTradingMode, readTradingAccess on an unknown outcome, then
  // editMessageText refused as gone → sendMessage
  modeSet: { backend: 2, telegram: 3 },
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
// the profile registration, so they are not in HANDLER_CALLS. The first poll comes a second after the status message: the worker usually
// answers within that. The deadline is the worker's INTENT_MAX_AGE_MS (60 s) plus its
// SUBMIT_ACK_TIMEOUT_MS (10 s) with room — the worker's constants, not importable here, so the
// relation is stated, not checked: past it, a live intent is still polled by nobody, and the
// message says so and points at its refresh button.
export const INTENT_TRACK_FIRST_POLL_MS = 1_000;
export const INTENT_TRACK_POLL_MS = 3_000;
export const INTENT_TRACK_DEADLINE_MS = 120_000;
// The chain asserts that one readIntent plus one edit — what tracker.stop() can be waiting for —
// fits inside SHUTDOWN_BUDGET_MS; the step itself is bounded by closeAll's budget in runBot, not
// by this constant.
export const INTENT_TRACK_DRAIN_MS = BACKEND_REQUEST_TIMEOUT_MS + TELEGRAM_API_TIMEOUT_MS;

// The demo session's status tracker (#284, session-tracker.ts), polling between updates like the
// intent tracker. A trade's open-to-settle cycle is at least the worker's catch-up grace (10 s),
// so a poll every 10 s is enough to follow it and bounds the load. The deadline is the worker's
// session deadline, imported and so checked below, plus the last trade's settle
// (SESSION_SETTLE_SLACK_SEC) with room.
export const SESSION_TRACK_FIRST_POLL_MS = 3_000;
export const SESSION_TRACK_POLL_MS = 10_000;
export const SESSION_TRACK_DEADLINE_MS = SESSION_MAX_DURATION_MS + 600_000;
// What sessionTracker.stop() can be waiting for: an attempt's readSession and edit, then for a
// finished session its summary card's claim and sendPhoto (#318).
export const SESSION_TRACK_DRAIN_MS = 2 * BACKEND_REQUEST_TIMEOUT_MS + 2 * TELEGRAM_API_TIMEOUT_MS;

// TRADING_ACCESS_BUDGET_MS, TRADING_SIGNAL_BUDGET_MS, TRADING_SESSION_START_BUDGET_MS and
// TRADING_SESSION_VIEW_BUDGET_MS are the backend's upper estimates of POST /trading/access, POST
// /trading/signal (#126), POST /trading/sessions (#283) and a session's view and stop (#337):
// waiting at least that long keeps a broker GET inside its budget from reading as an outage here.
export const TIMING_CHAIN_HOLDS =
  POLLING_BATCH_LIMIT === 1 &&
  TRADING_ACCESS_BUDGET_MS <= BACKEND_REQUEST_TIMEOUT_MS &&
  TRADING_SIGNAL_BUDGET_MS <= BACKEND_REQUEST_TIMEOUT_MS &&
  TRADING_SESSION_START_BUDGET_MS <= BACKEND_REQUEST_TIMEOUT_MS &&
  TRADING_SESSION_VIEW_BUDGET_MS <= BACKEND_REQUEST_TIMEOUT_MS &&
  POLLING_TIMEOUT_S * 1000 < TELEGRAM_API_TIMEOUT_MS &&
  HANDLER_BUDGET_MS < SHUTDOWN_BUDGET_MS &&
  TELEGRAM_API_TIMEOUT_MS < SHUTDOWN_BUDGET_MS &&
  STARTUP_BUDGET_MS < SHUTDOWN_BUDGET_MS &&
  GRAMMY_POLLING_BACKOFF_MS < SHUTDOWN_BUDGET_MS &&
  INTENT_TRACK_FIRST_POLL_MS < INTENT_TRACK_POLL_MS &&
  INTENT_TRACK_POLL_MS < INTENT_TRACK_DEADLINE_MS &&
  INTENT_TRACK_DRAIN_MS < SHUTDOWN_BUDGET_MS &&
  SESSION_TRACK_FIRST_POLL_MS < SESSION_TRACK_POLL_MS &&
  SESSION_TRACK_POLL_MS < SESSION_TRACK_DEADLINE_MS &&
  SESSION_MAX_DURATION_MS < SESSION_TRACK_DEADLINE_MS &&
  SESSION_TRACK_DRAIN_MS < SHUTDOWN_BUDGET_MS &&
  // a texts load ends before the next one starts (#299), and inside the shutdown budget
  BACKEND_REQUEST_TIMEOUT_MS < BOT_TEXTS_REFRESH_MS &&
  BACKEND_REQUEST_TIMEOUT_MS < SHUTDOWN_BUDGET_MS &&
  SHUTDOWN_BUDGET_MS < COMPOSE_STOP_GRACE_PERIOD_MS;
if (!TIMING_CHAIN_HOLDS) {
  throw new Error(
    'bot timing constants are out of order, or POLLING_BATCH_LIMIT is not 1 (see timing.ts)',
  );
}
