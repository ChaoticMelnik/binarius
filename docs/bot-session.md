# The session in the bot: the button, the session message, the stop, the trade messages and the summary card (issues #284, #320, #318, #122, #321, #327, #418, #464, #476, #551, #567, #536, #568, #587)

The analysis screen ([bot-demo.md](bot-demo.md#the-analysis)) draws «🚀 Сессия из 5 циклов» as its
first row on a signal (#360; since #509 never on «сигнала нет»); a finished single trade's message
draws the same button under its result (#360,
[bot-demo-trade.md](bot-demo-trade.md#the-status-message)); the launch screen of the signals list
in real mode (#320, #327, [bot-demo.md](bot-demo.md#the-launch-screen-in-real-mode-327)) draws
«🚀 Запустить цикл · REAL», and a stopped session's message «🔁 Ещё сессия». In real mode all four
carry the session button's data (#327); the launch screen's adds the token `:l` (#418), by which the
start deletes that screen once the session's message is sent
([The launch screen after the start](#the-launch-screen-after-the-start-418)). In demo (#476) the
same four doors open the amount screen ([bot-demo.md](bot-demo.md#the-amount-screen-476)), whose
amount saves the demo stake and then starts the session through the same path, and whose screen is
deleted the same way. Old demo buttons sent before #476 carry the session button's data and still
start at once.
Pressing a session button, or an amount, starts a session of that mode — demo, or real for a user in
real mode ([trading-mode.md](trading-mode.md)) — of `DEFAULT_SESSION_CYCLES` cycles (#552: a
martingale cycle ends with a win, so a session is five wins; under fixed five trades) through
`POST /trading/sessions` ([trading-session.md](trading-session.md#routes)) and sends one session
message: the picture of its signal's direction (#568, the analysis card's «BULLISH SETUP» or
«BEARISH SETUP») with the session's mode, pair, stake, expiry and «📡 Сигнал: …» as its caption,
without buttons (#536). The message follows the session through `GET /trading/sessions/:id` and is
edited when the session stops, to its end line, and when a trade of the session goes the other
way, to that direction's picture (#568). The trades themselves are opened by the worker's orchestrator (#287): the bot only
starts, reads and stops the session. Every settled trade then shows in a message without sound — a
martingale cycle in one message, each step added to it by an edit (#551) — and the finished
session's summary comes with sound — both sent by the backend ([Trade messages and the
summary](#trade-messages-and-the-summary-464)). Under them, always the last of the session's
messages while it runs, the backend keeps the waiting message «🔎 Ждём сигнал для следующей
сделки…» with «⏹ Остановить сессию» ([The waiting message](#the-waiting-message-536)). When
the session is over, one picture of its trades follows the summary
([The summary card](#the-summary-card-318)), and
«📤 Поделиться» under it sends a promo card of the session (#538) into a chat the user picks
([Sharing the card](#sharing-the-card-321)).
The command `/stop` (#122) stops every active session of the user at once ([/stop](#stop-122)).

```bash
pnpm test --project unit apps/bot/src   # needs no database or Redis
```

## Components

- `apps/bot/src/demo.ts` — the button's data `<mode>:sess:<assetId>:<sec>` (#327; the demo datum
  is byte for byte the one before), `:l` (`SESSION_START_LAUNCH_TOKEN`) appended on the launch
  screen's (#418)
  (`sessionStartCallbackData`, `SESSION_START_PATTERN`, `sessionStartDataOf`), the predicate
  `sessionFits(durationSec)` = `sessionFitsDeadline(DEFAULT_SESSION_CYCLES, durationSec,
  martingale)` (#552: the bot does not know the backend's strategy and counts martingale's worst
  case, the default and the longer one), the
  button's row in the analysis keyboard (in demo `demo:l:<assetId>:<sec>:a`, #476), and
  `launchScreen`'s «🚀 Запустить цикл · REAL» (#320, #327).
- `apps/bot/src/trading-session.ts` — `createTradingSessionComposer({ backend, logger,
  sessionTracker, connectKeyboard, cashierUrl?, setupCardPhotos })` returns `{ composer, startSession, resume }`:
  the start and stop presses, an old status message's «🔄 Обновить» (#536) and the command `/stop`
  (#122); `startSession(ctx, data, catalog, { retryUnknown, removeScreen })` is the one start path,
  which the amount screen's presses use too (`cycle-stake.ts`, #476); `resume(api, botUsername,
  trackedSession, label)` tracks a session again on its recorded message after a restart (#567).
  Also `sessionCardKeyboard` (the end of the path under a stopped session), `START_REFUSALS` and
  `sessionOutcomeUnknown`. `bot.ts` mounts it under its
  private-chat filter, right after the demo trade's composer.
- `packages/shared/src/bot-navigation.ts` — `sessionStopCallbackData(id, { waiting? })` and
  `SESSION_STOP_PATTERN` (#536): the stop button's data, `session:stop:<id>` under an old status
  message, `session:stop:<id>:w` under the waiting message the backend sends (49 / 51 bytes).
- `apps/bot/src/session-tracker.ts` — `createSessionTracker({ backend, logger, firstPollMs,
  pollMs, deadlineMs, resumeGapMs, maxEntries?, now? })` → `{ track, stop, size, has }`,
  `sessionEditMethod(drawing.picture)` (#568: the one choice of the message's kind,
  `editMessageMedia` for a drawing with a picture, else `editMessageText`), and
  `sessionTrackingDone`
  (`isTradingSessionFinished` of `packages/shared/src/trading-session.ts`, #337).
  `index.ts` builds one and hands it to `createBot` and to `runBot`.
- `apps/bot/src/session-resume.ts` (#567) — `createSessionResumer({ backend, tracker, logger,
  intervalMs })` → `{ attach, start, stop }`: the passes that track the listed sessions again
  ([Recovery after a restart](#recovery-after-a-restart-567)). `index.ts` builds it before
  `createBot`, which attaches the composer's `resume`; `runBot` starts it after the profile and
  drains it as its `session resume` step.
- `apps/bot/src/backend-client.ts` — `startSession(request)` → `{ started }` or `{ active }`,
  `readSession(id, telegramUserId)`, `stopSession(id, telegramUserId, waitingMessageId?)` (#587),
  `stopSessions(telegramUserId)`
  (#122, `POST /trading/sessions/stop`) ([The client](#the-client)),
  `claimSessionSummary(id, telegramUserId)` → the summary or `null` (#318),
  `recordSessionMessage(id, telegramUserId, messageId)` → the view,
  `forgetSessionMessage(id, telegramUserId, messageId)` → whether it was forgotten, and
  `listTrackedSessions()` (#567, `GET /trading/sessions/tracked?limit=2000`, its own body ceiling
  `MAX_TRACKED_SESSIONS_BODY_BYTES`, 2 MiB).
- `apps/bot/src/session-share.ts` (#321, #538) — `shareQuery`, `SHARE_PATTERN`,
  `INLINE_QUERY_LIMIT`, `shareFallbackLink`, `shareButton`, `attachShareButton` (the card's edit
  after the send) and `createSessionShareComposer({ backend, logger, storageChatId })`: the inline
  query and the chosen result.
  `bot.ts` mounts it on the bot itself, not under the private-chat filter: inline updates carry
  no chat.
- `apps/bot/src/session-card.ts` — `sessionCardModel`, `sessionCardSvg` and `renderSessionCard`
  (#318): the card's words and counts, its SVG, its PNG through `@resvg/resvg-js` and the fonts in
  `apps/bot/fonts/` (Inter 4.1, OFL, `OFL.txt` beside them).
- `apps/bot/src/session-promo.ts` (#538) — `promoDirection`, `sessionPromoModel`,
  `sessionPromoSvg`: the promo card of «📤 Поделиться», rendered by the same `renderSessionCard`.
- `apps/bot/src/send.ts` — `sendPhotoToStorage` (#538): the promo card's post to the storage
  channel, without a caption or a keyboard by type.
- `apps/bot/src/backend-client.ts` — `readSessionShare(id, telegramUserId)` (#538,
  `POST /trading/sessions/:id/share`).
- `apps/bot/src/texts.ts` — `sessionStatusText` (the session message), `sessionStopReplyText`
  (the reply to the stop, #536), `sessionEndLine`, `sessionStartButtonLabel` and `sessionTexts`,
  the shared session words over the bot's catalog; the texts are the `session` group of the catalog
  ([bot-texts.md](bot-texts.md)). `sessionWaitingSignal` is the backend's (the waiting message):
  the bot's facades leave it out. The button `sessionStopButton` is the backend's too; the bot
  draws it only in place of a pressed waiting message after a stop whose outcome is unknown
  (#587, `waitingStopKeyboard` of `keyboards.ts`).
- `packages/shared/src/session-texts.ts` (#464) — `createSessionTexts({ html, plain })`: the
  plural, the score, the result, the asset label, the stop-reason map (`SESSION_STOP_LINES`), the
  stopped session's end line (`sessionEndLine`, #536) and closing lines (`sessionClosingLines`),
  and the cycle message (`sessionCycleText`, #551) and summary builders. The bot's session message
  and the backend's notices print through it, each with its own catalog object, so the line the
  session message ends on is the summary's first line under its pair
  (`apps/bot/src/session-summary-parity.test.ts` holds them equal).
- `packages/shared/src/session-steps.ts` (#464) — `sessionTradeSteps(results, strategy)`: each
  settled trade's cycle and step.
- `packages/shared/src/telegram-refusals.ts` (#551) — `editRefusal`, `deleteRefusal`: what a
  refused edit or delete means, for the bot's screens and the backend's cycle message alike.
- `apps/backend/src/trading/session-notices.ts`, `session-notice-messages.ts`, `session-view.ts`
  and `packages/db/src/session-notice-ops.ts` (#464) — the sender of the trade messages, the
  summary and the waiting message (#536: `sessionWaitingMessage`, and `sendSessionWaiting` /
  `deleteSessionWaiting` of `apps/backend/src/auth/client-push.ts`) ([Trade messages and the
  summary](#trade-messages-and-the-summary-464)).
- `apps/bot/src/send.ts` — `NO_NEXT_STEP_REASONS.SessionStatus` (`session_status`, #536): the
  session message goes by `replyWithPhotoHtmlWithoutNextStep` (#568), or by
  `replyHtmlWithoutNextStep` without a direction or after a refused photo, and the tracker edits it
  by `editMessagePhotoByIdHtmlWithoutNextStep` (`editMessageMedia`, #568) or
  `editMessageTextByIdHtmlWithoutNextStep`; a 404 by `editMessagePhotoByIdHtml` or
  `editMessageTextByIdHtml` under the menu.
- `apps/bot/src/setup-card.ts` (#568) — `createSetupCardPhotos(logger)` → `{ photo, remember,
  forget }`: the pictures of a signal's direction, uploaded per process and direction until an
  answer brings its `file_id`, then sent by it. `bot.ts` builds one and hands it to the demo's composer (the analysis card,
  #482) and to the session's.
- `apps/bot/src/timing.ts` — `HANDLER_CALLS.sessionStart`, `.sessionRefresh`, `.sessionStop`, `.stop`,
  `.sessionShare`, `.sessionShared` (#321, #538) and
  the four `SESSION_TRACK_*` constants and the two `SESSION_RESUME_*` (#567) ([Timing](#timing)).
- `packages/shared/src/bot-text-format.ts` — `formatSignedUsd`, the session's result with its sign
  (#337), next to `formatUsd`; the catalog's `profit` and `outcome` (#539) variables print through
  it.

## Sequence

```text
<mode>:sess:<assetId>:<sec>[:l]    (in real «🚀 Сессия из 5 циклов · REAL» under the analysis or a finished trade, «🚀 Запустить цикл · REAL» with :l (#418), «🔁 Ещё сессия · REAL», #327; demo buttons sent before #476; the longest, real:sess:2147483647:15:l, 25 bytes)
  bot → answerCallbackQuery ∥ GET /trading/pairs (for the symbol only)
  bot → POST /trading/sessions { telegramUserId, assetId, durationSec, trades: 5 }
  bot → sendPhoto: the session message, the picture of view.signalAction with the text as its
        caption, without a keyboard (#536, #568); without a direction sendMessage; the photo
        refused → sendMessage of the same text, and the launch screen is then not deleted
  bot → deleteMessage of the pressed launch screen when the datum carries :l; refused as can't be
        deleted → editMessageReplyMarkup without a keyboard (#418)
  tracker: after 3 s → POST /trading/sessions/<id>/status-message { telegramUserId, messageId }
           (#567: records the message, the newest one wins (#587), and answers the view),
           then every 10 s → GET /trading/sessions/<id>?telegramUserId=<id>
           → editMessageMedia of that message (the picture and its caption, #568), or
           editMessageText without a direction, without a keyboard, when its drawing changes:
           when the session stops (#536) or its signal's direction turns (#568)
  backend's sender, its next tick once the message is recorded (#536):
        sendMessage: «🔎 Ждём сигнал для следующей сделки…», without sound, with
        «⏹ Остановить сессию» (session:stop:<id>:w); deleted before each new message of the session
        (a cycle message, a relaunch's status message, #587) and sent again under it, deleted once
        the session stopped, before the summary - unless its «⏹» stopped it (below)
  tracker, once the session is done and its final text is on screen:
        POST /trading/sessions/<id>/summary { telegramUserId }   (#318, at most once)
        → sendPhoto to the session message's chat: the card, its caption, «🔁 Ещё сессия» and the end of path
        → editMessageReplyMarkup of the card: «📤 Поделиться» on top of those rows (#321)
the bot's start (after the profile), then every 10 min                          (#567)
  bot → GET /trading/sessions/tracked?limit=2000 ∥ GET /trading/pairs
  bot → each listed session the tracker does not hold: tracked on its recorded message in the
        owner's language from the list (#508), its first poll a GET (the message is recorded
        already)
inline query share:<sessionId>   («📤 Поделиться» → a chat picked, #321, #538)
  bot → POST /trading/sessions/<id>/share { telegramUserId: <from.id> }
  bot → sendPhoto of the promo card to SHARE_STORAGE_CHAT_ID, without sound
  bot → answerInlineQuery: the cached promo card with its caption for the owner's finished
        session; an empty answer for everything else
  (a button sent before #538, share:<sessionId>:<fileId>: the same read, then the answer with
  that file id, nothing posted)
chosen_inline_result               (the user tapped the result, /setinlinefeedback)
  bot → one info line, no call
session:stop:<id>:w                («⏹ Остановить сессию» under the waiting message, #536)
  bot → answerCallbackQuery ∥ POST /trading/sessions/<id>/stop { telegramUserId, waitingMessageId }
        (#587: the pressed message handed over; 409 session_not_active → GET /trading/sessions/<id>)
  bot → editMessageText of the pressed waiting message (#587): the end line, the last trade's line
        by its status (The stop), and the end of the path; refused as gone → sendMessage with the
        same
  backend's sender, its next tick: no delete, the summary under it
session:stop:<id>                  (an old status message's «⏹», before #536)
  bot → answerCallbackQuery ∥ POST /trading/sessions/<id>/stop ∥ GET /trading/pairs
        (409 session_not_active → GET /trading/sessions/<id>)
  bot → editMessageText in place: the session message, under the end of the path; tracked
session:<id>                       (an old status message's «🔄 Обновить», before #536)
  bot → answerCallbackQuery, editMessageReplyMarkup without a keyboard; nothing read or sent
```

## The button

- On the analysis it is drawn on a signal only (#360, #509: before #509 «сигнала нет» drew it too,
  and the session waited for a signal itself; the owner wants no session on a pair without one) —
  as the first row, above «➕ Ещё»; not on «сигнала нет», `fetch_failed` or a failed signal call;
  at any payout (#631; #379 withheld it below 80 %). It is drawn only where `sessionFits(durationSec)` holds: 5 × 4 × (5 + 120) s and 5 × 4 × (15 + 120) s fit the worker's hour (#552: five cycles of up to four trades), so
  after #313 every duration of the set has the button; the guard stays, in the keyboard and in
  `sessionStartDataOf`, so a datum that does not fit starts nothing. The label is built from `DEFAULT_SESSION_CYCLES` with
  `cyclesCount` («5 циклов», #552), and the request sends the same number as `cycles`, so the label, the check and the request
  cannot disagree. In real mode every door's label ends with « · REAL» (`sessionStartButtonLabel`,
  `launchCycleButtonLabel`, `sessionAgainButtonLabel`; `MODE_LABELS`, as the real stake button):
  a real session never starts from a button that looks like a demo one (#327).
- The mode in the data is the mode the screen was drawn in; the handler sends it as `mode` and the
  backend compares it with the user's `trading_mode` (`mode_not_allowed` on a mismatch, below).
- The session's trades do not follow this screen's direction: the orchestrator asks for a signal
  before each trade (#130 decision 2). The button sits on its own row for that reason.
- The data carries no nonce (owner's decision). After a session has ended, an old button starts a
  new one, like a fresh press. While one is active, the backend answers 409 `active_session_exists`
  with it, and the bot shows it.
- The handler checks the duration again: a forged datum or one for a duration that does not fit
  (`demo:sess:101:900`) only stops the spinner, with no backend call.
- **Two more doors (#320).** «🚀 Запустить цикл · REAL» on the real launch screen carries
  `real:sess:<assetId>:<sec>` at the duration chosen on the main path (#382), and «🔁 Ещё сессия» on
  a stopped real session the view's own `settings.assetId`, `settings.durationSec` and `mode`; a
  stopped demo session's «🔁 Ещё сессия» carries `demo:l:<assetId>:<sec>:n`, the amount screen as a
  new message (#476). Neither adds a handler; the launch
  screen's datum adds `:l` (#418): the start, its refusals and the active session's 409 are the
  same, and once the session message is sent the start deletes the launch screen. A refusal's «💵 Сумма» opens the
  picker of the press's mode with the analysis origin (`stk:o:<d|r>:a:<assetId>:<sec>`, #327),
  whose way back is that pair's analysis, not the launch screen: one handler serves every door
  (accepted).
- **A third door (#360).** A single trade's status message, once the trade is `accepted`, `settled`
  or `rejected`, draws «🚀 Сессия из 5 циклов» with `real:sess:<assetId>:<sec>` of a real trade
  (#327) or `demo:l:<assetId>:<sec>:n` of a demo one (the amount screen, #476), above
  the end of the path, by the tracker's edits and by «🔄 Обновить статус» (`sessionOfferOf`,
  [bot-demo-trade.md](bot-demo-trade.md#the-status-message)), at any payout (#631). A press while
  a session runs shows the running one and starts none, as from any door.

## Outcomes of the start

| Answer | Source | What the bot shows |
| --- | --- | --- |
| 201 `{ session }` | created | the session message, tracked; a launch screen (`:l`) is deleted after it (#418) |
| 409 `active_session_exists` with a session | the account's active session: another press, or our own first attempt whose answer was lost | that session's message anew; tracking moves to it, the old message stays as it is; a launch screen (`:l`) is deleted after it (#418) |
| 409 `active_session_exists` with `null` | that session ended between the backend's check and its read | «⏳ Предыдущая сессия только что завершилась. Нажми кнопку ещё раз.» |
| 404 `broker_account_not_found`, 409 `account_revoked` | refusal before the side effect | `accountNone` / `accountRevoked` + the connect button |
| 409 `user_blocked`, `ambiguous_broker_account`, `account_not_confirmed`, `account_halted` | the same | the single trade's texts |
| 409 `insufficient_tokens` | the same | «🪙 Не хватает токенов: на каждую сделку сессии нужен один токен.»; «⭐ Купить токены» (#117, [stars.md](stars.md)) and «💳 Пополнить» (#27, [deposit.md](deposit.md), https only) in one row above the way back |
| 409 `trading_paused` | the same ([kill-switch.md](kill-switch.md)) | «⏸ Торговля временно приостановлена, попробуйте позже.» |
| 409 `demo_only` | the backend runs `DEMO_ONLY` and the session is real (#396): a real door pressed by a user left in real mode; the bot does not know the flag | «⚠️ Реальные сделки на этом сервере отключены — доступен только демо-режим.» |
| 409 `session_too_long` | the same; reachable only if `sessionFits` and the backend drift apart | «⏱ Сессия на этой длительности не уложится в час.» |
| 409 `balance_unavailable` | the same (no snapshot, or a zero minimum) | «⏳ Баланс Binodex ещё не получен — попробуй через минуту.» |
| 409 `pair_unavailable` | the same | «⚠️ Пара сейчас недоступна для сессии. Открой анализ заново.» |
| 409 `stake_precision`, `stake_below_minimum`, `insufficient_balance` | the same: the saved stake of the press's mode against that mode's balance of the snapshot (#297, #327) | the single trade's texts, without naming the minimum (this press reads no access); `insufficient_balance` of a real press names the real account (`stakeAboveAvailableReal`); + «💵 Сумма» → `stk:o:<d\|r>:a:<assetId>:<sec>` of the press's mode |
| 503 `catalog_unavailable` | the same: the route reads the catalog before it creates anything | `demoCatalogUnavailable`, **no retry** |
| 409 `no_signal` | the same (#509): the pair's signal on the current candle is «сигнала нет» — a door drawn without reading it («🔁 Ещё сессия», the offer under a single trade, the real launch screen after a saved stake, an old message) | «📭 По паре сейчас нет сигнала — сессию на ней не запускаю. Выбери пару из сигналов.» (`sessionNoSignal`) + «🔀 Выбрать другую пару» (`demo:sig:<sec>`) and «🏠 В меню» |
| 503 `signal_unavailable` | the same (#509): the signal could not be read — a broker failure, `rate_limited`, a throw | «⚠️ Не удалось проверить сигнал пары — повтори анализ.» (`sessionSignalUnavailable`) + the way back to the analysis, **no retry**: a known refusal, not an unknown outcome (`sessionOutcomeUnknown`) |
| 409 `mode_not_allowed` | the press's mode is not the user's (#327): a button drawn in the other mode, or a switch between the render and the press | «⚠️ Режим или сумма сделки изменились — открой анализ заново.» (`stakeAmountChanged`), no log |
| 404 `user_not_found`, any code of the read and stop routes, 400 `validation`, any other 4xx | a bug, or a backend this bot does not know | `unavailable`; `warn` `trading session not started` |
| any other 5xx, no answer, a broken body (a 409 `active_session_exists` whose body is not the contract's included) | unknown: the session may have been committed | one more `startSession` with the same request. A committed first attempt answers 409 with its session; otherwise the session is created once. Still unknown → «⚠️ Не удалось узнать, запущена ли сессия…» and `warn` `trading session not started` |

`START_REFUSALS` is `satisfies Record<TradingSessionErrorCode, …>`, so a code added to the
contract fails `tsc` in `trading-session.ts`; the lookup is `Object.hasOwn`, so `__proto__` as a
reason is `unavailable`. `sessionOutcomeUnknown` is `demo-trade.ts`'s rule minus the 503
`catalog_unavailable`.

## The launch screen after the start (#418)

«🚀 Запустить цикл · REAL» on the real launch screen
([bot-demo.md](bot-demo.md#the-launch-screen-in-real-mode-327)) carries `real:sess:<assetId>:<sec>:l`,
and a demo launch screen sent before #476 `demo:sess:<assetId>:<sec>:l`. The bot keeps no state, so
the token is how the start learns the pressed message is a launch screen. An amount of the amount
screen (#476, [bot-demo.md](bot-demo.md#the-amount-screen-476)) is always pressed on that screen,
so its start deletes it the same way (`removeScreen: true`). Only when the session's message was
sent — 201 and 409 with a session — does the start delete that message, and only after it was sent
and tracked, so a slow or refused delete never withholds it (`removeLaunchScreen`,
`trading-session.ts`; since #587 the stop under the waiting message deletes nothing). A refusal,
«⏳ Предыдущая сессия только что завершилась…» and an unknown outcome send no session message, and
the screen stays with its buttons: on the launch screen «🚀 Запустить
цикл» is the retry and «💵 Изменить ставку» the fix, on the amount screen the amounts and «✏️ Своя
сумма». A typed amount is a text: there is no screen to delete, the prompt stays. The analysis, the
row under a finished trade and «🔁 Ещё сессия» keep their messages (owner's decision 2026-10-10):
their session buttons in real carry the plain datum, their demo doors open the amount screen in
place of the analysis or as a new message.

| `deleteMessage` | Class (`deleteRefusal`, `telegram-refusals.ts`) | Then | Log |
| --- | --- | --- | --- |
| `true` | deleted | — | — |
| 400 «message to delete not found» (the user or an earlier press deleted it) | `gone` | nothing | `info` `the launch screen was already gone` |
| 400 «message can't be deleted» / «Message can't be deleted [for everyone]» (older than 48 h, or otherwise forbidden; compared by their common «can't be deleted») | `forbidden` | `editMessageReplyMarkup()` — the keyboard goes, the text stays | the strip's own failure → `warn` `the launch screen keyboard was not removed` |
| any other Telegram refusal (429, 403, 400 «chat not found», …) | unknown | nothing | `warn` `the launch screen was not deleted` |
| a transport failure (`HttpError`) | unknown | nothing | the same `warn` |
| anything else thrown | a bug | rethrown to `bot.catch` | — |

- A second press before the first delete landed: 409 → the session message anew, tracking moves,
  and the second delete finds the message gone → `info`.
- A launch screen drawn before #418 carries no token: pressed, it starts the session and stays.
- A token on a duration the demo no longer offers (`demo:sess:101:300:l`) lands in the legacy
  handler, as the plain datum does: the keyboard goes, nothing is sent.
- A real launch screen pressed after the user went demo, or on a `DEMO_ONLY` backend, is refused
  (`mode_not_allowed`, `demo_only`): no session message, the screen stays.
- The description of a refusal is never logged: the lines carry the method and the Telegram code.

## The client

`startSession` reads the body itself through `send()`, the half of `request()` that returns
`{ ok, status, payload }`; `request()` is `send()` plus the throw on a non-2xx, so every other
method behaves as before. A 2xx is parsed with `safeParseTradingSessionResponse`. A non-2xx whose
code is `active_session_exists` is parsed with `safeParseTradingSessionRefusal` and returns
`{ active: view | null }`; a body that fails it is `ContractViolation` (status kept). Every other
non-2xx is `BackendError(http_status, { status, reason })`. Nothing of the body but the parsed view
and the error code leaves the client. `readSession` and `stopSession` go through `request()`, the
id `encodeURIComponent`-ed into its segment; both are scoped by the owner, so another user's id is
the same 404 `not_found`. `stopSession` posts `{ telegramUserId }`, and `waitingMessageId` beside
it for a press under the waiting message (#587). `recordSessionMessage` posts `{ telegramUserId, messageId }` and reads
the answer as `readSession` does, 404 `not_found` included; `listTrackedSessions` parses its body
with `safeParseTrackedSessionsResponse` (`ContractViolation` otherwise) under
`MAX_TRACKED_SESSIONS_BODY_BYTES`: 2 000 rows at their longest are about 360 KB, past a quarter of
the common 1 MiB ceiling (Rule 26), and under a quarter of 2 MiB.

## The session message

`sessionStatusText(symbol, view)` (#536, the owner's answers 2 and 3 of 2026-10-16, after the
reference bot); the header is «💼 Реальная сессия» (`sessionHeaderReal`) for a real session,
«🎮 Демо-сессия» for a demo one, settings unavailable included (#327):

```text
🎮 Демо-сессия
🔹 Торговая пара: EUR/USD             (sessionPair)
🔹 Сумма сделки: $10.00               (sessionStake: the base stake, formatStake)
🔹 Время экспирации: 15 с             (sessionExpiry: settings.durationSec)
📡 Сигнал: ⬆️ Вверх                   (sessionSignalUp / sessionSignalDown: view.signalAction, #568)

Торговая сессия запущена…             (sessionRunning, while the session is not stopped)
```

**The picture** (#568, the owner's answers 6 and 7 of 2026-10-16 and of 2026-10-17). The text is
the caption of the picture of `view.signalAction` — `setup-bull.png` («BULLISH SETUP») for `up`,
`setup-bear.png` («BEARISH SETUP») for `down`, the analysis card's files (#482,
[bot-demo.md](bot-demo.md#the-analysis)) through the same cache (`setup-card.ts`): each uploaded
per process and direction until an answer brings its `file_id`, then sent by it. `signalAction` is the backend's
([trading-session.md](trading-session.md#routes)): the last intent's direction, else the
signal the start route checked; null on a session without a trade yet that was started before #568
or by the CLI `session-start`, which checks no signal
([trading-session.md](trading-session.md#the-table)); its message stays a text. The line
«📡 Сигнал: …» is the fifth line of the head (under the header when the settings cannot be read)
and is absent without a direction. No figure of the
analysis is printed: the features of a session trade's signal are stored nowhere. The caption's
budget is `TELEGRAM_CAPTION_LIMIT` (1024, `BOT_TEXT_MESSAGES` → `sessionRunning`,
`sessionCompleted`, `sessionStopped`, `sessionNoSettings`).

The kind of the message follows the drawing's picture (`view.signalAction`) at each call, with
no memory of what was sent (`sessionEditMethod`, the owner's answer В2 of 2026-10-17): with a direction the send is
`sendPhoto` and every edit `editMessageMedia` with that direction's picture and the caption, which
turns a text message into the photo too (Bot API: «to replace a text or a rich message with a
media»); without one, `sendMessage` and `editMessageText`. The picture changes with the first
trade in the other direction, whatever the two direction lines' overrides, and stays as it is between trades («сигнала нет» changes no
direction) and after the stop.

| Event | What the bot does |
| --- | --- |
| `sendPhoto` sent | tracking on the photo; its largest size's `file_id` remembered |
| `sendPhoto` refused (any Telegram refusal, a stale `file_id` among them; 429 too, the owner's answer of 2026-10-17) | the `file_id` forgotten, warn `the session photo was refused, sending its text`, the same text by `sendMessage`, tracking on it; the launch or amount screen is not deleted (the fifth call, [Timing](#timing)) |
| `sendPhoto` failed in transport | thrown to `bot.catch`, as a text's: no second message after an unknown delivery (#126); the session runs without a session message (risk 64) |
| `editMessageMedia` edited, or refused as not modified | drawn; an answer with the photo remembers its `file_id` |
| `editMessageMedia` refused as gone or 403 | the message is lost, as for a text ([The tracker](#the-tracker)) |
| `editMessageMedia` refused otherwise | the `file_id` forgotten, one warn per entry, again on the next poll, by the file |
| `editMessageMedia` failed in transport | again on the next poll |

Once the session stopped, the last line is its end line (`sessionEndLine`,
`packages/shared/src/session-texts.ts`): «🏁 Сессия завершена: 5 циклов, 5 сделок — 3 в плюс, 2 в
минус» for a completed one (#552: the closed cycles, then the trades and the score by trade),
otherwise the reason's line below, «⚠️ Статус сессии недоступен.» with no reason (the CHECKs refuse
that, the view's schema allows it). Nothing else: no trade number, no
score, no trade line, no «🔎 Ждём сигнал…» (the waiting message is the backend's, [The waiting
message](#the-waiting-message-536)); the trades are the backend's cycle messages, the result and the
balance its summary's (#464). The same end line opens the summary under its pair
(`session-summary-parity.test.ts`), and the reply to the stop ([The stop and the old
buttons](#the-stop-and-the-old-buttons-536)).

- **`settings: null`** (a hand-written row): the header and «⚠️ Настройки сессии не прочитаны —
  напиши в поддержку: /support», whatever the status.
- The pair's label ([`pairLabel`](pairs-catalog.md#the-pairs-label-428-631), #428, #631): the
  symbol without « OTC», capped at 64 characters; without a catalog «актив #<id>» stands in. The stake is
  `settings.stake.baseStake` through `formatStake`, never a number; the expiry is the settings'
  seconds and « с».
- **The figures of the summary** (#337) — the result, `trades.profit`, the backend's SQL sum of the
  settled trades' profit, printed by `formatSignedUsd` with every fraction digit it has; the
  balance of the session's mode and its age line — are the summary's lines
  ([Trade messages and the summary](#trade-messages-and-the-summary-464)), no longer the session
  message's (#536).

| Stop reason | Line |
| --- | --- |
| `manual_review` (a trade or the account on manual review) | 🛠 Сессия остановлена: нужна ручная проверка — напиши в поддержку: /support |
| `rejected_twice` | ❌ Сессия остановлена: две сделки подряд не открылись. |
| `timeout` | ⏱ Сессия остановлена: истёк час на сессию. |
| `stake_stop` | ⚠️ Сессия остановлена: ставку не удалось подобрать — проверь демобаланс в /account. |
| `max_steps_exceeded` (#450) | 🛑 Сессия остановлена: серия проигрышей дошла до лимита повышений ставки. |
| `max_stake_exceeded` (#450) | 🛑 Сессия остановлена: следующая ставка вышла бы за лимит размера ставки. |
| `max_session_loss_exceeded` (#450) | 🛑 Сессия остановлена: следующая сделка могла бы превысить лимит убытка сессии. |
| `session_duration_exceeded` (#450) | ⏱ Сессия остановлена: истёк час на сессию. (`sessionStopSessionDuration`, `timeout`'s words: the sizer's hour on the worker's clock) |
| `account_unavailable` | ⚠️ Сессия остановлена: новую сделку открыть нельзя — проверь токены и аккаунт в /account. |
| `pair_unavailable` | ⚠️ Сессия остановлена: пара закрылась или не принимает эту длительность. |
| `balance_unavailable` | ⚠️ Сессия остановлена: баланс Binodex не получен. |
| `invalid_settings` | ⚠️ Сессия остановлена из-за ошибки настроек — напиши в поддержку: /support |
| `user_stopped` | ⏹ Сессия остановлена по твоей команде. |
| `kill_switch` | the single trade's `tradingPaused`: ⏸ Торговля временно приостановлена, попробуйте позже. |
| `no_signal_timeout` (#509) | ⏳ Сессия остановлена: по паре не было сигнала 20 свечей по 15 с. Выбери другую пару. (`sessionStopNoSignalTimeout`: `SESSION_NO_SIGNAL_CANDLES` with the candle word (`sessionCandleOne/Few/Many`) and the candle of `intervalForDuration(settings.durationSec)` in seconds, #637; without readable settings `sessionStopNoSignalTimeoutNoSettings`: ⏳ Сессия остановлена: по паре долго не было сигнала. Выбери другую пару.) |

The map is `satisfies Record<Exclude<TradingSessionStopReason, 'completed' | 'no_signal_timeout'>, …>`;
`no_signal_timeout`'s line carries two variables and a fallback key, so `stopLine` builds it beside
the map from the view's `settings`.

**No keyboard** (#536). The session message is sent by `replyWithPhotoHtmlWithoutNextStep` or
`replyHtmlWithoutNextStep` and edited by `editMessagePhotoByIdHtmlWithoutNextStep` or
`editMessageTextByIdHtmlWithoutNextStep` (#568) with the reason `session_status`
([bot-navigation.md](bot-navigation.md) → Exceptions): the next step of a running session is the
waiting message's «⏹», of a stopped one the summary's and the card's. An edit without
`reply_markup` removes the inline keyboard on screen, so an old status message sent before #536
loses its «🔄 Обновить» and «⏹» on the tracker's edit at the stop. A 404 while tracking draws
«⚠️ Статус сессии недоступен.» under «🏠 В меню», as the caption of the picture when the last view
read had a direction (`editMessagePhotoByIdHtml`), else as a text. **The end of the path** (`sessionCardKeyboard`)
is the stopped session's next step under the reply to its stop, an old status message the stop
drew in place and the summary card: «🔁 Ещё сессия» (#320) on the same pair and duration — drawn
only when the view has `settings` and its duration is one the demo still offers (`durationOf`) —
then (#350, [bot-navigation.md](bot-navigation.md)) «📊 Новый анализ» on the same pair and
duration (when the demo still offers it) and «📡 К сигналам» in one row, «💳 Пополнить» (#27,
[deposit.md](deposit.md), only when `WEB_PUBLIC_URL` is https) and «👥 Пригласить друга» (#115,
[referrals.md](referrals.md)) in one row, «🏠 В меню» (the rows: bot-navigation.md → The width,
#506); without `settings` only «💳 Пополнить» and «👥 Пригласить друга» in one row and «🏠 В
меню». A session stopped by the no-signal limit (`no_signal_timeout`, #509) offers
another pair, not the same one again: no «🔁 Ещё сессия» and no «📊 Новый анализ», and «🔀 Выбрать
другую пару» in place of «📡 К сигналам», on the same data (`demo:sig:<sec>`;
`appendEndOfPath(…, { otherPair: true })`). A failed start, `sessionJustEnded`, leads back to the
analysis and the menu; a failed stop offers the menu, never the stop again.

## The stop and the old buttons (#536)

- **«⏹» under the waiting message** (`session:stop:<id>:w`, the owner's answer 4) stops at once,
  with no confirmation: `stopSession(id, user, pressedMessageId)` (#587). The stop route hands the
  pressed message over: when it is the recorded waiting message, the stop's own UPDATE drops its id
  and frees its slot, and on a 409 a CAS by that id does
  ([trading-session.md](trading-session.md#post-tradingsessionsidstop)); the backend's sender then
  neither deletes it nor waits for it, and the summary comes under it. 409 `session_not_active`
  reads the session and answers how it ended (decision В3). The reply is drawn **in place of the
  pressed message** (`editMessageText`, #587): the end line, and the last trade's line by its
  status (`sessionStopReplyText` → `LAST_TRADE_LINE`, the owner's decision of 2026-10-08 in #311
  and the wording of #619): «⏳ Открытая сделка доиграет до конца.» for an open trade
  (`accepted`); «🔎 Итог последней сделки уточняется у брокера.» for `unknown`/`reconciling` (the
  worker's reconciliation asks the broker); «⏳ Последняя сделка ещё открывается: если откроется —
  доиграет до конца.» for a trade not yet open (`planned`/`reserved`/`queued`/`submitting`: the
  worker still submits it, the stop does not cancel it —
  [trading-session.md](trading-session.md#post-tradingsessionsidstop)); nothing for `settled`,
  `rejected`, `manual_review` and no trade; under the end of the path. The line is sent once: the
  trade's outcome comes with the backend's cycle message and the summary, and the reply is not
  edited after it. The result and the balance come with the backend's summary, then the card. No
  catalog read (no pair in the reply), no `deleteMessage` and no `track()`: the session message
  is tracked from its start in this bot process, or recovered by the pass of #567 once its id is
  recorded; a session whose id is not recorded (started from the CLI, a bot restart
  in the 3 s before the first poll, a message reported lost) is not tracked after a bot restart, so
  it gets no card and no end line on its message ([risk 56](#accepted-risks)).

  | The press ended | Drawn in place of the pressed message | Keyboard | Log |
  | --- | --- | --- | --- |
  | 200, or 409 and the read | the reply above | the end of the path | — |
  | 404 `not_found` (the stop, or the read after a 409) | «⚠️ Статус сессии недоступен.» | «🏠 В меню» | — |
  | 409 and the read failed | `unavailable` | «🏠 В меню» | `warn` `trading session status not read` |
  | any other failure (5xx, transport, contract, an unexpected 4xx): the stop did not happen or its outcome is unknown | `unavailable` | the same «⏹» again (`waitingStopKeyboard`, the only «⏹» the bot draws) | `warn` `trading session not stopped` |

  | The edit | Then | Log |
  | --- | --- | --- |
  | done, or refused «not modified» | — | — |
  | refused as gone (the user deleted the message, the sender deleted it in the same second, or older than 48 h) | the same text as a new message, which may come under the summary ([risk 77](#accepted-risks)); after an unknown stop outcome under «🏠 В меню», not «⏹» (the sender's next waiting message carries the one «⏹», #587 round 1) | `info` `the pressed message was already gone` |
  | another Telegram refusal, a transport failure | nothing more: the summary and the card follow | `warn` `trading session stop reply not drawn` |
  | anything else | a bug, rethrown to `bot.catch` | `error` |

  A stop whose outcome is unknown and did commit leaves `unavailable` and «⏹» above the summary
  until the next press, which answers 409 → the final text in place ([risk
  80](#accepted-risks)).
- **«⏹» under an old status message** (`session:stop:<id>`, sent before #536; the owner's answer
  5, decision В4) is answered as before: the catalog read beside the stop, 409 → the read, and the
  session message drawn in place of the pressed one (`editMessageText`), under the end of the path;
  gone → a new message, recorded by its newer id (#567, #587). The session is tracked on that
  message, so its card comes as before. A stale edit of the old entry can land after the
  handler's — [risk 83](#accepted-risks).
- **An old «🔄 Обновить»** (`session:<id>`, `LEGACY_SESSION_REFRESH_PATTERN`): its keyboard is
  stripped (`removeLegacyKeyboard` of `demo.ts`: `answerCallbackQuery`, then
  `editMessageReplyMarkup`), nothing read or sent (the owner's answer 5).

## /stop (#122)

`/stop` (in the command menu and `/help`, after `/menu`) stops every active session of the user in
one request, `POST /trading/sessions/stop`
([trading-session.md](trading-session.md#post-tradingsessionsstop-122)), with no confirmation and
no retry, as the stop button. Then, never beside it, `POST /trading/mode` to demo (#473): a switch
out of real stops the sessions itself (#327), so it comes second, and it is asked whatever the stop
answered; no catalog is read (#536: the reply names no pair). When the mode changed or the switch
failed, its line comes first
([trading-mode.md](trading-mode.md#the-bot) → `/stop`): «🎮 Режим: DEMO — следующие сделки пойдут
на демо.» with «🏠 В меню» on `changed: true`; nothing in demo already or on 404 `user_not_found`;
«⚠️ Режим не переключён — открой /menu.» on another 4xx; `modeOutcomeUnknown` with «⚙️ Режим» and
«🏠 В меню» on anything else. Telegram refusing the line logs `trading mode line not sent` and the
message below goes on. Then one message answers, always with a keyboard (Rule 31):

| The route answered | The message | Keyboard | Tracking |
|---|---|---|---|
| no session (`[]`) | «Активных сессий нет.» (`sessionNoneActive`) | «🏠 В меню» | — |
| one session | the reply to «⏹» under the waiting message (#536, the owner's answer 4): the end line and the last trade's line by its status ([The stop](#the-stop-and-the-old-buttons-536)) | the end of the path (`sessionCardKeyboard`) | — : the session message is tracked from its start or recovered by #567 once its id is recorded, its card comes from there ([risk 56](#accepted-risks)) |
| two or more | «⏹ Остановлено сессий: N. Открытые сделки доиграют до конца.» (`sessionsStopped`) | «🏠 В меню» | — |
| any failure (`Unreachable`, non-2xx, `ContractViolation`) | `unavailable`, `warn` `trading sessions not stopped` | «🏠 В меню», no «🔄 Повторить» — `/stop` is a write | — |

`/stop` hands no waiting message over: the backend's sender deletes it as stale, and the reply,
a new message, may land under the summary ([risk 78](#accepted-risks)); the card is last either
way.

- **Nothing is closed at the broker.** The route writes only `trading_sessions`; an open trade plays
  out on its own path and the reply says so. The one broker call the route can make is the balance
  GET of a finished session (#337), a read.
- **The summary card of #318** comes through the session message's own entry (the press that
  started it, or the recovery of #567); `/stop` tracks nothing (#536).
- **In the email dialog** `/stop` answers and leaves the step as it was, as `/help`; in groups it is
  ignored. `/stop@bot` and a trailing text are the command (grammY `command()`).
- **Two or more** active sessions of one user are reachable from the bot only through the window of
  [risk 17](#accepted-risks) (an account revoked while its session runs, a second account signed
  in); otherwise one account per start, and two active accounts refuse the start as
  `ambiguous_broker_account`; the internal API and the CLI can make them freely.

## The tracker

One entry per session id, in process memory, like the intent tracker
([bot-demo-trade.md](bot-demo-trade.md#the-tracker)), with these differences:

- **Retargeting.** `track()` of an id already tracked replaces its entry: the next change is drawn
  on the new message, and the old message is not edited again. A read in flight when the session
  moves draws nothing on the old message, a 404 included, and during `stop()` too; only an edit
  already sent can still land there, so at most one more edit. The deadline
  keeps counting from the first `track()`.
- **Done** is `status === stopped` and the last trade can no longer move
  (`TRADE_INTENT_TRANSITIONS[status]` is empty: settled or rejected, or no trade) —
  `isTradingSessionFinished`, the predicate the backend refreshes the balance by (#337). A stopped session
  with an open trade is followed until that trade settles, so its counts are final. A last trade
  in `manual_review` still has edges, so that entry runs to the deadline; so does one in `unknown`
  or `reconciling` (`unknown → reconciling → accepted | rejected | manual_review`): a stopped
  session with such a trade is followed until the trade settles or is rejected, or to the
  deadline.
- **The render key is the drawing** (#536; #570 Minor 1; #568): `sessionDrawing(label, view)` —
  the text `sessionStatusText(label, view)` and the picture `view.signalAction` — so the message
  is edited only when either changes: when the session stops and when the signal's direction turns
  (#568); the pair's label and the catalog's overrides are in the key as printed. The edit is
  handed only the drawing (`SessionTrackRequest['edit']`), so it cannot draw what the key leaves
  out: equal overrides of `sessionSignalUp` and `sessionSignalDown` do not hide a turn (#568;
  `session-tracker.test.ts` Q1). The trades' counters, the last trade and the balance move nothing: the message does not print them.
  An entry that drew nothing on its message and remembers nothing of it (a recovered one) edits
  only a stopped session (`mayDraw`): the message may be one sent before #536, whose «🔄»/«⏹» stay
  while its session runs ([risk 55](#accepted-risks)).
- Past `SESSION_TRACK_DEADLINE_MS` the entry ends on the last view's drawing, with no hint (#536:
  the hint pointed at «🔄 Обновить»): the deadline's own last edit, not retried, is made only when
  that drawing is not on screen yet (the poll's edit failed, or a read failed after the last good one). An
  entry that never read a view ends with no edit (#567). A stopped session whose last trade is
  still in `unknown`/`reconciling` (or `manual_review`) at the deadline: the deadline's edit, if
  any, is the stopped session's drawing — the trade is not printed —, no card (`cardDue` needs a
  done view), and the entry ends. The session stays in `GET /trading/sessions/tracked` (a recorded
  message, no card), so the next pass of #567 (≤ `SESSION_RESUME_INTERVAL_MS`, 10 min)
  tracks it again, one GET per pass and no edit while the drawing stands, until the trade is
  terminal and the card is due ([Recovery](#recovery-after-a-restart-567) → A session past the
  deadline). A session whose message is not recorded gets no card then either (risk 56).
- **The kind of the edit** (#568): `sessionEditMethod(drawing.picture)` — `editMessageMedia` (the
  picture of `view.signalAction` with the text as its caption) for a drawing with a picture, else
  `editMessageText`; a 404's edit draws its text on the picture of the last view the entry read,
  the text alone when it read none.
  The same function names the method in the warn `trading session message not edited` of a
  transport failure (a Telegram refusal names its own).
- 404 `not_found` → «⚠️ Статус сессии недоступен.», stop. Any other read failure: `warn` once per
  entry, retried until the deadline. An edit refused as gone or with any 403 → the message is
  lost: reported (`POST …/status-message/lost`, [A lost message](#recovery-after-a-restart-567)),
  stop. Any other edit refusal or a transport failure: `warn` once per entry, retried on the next
  poll. Anything else thrown → `error` `trading session tracking failed`, stop.
- **The card** (#318): an entry calls it as it ends on a done view whose final edit landed and
  whose `noticesDone` is set (the backend's summary message went out, #464) — on the poll that sees
  it, or at the deadline — so once (one predicate, `cardDue`, at both places). A done view without
  `noticesDone` is polled on with no edit (the flag is not printed), and at the deadline it gets
  its final edit, if not on screen already, and no card. A
  failed edit means no card yet; a card that failed is not tried again: the entry has ended
  ([The summary card](#the-summary-card-318)).
- **Recovered entries are paced, and what was drawn is remembered** (#567). An entry tracked with
  no view (a recovered one) takes the next slot for its first poll instead of `firstPollMs`: slots
  are `resumeGapMs` apart (`SESSION_RESUME_GAP_MS`, 250 ms), none sooner than `firstPollMs` from
  the `track()`, and they carry over from one call to the next, so two passes in a row are paced
  together. A slot is an ordinary timer: `stop()` clears it like any other. An entry with a view
  (a press) polls after `firstPollMs` as before. When an entry ends, the tracker remembers what it
  last drew on its message (its drawing's key), bounded by `SESSION_TRACKER_MAX_ENTRIES`, the oldest going
  first; an entry that ends on a lost message leaves no memory. A recovered entry of the same
  message starts from that drawing, so its first poll edits only when the drawing changed — another
  label, override or direction included (#570 Minor 1, #568).
- `SESSION_TRACKER_MAX_ENTRIES` (10 000): the oldest entry goes first. `stop()` clears every timer,
  refuses new entries and waits for every attempt in flight; `runBot` drains it as its
  `session tracker` step.

### Recovery after a restart (#567)

- **The record.** Every entry made by a press (the start, an old status message's «⏹», #536)
  carries its message's id (`track({ …, record: true })`); its first poll is
  `recordSessionMessage(id, telegramUserId, messageId)` —
  `POST /trading/sessions/:id/status-message` with `{ telegramUserId, messageId }`
  — in place of the GET, one backend call as before, and its answer is the same view. The backend
  keeps `trading_sessions.status_message_id`: **the newest id wins** (#587: the CAS writes when the
  column is empty or holds a smaller id; Telegram's `message_id` grows within a chat, [risk
  79](#accepted-risks)). So a relaunch's message (a press of the session button on a running
  session) and a message sent in place of an old status message refused as gone become the recorded
  one: after a restart the resume follows the message the user saw last, and the backend's waiting
  message moves under it. A late record of an older message is refused and answers 200 with the
  view. A lost message frees the column (below), and the next record writes. A failed record
  (5xx, transport) is asked again on the next poll, with
  the same body; 404 ends the entry as a read's would. The recorded id is also what the backend's
  waiting message waits for (#536): the first one goes under the session message only once it is
  recorded.
- **The list.** `GET /trading/sessions/tracked` returns the sessions with a recorded message and no
  card, except the finished ones with no settled trade whose summary was sent (no card ever comes
  for them), oldest first, at most `TRACKED_SESSIONS_MAX` (2 000) —
  [trading-session.md](trading-session.md#get-tradingsessionstrackedlimit-567).
- **The pass** (`session-resume.ts`): at the bot's start, after the profile, and every
  `SESSION_RESUME_INTERVAL_MS` (10 min), the list beside the pairs catalog — the pass's only two
  calls. Each listed session `tracker.has()` does not hold is tracked on its message in the
  owner's private chat (its chat id is the user's id): no view yet: the first poll reads, and draws
  only a stopped session's message (a message sent before #536 keeps its «🔄»/«⏹» while its session
  runs); its first poll a GET in the next slot, 4 a second (`resumeGapMs`, [The
  tracker](#the-tracker)), its
  deadline counted from the session's `startedAt`. Edits and
  the card are a pressed entry's ([The summary card](#the-summary-card-318)). A catalog that cannot
  be read gives no label (the asset by its id); a list that cannot be read is `warn` `trading
  sessions not resumed`, and the next pass reads it again. One pass at a time; `stop()` ends the
  timer and waits for the pass in flight, whose entries are memory.
- **A session past the deadline** (a stuck one, or a done one still waiting for its summary): the
  first poll draws its final text and the entry ends — a stopped one's; a stuck active one draws
  nothing (`mayDraw`) — so each pass costs it one GET, and an edit
  only when what it prints changed since this process last drew it, plus one retry when that edit
  failed (429, 5xx, transport); the first pass after a start edits it once, as nothing is
  remembered. Its card comes on the first pass after it is due.
- **A lost message.** An edit refused as gone (`editRefusal`: the message deleted, too old to edit,
  or no text) or with any 403 (the bot blocked, the account deleted — the backend's own rule,
  `isTelegramForbidden`, Rule 19) can never land on that message, so it never gets its card. The
  tracker reports it with `forgetSessionMessage(id, telegramUserId, messageId)` — `POST
  /trading/sessions/:id/status-message/lost` with `{ telegramUserId, messageId }`
  ([trading-session.md](trading-session.md#post-tradingsessionsidstatus-messagelost-567)) — which
  clears `status_message_id` only while it is still that id, and the entry ends; the session
  leaves the list, and the next message the bot records for it is recorded again. A loss leaves
  no memory of what was drawn, so the next pass finds it again by an edit. The 404 edit
  («⚠️ Статус сессии недоступен.») reports nothing. A failed report is `warn` `trading session
  message not forgotten` and is not retried: the next pass tracks the session again, its edit is
  refused again, and the report goes again.
- **Not recovered:** a session with no recorded message — started before #567 and never pressed, a
  restart within the 3 s before the first poll, the CLI's — and a list longer than the ceiling,
  whose newest rows wait.

## Timing

- `HANDLER_CALLS.sessionStart` = 3 backend calls and 4 Bot API calls: the catalog read beside the
  answer (counted as sequential, as in `confirm`), `startSession` and its retry, the session
  message (`sendPhoto` with a direction, #568), then
  the launch screen's `deleteMessage` refused as forbidden and `editMessageReplyMarkup` (#418):
  47 s, equal to `demoAnalysis`. A refused photo sends its text instead and the screen is not
  deleted: the same count.
- `HANDLER_CALLS.cycleStakePreset` = 3 / 4 (#476): `setStake` and the catalog read beside the
  answer (counted as sequential), `startSession` in one attempt — its retry would make it 4 / 4 =
  52 s, past the shutdown budget — the session message, then the amount screen's `deleteMessage` refused as
  forbidden and `editMessageReplyMarkup`: 47 s; a refused photo, its text and no delete: 3 / 3.
  `HANDLER_CALLS.cycleStakeText` = 4 / 2 (#568; 4 / 1 before): `setStake` beside the catalog read,
  `startSession` and its retry, the photo and, refused, its text: 36 s.
  `HANDLER_CALLS.cycleStakeCustom` = 0 / 3: the prompt's edit refused as gone and sent anew.
- `HANDLER_CALLS.sessionRefresh` = 0 / 2 (#536): an old «🔄 Обновить», the answer and the strip
  of its keyboard: 16 s.
- `HANDLER_CALLS.sessionStop` = 3 / 3: an old status message's «⏹» — `stopSession` beside
  `readPairs` (counted as sequential), the read after a 409, the edit refused as gone and sent
  anew: 39 s. Under the waiting message (#536) it is 2 / 3: `stopSession`, the read after a 409,
  the answer, the edit in place refused as gone and sent anew (#587).
- `HANDLER_CALLS.stop` = 2 / 2 (#122, #473, #536): `stopSessions`, then `setTradingMode`, then the
  mode line and the message: 26 s.
- `HANDLER_CALLS.sessionShare` = 1 / 2 (#321, #538): `readSessionShare`, then `sendPhoto` to the
  storage channel and `answerInlineQuery`: 21 s; an old button's query, a refused read and an
  unset channel are 1 / 1. `HANDLER_CALLS.sessionShared` = 0 / 0: a log line.
- All stay at or below the longest path (`demoAnalysis` and, since #418, `sessionStart`, 47 s —
  [bot-demo-trade.md](bot-demo-trade.md#timing)), inside the shutdown budget. `timing.test.ts` runs every terminal branch of the nine.
- `SESSION_TRACK_FIRST_POLL_MS` = 3 s, `SESSION_TRACK_POLL_MS` = 10 s (a trade's open-to-settle
  cycle is at least the worker's catch-up grace, 10 s), `SESSION_TRACK_DEADLINE_MS` = `SESSION_MAX_DURATION_MS` + 10 min,
  `SESSION_TRACK_DRAIN_MS` = 2 × 5 s + 3 × 8 s = 34 s: an attempt's read and edit, then the card's
  claim and `sendPhoto` (#318) and the `editMessageReplyMarkup` that adds «📤 Поделиться» (#321).
- `SESSION_RESUME_INTERVAL_MS` = 10 min (#567): one list and one catalog read per bot process per
  pass, and a link of the chain through the pace below.
- `SESSION_RESUME_PER_SECOND` = 4, `SESSION_RESUME_GAP_MS` = 1000 / 4 = 250 ms (#567): the slots
  of the recovered entries' first polls ([The tracker](#the-tracker)). The chain checks
  `STARTUP_BUDGET_MS + SESSION_RESUME_DRAIN_MS + SESSION_TRACK_FIRST_POLL_MS + TRACKED_SESSIONS_MAX
  × SESSION_RESUME_GAP_MS < SESSION_RESUME_INTERVAL_MS`: 29 s + 10 s + 3 s + 500 s = 542 s < 600 s,
  so the first polls of a full list start within 10 minutes of the bot's start, and a pass's slots
  are spent before the next pass begins. Below 4 a second a full list does not fit.
  `SESSION_RESUME_DRAIN_MS` = 2 × 5 s = 10 s: what the recovery's `stop()` waits for, the list and
  the catalog counted one after the other. The recovery's calls are background work, as the
  tracker's, and in no `HANDLER_CALLS` budget; the first poll stays one backend call.
- The chain at import adds `TRADING_SESSION_START_BUDGET_MS <= BACKEND_REQUEST_TIMEOUT_MS` (the
  link #283 left to the bot), `TRADING_SESSION_VIEW_BUDGET_MS <= BACKEND_REQUEST_TIMEOUT_MS` (the
  read and the stop wait on one balance GET for a finished session, #337), first poll < poll < deadline, `SESSION_MAX_DURATION_MS <
  SESSION_TRACK_DEADLINE_MS` (imported, so checked), drain < `SHUTDOWN_BUDGET_MS`,
  `SESSION_RESUME_DRAIN_MS < SHUTDOWN_BUDGET_MS` and the recovery's pace above (#567).

## Logs

Each line carries `err` with the error's name and code, plus `backendStatus` and `backendReason`,
or the method and the Telegram code; the tracker's lines add `sessionId`. None carries the Telegram
id or the symbol.

- `trading session not started`
- `trading session status not read`
- `trading session not stopped`
- `trading sessions not stopped` (`/stop`, #122)
- `trading mode not reset` (`/stop`, #473): the switch to demo refused with a 4xx other than 404
- `trading mode outcome unknown` (`/stop`, #473): the switch may have committed
- `trading mode line not sent` (`/stop`, #473): Telegram refused the mode line (`method`,
  `telegramErrorCode`)
- `trading session message not edited` (`method`: `editMessageMedia` or `editMessageText`, #568)
- `the session photo was refused, sending its text` (#568): the session message's `sendPhoto` was
  refused (`method: sendPhoto`, `telegramErrorCode`, `byFileId`); its text went instead
- `the setup card picture is not remembered` (#568; the analysis card's before): a send or an
  edit of a picture answered with no size (`reason: no_file_id`); the next one uploads the file
- `trading session message not forgotten` (#567): the report of a lost status message failed
- `the launch screen was not deleted` (#418): the delete refused other than gone or forbidden, or
  failed in transport (`method: deleteMessage`, `telegramErrorCode` or `transportError`, `updateId`)
- `the launch screen keyboard was not removed` (#418): the strip after a forbidden delete failed
  (`method: editMessageReplyMarkup`, `updateId`)
- `the launch screen was already gone` (#418, `info`): the delete found no message
- `the pressed message was already gone` (`info`, #587): the reply to «⏹» under the waiting
  message found its message gone and went as a new message
- `trading session stop reply not drawn` (#587): the edit of the pressed waiting message failed
  other than gone or «not modified» (`method: editMessageText`, `telegramErrorCode` or
  `transportError`); nothing more is drawn
- `trading session tracking failed` (`error`)
- `trading sessions not resumed` (#567): the recovery's list could not be read (`backendStatus`,
  `backendReason`); nothing is tracked until the next pass
- `trading sessions resumed` (#567, `info`): `listed`, `resumed`, only when a pass tracked any
- `trading sessions resume failed` (#567, `error`): a pass threw outside the backend calls (a bug)
- `trading session card not sent` (#318): the claim failed (`backendStatus`, `backendReason`), the
  photo failed (`method: sendPhoto`, `telegramErrorCode`), or the render threw; with `sessionId`.
  A refused claim (409 `summary_unavailable`) logs nothing.
- `trading session share button not attached` (#321): the card is sent but has no «📤 Поделиться»:
  the edit failed (`method: editMessageReplyMarkup`, `telegramErrorCode`); with `sessionId`.
- `trading session not shared` (#321, #538): the inline handler's read failed other than 404
  (`backendStatus`, `backendReason`, `sessionId`), `reason: storage_off` (a new button's query with
  `SHARE_STORAGE_CHAT_ID` unset) or `reason: no_file_id` (the post's result named no size). A 404 —
  another user's or a missing session — logs nothing.
- `trading session promo not uploaded` (#538): the post of the promo card to the storage channel
  failed (`method: sendPhoto`, `telegramErrorCode`: 403 the bot is not the channel's admin, 400 the
  chat is wrong, 429 the channel's rate) or its render threw; with `sessionId`. The query is
  answered empty, nothing retries. The channel's id is not logged.
- `inline query not answered` (#321): `answerInlineQuery` failed (`method`, `telegramErrorCode`,
  `sessionId` when the query named one); a forged file id ends here, refused by Telegram.
- `trading session card shared` (#321, `info`): a chosen result, `sessionId` = its `result_id`.
  Neither the query nor the file id is logged.

## Trade messages and the summary (#464)

Every settled trade of a session shows in a message **without sound**
(`disable_notification: true`) and without buttons, in the trades' order; once the session is
finished, one summary message comes **with sound**. Under them stands the waiting message with
«⏹ Остановить сессию» ([The waiting message](#the-waiting-message-536)). The backend sends all
three, not the bot: a restart of either repeats no send by a retry — a block can show twice only by
the endings [risk 35](#accepted-risks) names — and skips nothing but what the endings below lose.

**One cycle, one message** (#551, the owner's decision 2026-10-16, after the reference bot). A
cycle's first trade sends a new message with its block; each later trade of the same cycle edits
that message (`editMessageText`), which then lists every step of the cycle, the newest at the
bottom. The next cycle is a new message. Under the fixed strategy every trade is step 1 of its own
cycle, so every trade is a new message of one block, as before #551.

```text
⚡ Цикл 2 Шаг 1
🔴 Ставка: $5.00 → -$5.00           (each block's two lines in a code block: Telegram shows it with «copy»)
📊 Цена: 0.49810 → 0.49790

🔄 Адаптивная ставка включена

⚡ Цикл 2 Шаг 2
⚪ Ставка: $11.50 → $0.00, ставка вернулась
📊 Цена: 0.49790 → 0.49790

⚡ Цикл 2 Шаг 3
🟢 Ставка: $11.50 → +$10.58
📊 Цена: 0.49790 → 0.49815
```

- **The figures** (#539): after «→» every outcome prints the broker trade's profit
  (`broker_trades.profit`, one `numeric` column of the claim, Rule 2) by `formatSignedUsd`: a win
  🟢 `+profit`, a loss 🔴 `-loss` (`-$5.00` for a full loss), a tie ⚪ `$0.00, ставка вернулась`
  (a zero has no sign). The stake is the intent's amount, printed by `formatStake` (every fraction
  digit, at least two). The class is the same SQL `case` on the profit's sign the view's counters
  use, so a profit of `0.001` is a win and prints `+$0.001`. The trades' lines add up to the
  summary's «💰 Результат», the SQL sum of the same profits.
- **The prices** are `broker_trades.open_price` → `close_price`, `formatPrice` with the pair's
  `digits` from the backend's pairs catalog; with no catalog or the pair gone, as the double prints
  (`String()`).
- **Cycle and step** (`sessionTradeSteps`). A cycle is the stake sizer's series (`readHistory` in
  `apps/trading-worker/src/stake/size.ts`): only a win closes it. Under martingale the step is the
  trade's number within its cycle (#551): a loss and a tie both move to the next step. The sizer's
  own step counts the losses in a row plus one and bounds its raises (`maxSteps`,
  [stake.md](stake.md)), so the message's step is the sizer's plus the ties since the last win
  (`steps-parity.test.ts`, every history of up to six trades); with ties a message can show a step
  above `maxSteps`. Under the fixed strategy every trade is step 1 of the next cycle. The sender
  passes the session's own strategy, `sessionStakeParams(settings).strategy` (#450): settings v1
  and settings that cannot be read count as `fixed`.
- **«🔄 Адаптивная ставка включена»** stands once per cycle, alone, between the blocks of step 1
  and step 2, whatever the stake of step 2 (after a tie it is the base stake). It is not repeated
  above steps 3, 4…; under the fixed strategy there is no step 2, so no line. No text says
  «Мартингейл».
- **The length.** Before an edit the sender measures the text as Telegram counts it after parsing
  the entities (`plainTextOf`, as `telegramTextProblems`); a text past `BOT_TEXT_LIMIT` (4069: the
  Bot API's 4096 less the width spacer the seam appends,
  [bot-navigation.md](bot-navigation.md#the-width-506)) opens a new message of the same cycle from
  the trade that did not fit,
  and the full one stays as it is. The defaults never get there — a cycle has at most `maxSteps`
  (4) trades plus its ties, of about 100 characters each — so only an override can; the assembled-messages registry
  (`sessionTrade`, [bot-texts.md](bot-texts.md)) keeps one block with its adaptive line within the
  limit, so the unit the sender never splits always fits.
- **The summary** is the pair («📈 {symbol}», `sessionSummarySymbol`, or «актив #N»), then the
  stopped session's closing lines (`sessionClosingLines`), the first of them the session message's
  end line (#536): «🏁 Сессия завершена: …» for a
  completed session, otherwise the stop line and «📊 Итог: …», then «💰 Результат» (the SQL sum,
  #337), the balance of the session's mode and its age line when it predates the last trade. Its
  balance is read as the route reads it (`readFinishedSessionView`): at most one successful broker
  GET per session — a refresh that did not answer `ok` is repeated by each later read of the
  finished view — `mayRefresh: false`. Under it «🏠 В меню»; under a `no_signal_timeout` stop (#509)
  «🔀 Выбрать другую пару» above it — `demo:sig:<sec>` when the duration is one the scanner lists
  (`signalsCallbackDataFor`, `packages/shared/src/bot-navigation.ts`), `demo:sig` otherwise (D10,
  D12).
- **Without a trade** no summary is sent — the session's mark alone — except for a
  `no_signal_timeout` stop (#509, D10, D11): the user learns why the session stood, with sound,
  from the pair line and the stop line.
- **When.** The trades as they settle, within `SESSION_NOTICE_TICK_MS` (3 s) plus the pacing; the
  summary once the session is finished — stopped and no intent of it outside the terminal statuses
  (`isTradingSessionFinished`) — and every settled trade was claimed first. A trade on manual
  review holds the summary: when an operator settles it, it comes as the next trade, then the
  summary («без результата, пока не закроется»). A finished session with no settled trade gets the
  mark and no message.
- **Who.** The session's owner by join (`trading_sessions → broker_accounts →
  users.telegram_user_id`); no id comes from outside. A user with `telegram_blocked_at` set gets
  nothing: the trades are claimed without a call, and the summary's mark is set without reading the
  view — no balance GET for a user nothing can reach (#620, D5). The notification level does not
  apply: trade results are outside it (Rule 19).

### The state

`trading_sessions.notified_trades` is the cursor: how many of the session's settled trades (a
settled intent with its broker trade), in creation order, were claimed for sending. A session's
trades are strictly sequential (one non-terminal intent per account, Rule 7), so settlement order
is creation order and a count is the whole state. `final_notice_sent_at` is the summary's mark.
Every trade is claimed by a CAS UPDATE before the Telegram call (`claimSessionTradeNotice`,
`claimSessionFinalNotice` in `packages/db/src/session-notice-ops.ts`): at most once, the mailing
engine's rule. The migration's backfill (0050) set every existing session's cursor at its settled
trades and marked every stopped session, so nothing settled before the deploy is sent. A session
stopped before that deploy with a trade still on manual review was marked too: when an operator
settles the trade later, neither its message nor a summary goes out — the mark keeps the session
out of the list and refuses the claim (#534 m5; the 0050 test's third session); the bot's card
(#318) is not held by it.

**The cycle message** (#551, migration 0054): `cycle_message_id` is Telegram's `message_id` of
the message the next step of the same cycle edits, `cycle_message_from` the index (from 0, in the
cursor's order) of the first settled trade it shows; both or neither (CHECK), the id above 0, the
index from 0. The claim returns them with every settled trade up to the claimed one, so the
sender knows the claimed trade's cycle and the blocks to show. One writer:
`recordSessionCycleMessage`, a CAS that holds only while the cursor stands right after the claimed
trade and no summary was sent, called only after Telegram answered a new message with its id. An
edit never changes them. For the claimed trade the sender:

1. with no cycle message, or one that shows another cycle: sends a new message with the cycle's
   trades so far — its own block alone, unless the session was met mid-cycle (a deploy, a new
   message whose outcome was unknown) — and records it from the cycle's first trade;
2. otherwise: renders the trades from `cycle_message_from` to the claimed one; past the length
   limit it sends a new message from the claimed trade and records it from there; else it edits the
   cycle message.

Since the state is written only after a send went through, and the claim before every call, a
step's block is never sent twice by a retry; the next step's edit shows every block of its
message again, so a block lost in the middle of a cycle comes back with the next step.

### Every way a send ends

| Ending | Cursor / cycle message | Then |
|---|---|---|
| a new message sent | stays claimed; the cycle message = its id and `from`, one CAS | the session's next trade in the same tick |
| an edit sent | stays claimed; unchanged | the next trade |
| an edit answered «message is not modified» | as sent | the next trade |
| an edit answered «message to edit not found», «message can't be edited» or «there is no text in the message to edit» (`editRefusal` → gone: the user deleted it, or it is too old to edit) | stays claimed; after one more pace a new message with the gone message's blocks (`from` to the claimed trade), recorded | the next trade; `warn` … `edited anew` |
| the user blocked the bot (read flag) — a trade, or the summary | claimed, no call; unchanged; the summary's mark set without the view's read (no balance GET, #620) | the next trade; for the summary nothing |
| 403 (send or edit) | stays claimed; the user is marked unreachable | later trades claimed without a call |
| 429 (send or edit) | put back (`releaseSessionTradeNotice`; the summary's by `releaseSessionFinalNotice`); unchanged | the whole sender pauses for `retry_after`; the same trade first after it |
| another 4xx (send or edit) | put back, an attempt counted in memory; unchanged | tried again on the next tick; at `SESSION_NOTICE_MAX_ATTEMPTS` (3) left claimed and `warn` … `dropped`; the block comes back only with the next step's edit of the same cycle message — a cycle's last step, and a step before a split (the next message starts from the claimed trade), stay lost, as the unknown edit's row |
| a new message with a waiting message on screen (#536) | before the send, after its own pace, the waiting message deleted ([its endings](#the-waiting-message-536)); a 429 on that delete puts the trade back and pauses the sender; an unknown outcome puts the trade back and skips the session (the next tick deletes first); a 403 counts the trade as sent without a call | the new message after one more pace; the waiting message under it in the same `serve` |
| 5xx, a timeout, the transport — a send | stays claimed; nothing recorded (the id is unknown) | `warn` … `outcome unknown`; the next step of the cycle sends a new message with the whole cycle — a repeat of its blocks if the first one arrived |
| 5xx, a timeout, the transport — an edit | stays claimed; unchanged | `warn` … `edit outcome unknown`; the next step's edit shows the block; a cycle's last step is lost |
| a new message answered with a `message_id` that is not a positive integer | stays claimed; nothing recorded | `warn` … `not recorded`; the next step sends a new message |
| the block does not fit (`BOT_TEXT_LIMIT`, 4069) | a new message from this trade; recorded from it | `info` … `split` |
| the process dies between the claim and the call | stays claimed | lost until the next step's edit; the cycle's last step is lost |
| the record refused (the cursor moved: another sender) | the other sender's record stands | a new message: at most repeated blocks, never a lost step; an edit: two senders' edits of one cycle message can land out of order and show the older step until the next step's edit ([risk 35](#accepted-risks); one sender in production) |
| the message cannot be built (a bug) | a trade stays claimed; the summary is built before its claim | `error`; a trade: the cursor has moved, the session waits for the next tick; the summary: the session stays in the list at its `created_at`, tried every tick ([risk 84](#accepted-risks)) |
| a statement or the summary's balance refresh throws (`session notices failed for a session`) | what was claimed stays claimed; nothing else | `error`; the session is tried again next tick at its place in the list, every tick while it throws ([risk 84](#accepted-risks)) |
| `stop()` mid-tick | the call in flight ends or times out — both calls of a gone edit under phase 1 | nothing is claimed after it; a finished session's summary does not start (no balance read) and goes after the next start |

Every ending after a claim moves the cursor, so no sent trade holds a session's place. Two endings
before any claim do not: a summary that cannot be built, and a thrown statement or refresh (the two
rows above) leave the session listed at its `created_at` and tried every tick; the list is
oldest-first and `SESSION_NOTICE_SCAN` (200) rows, so 200 such sessions would starve every newer
one ([risk 84](#accepted-risks); the hold-back is #660). The summary's 429 or refusal takes its
mark back only while the card (#318) has not been claimed on it; the card waits for the mark, so
in practice always.

### Rate and timing

`SESSION_NOTICE_SEND_PER_SECOND` = 9, its own pacer; with the mailings' 20 it stays under
Telegram's 30 a second for one bot (`TIMING_CHAIN_HOLDS`). An edit takes a token of the same
pacer as a send: Telegram counts it as a call. `SESSION_NOTICE_SCAN` = 200 pending sessions a
tick, oldest first (`trading_sessions_notice_pending_idx`). `stop()` waits for the call in flight:
the pace's gap, a summary's balance refresh and its send; or a step's edit, and when Telegram
answers the cycle message is gone, the waiting message's delete and the new message, each after a
pace of its own, then the next trade's pace (#551, #536, `3 × (1000 / 9 +
CLIENT_PUSH_TELEGRAM_API_TIMEOUT_MS)` = 9 333 ms < 10 000). A summary and the waiting message's own
steps start with their pace and a check of `stop()` (the summary's before its balance read), so
these paths never add up; each is under phase 1's budget. The waiting message takes the same
pacer's tokens (a send and a delete are calls); a new cycle is three calls instead of one. The bot's recovery after a restart adds up to 4 first polls a second on the same
token (`SESSION_RESUME_PER_SECOND`, #567): up to 4 first polls a second, and only a stopped
session's is an edit (#536, `mayDraw`) — 12 calls when each entry's card is due ([risk
47](#accepted-risks)).

The list's query evaluates each correlated subquery twice per row — in the select list and in the
filter, over the sessions with `final_notice_sent_at` null: Postgres plans one SubPlan per
occurrence. `EXPLAIN` of the query as drizzle sends it, on an empty migrated database
(PostgreSQL 18.6, 2026-10-18): 4 SubPlans — the settled count twice as an index probe by session
id, the select list's «finished» as an index probe and the filter's as a hashed SubPlan over
`trade_intents` by status; the same two subqueries under `WITH … AS MATERIALIZED`, which drizzle
0.45 cannot emit: 2 SubPlans, both index probes. The plan at the pilot's volume is not measured
([risk 85](#accepted-risks)). A claim reads the session's settled trades up to the claimed one, so
a session's sends read Σ ≤ 406 rows at ≤ 28 settled trades (Rule 28), ≤ 260 k at the 720 ceiling
(`MAX_SESSION_SUMMARY_TRADES`; risk 85, #660).

### The waiting message (#536)

«🔎 Ждём сигнал для следующей сделки…» (`sessionWaitingSignal`) without sound, with one button,
«⏹ Остановить сессию» (`sessionStopButton`, `session:stop:<id>:w`), built when sent
(`sessionWaitingMessage`, `session-notice-messages.ts`, Rule 30) and sent by
`sendSessionWaiting`, deleted by `deleteSessionWaiting` (`client-push.ts`). It is always the last
message of a running session (the owner's decision 2026-10-15): deleted before each new message
of the session — a cycle message, or a relaunch's status message (#587) — and sent again under it;
an edit of a step leaves it where it is (#551); deleted once the session stopped — any reason — on
the next tick, before the summary; never sent again after. A stop by its own «⏹» hands it to the
bot instead (#587): the bot draws its reply in place of it, and the sender does not delete it.

**The state** (migration 0061): `trading_sessions.waiting_message_id`, Telegram's
`message_id` of the live waiting message, NULL when there is none; and `waiting_after_message`,
its **slot**: the latest message of the session when it was claimed (#587),
`greatest(coalesce(cycle_message_id, 0), coalesce(status_message_id, 0))` — the cycle message or
the bot's recorded status message it stands under, whichever is newer (message ids grow within a
chat, [risk 79](#accepted-risks)), 0 before either — NULL while none is claimed (none yet, or
freed). A positive id, a slot from 0, an id only on a claimed slot (three CHECKs). Two SQL
predicates in `session-notice-ops.ts` alone decide:

- **due**: the session is active, no live waiting message, its slot is not the session's latest
  message (`is distinct from`), the session has a message to stand under — the bot's recorded
  status message (#567) or a claimed trade (`notified_trades > 0`: a trade's message goes only
  after the session message, recorded or not) — and the user has not blocked the bot;
- **stale**: a live waiting message, and the session stopped, or a newer message of the session
  left its slot behind and the user can be reached (`telegram_blocked_at is null`, #587: a blocked
  user's running session keeps the id unlisted until the user is reachable again).

`listPendingSessionNotices` lists a session with either (both inside `final_notice_sent_at is
null`, so the index is the same). The writers, each one CAS UPDATE of the session's row:
`claimSessionWaiting` (the slot, before the send: only with no live id and on a slot not claimed
on the session's latest message (cycle or status), so at most one waiting message of unknown fate),
`recordSessionWaitingMessage` (the id, on its own slot, while the session is active),
`releaseSessionWaiting` (the slot freed after a certain refusal), `clearSessionWaitingMessage`
(the id dropped and the slot freed after the delete, so an active session is due again whatever
becomes of the cycle message sent next). Since #587 the stop route writes them too, on purpose:
`stopTradingSession` with the pressed message's `waitingMessageId` drops the id and frees the slot
in the stop's own UPDATE when it is the recorded one, and on a 409 `clearSessionWaitingMessage` by
that id does; both clear only by `(id, waiting_message_id)`, and the sender re-reads
`waiting_message_id` right before each `deleteMessage` (`readSessionWaitingMessage`): a message the
stop route took over before that read is never deleted; a hand-over that commits while the delete
is in flight is [risk 82](#accepted-risks). `claimSessionFinalNotice` holds only with
`waiting_message_id is null`: the summary is the last message by the predicate, not by the order of
the code. No backfill: the columns are NULL for every session at the deploy, so a running one with
an anchor is due at the backend's start and gets its waiting message on the sender's first tick,
at its pace ([risk 54](#accepted-risks), [At the deploy and at a
restart](#at-the-deploy-and-at-a-restart-536)).

**One `serve` of a session** does, in this order: the trades past the cursor (a new cycle message
deletes the waiting message first, above); then a stale waiting message's delete; then the summary
of a finished session, or the waiting message due — while the session is active and the user
reachable as this `serve` left them (a 403 in a step before it sends nothing more). Each step of
the waiting message starts with its pace and a check of `stop()`.

| A send of the waiting message | Columns | Listed after? | Then |
| --- | --- | --- | --- |
| 2xx with a positive `message_id`, recorded | `waiting_message_id` = it | no | — |
| 2xx, the record refused (the session stopped between, or another sender recorded first) | the slot claimed, no id | no | one more pace, its own message deleted (`info` `… removed: not recorded`; a failure `warn` `… not removed`) |
| 2xx with a `message_id` that is not a positive integer | the slot claimed, no id | no | `warn` `… not recorded: no message id`; the next one after the session's next new message (a recorded cycle message or a relaunch's status message) |
| 403 | the slot freed; the user marked unreachable | no (due needs `telegram_blocked_at is null`) | `warn` `… refused: the user is unreachable`; due again after `markTelegramReachable` while the session runs |
| 429 | the slot freed | yes | the whole sender pauses for `retry_after`, then the send again |
| another 4xx | the slot freed, an attempt counted in memory | yes, until the third, then the slot stays claimed | `warn` `… refused`, then `… dropped` |
| 5xx, a timeout, the transport | the slot claimed, no id | no | `warn` `… outcome unknown`; a delivered one is never deleted ([risk 50](#accepted-risks)) |
| the claim lost (another sender) | — | as the winner's | the session is read again next tick |
| `stop()` between the pace and the claim | — | yes | nothing claimed; after the next start |

| A delete of the waiting message | Columns | Listed after? | Then |
| --- | --- | --- | --- |
| deleted | the id dropped, the slot freed | by the other predicates (an active session → due → a new one; a stopped one → the summary) | — |
| 400 «message to delete not found» (`deleteRefusal` gone: the user deleted it, or a bot before #587 did on its «⏹») | the id dropped, the slot freed | the same | `info` `… already gone` |
| 400 «can't be deleted» (older than 48 h) | the id dropped, the slot freed | the same | `warn` `… not deleted`; it stays with its button ([risk 51](#accepted-risks)) |
| 403, the session active | the id and the slot kept (#587: the message is still in the chat); the user marked unreachable | no (stale on a left-behind slot and due both need a reachable user) | `warn` `… refused: the user is unreachable`; before a new cycle message the trade counts as sent without a call (Rule 19); after `markTelegramReachable` the next new message of the session deletes it first |
| 403, the session stopped | the id dropped, the slot freed; the user marked unreachable | by `finished` | `warn` `… refused: the user is unreachable`; the summary claimed without a call |
| 429 | the id kept | yes (stale) | the sender pauses; before a new cycle message the trade is put back first |
| another 4xx | the id dropped, the slot freed | the same | `warn` `… not deleted` |
| 5xx, a timeout, the transport | the id kept, an attempt counted in memory | yes (stale), until the third, then the id dropped, the slot freed and `warn` `… delete dropped` | `warn` `… delete outcome unknown`; the delete is idempotent; before a new cycle message the trade is put back and the session skipped: the next tick deletes first, then the trade |
| the user blocked the bot (read flag), the session active | the id and the slot kept, no call (#587) | no | before a new cycle message the trade counts as sent; after `markTelegramReachable` as the 403 row |
| the user blocked the bot (read flag), the session stopped | the id dropped and the slot freed without a call | by `finished` | the summary claimed without a call |
| handed to the bot at the stop (`waitingMessageId` in the stop body, #587) | the id dropped and the slot freed by the stop route, no call | by `finished` | the bot drew its reply in place of it; the summary on the next tick, under it |
| taken over before the call (the stop route's hand-over or its 409 clear, read right before the call: another id or NULL, #587 round 1) | as the route left them, no call | by `finished` (the session stopped) | `info` `… taken over: not deleted`; before a new cycle message the trade goes on, its message under the bot's reply |
| deleted, and the clear found the id gone (the stop took it over during the call) | as the route left them | by `finished` | `warn` `… deleted after the stop took it over` ([risk 82](#accepted-risks)) |

| A new cycle message after the delete (the id dropped, the slot freed) | The waiting message after it |
| --- | --- |
| 2xx, `recordSessionCycleMessage` recorded it | due under it: sent by the same `serve` |
| 2xx, the record's CAS refused (another sender); 2xx without a positive `message_id`; 5xx, a timeout, the transport; another 4xx the third time (`… dropped`) | due all the same (the slot is free): sent by the same `serve`, under whatever went out |
| another 4xx, the first or second time | the trade put back, the session skipped; the next tick sends the trade (no delete: no id), then the waiting message |
| 429 | the trade put back, the sender pauses; after it the trade, then the waiting message |
| 403 | the user marked unreachable, nothing more; due again after `markTelegramReachable` |

A new cycle message with no waiting message before it (the first trade, or after an unknown
outcome of the waiting message's send) leaves the slot where it was: a free slot is due under a
claimed trade by the next tick; a slot claimed on the session's latest message (an unknown outcome,
[risk 50](#accepted-risks)) waits for the session's next new message (a recorded cycle message or a
relaunch's status message).

No ending leaves a session listed with nothing to take it out: a claimed slot ends due, a dropped
id ends stale, and the attempts in memory bound the refusals to three ticks, after which the slot
or the id is fixed in the database. A restart of the backend clears the attempts: a slot refused
three times stays claimed. A running session with a reachable user is left without a live waiting
message until its next recorded new cycle message only by these endings, each with its log line:

1. the waiting message's send with an unknown outcome and not delivered (`… outcome unknown`,
   [risk 50](#accepted-risks));
2. a 2xx without a positive `message_id`: the slot claimed, the message with the user but not
   deletable (`… not recorded: no message id`, [risk 52](#accepted-risks));
3. its third definite refusal (`… dropped`: Telegram refusing the message itself three times is a
   defect, not the network — a `session waiting message dropped` in a week is a reason for an
   issue);
4. a waiting message the user deleted (the sender learns it on its next delete, as gone);
5. a record refused (the session stopped, or another sender recorded first) and the clean-up
   delete failed (`… not removed`): the message stays with its «⏹» ([risk 81](#accepted-risks)),
   the slot claimed.

A blocked user's running session keeps its waiting message's id while the user is unreachable
(#587): it is not listed for it (stale on a left-behind slot needs a reachable user), so it costs
no tick; once the user is reachable, the next new message of the session, or a left-behind slot,
deletes it first — never a second «⏹» beside it.

#### At the deploy and at a restart (#536)

- **Volume.** At the backend's start every active session with a recorded status message or a
  claimed trade and a reachable user is due (no backfill, the owner's decision 2026-10-17). The
  code does not bound their number (one active session per account); the planned figure is 2 000
  (`TRACKED_SESSIONS_MAX`).
- **Calls.** One `sendMessage` and two UPDATEs (claim, record) each, no broker call. Each send
  takes a token of the sender's pacer (`SESSION_NOTICE_SEND_PER_SECOND`, 9 a second, shared with
  the trades, edits, deletes and summaries; with the mailing 20 + 9 < 30, `TIMING_CHAIN_HOLDS`).
  The list is read `SESSION_NOTICE_SCAN` (200) rows a tick, oldest first; a tick longer than the
  interval makes the next one a no-op, so the catch-up is ticks at 9 calls a second, not a burst:
  the last of N such sessions gets its waiting message within 3 s + N/9 s of the backend's start
  (2 000 → about 225 s). A later session's trade messages wait behind them, once a deploy.
- **The order of the deploy**: the bot first (`docker compose up -d --no-deps bot`), then the
  backend (`binarius-deploy`); the steps are the PR's. The bot's recovery pass only reads a running
  session (`mayDraw`): an old status message keeps its «🔄»/«⏹» until its session stops ([risk
  55](#accepted-risks)), whatever the pause between the steps; a session started between them waits
  for the new backend ([risk 59](#accepted-risks)).
- **A restart of the bot** draws only the sessions stopped while it was down (their final edit and
  card); a running one costs one GET and no Telegram call.
- **At the deploy of #587**: a session with a live waiting message claimed on slot 0 under a
  recorded status message (no cycle message yet) finds its slot left behind — the slot now names the
  status message — and gets one delete and one send on the first ticks, at the sender's 9 a second
  as the volume above; a session without a recorded status message (slot 0 under a claimed trade)
  does not move. One deploy, the backend before the bot (`binarius-deploy`): an old bot's stop body
  is still accepted; in the window an old bot's record carrying `replacesMessageId` is a 400, asked
  again each poll until the bot restarts — the rare old-«⏹» path only; a new bot on an old backend
  would get its stop body refused (400 → `unavailable` and «⏹» in place).

### Logs (backend)

With `sessionId` (and `claimed` for a trade), the error's name and code and the Telegram method and
code; no Telegram id, no message id, no text. The trade's lines are the same for a send and an
edit: the method field (`sendMessage`, `editMessageText`) tells them apart.

- `session trade notice refused`, `… dropped`, `… outcome unknown`, `… edit outcome unknown`
  (#551), `… refused: the user is unreachable` (`warn`); `session summary refused`, `… dropped`,
  `… outcome unknown`, `… refused: the user is unreachable` (`warn`)
- `session trade notice edited anew: the cycle message is gone`, `session trade notice not
  recorded: no message id` (`warn`, #551); `session trade notice split: the cycle message is full`
  (`info`, with `from`, #551)
- `session waiting message refused`, `… dropped`, `… outcome unknown`, `… refused: the user is
  unreachable`, `… not recorded: no message id`, `… not deleted`, `… delete outcome unknown`, `…
  delete dropped`, `… not removed` (`warn`, #536), `… deleted after the stop took it over` (`warn`,
  #587 round 1, [risk 82](#accepted-risks)); `session waiting message already gone`, `… removed:
  not recorded` (`info`, #536), `… taken over: not deleted` (`info`, #587 round 1)
- `session notices paused: Telegram asked to wait` (`warn`, `pauseMs`)
- `session trade notice not built`, `session summary not built`, `session notices failed for a
  session`, `session notice tick failed` (`error`)

## The summary card (#318)

One PNG per finished session, demo and real alike, sent to the session message's chat under the
backend's summary message (#464), without sound (`disable_notification: true`): the summary
carries the session's one sound. Sharing it is «📤 Поделиться» ([Sharing the card](#sharing-the-card-321)) or
Telegram's own forwarding.

- **When.** The tracker's entry ends on a done view (stopped, the last trade settled or rejected),
  the end line is on screen and the summary message went out (`noticesDone`, #464; the claim
  below refuses the card before it). A last trade on `manual_review` is not done, so no card yet:
  an operator settling it later gives one on the tracker's next poll while its entry lives (until
  `SESSION_TRACK_DEADLINE_MS`), otherwise on the next recovery pass (#567). A session with no
  settled trade gets none.
- **At most once.** `POST /trading/sessions/:id/summary` ([trading-session.md](trading-session.md#routes))
  sets `trading_sessions.summary_sent_at` by one CAS UPDATE — only once `final_notice_sent_at` is
  set (#464) — and answers the card's rows; every
  other answer is 409 `summary_unavailable`, and the bot then sends nothing. Two entries of one
  session (a start's 409, an old status message's «⏹» while it is tracked) race the claim and one
  wins.
- **The numbers.** Each trade's result is its `broker_trades.profit`, the total the same SQL sum
  the summary prints (`sessionProfitSumSql`, #337); the bot formats them (`formatSignedUsd`) and
  adds nothing. Win, loss and tie go by the exact decimal's sign, as the view counts them, so
  `0.001` is a win that prints `+$0.001` (every digit, #450). The prices are
  `broker_trades.open_price`/`close_price`: the line runs through each trade's entry (a quarter
  into its column) and exit (three quarters), scaled between the lowest and the highest price, in
  the middle when all are equal. It is not the
  market path between them. No balance: the card is made to be forwarded, the balance is the
  summary's.
- **The layout.** 1200 × 675, dark. The pair (or «актив #N»), «СЕССИЯ ЗАВЕРШЕНА», «ИТОГ» and the
  signed total; a column per trade, «Сделка N» and its result (at most
  `MAX_SESSION_SUMMARY_TRADES`, 720, the summary's bound since #552: a five-cycle martingale
  session without ties has at most 20 trades, and only many ties make the columns crowd); blue entry markers, exits green,
  red or grey; the legend; the footer «5 сделок · 3 в плюс, 2 в минус», «в ноль» only when a trade
  tied. Every word is the catalog's (`sessionCard*`), XML-escaped, and shrinks to fit its slot.
- **The caption** is `sessionCardCaption`: «🏁 {symbol}: итог сессии {profit}» and «🤖 @{botUsername}»,
  the bot's `ctx.me.username` from the press that started tracking.
- **The keyboard** is the end of the path ([The session message](#the-session-message)): «🔁 Ещё
  сессия» while the demo offers the duration, «📊 Новый анализ» and
  «📡 К сигналам» in one row, «💳 Пополнить» (#27, https only) and «👥 Пригласить друга» (#115) in
  one row, «🏠 В меню»; «💳 Пополнить» and «👥 Пригласить друга» in one row and «🏠 В меню» alone
  without `settings`
  (`sessionCardKeyboard`); under a `no_signal_timeout` stop «🔀 Выбрать другую пару» in place of the
  first three (#509). «📤 Поделиться» comes on top of these rows by
  an edit right after the send (#321).
  «📡 К сигналам» edits the pressed message; under the card Telegram refuses that with «there is
  no text in the message to edit», `editRefusal` (`telegram-refusals.ts`) reads it as gone, and the screen
  comes as a new message under the card, with one `warn` `the demo screen was not edited, sending
  it anew` per press. «📊 Новый анализ» tries no edit (#482): the press carries the photo, so
  «⏳» goes as a new message at once, and its result is edited into it, or, for a signal, the
  card goes as a photo and «⏳» is deleted ([bot-demo.md → The analysis](bot-demo.md#the-analysis)).
- **The renderer.** `@resvg/resvg-js` 2.6.2 (MPL-2.0), a prebuilt native module per platform, about
  30 ms per card on the bot's event loop. It loads only `apps/bot/fonts/Inter-*.ttf`
  (`loadSystemFonts: false`): the alpine image has no fonts, and without a font resvg drops the
  text without an error. `pnpm check` renders on the host's build and holds that the lockfile has
  the `linux-x64-musl` and `linux-arm64-musl` builds (`lockfile-musl.test.ts`); that the musl build
  loads in the image is the owner's check:

  ```bash
  docker compose build bot
  docker compose run --rm --no-deps -w /app/apps/bot bot node --input-type=module -e "import('@resvg/resvg-js').then(({ Resvg }) => { const png = new Resvg('<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"10\" height=\"10\"/>').render().asPng(); console.log(png.length > 0 ? 'ok' : 'empty') })"
  ```

## Sharing the card (#321)

«📤 Поделиться» opens Telegram's chat picker (people, groups and channels; no chats with bots) and
posts a promo card of the session there with its own caption, «via @bot» (#538: before it, the
#318 card itself). The promo card is drawn when the share is pressed and posted to a private
storage channel for its `file_id`; the owner proof is the backend's read of the session.

- **The button.** Only with `SHARE_STORAGE_CHAT_ID` set (`apps/bot/src/env.ts`; unset, the bot
  logs `share button off: SHARE_STORAGE_CHAT_ID is not set` at start and the card goes with its
  #318 keyboard alone). The card is sent with its #318 keyboard and then gets the row
  `switch_inline_query_chosen_chat` = `share:<sessionId>` on top, by one `editMessageReplyMarkup`
  that sets the whole keyboard again (the share row, then every row of `sessionCardKeyboard`). A
  failed edit → no button, one `warn`, no retry; the card's own `trading session card not sent`
  does not fire.
- **The answer.** `SHARE_PATTERN` parses the query: a lower-case uuid, and after #321's form a
  `:` and a file id of 1–213 non-space characters; anything else is answered empty with no
  backend call. A matching query reads `POST /trading/sessions/:id/share { telegramUserId:
  <from.id> }` ([trading-session.md](trading-session.md)): the route is scoped by the owner, so
  another user's id is the same 404 as a missing session and gets the empty answer (Rule 13). A
  session that is not done (`sessionTrackingDone`: stopped, the last trade settled or rejected) gets
  the empty answer too; the same button works once the last trade settles. The asset is the
  settings', or the last trade's when the settings could not be read — the card's own rule; with
  neither, or with no settled trade, the empty answer.
- **The promo card** (`session-promo.ts`), 1080 × 1350, the #318 card's background, colours,
  fonts and renderer, top to bottom: the pair (`pairLabel`; without the pair in the backend's
  catalog «актив #N») and the direction badge — a pill, green «▲ ВВЕРХ» or red «▼ ВНИЗ», the arrow a
  path since resvg drops a glyph Inter lacks; the badge widens with an override of its label, from
  the default's width up to half the card; «Мой результат сессии» and the result in large type,
  green, red or grey by its sign (the view's `trades.profit`, the SQL sum; a minus is shown as it
  is); the line through every settled trade's entry and exit price in order, the entries blue, the
  exits by outcome, the first entry price under its point and the last exit price over its point
  (`formatPrice` with the catalog pair's `digits`, Rule 20; no labels without the pair; all prices
  equal → the line in the middle); the mark (a circle with the brand's first letter) and the
  brand; the call «Торгуй со мной в Binarius и получи бесплатные токены!»; the session's end
  (`ended_at`) in Moscow time, «12.10.2026 21:32 МСК» (`formatPaymentDate`). The direction is the
  majority of the settled trades' (`broker_trades.action`), the last trade's on a tie
  (`promoDirection`). Every text is a catalog entry (`sessionPromo*`, the `session` group),
  escaped into the SVG and shrunk to its slot (`fitSize`).
- **The storage channel.** `sendPhotoToStorage(api, SHARE_STORAGE_CHAT_ID, png)` posts the PNG
  without sound, without a caption or a keyboard; the answer names the largest size's `file_id`
  (`photo.at(-1)`). Posts are never deleted: Bot API does not document that a `file_id` outlives
  its message, so nothing relies on it. One post per press after Telegram's 300 s cache; a refused
  post (403 the bot is not an admin, 400 the chat is wrong, 429 the channel's ≈ 20 messages a
  minute) → `trading session promo not uploaded` and the empty answer, no retry.
- **The result** is `InlineQueryResultCachedPhoto` with `id` = the session's id, the posted
  card's `file_id`, and the caption `sessionShareCaption` through `answerInlineQueryPhotoHtml`
  (`send.ts`): «Присоединяйся к Binarius — получи бесплатные токены!» and the sender's personal
  link `https://t.me/{botUsername}?start=ref_{code}` (`referralLinkOf`, #115; the route creates
  the code on first use, as /invite does). A sender without a code — blocked, or without a users
  row — gets `https://t.me/{botUsername}?start=share` (`shareFallbackLink`). No keyboard
  (docs/bot-navigation.md → Exceptions). The URL is plain text, which Telegram turns into a link;
  the payload is recorded as `acquisition_source` by the first `/start` of a new user
  ([bot-start.md](bot-start.md)). The found answer is `is_personal`, cached by Telegram for its
  default 300 s; the empty one `cache_time: 0`. «Бесплатные токены» are the starter pack the
  invitee gets for the first linked account (`link_bonus`, [referrals.md](referrals.md)).
- **A button sent before #538** (`share:<sessionId>:<fileId>`) is answered with that file id — the
  #318 card — and the new caption; nothing is drawn or posted, and no channel is needed. The file
  id is Telegram's to check: a forged or foreign one makes `answerInlineQuery` fail with 400
  (`inline query not answered`).
- **Owner steps.** BotFather, the client bot: `/setinline` with a placeholder («Поделиться итогом
  сессии»), `/setinlinefeedback` → Enabled. Until `/setinline` is set, inline mode is off for the
  bot and Telegram delivers no inline queries. For the promo card (#538): a private channel with
  the client bot as an administrator allowed to post, its id (`-100…`) as `SHARE_STORAGE_CHAT_ID`
  in `.env`, then `docker compose up -d bot`.
- **The deploy** (#538): the backend before the bot — a new bot against an old backend gets 404 on
  `/share` and answers every share empty until the backend is up.

## Accepted risks

1. **In-memory tracking, recovered at the start** (#567). A restart drops every entry; the bot's
   first recovery pass, right after the profile, tracks again each session with a recorded
   message. A message shows its last state from the restart to that pass. Falsifiable: a stopped
   session's message not edited for over 10 minutes after a restart.
2. **An old button starts a new session** once the previous one has ended (owner's decision).
3. **Poll load.** One `GET /trading/sessions/:id` per tracked session every 10 s: at most 1 000
   requests a second at 10 000 entries, ≤ 300 at the pilot's 1–3k sessions.
4. **Retargeting** can leave one more edit on the old message.
5. **A last trade in `manual_review`** keeps its entry polling to the deadline; the message then
   keeps the stopped session's end line.
6. Closed by #536: the session message prints no balance and no age; the summary's age line is as
   of its send.
7. **A socket settlement racing the balance GET** (#337). The socket writers are on at the pilot
   (Rule 27). A `GET /v1/broker/user` the broker answered before it closed the trade, written after
   the `settle` row commits (`close_trade.success` → `settleClosedTrades`), reads `current: true`
   with the balance from before the close. The window is the GET's own latency, at most
   `BROKER_REST_TIMEOUT_MS` (5 s). That the broker sends `update_balance` when a trade closes,
   which would correct the row on its next event, is stated, not verified (observed live only at
   open, [broker-socket.md](broker-socket.md)). On the REST path the catch-up grace (10 s) is longer
   than the GET timeout, so the race cannot happen there. Falsifiable: a summary whose
   «🧪 Демобаланс» differs from `/menu` read right after, with no «🕒» line.
8. **Saved overrides of the keys #536 removed** (`sessionSettings`, `sessionStep`, `sessionCycle`
   of #552, `sessionScore`, `sessionDeadline`, `sessionRefreshButton`) stay in
   `bot_text_overrides`; the loaders refuse such a row with a `warn` and print the defaults
   (decision В2). The owner's step in the PR:
   `bot-text list`, and `bot-text reset <key>` for each listed one.
9. **One deploy for the backend and the bot** (#337): the view's schema is strict on both sides, so a
   bot older than the backend answers `ContractViolation` on every session read until redeployed.
10. **At most once, not exactly once** (#318, owner 2026-10-07): a crash or a lost answer between
    the claim and `sendPhoto` loses the card, and nothing retries it.
11. **Sessions that ended before #318** have no mark and get no card any more: «🔄 Обновить» is
    gone (#536), and no message of theirs is recorded (#567).
12. **The musl build is not loaded by `pnpm check`** (#318): CI and the host install other builds.
    Falsifiable: the owner's container command above does not print `ok`.
13. **Render cost** (#318): about 30 ms per finished session on the bot's event loop. Falsifiable:
    a render over 200 ms on the pilot.
14. **Warn noise under the card** (#318): every press of «📡 К сигналам» under a card logs one
    `warn` `the demo screen was not edited, sending it anew` («📊 Новый анализ» no longer edits
    there, #482); a separate outcome for "no text" would be a third answer in every caller of
    `editRefusal`. Falsifiable: that line's rate after #482 is roughly the rate of that press.
15. **A leftover «⏳»** (#318) — closed by #482: under the card «⏳» is sent at once and the
    result is edited into it, or deleted after a signal's card; it stays only when that edit or
    delete is refused or fails in transport.
16. **Telegram's wording is taken from public reports** (#318): «there is no text in the message
    to edit» has not been observed live here. Falsifiable by the owner's check in the PR: a press
    under the card that logs `update handler failed` means the description differs.
17. **Two or more sessions stopped by `/stop`** (#122) get one count line, with no status, no
    tracking and no summary card; each session's own message, if tracked, still follows it.
    Reachable from the bot through one window (#455 m1): the account of a running session is
    revoked (a failed refresh, Rule 12), and no sweep stops its session; the orchestrator does at
    its next attempt, when the intent's creation is refused as `account_revoked` → stop
    `account_unavailable` ([trading-session.md](trading-session.md#the-orchestrator), the refusal
    table), i.e. after the session's current hold-back (the next candle, the retry after a failed
    attempt, or the open trade's end). If in that window the user signs in on another broker
    account (the only active one now) and starts a session, `checkTradingSessionStart` →
    `resolveTradingAccount` finds one active account with no active session, and the start
    passes: two active sessions, both from the bot. Falsifiable: «⏹ Остановлено сессий: 2» in the
    chat of a user who never used the CLI, or `stopUserSessions` returning two rows for such a
    user.
18. **No repeat on an unknown outcome of `/stop`** (#122): the stop may have committed; the truth is
    in the session's message (the tracker's edit at the stop), and a second `/stop` answers
    «Активных сессий нет.».
19. **One more Bot API call per card** (#321): a failed `editMessageReplyMarkup` leaves the card
    without «📤 Поделиться», and nothing retries it — a done session sends no second card. Without
    `SHARE_STORAGE_CHAT_ID` no card gets the button (#538).
20. **The query is visible in the input field** for a moment after the press (#321): since #538
    it is `share:<sessionId>`, the session's id, which answers nothing to anyone but its owner; an
    old button still shows its card's `file_id`, Telegram's identifier of the user's own card.
21. **A public inline surface** (#321): anyone can send the bot inline queries; each one that does
    not match costs one empty answer and nothing else. Falsifiable: inline-query volume above the
    bot's other update volume on the pilot.
22. **Telegram caches the found answer** for 300 s per user and query (#321): a text override of
    `sessionShareCaption` or of the promo card's texts, and a change of the channel, reach an
    already-answered query after that.
23. **`switch_inline_query_chosen_chat` is Bot API 6.7+** (#321): that it opens the picker on the
    owner's clients is the owner's check.
24. **Cards sent before #321** have no «📤 Поделиться» and get none: a done session's claim answers
    409, so no new card is sent. Cards sent before #538 keep their old button, which shares the
    #318 card with the new caption, and get no promo card.
25. **Two «📤 Поделиться» buttons** (#321): the URL button on `/invite` (`inviteShareButton`) and the
    one under the card (`sessionShareButton`); different screens, separate keys.
26. **At most once for each trade's call and the summary** (#464, manager's decision 2a; #551): an
    unknown Telegram outcome or a crash between the claim and the call is never retried for that
    trade. In the middle of a cycle the next step's edit shows the lost block again; a cycle's last
    step, and a block that went into a new message after a split whose outcome was unknown, stay
    lost (the next step splits again and starts with its own block). A retry never doubles a
    message; a new message whose outcome was unknown can repeat blocks (risk 35). Falsifiable:
    `session trade notice outcome unknown` and `… edit outcome unknown` above 0.1 % of calls.
27. **The notices' rate** (#464): at most 9 a second (540 a minute) for every session together;
    above it the messages lag behind the trades, never drop. The bot's own replies and edits are
    outside that budget, as before. Telegram also asks for no more than about one message a second
    to one chat (stated, not measured): a session's backlog — after a restart, a pause or an
    unblock — goes to its one chat at the sender's 9 a second, up to 28 trades plus the waiting
    message's delete and send, so a 429 on that chat pauses the whole sender for `retry_after`; no
    loss, no double, the other sessions wait too. A rate per chat is #660 (#534 m2).
28. **Latency** (#464): a trade's message comes up to `SESSION_NOTICE_TICK_MS` plus the pacing
    after its settle.
29. Closed by #539: the trade lines print the profit and add up to «💰 Результат».
30. **A stopped session stuck on manual review** (#464) is not in the sender's list once its
    settled trades are claimed (`finishedSql` is false, the cursor equals the settled count, no
    waiting message): it costs nothing until an operator settles or rejects the trade, when it is
    listed again for that trade and the summary (N8).
31. **No card** when the backend has not sent the summary by the tracker's deadline (#464, about
    70 min after the start) — until the next recovery pass once the mark is set (#567).
32. **Sessions running at the deploy** (#464) get their later trades and their summary; the trades
    settled before it are not sent. Sessions that ended before it get no summary.
33. **Doors drawn without reading the signal** (#509): «🔁 Ещё сессия» after another stop, the offer
    under a single trade and the real launch screen after a saved stake show their button on a
    pair whose signal may be gone by the press; the press refuses with the reason — the amount
    screen's node `demo:l` reads the signal at the press in either mode, the start route's step 4c
    in real — and a session never starts on «сигнала нет».
34. **A signal gone right after the start** (#509): the start saw a signal, the orchestrator's
    first attempt a few seconds later sees «сигнала нет»; the session waits up to the no-signal
    limit and stops with no trade. That is the limit, by the owner's decision.
35. **Repeated blocks** (#551): a new message whose outcome was unknown (the next step sends the
    cycle anew), and a second sender in a deploy's window (its record refused, its message sent),
    can show a cycle's blocks twice, within one cycle; no step is lost by it in a new message; two
    senders' edits of one cycle message can land out of order, so the message shows the older step
    until the next step's edit — production runs one sender (stated). Falsifiable: two
    messages of one cycle with common blocks more often than `session trade notice outcome
    unknown`.
36. **Sessions mid-cycle at the deploy of #551** have no cycle message: their next step sends a new
    message with the cycle so far, repeating the blocks sent one per message before the deploy,
    once. No backfill.
37. **A step above `maxSteps`** (#551, the owner's answer 2026-10-16): with ties a message shows,
    say, «Шаг 5» under a limit of 4; the limit bounds the raises, and its stop text «лимит повышений
    ставки» says so ([stake.md](stake.md)).
38. **Edits share the notices' rate** (#551): an edit is one call of the 9 a second; long series of
    edits make the messages lag behind the trades, never drop (risk 27).
39. **The newest recorded message wins** (#567, #587): a session's second message (a press of the
    session button again, an old status message's «⏹» answered anew) becomes the recorded one by
    its newer id; after a restart edits and the card go to it, and the first message keeps the text
    it had. Both show the one session. Falsifiable: after a restart only the upper of two messages
    of a session is edited. A lost message frees the column: the next new message the bot records
    is the one after a restart, not one it already followed in memory, whose record came before the
    loss.
40. **Stuck sessions** (#567) — on manual review, or with a stalled worker, longer than
    `SESSION_TRACK_DEADLINE_MS` from `started_at`: each recovery pass costs each one GET; an edit
    only when its drawing changed since this process's last edit of it, plus one retry when that
    edit did not land. The first pass after a restart edits each one once (its current drawing); an
    unchanged one is «not modified» (shown). The card comes on the first pass after the operator settles the trade and
    the summary is sent. Falsifiable: more than 100 rows of the list with `startedAt` older than
    a day, or an edit of a stuck session nothing of whose drawing changed since
    this process's last landed edit of it.
41. **Sessions started before #567** have no recorded message: after a restart they are not
    recovered until a press of an old status message's «⏹» records one (#536: «🔄 Обновить» no
    longer does). Likewise a restart in the 3 s before a new session message's first poll.
    Falsifiable: a card missing for a session started before the deploy and finished after a
    restart of the bot.
42. **The list's ceiling** (#567): with more than `TRACKED_SESSIONS_MAX` (2 000) open sessions the
    newest wait for the oldest to close. A row leaves when its card is claimed, when its session
    finishes with no settled trade and its summary sent, or when its message is lost; only the
    stuck ones (risk 40) stay long, and the operator closes them. Falsifiable: the list answering
    exactly 2 000 rows.
43. **Up to 10 minutes** (#567) for an entry the tracker dropped later — evicted at
    `SESSION_TRACKER_MAX_ENTRIES` or ended at the deadline before the summary — to be tracked
    again, plus its slot. A restart itself waits for no interval: the first pass runs at the
    start, its first polls in slots, the last of a full list about 8.5 minutes after the pass and
    at most 542 s after the start (the chain's link).
44. **The backend before the bot at a deploy** (#567): a bot whose backend does not know
    `POST …/status-message` gets 404 on the first poll and shows «⚠️ Статус сессии недоступен.»
    for the starts in that window.
45. **A 403 is a loss** (#567): after the user unblocks the bot, the card of a session whose edit
    got a 403 never comes, as the backend drops the summary that fell on the block (Rule 19); a
    pressed entry no longer edits its message after a 403 either. Falsifiable: a card arriving
    without the #464 summary before it.
46. **An edit refused for good in words outside `editRefusal`** is retried on every pass: one GET
    and two edits. Falsifiable: `trading session message not edited` for one session on adjacent
    passes with a code that is neither 429 nor 5xx.
47. **The recovery's pace on the bot's token** (#567): up to 4 first polls a second — only a
    stopped session's is an edit (#536), up to 12 calls when each entry's card is due — for up to about 8.5 minutes after the
    start and up to about 500 s of each periodic pass with a full list. It comes on top of the
    backend's pacers, 20 + 9 a second (about 30 a second for Telegram: stated, not measured), and
    of the bot's unpaced replies to users, which came on top of those shares before. A restart
    during a mailing at its full pace can exceed about 30 a second. The cover: on a 429 the
    mailings and the session's messages wait for `retry_after`, and a tracker edit is retried on
    its entry's next poll. Below 4 a second a full list does not fit the task's 10 minutes;
    cutting the backend's shares (#202, #464) is out of scope. Falsifiable: a 429 in the bot's
    logs (`trading session message not edited`, `error_code` 429) or the backend's (a session
    message waiting for `retry_after`) within 10 minutes of the bot's start with no mailing
    running.
48. **The pace's clock** (#567): slots are counted on the tracker's clock (`Date.now`, as the
    deadline). A clock stepping back delays the remaining slots by the step. Falsifiable: a
    recovered entry's first poll later than `firstPollMs + its position × SESSION_RESUME_GAP_MS`
    with a sound clock.

49. **The waiting message comes 3–6 s after the session message** (#536): the tracker's first poll
    records the message after 3 s, and the sender's tick is 3 s. Falsifiable: a waiting message
    later than 10 s after the session message with the backend and the bot running.
50. **An orphan waiting message** (#536): a send whose outcome is unknown (5xx, a timeout) leaves
    its slot claimed and no id; the next one comes only after the session's next new message
    (cycle or status), and a delivered one is deleted by no one. Its «⏹» works (the stop or 409 → the reply drawn in its
    place, #587). At most one per slot, the trades' rule (risk 26). Falsifiable: `session waiting message
    outcome unknown` above 0.1 % of the sends.
51. **A waiting message older than 48 h is not deleted** (#536, Telegram's limit): only a session
    stuck on manual review that long; it stays with its button, and a press answers 409 → the end
    line. The bot does not strip it either (a fourth Telegram call in `HANDLER_CALLS.sessionStop`;
    the plan's decision, Plan Update of review round 1). Falsifiable: `session waiting message not deleted` with code 400 for a session younger than
    48 h.
52. **«Always the last» holds by the order of the calls in one `serve`, not by state** (#536): the
    waiting message is deleted before a new cycle message and its slot freed, so whatever becomes
    of the new message, a new waiting message is due under it; a relaunch's status message moves the
    slot the same way (#587). A waiting message stays above a new cycle message only when the sender
    cannot delete it: an orphan of risk 50, a send without a
    positive `message_id`, a delete given up after three unknown outcomes, one older than 48 h
    (risk 51). A second sender between the delete and the trade's message could claim a waiting
    message above it — the backend runs one sender (stated). Falsifiable: a waiting message above a
    cycle message with one sender and no `session waiting message outcome unknown`, `… not
    recorded: no message id` or `… delete dropped`.
53. **The stop route hands the waiting message to the bot** (#587, reversing #536's choice on
    purpose, the manager's answer В1): the sender is no longer the waiting columns' one writer;
    the sender and the stop route both clear only by `(id, waiting_message_id)`, and the sender
    re-reads the column right before each delete, so neither clears or deletes a message the other
    took first. The reply replaces the waiting message where it stands, the summary is appended
    after it, the card after the summary — «last» by construction, not by time. Falsifiable: a
    `deleteMessage` of the pressed waiting message after a stop by its «⏹» without the risk 82
    warn.
54. **Sessions running at the deploy of #536** get their waiting message at the backend's start (the
    owner's decision 2026-10-17): no backfill, the sender's first tick, its pace — at most 3 s +
    N/9 s for N such sessions (2 000 → about 225 s); the trade messages of later sessions wait
    behind them once. Falsifiable: a running session with a recorded status message or a claimed
    trade and a reachable user without a waiting message 3 s + N/9 s + 10 s after the backend's
    start, with no `session waiting message …` warn for it.
55. **An old status message (before #536) keeps its old text and its «🔄»/«⏹» until its session
    stops** (#536): a recovered entry draws only a stopped session (`mayDraw`); the final edit,
    without `reply_markup`, strips the keyboard. Until then the chat has two «⏹» — the old one and
    the waiting message's — and either stops the session; «🔄» strips its own keyboard only (answer
    5); the old progress lines stay as the old bot last drew them. At most
    `SESSION_MAX_DURATION_MS` after the deploy. Falsifiable: an old status message edited, or left
    without buttons, while its session runs.
56. **A session whose message id is not recorded gets no card after a bot restart** (#536): one
    started before #567 and never pressed, one started from the CLI, a bot restart in the 3 s
    before the first poll, a session message reported lost. No button records it any more, and
    neither «⏹» under the waiting message nor `/stop` starts tracking: no #318 card and no end line
    on its message; the summary (#464, the result and the balance) and the reply to «⏹» come all
    the same. None from before #567 is left at the deploy (#567 runs on the pilot since 2026-10-16,
    a session lasts at most an hour and its settlement). Falsifiable: a missing card of a session
    with a recorded `status_message_id`.
57. **Three Telegram calls per new cycle** (#536) instead of one — the delete, the cycle message,
    the waiting message — in the same 9 a second: the messages lag behind the trades, never drop
    (risk 27).
58. **The tracker still polls every 10 s** (#536) though the text changes only at the stop and, since
    #568, when the signal's direction turns: the poll is what sees them and the card's moment;
    saving it is out of scope.
59. **The deploy's window** (#536): the bot first, `docker compose up -d --no-deps bot` (without
    `--no-deps` Compose recreates the backend first — the architect's probe on Compose 2.40.3),
    then `binarius-deploy`; the other order would send `session:stop:<id>:w` to a bot that does
    not answer it. A session started between them gets its session message without buttons and its
    waiting message only on the new backend's first tick: the window is `binarius-deploy`'s run up
    to its `up -d --wait` (the build, a cache hit after `docker compose build` in the first step,
    the migrations, the worker swap — ready ≤ 120 s plus drain ≤ 40 s,
    [worker-deploy.md](worker-deploy.md)) plus 3 s; `/stop` works. Sessions running before the
    bot's restart keep their old buttons (risk 55). Falsifiable: a session started after the
    backend's start with no waiting message within 10 s.
60. **A recovered running session is not redrawn after a bot restart** (#536): a pair's label or an
    override of the session texts changed while the bot was down shows on its message only at the
    stop. Falsifiable: an edit of a recovered running session's message before its stop.
61. **The deploy's window of the view's contract** (#568): `signalAction` is a required field of the
    strict view schema on both sides; the bot and the backend go out in one `binarius-deploy`, and
    in the seconds between them the old process answers `ContractViolation`: a start in the window
    reads «⚠️ Исход неизвестен» (`sessionOutcomeUnknown`) and its session runs without a session
    message (risk 56); a tracker's poll is one warn and a retry. Falsifiable: `trading session
    status not read` with `contract_violation` later than a minute after the deploy.
62. **A text turned into a photo rests on the Bot API's reference** (#568): `editMessageMedia`
    replacing a text message was not observed here before the owner's probe before the merge.
    Falsifiable: `trading session message not edited` with code 400 at the stop of a session started
    before the deploy, or after a refused photo.
63. **A media edit refused by the file is repeated each poll with an upload** (#568, the class of
    risk 46): up to ~420 uploads of ~280 KB for one stuck entry until its deadline. Falsifiable:
    `trading session message not edited` with 400 for one session on consecutive polls.
64. **A transport failure of `sendPhoto` at the start is a `sendMessage` failure of before** (#568):
    thrown, the session runs without a session message (risk 56). Falsifiable: `update handler
    failed` with `sendPhoto` at a start.
65. **The first successful media edit of each direction in a process uploads the file** (#568,
    240–280 KB); the rest go by its `file_id`. An answer «message is not modified» brings no
    `file_id`, so the next edit of that direction uploads again: after a restart the uploads per
    recovery pass are not bounded by two (review round 1 m1). Falsifiable: an upload of a direction
    after a photo of it answered in the process with no refusal between.
66. **Sessions running at the deploy of #568 that had a trade get the picture at their stop** (one
    edit of the recovered entry, `mayDraw`); without a trade they stay a text. Falsifiable: a
    session started before the deploy, with a trade, that ended as a text.
67. **`HANDLER_CALLS.cycleStakeText` 4 / 1 → 4 / 2** (#568, 36 s): a refused photo after a typed
    amount sends its text; the 47 s ceiling does not grow.
68. **An old «⏹» without `:w`** (before #536, `showInPlace`) draws the text in place under the end of
    the path; a later change of its drawing is a media edit, a photo without the keyboard (the text
    edit of #536 stripped it as well). No message from before #536 is left on the pilot.
69. **A 404 on a photo of an entry that read no view** (a recovered one): its text edit is refused
    as gone and the entry ends with no «⚠️ Статус сессии недоступен.» and no report — the error
    path (rows are never deleted).
70. **A second bot process, or a restart, uploads the pictures again** (memory only), as the
    analysis card's (#482).
71. **The text after a refused photo at the start shows no direction when the two direction lines
    are overridden alike** (#568): the message is that text until the next change of its drawing,
    which draws the picture. Falsifiable: such a text still on screen after its session stopped.

72. **One storage channel for every user** (#538): Bot API allows about 20 messages a minute in
    one chat, so a burst of presses above it gets 429 and empty answers with `trading session
    promo not uploaded`. Falsifiable: that line with `telegramErrorCode: 429` more than once a day.
73. **The channel grows by a post per press** (#538): no memory of the promo card's `file_id`, so a
    press after Telegram's 300 s cache draws and posts again; a post whose answer failed is an
    orphan. The owner may clear the channel; nothing but Telegram's cache of an answered query
    relies on a post, and whether a `file_id` outlives its deleted message is not documented.
74. **A blocked sender shares the plain link** (#538): `?start=share`, no referral code is created
    for a blocked user (Rule 34).
75. **The referral code is created at the press** (#538), even if the user then closes the picker:
    harmless, the code is personal and permanent, as /invite's.
76. **A glyph outside Inter in an override of the promo card's texts** (an emoji) is dropped by
    resvg without a word (#538), as on the #318 card.
77. **The reply in place refused as gone becomes a new message** (#587): a press in the same second
    as a settlement (the sender deleting the waiting message before the stop's UPDATE), or a user
    who deleted the waiting message: the reply then may land under the summary. Falsifiable: `the
    pressed message was already gone` with a stop reply under a summary more than rarely.
78. **`/stop`'s reply and the mode screen's line are new messages** (#587, the manager's answer В5):
    no waiting message is handed over, so they may swap with the summary; the card is last either
    way. Falsifiable: a `/stop` reply under the summary — cosmetic.
79. **Message ids grow within a chat** (#587, the manager's answer В3): the newest-wins record and
    the slot `greatest(...)` rest on Telegram's `message_id` growing in the owner's private chat,
    where the bot's session message and the backend's cycle and waiting messages all go from the
    same bot token. A violation costs one refused record or one extra delete and send of the waiting
    message, never a wrong action. Falsifiable: a recorded `status_message_id` smaller than a
    message of the same session sent before it.
80. **An unknown stop outcome that did commit** (#587) leaves `unavailable` and «⏹» in place of the
    waiting message, above the summary, until the next press: it answers 409 → the final text in
    place. The route cleared the id with the stop, so the sender does not delete that message.
    Falsifiable: `trading session not stopped` for a session that stopped by the button.
81. **The orphan of a refused record and a failed clean-up delete** (#584 m3, documented, not fixed):
    the waiting message just sent stays in the chat with its «⏹» (`… not removed`); its «⏹» works,
    and the next cycle's waiting message comes under the new cycle message — one more «⏹» in the
    chat until the session ends. Falsifiable: `session waiting message not removed` above 0.1 % of
    the waiting sends.
82. **A hand-over during the sender's call** (#587 round 1). (a) The stop by «⏹» commits after the
    sender's re-read of `waiting_message_id`, while its `deleteMessage` is in flight. If the delete
    reaches Telegram first, the reply comes as a new message (risk 77). If the bot's edit gets there
    first (it comes after the route's answer, so one HTTP round trip plus one Telegram call behind
    the commit), the delete erases the drawn reply: the user sees the summary and the card, but no
    end line. Bound: the commit inside one DB read plus one Telegram call, and the bot overtaking a
    call already sent. Closing it would take a lock across the Telegram call (Rule 5) or a
    hand-over flag answered to the bot. Falsifiable: `session waiting message deleted after the
    stop took it over` more than once a week; the same line appears with two senders (risk 52),
    which the backend does not run. (b) The waiting message whose record was refused (the session
    stopped between the claim and the record by another cause): the clean-up delete follows within
    one pace (≤ 1/9 s) of the send's answer. A press of its «⏹» inside that bound gets the 409 end
    line drawn in place, and then the delete erases it; no state can tell, because the message was
    never the row's. The summary and the card come all the same. Falsifiable: a stop of a session
    through `:w` within 1 s after its `session waiting message removed: not recorded` line.
83. **A stale edit on an old status message whose «⏹» stopped a running session** (#311 п.1, the
    owner's decision 2026-10-18 in #619: documented, not fixed). `showInPlace` draws the session
    message in place of the pressed message and retargets the tracker to that same message. A read
    the old entry started before the stop can answer the running view after the handler's edit,
    and that edit lands (the one edit [The tracker](#the-tracker) → Retargeting allows): the new
    entry was created with the stopped drawing as rendered, so nothing redraws it, and the message
    shows the running session under its card. Reachable only on a session still running when a
    pre-#536 button was pressed — the first `SESSION_MAX_DURATION_MS` (1 h) after #536's deploy —
    and inside Telegram's 48-hour edit window of that message; after that every such session is
    stopped, every read answers the stopped view, and no stale edit exists. Falsifiable: a message
    sent before #536 showing «Торговая сессия запущена…» under a summary card.
84. **A session whose turn ends before any claim stays listed** (#534 m4): a summary that cannot be
    built (`session summary not built`) or a thrown statement or balance refresh (`session notices
    failed for a session`) leaves the session in the list at its `created_at`, tried every tick —
    for the thrown refresh one view read and one refresh attempt a tick. The list is oldest-first,
    200 rows a tick, so 200 such sessions would starve every newer one; nothing in the sender frees
    the slot (the hold-back is #660). Falsifiable: the same `sessionId` in one of those two `error`
    lines on consecutive ticks.
85. **The list's duplicated subqueries and the claim's growing read** (#534 m7): the numbers of
    [Rate and timing](#rate-and-timing); a tick longer than `SESSION_NOTICE_TICK_MS` makes the next
    one a no-op, never two ticks at once. Falsifiable: `EXPLAIN ANALYZE` of the list's query on the
    pilot's database over 300 ms (an owner's step; #660 holds the `MATERIALIZED` form).

## Running it locally

The bot's presses are covered by `trading-session.test.ts`, `session-tracker.test.ts`,
`demo.test.ts` and `timing.test.ts` against the real handlers; they need no services. The summary
card is drawn and rendered by `session-card.test.ts` on the host's resvg build. The routes
the bot calls are run end to end by [trading-session.md → Running it locally](trading-session.md#running-it-locally).
That a started session trades and its counters move needs #287's orchestrator in the worker.
The steps in Telegram — «🎮 Демо-торговля», «🧭 Выбрать пару вручную», a pair, 15 s, «📊 Анализ»,
«🚀 Сессия из 5 циклов» first, with or without a signal, then an amount of the amount screen
(#476; or a pair of «Сигналы сейчас» and an amount), the session message, the waiting message under
the cycle messages, «⏹ Остановить сессию» under it (#536); on a
signal, «➕ Ещё», the stake button, and the row «🚀 Сессия из 5 циклов» under the trade's result
(#360) — need a bot token of its own, which no runtime check of this issue used.

## Boundaries

- **#287** — the orchestrator that opens the session's trades ([trading-session.md](trading-session.md)).
- **#283** — the start, read and stop routes.
- **#29** — notifications; the session's trade messages and summary are #464's.
- **#450** — the martingale strategy by default ([stake.md](stake.md#defaults)): the session's
  strategy goes to `sessionTradeSteps`, the adaptive line appears on the raised steps, and the four
  limits stop the session with their own lines.
- **#297** — choosing the stake; its new start refusals join `START_REFUSALS`.
- **#360** — the button first on every `decided` analysis, and under a finished single trade;
  since **#509** on a signal only, and every door's press or start checks the pair's signal.
- **#321** — «📤 Поделиться» under the summary card ([Sharing the card](#sharing-the-card-321));
  **#538** answers it with the promo card and the sender's referral link.
- **#594** — the owner's PNG logo on the promo card in place of the drawn mark.
- **#121**, **#327** — real mode and real sessions ([trading-mode.md](trading-mode.md)); **#473**
  (shipped) extends `/stop` with the switch back to demo, **#474**'s mode screen tells the sessions
  a switch stopped.
  **#201** — levels and rewards.
