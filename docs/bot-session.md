# The demo session in the bot: the button, the status and the stop (issues #284, #320)

The analysis screen ([bot-demo.md](bot-demo.md#the-analysis)) draws «🚀 Сессия из 5 сделок» as its
first row on every `decided` answer, a signal or none (#360); a finished single trade's message
draws the same button under its result (#360,
[bot-demo-trade.md](bot-demo-trade.md#the-status-message)); the launch screen of the signals list
(#320, [bot-demo.md](bot-demo.md#the-launch-screen-320)) draws «🚀 Запустить цикл», and a stopped
session's message «🔁 Ещё сессия». All four carry the same data. Pressing one starts a demo session of `DEFAULT_SESSION_TRADES` trades through
`POST /trading/sessions` ([trading-session.md](trading-session.md#routes)) and sends one status
message. The message follows the session through `GET /trading/sessions/:id` and carries
«🔄 Обновить» and «⏹ Остановить сессию». The trades themselves are opened by the worker's
orchestrator (#287): the bot only starts, reads and stops the session.

```bash
pnpm test --project unit apps/bot/src   # needs no database or Redis
```

## Components

- `apps/bot/src/demo.ts` — the button's data `demo:sess:<assetId>:<sec>`
  (`sessionStartCallbackData`, `SESSION_START_PATTERN`, `sessionStartDataOf`), the predicate
  `sessionFits(durationSec)` = `sessionFitsDeadline(DEFAULT_SESSION_TRADES, durationSec)`, the
  button's row in the analysis keyboard, and `launchScreen`'s «🚀 Запустить цикл» (#320).
- `apps/bot/src/trading-session.ts` — `createTradingSessionComposer({ backend, logger,
  sessionTracker, connectKeyboard })`: the start, refresh and stop presses. Also
  `sessionRefreshCallbackData`, `sessionStopCallbackData`, their patterns, `sessionKeyboard`,
  `START_REFUSALS` and `sessionOutcomeUnknown`. `bot.ts` mounts it under its private-chat filter,
  right after the demo trade's composer.
- `apps/bot/src/session-tracker.ts` — `createSessionTracker({ backend, logger, firstPollMs,
  pollMs, deadlineMs, maxEntries?, now? })` → `{ track, stop, size }`, and `sessionTrackingDone`.
  `index.ts` builds one and hands it to `createBot` and to `runBot`.
- `apps/bot/src/backend-client.ts` — `startSession(request)` → `{ started }` or `{ active }`,
  `readSession(id, telegramUserId)`, `stopSession(id, telegramUserId)` ([The client](#the-client)).
- `apps/bot/src/texts.ts` — `sessionStatusText`, `pluralTrades`, `sessionStartButtonLabel` and the
  stop-reason map; the texts are the `session` group of the catalog and the two buttons
  `sessionRefreshButton`, `sessionStopButton` ([bot-texts.md](bot-texts.md)).
- `apps/bot/src/timing.ts` — `HANDLER_CALLS.sessionStart`, `.sessionRefresh`, `.sessionStop` and
  the four `SESSION_TRACK_*` constants ([Timing](#timing)).

## Sequence

```text
demo:sess:<assetId>:<sec>          («🚀 Сессия из 5 сделок» under the analysis or a finished trade, «🚀 Запустить цикл», «🔁 Ещё сессия»)
  bot → answerCallbackQuery ∥ GET /trading/pairs (for the symbol only)
  bot → POST /trading/sessions { telegramUserId, assetId, durationSec, trades: 5 }
  bot → sendMessage: the status, with «🔄 Обновить» (session:<id>) and «⏹ Остановить сессию»
        (session:stop:<id>)
  tracker: after 3 s, then every 10 s → GET /trading/sessions/<id>?telegramUserId=<id>
           → editMessageText of that message when what it prints changes
session:<id>                       («🔄 Обновить»)
  bot → answerCallbackQuery ∥ GET /trading/sessions/<id> ∥ GET /trading/pairs
  bot → editMessageText in place; tracking resumes on this message unless the session is done
session:stop:<id>                  («⏹ Остановить сессию»)
  bot → answerCallbackQuery ∥ POST /trading/sessions/<id>/stop ∥ GET /trading/pairs
        (409 session_not_active → GET /trading/sessions/<id>)
  bot → editMessageText in place
```

## The button

- On the analysis it is drawn on every `decided` answer (#360) — a signal or «сигнала нет», since
  the orchestrator asks for a signal before each trade itself — as the first row, above «➕ Ещё»;
  not on `fetch_failed` or a failed signal call, where its first trade would wait on the same
  failure, and not on a pair paying below the cycle floor (`pairPayoutAccepted`, #379; the screen
  says why, and «➕ Ещё» carries the verdict in its datum). It is drawn only where `sessionFits(durationSec)` holds: 5 × (5 + 120) s and 5 × (15 + 120) s fit the worker's hour, so
  after #313 every duration of the set has the button; the guard stays, in the keyboard and in
  `sessionStartDataOf`, so a datum that does not fit starts nothing. The label is built from `DEFAULT_SESSION_TRADES` with
  `pluralTrades`, and the request sends the same number, so the label, the check and the request
  cannot disagree.
- The session's trades do not follow this screen's direction: the orchestrator asks for a signal
  before each trade (#130 decision 2). The button sits on its own row for that reason.
- The data carries no nonce (owner's decision). After a session has ended, an old button starts a
  new one, like a fresh press. While one is active, the backend answers 409 `active_session_exists`
  with it, and the bot shows it.
- The handler checks the duration again: a forged datum or one for a duration that does not fit
  (`demo:sess:101:900`) only stops the spinner, with no backend call.
- **Two more doors (#320).** «🚀 Запустить цикл» on the launch screen carries
  `demo:sess:<assetId>:<sec>` at the duration chosen on the main path (#382), and «🔁 Ещё сессия» on a stopped session the view's own
  `settings.assetId` and `settings.durationSec`. Neither adds a handler or a datum: the start, its
  refusals and the active session's 409 are the same. A refusal's «💵 Сумма» opens the picker with
  the analysis origin (`stk:o:a:<assetId>:<sec>`), whose way back is that pair's analysis, not the
  launch screen: one datum serves every door (accepted).
- **A third door (#360).** A single trade's status message, once the trade is `accepted`, `settled`
  or `rejected`, draws «🚀 Сессия из 5 сделок» with `demo:sess:<assetId>:<sec>` of that trade, above
  the end of the path, by the tracker's edits and by «🔄 Обновить статус» (`sessionOfferOf`,
  [bot-demo-trade.md](bot-demo-trade.md#the-status-message)), and only when the pair paid at least
  the cycle floor (#379) as the catalog had it at the press or at the refresh; unknown — the read
  failed or the id is not listed — draws no offer. A press while a session runs shows the
  running one and starts none, as from any door.

## Outcomes of the start

| Answer | Source | What the bot shows |
| --- | --- | --- |
| 201 `{ session }` | created | the status message, tracked |
| 409 `active_session_exists` with a session | the account's active session: another press, or our own first attempt whose answer was lost | that session's status as a new message; tracking moves to it, and the old message keeps its «🔄 Обновить» |
| 409 `active_session_exists` with `null` | that session ended between the backend's check and its read | «⏳ Предыдущая сессия только что завершилась. Нажми кнопку ещё раз.» |
| 404 `broker_account_not_found`, 409 `account_revoked` | refusal before the side effect | `accountNone` / `accountRevoked` + the connect button |
| 409 `user_blocked`, `ambiguous_broker_account`, `account_not_confirmed`, `account_halted` | the same | the single trade's texts |
| 409 `insufficient_tokens` | the same | «🪙 Не хватает токенов: на каждую сделку сессии нужен один токен.» |
| 409 `trading_paused` | the same ([kill-switch.md](kill-switch.md)) | «⏸ Торговля временно приостановлена, попробуйте позже.» |
| 409 `session_too_long` | the same; reachable only if `sessionFits` and the backend drift apart | «⏱ Сессия на этой длительности не уложится в час.» |
| 409 `balance_unavailable` | the same (no snapshot, or a zero minimum) | «⏳ Баланс Binodex ещё не получен — попробуй через минуту.» |
| 409 `pair_unavailable` | the same | «⚠️ Пара сейчас недоступна для сессии. Открой анализ заново.» |
| 409 `payout_too_low` | the same: the pair pays less than `MIN_CYCLE_PAYOUT_PCT` (80, #379) — an old analysis message or «🔁 Ещё сессия» on a pair whose payout fell; the bot's own screens offer no session there | «🚫 Выплата по паре сейчас ниже порога — сессия на ней не запускается. Открой анализ заново.» (`sessionPayoutTooLow`) + the way back to the analysis, which, re-read, shows the note and no session button |
| 409 `stake_precision`, `stake_below_minimum`, `insufficient_demo_balance` | the same: the saved demo stake against the snapshot (#297) | the single trade's texts, without naming the minimum (this press reads no access), + «💵 Сумма» → `stk:o:a:<assetId>:<sec>` |
| 503 `catalog_unavailable` | the same: the route reads the catalog before it creates anything | `demoCatalogUnavailable`, **no retry** |
| 404 `user_not_found`, 409 `mode_not_allowed`, any code of the read and stop routes, 400 `validation`, any other 4xx | a bug, or a backend this bot does not know | `unavailable`; `warn` `trading session not started` |
| any other 5xx, no answer, a broken body (a 409 `active_session_exists` whose body is not the contract's included) | unknown: the session may have been committed | one more `startSession` with the same request. A committed first attempt answers 409 with its session; otherwise the session is created once. Still unknown → «⚠️ Не удалось узнать, запущена ли сессия…» and `warn` `trading session not started` |

`START_REFUSALS` is `satisfies Record<TradingSessionErrorCode, …>`, so a code added to the
contract fails `tsc` in `trading-session.ts`; the lookup is `Object.hasOwn`, so `__proto__` as a
reason is `unavailable`. `sessionOutcomeUnknown` is `demo-trade.ts`'s rule minus the 503
`catalog_unavailable`.

## The client

`startSession` reads the body itself through `send()`, the half of `request()` that returns
`{ ok, status, payload }`; `request()` is `send()` plus the throw on a non-2xx, so every other
method behaves as before. A 2xx is parsed with `safeParseTradingSessionResponse`. A non-2xx whose
code is `active_session_exists` is parsed with `safeParseTradingSessionRefusal` and returns
`{ active: view | null }`; a body that fails it is `ContractViolation` (status kept). Every other
non-2xx is `BackendError(http_status, { status, reason })`. Nothing of the body but the parsed view
and the error code leaves the client. `readSession` and `stopSession` go through `request()`, the
id `encodeURIComponent`-ed into its segment; both are scoped by the owner, so another user's id is
the same 404 `not_found`.

## The status message

`sessionStatusText(symbol, view, { deadline? })`:

```text
🎮 Демо-сессия
📈 EUR/USD OTC · ⏱ 15 с · ставка $1.00
🔢 Сделка 3 из 5
📊 Счёт: 1 в плюс, 1 в минус             (from the first settled trade; «в ноль» only when tied > 0)

✅ Сделка открыта у брокера.             (the last trade's line from the demo trade's texts)
```

- **Live** (`status` is not `stopped`): the trade number is `min(settled + 1, planned)`; the last
  line is the last trade's status line when it is live, otherwise «🔎 Ждём сигнал для следующей
  сделки…».
- **Completed**: «🏁 Сессия завершена: 5 сделок — 3 в плюс, 2 в минус».
- **Stopped for another reason**: the reason's line, then «📊 Итог: …» when a trade settled, then
  the last trade's line while it is live, and «⏳ Открытая сделка доиграет до конца.» only when the
  worker carries it to its end without a person (live and not `manual_review`). Under the
  `manual_review` stop a trade on manual review gets no line of its own: the stop line already says
  it and points at /support (one text for both sources, owner's decision).
- **The deadline hint** («⏳ Сессия ещё идёт…») goes only under a session that is not stopped; a
  stopped one gets its plain final status.
- **`settings: null`** (a hand-written row): the header and «⚠️ Настройки сессии не прочитаны —
  напиши в поддержку: /support».
- The symbol is capped at 64 characters; without a catalog «актив #<id>» stands in. The stake is
  `settings.stake.baseStake` through `formatUsd`, never a number.

| Stop reason | Line |
| --- | --- |
| `manual_review` (a trade or the account on manual review) | 🛠 Сессия остановлена: нужна ручная проверка — напиши в поддержку: /support |
| `rejected_twice` | ❌ Сессия остановлена: две сделки подряд не открылись. |
| `timeout` | ⏱ Сессия остановлена: истёк час на сессию. |
| `stake_stop` | ⚠️ Сессия остановлена: ставку не удалось подобрать — проверь демобаланс в /account. |
| `account_unavailable` | ⚠️ Сессия остановлена: новую сделку открыть нельзя — проверь токены и аккаунт в /account. |
| `pair_unavailable` | ⚠️ Сессия остановлена: пара закрылась или не принимает эту длительность. |
| `balance_unavailable` | ⚠️ Сессия остановлена: баланс Binodex не получен. |
| `invalid_settings` | ⚠️ Сессия остановлена из-за ошибки настроек — напиши в поддержку: /support |
| `user_stopped` | ⏹ Сессия остановлена по твоей команде. |
| `kill_switch` | the single trade's `tradingPaused`: ⏸ Торговля временно приостановлена, попробуйте позже. |

The map is `satisfies Record<Exclude<TradingSessionStopReason, 'completed'>, …>`.

**Keyboards.** A live session: [«🔄 Обновить»][«⏹ Остановить сессию»]. A stopped one: «🔄 Обновить»,
because its last trade can still settle, and under it «🔁 Ещё сессия» (#320) on the same pair and
duration — drawn only when the view has `settings` and its duration is one the demo still offers
(`durationOf`), so a session of before #313 gets none — then the end of the path (#350,
([bot-navigation.md](bot-navigation.md))): «📊 Новый анализ» on the same pair and duration (when the demo still offers
it), «📡 К сигналам», «🏠 В меню»; without `settings` only «🏠 В меню». The tracker's edits redraw
the keyboard from the view they show, so the stop button goes away and the rest appears when the
session stops. A failed start, `sessionJustEnded`, leads back to the analysis and the menu; a failed
refresh or stop offers the refresh and the menu, never the stop again.

## The refresh and the stop

- **Refresh** reads the session and edits it in place («not modified» is done; gone sends it anew;
  a transport failure gets `warn` `trading session message not edited`). A session that is not done
  is tracked again on the message that shows it: after a restart this button is how tracking
  resumes. 404 → «⚠️ Статус сессии недоступен.»; any other failure → `unavailable` and `warn`
  `trading session status not read`.
- **Stop** stops at once, with no confirmation (owner's decision); the reply is the stopped view in
  place, with «⏳ Открытая сделка доиграет до конца.» while its trade is open and not on manual
  review. 409 `session_not_active` reads the session and shows how it ended. 404 → «⚠️ Статус
  сессии недоступен.»; any other failure → `unavailable` and `warn` `trading session not stopped`.
  It is not retried: the refresh button shows the truth, and a second stop is harmless.

## The tracker

One entry per session id, in process memory, like the intent tracker
([bot-demo-trade.md](bot-demo-trade.md#the-tracker)), with these differences:

- **Retargeting.** `track()` of an id already tracked replaces its entry: the next change is drawn
  on the new message, and the old message is not edited again. A read in flight when the session
  moves draws nothing on the old message, a 404 included, and during `stop()` too; only an edit
  already sent can still land there, so at most one more edit. The deadline
  keeps counting from the first `track()`.
- **Done** is `status === stopped` and the last trade can no longer move
  (`TRADE_INTENT_TRANSITIONS[status]` is empty: settled or rejected, or no trade). A stopped session
  with an open trade is followed until that trade settles, so its counts are final. A last trade
  in `manual_review` still has edges, so that entry runs to the deadline.
- **The render key** is `status|stopReason|planned|settled|won|lost|tied|lastIntent.id|
  lastIntent.status|lastIntent.lastError`; the message is edited only when it changes.
- Past `SESSION_TRACK_DEADLINE_MS`: one last edit, not retried — «⏳ Сессия ещё идёт — нажми
  «🔄 Обновить», чтобы увидеть ход.» under a session that is not stopped, the final status otherwise
  (a done one whose edit never landed, or a stopped one whose last trade is still on manual review).
- 404 `not_found` → «⚠️ Статус сессии недоступен.», stop. Any other read failure: `warn` once per
  entry, retried until the deadline. Gone → stop. Anything else thrown → `error` `trading session
  tracking failed`, stop.
- `SESSION_TRACKER_MAX_ENTRIES` (10 000): the oldest entry goes first. `stop()` clears every timer,
  refuses new entries and waits for every attempt in flight; `runBot` drains it as its
  `session tracker` step.

## Timing

- `HANDLER_CALLS.sessionStart` = 3 backend calls and 2 Bot API calls: the catalog read beside the
  answer (counted as sequential, as in `confirm`), `startSession` and its retry, the message: 31 s.
- `HANDLER_CALLS.sessionRefresh` = 2 / 3: the edit refused as gone, then sent anew: 34 s.
- `HANDLER_CALLS.sessionStop` = 3 / 3: `stopSession`, the read after a 409, the edit refused as
  gone and sent anew: 39 s.
- All stay below the longest path (`confirm`, 45 s; `demoAnalysis` is 42 s since #360 —
  [bot-demo-trade.md](bot-demo-trade.md#timing)), so `HANDLER_BUDGET_MS` and the shutdown
  budget do not move. `timing.test.ts` runs every terminal branch of the three.
- `SESSION_TRACK_FIRST_POLL_MS` = 3 s, `SESSION_TRACK_POLL_MS` = 10 s (a trade's open-to-settle
  cycle is at least the worker's catch-up grace, 10 s), `SESSION_TRACK_DEADLINE_MS` = `SESSION_MAX_DURATION_MS` + 10 min,
  `SESSION_TRACK_DRAIN_MS` = 5 s + 8 s.
- The chain at import adds `TRADING_SESSION_START_BUDGET_MS <= BACKEND_REQUEST_TIMEOUT_MS` (the
  link #283 left to the bot), first poll < poll < deadline, `SESSION_MAX_DURATION_MS <
  SESSION_TRACK_DEADLINE_MS` (imported, so checked) and drain < `SHUTDOWN_BUDGET_MS`.

## Logs

Each line carries `err` with the error's name and code, plus `backendStatus` and `backendReason`,
or the method and the Telegram code; the tracker's lines add `sessionId`. None carries the Telegram
id or the symbol.

- `trading session not started`
- `trading session status not read`
- `trading session not stopped`
- `trading session message not edited`
- `trading session tracking failed` (`error`)

## Accepted risks

1. **In-memory tracking.** A restart leaves each status at its last state until «🔄 Обновить».
2. **An old button starts a new session** once the previous one has ended (owner's decision).
3. **Poll load.** One `GET /trading/sessions/:id` per tracked session every 10 s: at most 1 000
   requests a second at 10 000 entries, ≤ 300 at the pilot's 1–3k sessions.
4. **Retargeting** can leave one more edit on the old message.
5. **A last trade in `manual_review`** keeps its entry polling to the deadline; the message then
   keeps the stopped session's final status.
6. **No profit sum**, only won/lost/tied counts: the view has no sum (#283).

## Running it locally

The bot's presses are covered by `trading-session.test.ts`, `session-tracker.test.ts`,
`demo.test.ts` and `timing.test.ts` against the real handlers; they need no services. The routes
the bot calls are run end to end by [trading-session.md → Running it locally](trading-session.md#running-it-locally).
That a started session trades and its counters move needs #287's orchestrator in the worker.
The steps in Telegram — «🎮 Демо-торговля», «🧭 Выбрать пару вручную», a pair, 15 s, «📊 Анализ»,
«🚀 Сессия из 5 сделок» first, with or without a signal (or a pair of «Сигналы сейчас» and
«🚀 Запустить цикл»), the status moving, «⏹ Остановить сессию»; on a signal, «➕ Ещё», the stake
button, and the row «🚀 Сессия из 5 сделок» under the trade's result (#360) — need a bot token of
its own, which no runtime check of this issue used.

## Boundaries

- **#287** — the orchestrator that opens the session's trades ([trading-session.md](trading-session.md)).
- **#283** — the start, read and stop routes.
- **#29** — a notification for each trade of the session; this message is only edited.
- **#297** — choosing the stake; its new start refusals join `START_REFUSALS`.
- **#360** — the button first on every `decided` analysis, and under a finished single trade.
- **#121** — real mode; **#201** — levels and rewards.
