# The demo session in the bot: the button, the status, the stop and the summary card (issues #284, #320, #318)

The analysis screen ([bot-demo.md](bot-demo.md#the-analysis)) draws «🚀 Сессия из 5 сделок» as its
first row on every `decided` answer, a signal or none (#360); a finished single trade's message
draws the same button under its result (#360,
[bot-demo-trade.md](bot-demo-trade.md#the-status-message)); the launch screen of the signals list
(#320, [bot-demo.md](bot-demo.md#the-launch-screen-320)) draws «🚀 Запустить цикл», and a stopped
session's message «🔁 Ещё сессия». All four carry the same data. Pressing one starts a demo session of `DEFAULT_SESSION_TRADES` trades through
`POST /trading/sessions` ([trading-session.md](trading-session.md#routes)) and sends one status
message. The message follows the session through `GET /trading/sessions/:id` and carries
«🔄 Обновить» and «⏹ Остановить сессию». The trades themselves are opened by the worker's
orchestrator (#287): the bot only starts, reads and stops the session. When the session is over,
one picture of its trades follows the final status ([The summary card](#the-summary-card-318)).

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
  pollMs, deadlineMs, maxEntries?, now? })` → `{ track, stop, size }`, and `sessionTrackingDone`
  (`isTradingSessionFinished` of `packages/shared/src/trading-session.ts`, #337).
  `index.ts` builds one and hands it to `createBot` and to `runBot`.
- `apps/bot/src/backend-client.ts` — `startSession(request)` → `{ started }` or `{ active }`,
  `readSession(id, telegramUserId)`, `stopSession(id, telegramUserId)` ([The client](#the-client)),
  `claimSessionSummary(id, telegramUserId)` → the summary or `null` (#318).
- `apps/bot/src/session-card.ts` — `sessionCardModel`, `sessionCardSvg` and `renderSessionCard`
  (#318): the card's words and counts, its SVG, its PNG through `@resvg/resvg-js` and the fonts in
  `apps/bot/fonts/` (Inter 4.1, OFL, `OFL.txt` beside them).
- `apps/bot/src/texts.ts` — `sessionStatusText`, `pluralTrades`, `sessionStartButtonLabel` and the
  stop-reason map; the texts are the `session` group of the catalog and the two buttons
  `sessionRefreshButton`, `sessionStopButton` ([bot-texts.md](bot-texts.md)).
- `apps/bot/src/timing.ts` — `HANDLER_CALLS.sessionStart`, `.sessionRefresh`, `.sessionStop` and
  the four `SESSION_TRACK_*` constants ([Timing](#timing)).
- `packages/shared/src/bot-text-format.ts` — `formatSignedUsd`, the session's result with its sign
  (#337), next to `formatUsd`; the catalog's `profit` variable prints through it.

## Sequence

```text
demo:sess:<assetId>:<sec>          («🚀 Сессия из 5 сделок» under the analysis or a finished trade, «🚀 Запустить цикл», «🔁 Ещё сессия»)
  bot → answerCallbackQuery ∥ GET /trading/pairs (for the symbol only)
  bot → POST /trading/sessions { telegramUserId, assetId, durationSec, trades: 5 }
  bot → sendMessage: the status, with «🔄 Обновить» (session:<id>) and «⏹ Остановить сессию»
        (session:stop:<id>)
  tracker: after 3 s, then every 10 s → GET /trading/sessions/<id>?telegramUserId=<id>
           → editMessageText of that message when what it prints changes
           (a finished session whose balance predates its last trade: the backend asks the
           broker once more before it answers, #337 — trading-session.md → Routes)
session:<id>                       («🔄 Обновить»)
  bot → answerCallbackQuery ∥ GET /trading/sessions/<id> ∥ GET /trading/pairs
  bot → editMessageText in place; tracking resumes on this message, a done session's included
  tracker, once the session is done and its final status is on screen:
        POST /trading/sessions/<id>/summary { telegramUserId }   (#318, at most once)
        → sendPhoto to the status's chat: the card, its caption, «🔁 Ещё сессия» and the end of path
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
| 409 `demo_only` | the backend runs `DEMO_ONLY` and the session is real (#396; unreachable while the bot asks for demo) | «⚠️ Реальные сделки на этом сервере отключены — доступен только демо-режим.» |
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
📊 Счёт: 1 в плюс, 1 в минус · -$0.50    (from the first settled trade; «в ноль» only when tied > 0)

✅ Сделка открыта у брокера.             (the last trade's line from the demo trade's texts)
```

A finished one (#337):

```text
🎮 Демо-сессия
📈 EUR/USD OTC · ⏱ 15 с · ставка $1.00

🏁 Сессия завершена: 5 сделок — 3 в плюс, 2 в минус
💰 Результат: +$2.50
🧪 Демобаланс: $10 002.50
🕒 Баланс Binodex обновлён 1 мин назад.  (only when the balance predates the last trade)
```

- **The result** is `trades.profit` of the view: the backend's SQL sum of the settled trades'
  profit, printed by `formatSignedUsd` (`+$2.50`, `-$0.50`; a zero, truncated ones included, is
  `$0.00` with no sign). The bot adds no money (Rule 2). The live score line carries it after
  «·»; a stopped session gets it as its own line «💰 Результат: …».
- **The balance** is `balance.available` of the view in the session's mode, through `formatUsd`:
  «🧪 Демобаланс» for demo, «💵 Реальный баланс» for real (`sessionBalanceDemo`/
  `sessionBalanceReal`, the `/menu` card's words). `balance.current === false` (no observation is
  newer than the session's last settlement) adds the `/menu` card's age line `statusStale`. No
  snapshot (`balance: null`): the result alone.
- Both lines appear only once a trade settled (`settled > 0`), under every stop reason.

- **Live** (`status` is not `stopped`): the trade number is `min(settled + 1, planned)`; the last
  line is the last trade's status line when it is live, otherwise «🔎 Ждём сигнал для следующей
  сделки…».
- **Completed**: «🏁 Сессия завершена: 5 сделок — 3 в плюс, 2 в минус», then the result, the
  balance and its age line (above).
- **Stopped for another reason**: the reason's line, then «📊 Итог: …» when a trade settled, the
  result, the balance and its age line, then the last trade's line while it is live, and «⏳ Открытая сделка доиграет до конца.» only when the
  worker carries it to its end without a person (live and not `manual_review`). Under the
  `manual_review` stop a trade on manual review gets no line of its own: the stop line already says
  it and points at /support (one text for both sources, owner's decision). The backend does not
  refresh such a session's balance (it is not finished), so it shows the stored one with its age.
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
  a transport failure gets `warn` `trading session message not edited`). The session is tracked
  again on the message that shows it: after a restart this button is how tracking resumes, and a
  done session's entry sends its summary card, if it was never sent, and ends (#318). 404 → «⚠️ Статус сессии недоступен.»; any other failure → `unavailable` and `warn`
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
  (`TRADE_INTENT_TRANSITIONS[status]` is empty: settled or rejected, or no trade) —
  `isTradingSessionFinished`, the predicate the backend refreshes the balance by (#337). A stopped session
  with an open trade is followed until that trade settles, so its counts are final. A last trade
  in `manual_review` still has edges, so that entry runs to the deadline.
- **The render key** is `status|stopReason|planned|settled|won|lost|tied|profit|
  balance.available|balance.current|lastIntent.id|lastIntent.status|lastIntent.lastError`; the
  message is edited only when it changes. `balance.ageSec` is left out: it moves on every poll and
  would edit a `manual_review` session's message every 10 s to the deadline.
- Past `SESSION_TRACK_DEADLINE_MS`: one last edit, not retried — «⏳ Сессия ещё идёт — нажми
  «🔄 Обновить», чтобы увидеть ход.» under a session that is not stopped, the final status otherwise
  (a done one whose edit never landed, or a stopped one whose last trade is still on manual review).
- 404 `not_found` → «⚠️ Статус сессии недоступен.», stop. Any other read failure: `warn` once per
  entry, retried until the deadline. Gone → stop. Anything else thrown → `error` `trading session
  tracking failed`, stop.
- **The card** (#318): an entry calls it as it ends on a done view whose final edit landed — on the
  poll that sees it, or at the deadline — so once. A failed edit means no card yet; a card that
  failed is not tried again: the entry has ended ([The summary card](#the-summary-card-318)).
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
  `SESSION_TRACK_DRAIN_MS` = 2 × 5 s + 2 × 8 s = 26 s: an attempt's read and edit, then the card's
  claim and `sendPhoto` (#318).
- The chain at import adds `TRADING_SESSION_START_BUDGET_MS <= BACKEND_REQUEST_TIMEOUT_MS` (the
  link #283 left to the bot), `TRADING_SESSION_VIEW_BUDGET_MS <= BACKEND_REQUEST_TIMEOUT_MS` (the
  read and the stop wait on one balance GET for a finished session, #337), first poll < poll < deadline, `SESSION_MAX_DURATION_MS <
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
- `trading session card not sent` (#318): the claim failed (`backendStatus`, `backendReason`), the
  photo failed (`method: sendPhoto`, `telegramErrorCode`), or the render threw; with `sessionId`.
  A refused claim (409 `summary_unavailable`) logs nothing.

## The summary card (#318)

One PNG per finished session, demo and real alike, sent to the status message's chat under its
final status. Sharing it is Telegram's own forwarding; a share button is #321.

- **When.** The tracker's entry ends on a done view (stopped, the last trade settled or rejected)
  and the final status is on screen. A last trade on `manual_review` is not done, so no card: an
  operator settling it later gives one only on the user's «🔄 Обновить». A session with no settled
  trade gets none.
- **At most once.** `POST /trading/sessions/:id/summary` ([trading-session.md](trading-session.md#routes))
  sets `trading_sessions.summary_sent_at` by one CAS UPDATE and answers the card's rows; every
  other answer is 409 `summary_unavailable`, and the bot then sends nothing. Two entries of one
  session (a refresh while it is tracked, a start's 409) race the claim and one wins.
- **The numbers.** Each trade's result is its `broker_trades.profit`, the total the same SQL sum
  the status prints (`sessionProfitSumSql`, #337); the bot formats them (`formatSignedUsd`) and
  adds nothing. Win, loss and tie go by the exact decimal's sign, as the view counts them, so
  `0.001` is a win that prints `+$0.00`. The prices are `broker_trades.open_price`/`close_price`:
  the line runs through each trade's entry (a quarter into its column) and exit (three quarters),
  scaled between the lowest and the highest price, in the middle when all are equal. It is not the
  market path between them. No balance: the card is made to be forwarded, the balance stays in the
  status.
- **The layout.** 1200 × 675, dark. The pair (or «актив #N»), «СЕССИЯ ЗАВЕРШЕНА», «ИТОГ» and the
  signed total; a column per trade, «Сделка N» and its result; blue entry markers, exits green,
  red or grey; the legend; the footer «5 сделок · 3 в плюс, 2 в минус», «в ноль» only when a trade
  tied. Every word is the catalog's (`sessionCard*`), XML-escaped, and shrinks to fit its slot.
- **The caption** is `sessionCardCaption`: «🏁 {symbol}: итог сессии {profit}» and «🤖 @{botUsername}»,
  the bot's `ctx.me.username` from the press that started tracking.
- **The keyboard** is the stopped status's without «🔄 Обновить» (which edits a message's text, and
  a photo has a caption): «🔁 Ещё сессия» while the demo offers the duration, «📊 Новый анализ»,
  «📡 К сигналам», «🏠 В меню»; «🏠 В меню» alone without `settings` (`sessionCardKeyboard`).
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

## Accepted risks

1. **In-memory tracking.** A restart leaves each status at its last state until «🔄 Обновить».
2. **An old button starts a new session** once the previous one has ended (owner's decision).
3. **Poll load.** One `GET /trading/sessions/:id` per tracked session every 10 s: at most 1 000
   requests a second at 10 000 entries, ≤ 300 at the pilot's 1–3k sessions.
4. **Retargeting** can leave one more edit on the old message.
5. **A last trade in `manual_review`** keeps its entry polling to the deadline; the message then
   keeps the stopped session's final status.
6. **The age line is as of the edit that drew it** (#337): the render key leaves `ageSec` out, so
   a message showing «🕒 … N назад» keeps that N until something else changes; «🔄 Обновить»
   redraws it.
7. **A socket settlement racing the balance GET** (#337). The socket writers are on at the pilot
   (Rule 27). A `GET /v1/broker/user` the broker answered before it closed the trade, written after
   the `settle` row commits (`close_trade.success` → `settleClosedTrades`), reads `current: true`
   with the balance from before the close. The window is the GET's own latency, at most
   `BROKER_REST_TIMEOUT_MS` (5 s). That the broker sends `update_balance` when a trade closes,
   which would correct the row on its next event, is stated, not verified (observed live only at
   open, [broker-socket.md](broker-socket.md)). On the REST path the catch-up grace (10 s) is longer
   than the GET timeout, so the race cannot happen there. Falsifiable: a final status whose
   «🧪 Демобаланс» differs from `/menu` read right after, with no «🕒» line.
8. **A saved override of `sessionScore` without `{profit}`** shows the score without the sum until
   it is edited; overrides are not migrated (#337).
9. **One deploy for the backend and the bot** (#337): the view's schema is strict on both sides, so a
   bot older than the backend answers `ContractViolation` on every session read until redeployed.
10. **At most once, not exactly once** (#318, owner 2026-10-07): a crash or a lost answer between
    the claim and `sendPhoto` loses the card, and nothing retries it.
11. **Sessions that ended before #318** have no mark and get their card on their next
    «🔄 Обновить» — still one.
12. **The musl build is not loaded by `pnpm check`** (#318): CI and the host install other builds.
    Falsifiable: the owner's container command above does not print `ok`.
13. **Render cost** (#318): about 30 ms per finished session on the bot's event loop. Falsifiable:
    a render over 200 ms on the pilot.

## Running it locally

The bot's presses are covered by `trading-session.test.ts`, `session-tracker.test.ts`,
`demo.test.ts` and `timing.test.ts` against the real handlers; they need no services. The summary
card is drawn and rendered by `session-card.test.ts` on the host's resvg build. The routes
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
- **#321** — «📤 Поделиться» under the summary card, added to `sessionCardKeyboard`'s rows.
- **#121** — real mode; **#201** — levels and rewards.
