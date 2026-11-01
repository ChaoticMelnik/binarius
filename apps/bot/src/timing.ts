import {
  BOT_TEXTS_REFRESH_MS,
  H1_SECOND_CLOSE_MARGIN_MS,
  SESSION_FIRST_NOTICE_GRACE_MS,
  H1_START_SECOND_MAX_AGE_MS,
  SESSION_MAX_DURATION_MS,
  SESSION_SUMMARY_FALLBACK_MS,
  STARS_PRECHECKOUT_BUDGET_MS,
  TRADING_ACCESS_BUDGET_MS,
  TRADING_SESSION_START_BUDGET_MS,
  TRADING_SESSION_VIEW_BUDGET_MS,
  TRADING_SIGNAL_BUDGET_MS,
  TRACKED_SESSIONS_MAX,
} from '@binarius/shared';

// Every bound the bot runs under, and what each one bounds. The chain is checked at import, so
// a constant edited into an impossible order stops the process instead of producing a shutdown
// that silently loses updates.

// Server-side wait for one long poll's getUpdates (its `timeout`, polling.ts).
// It has to stay below the client timeout, or every long poll would be aborted by our own
// client and retried.
export const POLLING_TIMEOUT_S = 5;
// Handlers running at once in one bot process (#869, polling.ts): one per user, the head of the
// user's chain — a user's updates run one after another in their order, different users' side by
// side. Each getUpdates asks for no more than the smaller remainder of this and POLLING_WAITING_MAX
// (its `limit`), so an update of a user with no handler running starts on arrival unless the process
// already holds POLLING_WAITING_MAX waiting updates. The offset is confirmed by the next getUpdates,
// and at the stop by one getUpdates({ offset, limit: 1 }); start() settles once every fetched update
// is handled, so the drain runs at most this many handlers in parallel and at most
// POLLING_WAITING_MAX updates behind them in their users' chains. The Bot API takes a limit of 1-100.
export const POLLING_CONCURRENCY = 8;
// Fetched updates waiting behind their user's running handler, in the whole process (#869): while
// this many wait, no getUpdates goes, with one warn line `polling paused: …`.
export const POLLING_WAITING_MAX = 16;
export const TELEGRAM_GET_UPDATES_LIMIT_MAX = 100;
// Each Bot API call (grammY's ApiClientOptions.timeoutSeconds, default 500), including the
// confirming getUpdates that the polling loop's stop() issues.
export const TELEGRAM_API_TIMEOUT_MS = 8_000;
// One call to the backend's internal API (AbortSignal.timeout in backend-client.ts).
export const BACKEND_REQUEST_TIMEOUT_MS = 5_000;

// The Stars pre-checkout (#117, docs/stars.md → Timing). Telegram fails the payment unless the bot
// answers the pre_checkout_query within 10 s. The backend call has its own timeout, above the
// route's budget, and leaves a reserve for the answer itself. A query that waited behind another
// handler past the reserve is lost (accepted risk 1 of the plan): Telegram charges nothing.
export const TELEGRAM_PRECHECKOUT_DEADLINE_MS = 10_000;
export const STARS_PRECHECKOUT_BACKEND_TIMEOUT_MS = 3_000;
export const PRECHECKOUT_ANSWER_RESERVE_MS = 2_000;

// The language middleware's read of a user it has not cached (#508, language.ts): one GET
// /users/language before the update's handler, bounded by its own timeout because every update
// of that user waits for it. Shorter than a handler's backend call: a slow read costs one message
// in the language of the Telegram client, not the update.
export const LANGUAGE_READ_TIMEOUT_MS = 2_000;
// The cache of users' languages: one entry per user who wrote since the start, the oldest out
// first past this many.
export const LANGUAGE_CACHE_MAX = 10_000;
// A user with no language row (#875, language.ts): the Telegram client's language kept this long,
// so updates before the first /start do not read again. Rows are made only by POST /users/start of
// this same bot, which fills the cache itself; the bound is for a second process.
export const LANGUAGE_MISSING_TTL_MS = 60_000;

// The Bot API calls onStart makes one after another before the first getUpdates: the command
// menu, the description, the short description (lifecycle.ts). Not a handler path — no update is
// in flight while they run — but start() awaits onStart to completion and stop() cancels none
// of them, so a signal during the registration waits for all of them. Each is a slot of two calls
// side by side, Russian and English (#508), both bounded by the one client timeout, so the slots
// are what the budget counts: six calls in a row would be 53 000 ms, past SHUTDOWN_BUDGET_MS.
// lifecycle.test.ts compares this number with the methods the real start calls.
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
  // recordStart ∥ readTradingAccess (#875) — counted as sequential, as in confirm — then the
  // status card: sendPhoto refused by Telegram (GrammyError) → sendMessage; its unpin and pin run
  // off the chain (detached.ts, DETACHED_DRAIN_MS). The welcome (sendVideo refused → sendMessage)
  // is the same.
  start: { backend: 2, telegram: 2 },
  // /menu: /start's path without a payload
  menu: { backend: 2, telegram: 2 },
  // «🏠 В меню» (#350): answerCallbackQuery, then /menu's path; the card is not pinned
  menuButton: { backend: 2, telegram: 3 },
  // «🔄 Повторить» of /account, /settings or /invite (#350, #115): answerCallbackQuery, then the
  // command
  commandRetry: { backend: 1, telegram: 2 },
  // the status card's button (#685): the signals list as a new message, answerCallbackQuery ∥
  // readSignals ∥ readPairs — the reads counted as sequential, as in confirm — then sendMessage;
  // without a pair the scanner's sendAnimation, refused for its file → sendMessage (#859)
  demo: { backend: 2, telegram: 3 },
  // the list in place (#320, #685: `demo:sig`, and `demo:sig:<sec>` of an old button): the same
  // reads, then editMessageText refused as gone → sendMessage; without a pair (#859) the text
  // becomes the animation (editMessageMedia), refused for its file → the text path, 4 calls;
  // under the summary card (a photo) or an animation no edit is tried, shorter (#761)
  demoSignals: { backend: 2, telegram: 4 },
  // a pair of the list (#320) and the analysis card's door (#476): answerCallbackQuery ∥ readPairs
  // ∥ readTradingAccess — counted the same way; no signals list since #828 — then editMessageText
  // refused as gone → sendMessage; the session row under the analysis card (a photo, #761) sends
  // at once, shorter
  demoLaunch: { backend: 2, telegram: 3 },
  // the door drawn without a signal (`n`: «🔁 Ещё сессия», the offer under a single trade, #476):
  // the reads of demoLaunch ∥ readSignals (the H1 list, #664, #828), then sendMessage at once; the
  // wait's sendAnimation, refused for its file → sendMessage (#859)
  demoLaunchCheck: { backend: 3, telegram: 3 },
  // each demo screen edited in place (#125: «↩️ Типы», a type's page, a pair's summary, also by
  // `demo:d:<id>:5` of an old button): answerCallbackQuery ∥ readPairs, then editMessageText
  // refused as gone → sendMessage; under the analysis card (a photo) no edit is tried, shorter
  // (#761)
  demoGroups: { backend: 1, telegram: 3 },
  demoPage: { backend: 1, telegram: 3 },
  demoAsset: { backend: 1, telegram: 3 },
  // a button with a duration the demo no longer offers (15 s until #685, the set before #313) or
  // a launch screen's from before #382 (no duration): the signals list as a new message,
  // answerCallbackQuery ∥ readSignals ∥ readPairs — counted as sequential — then sendMessage, or
  // without a pair as demo (#859)
  legacyDuration: { backend: 2, telegram: 3 },
  // a mode-less picker button from before #326, a launch screen's picker from before #382:
  // answerCallbackQuery, then editMessageReplyMarkup
  legacyKeyboard: { backend: 0, telegram: 2 },
  // «📊 Анализ» (#126): answerCallbackQuery ∥ readPairs ∥ readTradingAccess — the reads counted
  // as sequential, as in confirm; the access read gives the mode the session row and the card's
  // amounts depend on (#121, #482), and runs beside «⏳» since #875 — then «⏳», evaluateSignal and
  // the result. The card is «⏳» edited into it (editMessageMedia, #875), 3 / 3. The longest paths:
  // «⏳» edited (or sent at once under a photo), its edit into the card refused (for its file or a
  // 429) → «⏳» edited into the text card, or refused as gone → the card's sendPhoto (refused:
  // nothing more), or failing in transport → «⏳» says the analysis is unavailable; «⏳» gone, the
  // card's sendPhoto refused → sendMessage; «⏳» sent under a photo, the text result's edit refused
  // as gone → sendMessage; without a signal (#859) «⏳» edited, its editMessageMedia into the
  // animation refused as gone → sendAnimation, or for its file → «⏳»'s editMessageText. A gone «⏳»
  // is not sent anew, which would make the card's path 3 / 5 = 55 s. All are 3 / 4, 47 s: the
  // longest handler, with sessionStart (#418), under SHUTDOWN_BUDGET_MS.
  demoAnalysis: { backend: 3, telegram: 4 },
  // «➕ Ещё» (#360): answerCallbackQuery ∥ readTradingAccess — counted as sequential, as in
  // confirm — then editMessageReplyMarkup; a refused edit sends nothing more
  analysisMore: { backend: 1, telegram: 2 },
  // the stake button (#127): answerCallbackQuery ∥ readPairs ∥ readTradingAccess — the reads
  // counted as sequential, as in confirm — then createIntent and its one retry on an unknown
  // outcome, then sendMessage; a fingerprint mismatch (#297) sends one message instead
  stake: { backend: 4, telegram: 2 },
  // the stake picker (#297, stake-picker.ts) opened, a preset and the reset: answerCallbackQuery
  // ∥ readTradingAccess or setStake — counted as sequential — then, after a save opened from
  // a launch screen, readPairs for its symbol (#320) ∥ readTradingAccess for the mode (#121) —
  // counted the same way — then editMessageText refused as gone → sendMessage; opened under the
  // analysis card (a photo) no edit is tried, shorter (#761)
  stakePickerOpen: { backend: 1, telegram: 3 },
  stakePreset: { backend: 3, telegram: 3 },
  stakeReset: { backend: 3, telegram: 3 },
  // «✏️ Ввести»: answerCallbackQuery, then the prompt's edit refused as gone → sendMessage
  stakeCustom: { backend: 0, telegram: 3 },
  // a text on the stake step: setStake, readPairs ∥ readTradingAccess after a save opened
  // from a launch screen (#121), then sendMessage
  stakeText: { backend: 3, telegram: 1 },
  // the picker's way back to /settings: answerCallbackQuery ∥ recordStart — counted as
  // sequential — then editMessageText refused as gone → sendMessage
  settingsShow: { backend: 1, telegram: 3 },
  // «🔄 Обновить» (#127): answerCallbackQuery ∥ readIntent ∥ readPairs — counted the same
  // way — then editMessageText refused as gone → sendMessage
  intentRefresh: { backend: 2, telegram: 3 },
  // «🚀 Сессия из 5 циклов» (#284; in real the analysis, the row under a finished trade #360, «🔁 Ещё
  // сессия» #320 and the launch screen's «🚀 Запустить цикл» land here, and demo buttons sent
  // before #476): answerCallbackQuery ∥
  // readPairs — counted as sequential, as in confirm — then startSession and its one retry on an
  // unknown outcome, then sendMessage, or sendPhoto with a signal's direction (#568); after it, the
  // launch screen's deleteMessage refused as forbidden and editMessageReplyMarkup (#418), so the
  // status is never withheld by them. A refused photo sends its text instead, and the screen is
  // then not deleted: the same count. 47 s, equal to demoAnalysis.
  sessionStart: { backend: 3, telegram: 4 },
  // an amount of the amount screen (#476, cycle-stake.ts): answerCallbackQuery ∥ setStake ∥
  // readPairs — counted as sequential, as in confirm — then startSession in one attempt (its retry
  // would make it 4 / 4 = 52 s, past SHUTDOWN_BUDGET_MS), sendMessage or sendPhoto (#568), then the
  // screen's deleteMessage refused as forbidden and editMessageReplyMarkup (#418); a refused photo
  // sends its text and keeps the screen, 3 / 3. A 409 no_signal under the analysis card (#761):
  // the wait's sendMessage, then the card's deleteMessage refused as forbidden and
  // editMessageReplyMarkup, the same 3 / 4. 47 s, equal to sessionStart.
  cycleStakePreset: { backend: 3, telegram: 4 },
  // its «✏️ Ввести»: answerCallbackQuery, then the prompt's edit refused as gone → sendMessage;
  // under the analysis card (a photo) no edit is tried, shorter (#761)
  cycleStakeCustom: { backend: 0, telegram: 3 },
  // a text on that step: setStake ∥ readPairs — counted as sequential — then startSession and its
  // one retry on an unknown outcome, then sendMessage, or sendPhoto and, refused, sendMessage
  // (#568); nothing is deleted. 36 s
  cycleStakeText: { backend: 4, telegram: 2 },
  // an old status message's «🔄 Обновить» (#536): answerCallbackQuery, then
  // editMessageReplyMarkup, as legacyKeyboard
  sessionRefresh: { backend: 0, telegram: 2 },
  // «⏹ Остановить сессию» under an old status message (no `:w`, the worse path): answerCallbackQuery
  // ∥ stopSession ∥ readPairs, readSession after a 409 session_not_active, then editMessageText
  // refused as gone → sendMessage. Under the waiting message (`:w`, #536) it is 2 / 3:
  // answerCallbackQuery ∥ stopSession, readSession after a 409, then editMessageText refused as
  // gone → sendMessage (#587: the reply in place of the pressed message). Under the open trade's
  // block (`:c`, #722) 2 / 3: answerCallbackQuery ∥ stopSession, readSession after a 409, then
  // sendMessage and editMessageReplyMarkup
  sessionStop: { backend: 3, telegram: 3 },
  // «📤 Поделиться»'s inline query (#321, #538): readSessionShare, then sendPhoto of the promo card
  // to the storage channel and answerInlineQuery with its file id; an old button's query, a refusal
  // and a channel left unset are 1 / 1; a query of another shape is answered empty at once
  sessionShare: { backend: 1, telegram: 2 },
  // the chosen result (/setinlinefeedback): one log line
  sessionShared: { backend: 0, telegram: 0 },
  // answerCallbackQuery, then sendMessage asking for the address
  connect: { backend: 0, telegram: 2 },
  // an old site sign-in button (#314 hid it): answerCallbackQuery, then editMessageReplyMarkup,
  // as legacyKeyboard
  oauth: { backend: 0, telegram: 2 },
  // answerCallbackQuery ∥ confirmLogin — the parallel pair is counted as sequential, so this bound
  // is loose by BACKEND_REQUEST_TIMEOUT_MS (accepted) — then the account card:
  // sendPhoto refused by Telegram (GrammyError) → sendMessage; its pin off the chain (#875)
  confirm: { backend: 1, telegram: 3 },
  // a text on the address step: sendEmailCode, then sendMessage
  emailStep: { backend: 1, telegram: 1 },
  // a text on the code step: emailLogin, the recheck through recordStart when its outcome is
  // not a definite refusal and the recheck finds the account active, then the account card as
  // in confirm: sendPhoto refused → sendMessage, its pin off the chain (#875)
  codeStep: { backend: 2, telegram: 2 },
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
  // «👥 Позвать» (#115): answerCallbackQuery, then /invite's path
  inviteButton: { backend: 1, telegram: 2 },
  // a level pressed: answerCallbackQuery ∥ setNotificationLevel — counted the same way as confirm —
  // then editMessageText refused by Telegram (GrammyError) → sendMessage
  level: { backend: 1, telegram: 3 },
  // the selected level pressed: answerCallbackQuery only
  levelCurrent: { backend: 0, telegram: 1 },
  // /stop (#122): stopSessions → setTradingMode to demo (#473), then the mode line, then the #122
  // message (one session's is the reply to its stop, #536, no catalog read)
  stop: { backend: 2, telegram: 2 },
  // the mode screen (#474, trading-mode.ts) from /settings (#686): answerCallbackQuery ∥
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
  // /buy (#117): readAccount, then sendMessage — the package screen, or the refusal
  buy: { backend: 1, telegram: 1 },
  // «⭐ Купить»: answerCallbackQuery, then /buy's path
  buyButton: { backend: 1, telegram: 2 },
  // a package: answerCallbackQuery ∥ createStarsInvoice — counted as sequential, as in confirm —
  // then sendInvoice or the refusal's sendMessage
  buyPackage: { backend: 1, telegram: 2 },
  // pre_checkout_query: checkStarsPreCheckout (its own shorter timeout, counted at the full one),
  // then answerPreCheckoutQuery
  preCheckout: { backend: 1, telegram: 1 },
  // successful_payment: reportStarsPaid, then sendMessage
  paid: { backend: 1, telegram: 1 },
  // /paysupport (#118): listStarsPayments, then sendMessage — the list, the empty screen or the
  // failure
  paysupport: { backend: 1, telegram: 1 },
  // its list again (`ps:l`): answerCallbackQuery, then /paysupport's path
  paysupportList: { backend: 1, telegram: 2 },
  // «Нужен возврат» (`ps:r:<id>`): answerCallbackQuery ∥ requestStarsRefund — counted as
  // sequential, as in confirm — then sendMessage
  paysupportRequest: { backend: 1, telegram: 2 },
  // the language screen (#508, language-screen.ts) from a status card sent before #708:
  // answerCallbackQuery, then sendMessage
  language: { backend: 0, telegram: 2 },
  // /language (#708): sendMessage; no backend call — the language read is languageMiddleware's,
  // bounded by LANGUAGE_READ_TIMEOUT_MS in its own link of the shutdown chain
  languageCommand: { backend: 0, telegram: 1 },
  // a language pressed: answerCallbackQuery ∥ setLanguage — counted as sequential, as in confirm —
  // then editMessageText refused as gone → sendMessage
  languageSet: { backend: 1, telegram: 3 },
  // the current language pressed: answerCallbackQuery only
  languageCurrent: { backend: 0, telegram: 1 },
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
// The cards' unpin and pin handed off the users' chains (#875, detached.ts): what its stop() can
// be waiting for, one of each. It runs beside the drain of the handlers.
export const DETACHED_DRAIN_MS = 2 * TELEGRAM_API_TIMEOUT_MS;
// The pairs catalog kept for every reader of the process (#875, pairs-cache.ts): one GET
// /trading/pairs a second at most, however many press or wait. The wait for a signal's tick reads
// it once a period, so a kept answer is never older than one tick (the chain below); on top of the
// backend's own snapshot age (MAX_BROKER_PAIRS_TTL_MS, 60 s, packages/broker-rest — not a
// dependency of the bot, so stated, not checked).
export const PAIRS_CACHE_TTL_MS = 1_000;
// The polling loop's sleep after a failed getUpdates or deleteWebhook (polling.ts): a transport
// failure or a refusal other than 401, 409 and 429 — those stop the loop, and a 429 sleeps its own
// retry_after. The stop interrupts the sleep; the link below covers a call that does not.
export const POLLING_RETRY_MS = 3_000;
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

// The session's status tracker (#284, session-tracker.ts), polling between updates like the
// intent tracker. A trade's open-to-settle cycle is at least the worker's catch-up grace (10 s),
// so a poll every 10 s is enough to follow it and bounds the load. The deadline is the worker's
// session deadline, imported and so checked below, plus the last trade's settle
// (SESSION_SETTLE_SLACK_SEC) with room. A pressed session's first poll, its message's record, goes
// at once (#911); SESSION_TRACK_FIRST_POLL_MS is the floor of the recovered entries' slots.
export const SESSION_TRACK_FIRST_POLL_MS = 3_000;
export const SESSION_TRACK_POLL_MS = 10_000;
export const SESSION_TRACK_DEADLINE_MS = SESSION_MAX_DURATION_MS + 600_000;
// The summary's photo answered 429 (#537, trading-session.ts → sendSummary): the one wait before
// its one retry, Telegram's retry_after capped at this.
export const SESSION_SUMMARY_RETRY_WAIT_MS = 5_000;
// What sessionTracker.stop() can be waiting for: an attempt's readSession and edit, then for a
// finished session its summary's claim and sendPhoto (#318, #537) with «📤 Поделиться» in it
// (#321, #875), on a 429 the wait and the photo again; a photo refused for good goes as a text
// instead of the retry, the same count less the wait. A lost message (#567) is shorter: the read,
// the poll's failed edit, the deadline's last edit refused for good and the report of it, 2B + 2T.
export const SESSION_TRACK_DRAIN_MS =
  2 * BACKEND_REQUEST_TIMEOUT_MS + 3 * TELEGRAM_API_TIMEOUT_MS + SESSION_SUMMARY_RETRY_WAIT_MS;

// The recovery of session tracking after a restart (#567, session-resume.ts): a pass at the
// start and one every 10 minutes, each one list request and one catalog read per bot process.
// What its stop() can be waiting for is a pass's list and catalog, counted one after the other;
// the entries it hands the tracker are memory. The interval is a link of the chain through the
// pace below.
export const SESSION_RESUME_INTERVAL_MS = 600_000;
export const SESSION_RESUME_DRAIN_MS = 2 * BACKEND_REQUEST_TIMEOUT_MS;
// The pace of the recovered entries' first polls (session-tracker.ts → resumeGapMs): each is one
// readSession, at most one editMessageText and, for a session whose card is due, its sendPhoto
// (#875: «📤 Поделиться» in it). 4 a second lays a full list (TRACKED_SESSIONS_MAX) out within one
// interval of the bot's start, the task's 10 minutes; it comes on top of the backend's 20 + 9 a
// second on the same token (docs/bot-session.md → Accepted risks, 47).
export const SESSION_RESUME_PER_SECOND = 4;
export const SESSION_RESUME_GAP_MS = 1000 / SESSION_RESUME_PER_SECOND;

// The wait for a signal (#664, signal-wait.ts, docs/bot-demo.md → The wait for a signal): one
// poll of GET /trading/signals and GET /trading/pairs for every waiting user, once a second (#828:
// an H1 signal lives a second), between updates like the trackers, so not in HANDLER_CALLS. The
// reference point is f, the end label of a closed second: the poll comes POLL_OFFSET after it, past
// the series' clock close (H1_SECOND_CLOSE_MARGIN_MS), and the next poll still finds the second
// current (H1_START_SECOND_MAX_AGE_MS), so no second's decision is missed (signalWaitBoundsHold).
export const SIGNAL_WAIT_POLL_MS = 1_000;
export const SIGNAL_WAIT_POLL_OFFSET_MS = 600;
// how long the buttons of pairs with a signal stand, the list's and the alternatives' (owner's
// decision 2026-10-21)
export const SIGNALS_LIST_TTL_MS = 30_000;
// A technical bound, not a product limit: an entry nobody left the screen of ends after an hour
// (the order of SESSION_MAX_DURATION_MS), well below the 48 h after which Telegram no longer edits
// a message.
export const SIGNAL_WAIT_MAX_MS = 3_600_000;
export const TELEGRAM_EDIT_WINDOW_MS = 48 * 3_600_000;
// The pace of the wait's edits, in a tick and at the stop. With the session recovery's 4 a second
// and the backend's 20 + 9 on the same token the worst coincidence is about 38 a second, above
// Telegram's ~30 (docs/bot-session.md → Rate and timing): a 429 pauses the edits for its
// retry_after.
export const SIGNAL_WAIT_EDITS_PER_SECOND = 5;
export const SIGNAL_WAIT_EDIT_GAP_MS = 1000 / SIGNAL_WAIT_EDITS_PER_SECOND;
// The wait's edits go through one token bucket (#869, edit-pacer.ts): EDITS_PER_SECOND with a burst
// of EDIT_BURST after a quiet second — at most burst + rate x T edits in any window of T, 10 in the
// first second — at most one edit of a chat in CHAT_EDIT_GAP_MS, and the edits that show a signal
// before the ones a TTL or a caption asks for. The stop's edits keep the gap of EDIT_GAP_MS.
export const SIGNAL_WAIT_EDIT_BURST = 5;
export const SIGNAL_WAIT_CHAT_EDIT_GAP_MS = 1_000;
// The resolutions of a tick (readTradingAccess, evaluateSignal) run side by side, at most this many:
// with POLLING_CONCURRENCY handlers it bounds the bot's access reads in flight (C + R).
export const SIGNAL_WAIT_RESOLVE_CONCURRENCY = 10;
// The bound for a signal shown to many waiting users: with the bucket full, the signal edits of
// FANOUT_ENTRIES entries that ask for their slots together are sent at most FANOUT_MS after the
// first asks — the twentieth at about +3 s, whatever Telegram takes to answer. An edit asks once its
// entry's reads end (the access read; for an analysis the signal and the access read), at most
// RESOLVE_CONCURRENCY reads at once, so with a slow backend the second ten ask one backend round
// later.
export const SIGNAL_WAIT_FANOUT_ENTRIES = 20;
export const SIGNAL_WAIT_FANOUT_MS = 4_000;
// a transport failure or another refusal of an entry's edit, retried on the next ticks
export const SIGNAL_WAIT_EDIT_FAILURES_MAX = 3;
// The scanner's caption under the wait's animation (#859, Rule 58): an entry's caption is redrawn
// at most once in this (the owner's «не чаще раза в 3-5 с»), after the edits that end waits, at
// most this many a tick, so the captions never take the whole second's budget: with N waiting
// users each caption moves once in max(4 s, N / 2 s).
export const SIGNAL_WAIT_CAPTION_MS = 4_000;
export const SIGNAL_WAIT_CAPTION_EDITS_PER_TICK = 2;
// At the stop the waiting messages become the start of trading, one launched every
// SIGNAL_WAIT_EDIT_GAP_MS inside this window (100 messages); each launched one is awaited, bounded
// by TELEGRAM_API_TIMEOUT_MS.
export const SIGNAL_WAIT_SHUTDOWN_BUDGET_MS = 20_000;
// What stop() waits for of a tick in flight: an analysis's resolution — evaluateSignal,
// readTradingAccess, the photo's edit and the text's after a refused photo; the resolutions run in
// parallel, and an edit still waiting for its slot at the stop ends without being sent. The tick's
// two shared reads are shorter.
export const SIGNAL_WAIT_INFLIGHT_MS = 2 * BACKEND_REQUEST_TIMEOUT_MS + 2 * TELEGRAM_API_TIMEOUT_MS;

// The wait's links of the chain, a function so a test can show which value breaks them.
export const signalWaitBoundsHold = ({
  closeMarginMs = H1_SECOND_CLOSE_MARGIN_MS,
  maxAgeMs = H1_START_SECOND_MAX_AGE_MS,
  pollOffsetMs = SIGNAL_WAIT_POLL_OFFSET_MS,
  pollMs = SIGNAL_WAIT_POLL_MS,
  listTtlMs = SIGNALS_LIST_TTL_MS,
  maxMs = SIGNAL_WAIT_MAX_MS,
  inflightMs = SIGNAL_WAIT_INFLIGHT_MS,
  shutdownBudgetMs = SIGNAL_WAIT_SHUTDOWN_BUDGET_MS,
  captionMs = SIGNAL_WAIT_CAPTION_MS,
  captionEditsPerTick = SIGNAL_WAIT_CAPTION_EDITS_PER_TICK,
  editsPerSecond = SIGNAL_WAIT_EDITS_PER_SECOND,
  editBurst = SIGNAL_WAIT_EDIT_BURST,
  chatGapMs = SIGNAL_WAIT_CHAT_EDIT_GAP_MS,
  resolveConcurrency = SIGNAL_WAIT_RESOLVE_CONCURRENCY,
  fanoutEntries = SIGNAL_WAIT_FANOUT_ENTRIES,
  fanoutMs = SIGNAL_WAIT_FANOUT_MS,
}: {
  closeMarginMs?: number;
  maxAgeMs?: number;
  pollOffsetMs?: number;
  pollMs?: number;
  listTtlMs?: number;
  maxMs?: number;
  inflightMs?: number;
  shutdownBudgetMs?: number;
  captionMs?: number;
  captionEditsPerTick?: number;
  editsPerSecond?: number;
  editBurst?: number;
  chatGapMs?: number;
  resolveConcurrency?: number;
  fanoutEntries?: number;
  fanoutMs?: number;
} = {}): boolean =>
  0 < pollOffsetMs &&
  // the list read after the clock rule closed the second at the latest
  closeMarginMs < pollOffsetMs &&
  pollOffsetMs < pollMs &&
  // a second closed at the latest by the clock rule is still served at the next poll
  pollMs <= maxAgeMs - closeMarginMs &&
  pollMs < listTtlMs &&
  listTtlMs < maxMs &&
  maxMs < TELEGRAM_EDIT_WINDOW_MS &&
  inflightMs < SHUTDOWN_BUDGET_MS &&
  // the stop's last launched edit ends inside the bot's own budget
  shutdownBudgetMs + TELEGRAM_API_TIMEOUT_MS < SHUTDOWN_BUDGET_MS &&
  // the owner's 3-5 s between captions, counted in polls (#859)
  3 * pollMs <= captionMs &&
  captionMs <= 5 * pollMs &&
  // a tick's captions fit its second at the edits' pace, and leave the second's budget room
  captionEditsPerTick * (1000 / editsPerSecond) < pollMs &&
  captionEditsPerTick < editsPerSecond &&
  // the burst never exceeds a second's worth of edits (#869)
  1 <= editBurst &&
  editBurst <= editsPerSecond &&
  // an entry's one edit a tick never waits for its own previous one
  chatGapMs <= pollMs &&
  1 <= resolveConcurrency &&
  // the fan-out's last signal edit leaves inside its bound, and before the buttons expire
  (fanoutEntries - editBurst) * (1000 / editsPerSecond) < fanoutMs &&
  fanoutMs < listTtlMs;

// The session's first message waits for the card's record or SESSION_FIRST_NOTICE_GRACE_MS from
// started_at (#911): started_at is written inside the start route, whose rest is within its
// budget, and then one sendPhoto within the API timeout puts the card in the chat before the
// grace ends even with no record. A function so a test can show which value breaks it.
export const sessionFirstNoticeBoundsHold = ({
  startBudgetMs = TRADING_SESSION_START_BUDGET_MS,
  telegramTimeoutMs = TELEGRAM_API_TIMEOUT_MS,
  graceMs = SESSION_FIRST_NOTICE_GRACE_MS,
}: { startBudgetMs?: number; telegramTimeoutMs?: number; graceMs?: number } = {}): boolean =>
  startBudgetMs + telegramTimeoutMs < graceMs;

// TRADING_ACCESS_BUDGET_MS, TRADING_SIGNAL_BUDGET_MS, TRADING_SESSION_START_BUDGET_MS and
// TRADING_SESSION_VIEW_BUDGET_MS are the backend's upper estimates of POST /trading/access, POST
// /trading/signal (#126), POST /trading/sessions (#283) and a session's view and stop (#337):
// waiting at least that long keeps a broker GET inside its budget from reading as an outage here.
const TIMING_CHAIN_HOLDS =
  1 <= POLLING_CONCURRENCY &&
  POLLING_CONCURRENCY <= TELEGRAM_GET_UPDATES_LIMIT_MAX &&
  1 <= POLLING_WAITING_MAX &&
  TRADING_ACCESS_BUDGET_MS <= BACKEND_REQUEST_TIMEOUT_MS &&
  TRADING_SIGNAL_BUDGET_MS <= BACKEND_REQUEST_TIMEOUT_MS &&
  TRADING_SESSION_START_BUDGET_MS <= BACKEND_REQUEST_TIMEOUT_MS &&
  TRADING_SESSION_VIEW_BUDGET_MS <= BACKEND_REQUEST_TIMEOUT_MS &&
  POLLING_TIMEOUT_S * 1000 < TELEGRAM_API_TIMEOUT_MS &&
  HANDLER_BUDGET_MS < SHUTDOWN_BUDGET_MS &&
  // the language read runs before the handler, inside the same update (#508)
  LANGUAGE_READ_TIMEOUT_MS < BACKEND_REQUEST_TIMEOUT_MS &&
  // the drain's handlers run in parallel, a user's one after another (accepted risk R1, #869)
  HANDLER_BUDGET_MS + LANGUAGE_READ_TIMEOUT_MS < SHUTDOWN_BUDGET_MS &&
  TELEGRAM_API_TIMEOUT_MS < SHUTDOWN_BUDGET_MS &&
  STARTUP_BUDGET_MS < SHUTDOWN_BUDGET_MS &&
  POLLING_RETRY_MS < SHUTDOWN_BUDGET_MS &&
  INTENT_TRACK_FIRST_POLL_MS < INTENT_TRACK_POLL_MS &&
  INTENT_TRACK_POLL_MS < INTENT_TRACK_DEADLINE_MS &&
  INTENT_TRACK_DRAIN_MS < SHUTDOWN_BUDGET_MS &&
  SESSION_TRACK_FIRST_POLL_MS < SESSION_TRACK_POLL_MS &&
  SESSION_TRACK_POLL_MS < SESSION_TRACK_DEADLINE_MS &&
  SESSION_MAX_DURATION_MS < SESSION_TRACK_DEADLINE_MS &&
  SESSION_TRACK_DRAIN_MS < SHUTDOWN_BUDGET_MS &&
  SESSION_RESUME_DRAIN_MS < SHUTDOWN_BUDGET_MS &&
  DETACHED_DRAIN_MS < SHUTDOWN_BUDGET_MS &&
  PAIRS_CACHE_TTL_MS <= SIGNAL_WAIT_POLL_MS &&
  // a live bot claims a tracked session's summary before the backend's fallback may (#537): two
  // recovery passes come within its grace
  2 * SESSION_RESUME_INTERVAL_MS < SESSION_SUMMARY_FALLBACK_MS &&
  signalWaitBoundsHold() &&
  sessionFirstNoticeBoundsHold() &&
  // the first polls of a full recovery list start within one interval of the bot's start (#567)
  STARTUP_BUDGET_MS +
    SESSION_RESUME_DRAIN_MS +
    SESSION_TRACK_FIRST_POLL_MS +
    TRACKED_SESSIONS_MAX * SESSION_RESUME_GAP_MS <
    SESSION_RESUME_INTERVAL_MS &&
  // the pre-checkout: the route inside the call, the call and the answer inside Telegram's 10 s
  STARS_PRECHECKOUT_BUDGET_MS <= STARS_PRECHECKOUT_BACKEND_TIMEOUT_MS &&
  STARS_PRECHECKOUT_BACKEND_TIMEOUT_MS <= BACKEND_REQUEST_TIMEOUT_MS &&
  LANGUAGE_READ_TIMEOUT_MS + STARS_PRECHECKOUT_BACKEND_TIMEOUT_MS + PRECHECKOUT_ANSWER_RESERVE_MS <
    TELEGRAM_PRECHECKOUT_DEADLINE_MS &&
  // a texts load ends before the next one starts (#299), and inside the shutdown budget
  BACKEND_REQUEST_TIMEOUT_MS < BOT_TEXTS_REFRESH_MS &&
  BACKEND_REQUEST_TIMEOUT_MS < SHUTDOWN_BUDGET_MS &&
  SHUTDOWN_BUDGET_MS < COMPOSE_STOP_GRACE_PERIOD_MS;
if (!TIMING_CHAIN_HOLDS) {
  throw new Error('bot timing constants are out of order (see timing.ts)');
}
