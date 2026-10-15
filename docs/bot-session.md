# The session in the bot: the button, the status, the stop, the trade messages and the summary card (issues #284, #320, #318, #122, #321, #327, #418, #464, #476)

The analysis screen ([bot-demo.md](bot-demo.md#the-analysis)) draws «🚀 Сессия из 5 сделок» as its
first row on a signal (#360; since #509 never on «сигнала нет»); a finished single trade's message
draws the same button under its result (#360,
[bot-demo-trade.md](bot-demo-trade.md#the-status-message)); the launch screen of the signals list
in real mode (#320, #327, [bot-demo.md](bot-demo.md#the-launch-screen-in-real-mode-327)) draws
«🚀 Запустить цикл · REAL», and a stopped session's message «🔁 Ещё сессия». In real mode all four
carry the session button's data (#327); the launch screen's adds the token `:l` (#418), by which the
start deletes that screen once the session's status is sent
([The launch screen after the start](#the-launch-screen-after-the-start-418)). In demo (#476) the
same four doors open the amount screen ([bot-demo.md](bot-demo.md#the-amount-screen-476)), whose
amount saves the demo stake and then starts the session through the same path, and whose screen is
deleted the same way. Old demo buttons sent before #476 carry the session button's data and still
start at once.
Pressing a session button, or an amount, starts a session of that mode — demo, or real for a user in
real mode ([trading-mode.md](trading-mode.md)) — of `DEFAULT_SESSION_TRADES` trades through
`POST /trading/sessions` ([trading-session.md](trading-session.md#routes)) and sends one status
message. The message follows the session through `GET /trading/sessions/:id` and carries
«🔄 Обновить» and «⏹ Остановить сессию». The trades themselves are opened by the worker's
orchestrator (#287): the bot only starts, reads and stops the session. Every settled trade then
comes as its own new message without sound, and the finished session's summary with sound — both
sent by the backend ([Trade messages and the summary](#trade-messages-and-the-summary-464)). When
the session is over, one picture of its trades follows the summary
([The summary card](#the-summary-card-318)), and
«📤 Поделиться» under it sends that picture into a chat the user picks
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
  `sessionFits(durationSec)` = `sessionFitsDeadline(DEFAULT_SESSION_TRADES, durationSec)`, the
  button's row in the analysis keyboard (in demo `demo:l:<assetId>:<sec>:a`, #476), and
  `launchScreen`'s «🚀 Запустить цикл · REAL» (#320, #327).
- `apps/bot/src/trading-session.ts` — `createTradingSessionComposer({ backend, logger,
  sessionTracker, connectKeyboard })` returns `{ composer, startSession }`: the start, refresh and
  stop presses and the command `/stop` (#122); `startSession(ctx, data, catalog, { retryUnknown,
  removeScreen })` is the one start path, which the amount screen's presses use too
  (`cycle-stake.ts`, #476). Also
  `sessionRefreshCallbackData`, `sessionStopCallbackData`, their patterns, `sessionKeyboard`,
  `START_REFUSALS` and `sessionOutcomeUnknown`. `bot.ts` mounts it under its private-chat filter,
  right after the demo trade's composer.
- `apps/bot/src/session-tracker.ts` — `createSessionTracker({ backend, logger, firstPollMs,
  pollMs, deadlineMs, maxEntries?, now? })` → `{ track, stop, size }`, and `sessionTrackingDone`
  (`isTradingSessionFinished` of `packages/shared/src/trading-session.ts`, #337).
  `index.ts` builds one and hands it to `createBot` and to `runBot`.
- `apps/bot/src/backend-client.ts` — `startSession(request)` → `{ started }` or `{ active }`,
  `readSession(id, telegramUserId)`, `stopSession(id, telegramUserId)`, `stopSessions(telegramUserId)`
  (#122, `POST /trading/sessions/stop`) ([The client](#the-client)),
  `claimSessionSummary(id, telegramUserId)` → the summary or `null` (#318).
- `apps/bot/src/session-share.ts` (#321) — `shareQuery`, `SHARE_PATTERN`, `INLINE_QUERY_LIMIT`,
  `shareButton`, `attachShareButton` (the card's edit after the send) and
  `createSessionShareComposer({ backend, logger })`: the inline query and the chosen result.
  `bot.ts` mounts it on the bot itself, not under the private-chat filter: inline updates carry
  no chat.
- `apps/bot/src/session-card.ts` — `sessionCardModel`, `sessionCardSvg` and `renderSessionCard`
  (#318): the card's words and counts, its SVG, its PNG through `@resvg/resvg-js` and the fonts in
  `apps/bot/fonts/` (Inter 4.1, OFL, `OFL.txt` beside them).
- `apps/bot/src/texts.ts` — `sessionStatusText`, `sessionStartButtonLabel` and `sessionTexts`, the
  shared session words over the bot's catalog; the texts are the `session` group of the catalog and
  the two buttons `sessionRefreshButton`, `sessionStopButton` ([bot-texts.md](bot-texts.md)).
- `packages/shared/src/session-texts.ts` (#464) — `createSessionTexts({ html, plain })`: the
  plural, the score, the result, the asset label, the stop-reason map (`SESSION_STOP_LINES`), the
  stopped session's closing lines (`sessionClosingLines`), and the trade message and summary
  builders. The bot's status message and the backend's notices print through it, each with its own
  catalog object, so the summary's lines are the status message's own
  (`apps/bot/src/session-summary-parity.test.ts` holds them equal).
- `packages/shared/src/session-steps.ts` (#464) — `sessionTradeSteps(results, strategy)`: each
  settled trade's cycle and step.
- `apps/backend/src/trading/session-notices.ts`, `session-notice-messages.ts`, `session-view.ts`
  and `packages/db/src/session-notice-ops.ts` (#464) — the sender of the trade messages and the
  summary ([Trade messages and the summary](#trade-messages-and-the-summary-464)).
- `apps/bot/src/timing.ts` — `HANDLER_CALLS.sessionStart`, `.sessionRefresh`, `.sessionStop`, `.stop`,
  `.sessionShare`, `.sessionShared` (#321) and
  the four `SESSION_TRACK_*` constants ([Timing](#timing)).
- `packages/shared/src/bot-text-format.ts` — `formatSignedUsd`, the session's result with its sign
  (#337), next to `formatUsd`; the catalog's `profit` variable prints through it.

## Sequence

```text
<mode>:sess:<assetId>:<sec>[:l]    (in real «🚀 Сессия из 5 сделок · REAL» under the analysis or a finished trade, «🚀 Запустить цикл · REAL» with :l (#418), «🔁 Ещё сессия · REAL», #327; demo buttons sent before #476; the longest, real:sess:2147483647:15:l, 25 bytes)
  bot → answerCallbackQuery ∥ GET /trading/pairs (for the symbol only)
  bot → POST /trading/sessions { telegramUserId, assetId, durationSec, trades: 5 }
  bot → sendMessage: the status, with «🔄 Обновить» (session:<id>) and «⏹ Остановить сессию»
        (session:stop:<id>)
  bot → deleteMessage of the pressed launch screen when the datum carries :l; refused as can't be
        deleted → editMessageReplyMarkup without a keyboard (#418)
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
        → editMessageReplyMarkup of the card: «📤 Поделиться» on top of those rows (#321)
inline query share:<sessionId>:<fileId>   («📤 Поделиться» → a chat picked, #321)
  bot → GET /trading/sessions/<id>?telegramUserId=<from.id> ∥ GET /trading/pairs
  bot → answerInlineQuery: the cached card with its caption for the owner's finished session;
        an empty answer for everything else
chosen_inline_result               (the user tapped the result, /setinlinefeedback)
  bot → one info line, no call
session:stop:<id>                  («⏹ Остановить сессию»)
  bot → answerCallbackQuery ∥ POST /trading/sessions/<id>/stop ∥ GET /trading/pairs
        (409 session_not_active → GET /trading/sessions/<id>)
  bot → editMessageText in place
```

## The button

- On the analysis it is drawn on a signal only (#360, #509: before #509 «сигнала нет» drew it too,
  and the session waited for a signal itself; the owner wants no session on a pair without one) —
  as the first row, above «➕ Ещё»; not on «сигнала нет», `fetch_failed` or a failed signal call,
  and not on a pair paying below the cycle floor (`pairPayoutAccepted`, #379; the screen
  says why, and «➕ Ещё» carries the verdict in its datum). It is drawn only where `sessionFits(durationSec)` holds: 5 × (5 + 120) s and 5 × (15 + 120) s fit the worker's hour, so
  after #313 every duration of the set has the button; the guard stays, in the keyboard and in
  `sessionStartDataOf`, so a datum that does not fit starts nothing. The label is built from `DEFAULT_SESSION_TRADES` with
  `pluralTrades`, and the request sends the same number, so the label, the check and the request
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
  same, and once the status is sent the start deletes the launch screen. A refusal's «💵 Сумма» opens the
  picker of the press's mode with the analysis origin (`stk:o:<d|r>:a:<assetId>:<sec>`, #327),
  whose way back is that pair's analysis, not the launch screen: one handler serves every door
  (accepted).
- **A third door (#360).** A single trade's status message, once the trade is `accepted`, `settled`
  or `rejected`, draws «🚀 Сессия из 5 сделок» with `real:sess:<assetId>:<sec>` of a real trade
  (#327) or `demo:l:<assetId>:<sec>:n` of a demo one (the amount screen, #476), above
  the end of the path, by the tracker's edits and by «🔄 Обновить статус» (`sessionOfferOf`,
  [bot-demo-trade.md](bot-demo-trade.md#the-status-message)), and only when the pair paid at least
  the cycle floor (#379) as the catalog had it at the press or at the refresh; unknown — the read
  failed or the id is not listed — draws no offer. A press while a session runs shows the
  running one and starts none, as from any door.

## Outcomes of the start

| Answer | Source | What the bot shows |
| --- | --- | --- |
| 201 `{ session }` | created | the status message, tracked; a launch screen (`:l`) is deleted after it (#418) |
| 409 `active_session_exists` with a session | the account's active session: another press, or our own first attempt whose answer was lost | that session's status as a new message; tracking moves to it, and the old message keeps its «🔄 Обновить»; a launch screen (`:l`) is deleted after it (#418) |
| 409 `active_session_exists` with `null` | that session ended between the backend's check and its read | «⏳ Предыдущая сессия только что завершилась. Нажми кнопку ещё раз.» |
| 404 `broker_account_not_found`, 409 `account_revoked` | refusal before the side effect | `accountNone` / `accountRevoked` + the connect button |
| 409 `user_blocked`, `ambiguous_broker_account`, `account_not_confirmed`, `account_halted` | the same | the single trade's texts |
| 409 `insufficient_tokens` | the same | «🪙 Не хватает токенов: на каждую сделку сессии нужен один токен.»; «⭐ Купить токены» (#117, [stars.md](stars.md)), then «💳 Пополнить» (#27, [deposit.md](deposit.md), https only) above the way back |
| 409 `trading_paused` | the same ([kill-switch.md](kill-switch.md)) | «⏸ Торговля временно приостановлена, попробуйте позже.» |
| 409 `demo_only` | the backend runs `DEMO_ONLY` and the session is real (#396): a real door pressed by a user left in real mode; the bot does not know the flag | «⚠️ Реальные сделки на этом сервере отключены — доступен только демо-режим.» |
| 409 `session_too_long` | the same; reachable only if `sessionFits` and the backend drift apart | «⏱ Сессия на этой длительности не уложится в час.» |
| 409 `balance_unavailable` | the same (no snapshot, or a zero minimum) | «⏳ Баланс Binodex ещё не получен — попробуй через минуту.» |
| 409 `pair_unavailable` | the same | «⚠️ Пара сейчас недоступна для сессии. Открой анализ заново.» |
| 409 `payout_too_low` | the same: the pair pays less than `MIN_CYCLE_PAYOUT_PCT` (80, #379) — an old analysis message or «🔁 Ещё сессия» on a pair whose payout fell; the bot's own screens offer no session there | «🚫 Выплата по паре сейчас ниже порога — сессия на ней не запускается. Открой анализ заново.» (`sessionPayoutTooLow`) + the way back to the analysis, which, re-read, shows the note and no session button |
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
so its start deletes it the same way (`removeScreen: true`). Only when the session's status was
sent — 201 and 409 with a session — does the start delete that message, and only after the status
was sent and tracked, so a slow or refused delete never withholds it (`removeLaunchScreen`,
`trading-session.ts`). A refusal, «⏳ Предыдущая сессия только что завершилась…» and an unknown
outcome send no status, and the screen stays with its buttons: on the launch screen «🚀 Запустить
цикл» is the retry and «💵 Изменить ставку» the fix, on the amount screen the amounts and «✏️ Своя
сумма». A typed amount is a text: there is no screen to delete, the prompt stays. The analysis, the
row under a finished trade and «🔁 Ещё сессия» keep their messages (owner's decision 2026-10-10):
their session buttons in real carry the plain datum, their demo doors open the amount screen in
place of the analysis or as a new message.

| `deleteMessage` | Class (`deleteRefusal`, `screen.ts`) | Then | Log |
| --- | --- | --- | --- |
| `true` | deleted | — | — |
| 400 «message to delete not found» (the user or an earlier press deleted it) | `gone` | nothing | `info` `the launch screen was already gone` |
| 400 «message can't be deleted» / «Message can't be deleted [for everyone]» (older than 48 h, or otherwise forbidden; compared by their common «can't be deleted») | `forbidden` | `editMessageReplyMarkup()` — the keyboard goes, the text stays | the strip's own failure → `warn` `the launch screen keyboard was not removed` |
| any other Telegram refusal (429, 403, 400 «chat not found», …) | unknown | nothing | `warn` `the launch screen was not deleted` |
| a transport failure (`HttpError`) | unknown | nothing | the same `warn` |
| anything else thrown | a bug | rethrown to `bot.catch` | — |

- A second press before the first delete landed: 409 → the status anew, tracking moves, and the
  second delete finds the message gone → `info`.
- A launch screen drawn before #418 carries no token: pressed, it starts the session and stays.
- A token on a duration the demo no longer offers (`demo:sess:101:120:l`) lands in the legacy
  handler, as the plain datum does: the keyboard goes, nothing is sent.
- A real launch screen pressed after the user went demo, or on a `DEMO_ONLY` backend, is refused
  (`mode_not_allowed`, `demo_only`): no status, the screen stays.
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
the same 404 `not_found`.

## The status message

`sessionStatusText(symbol, view, { deadline? })`; the header is «💼 Реальная сессия»
(`sessionHeaderReal`) for a real session, «🎮 Демо-сессия» for a demo one, settings unavailable
included (#327):

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
  profit, printed by `formatSignedUsd` with every fraction digit it has, at least two (`+$2.50`,
  `-$0.50`, `-$1.7515`: the live broker pays `S × p / 100` unrounded, so a sum can carry more digits
  than cents, and cutting them would show a loss smaller than it is, #450); a zero is `$0.00` with
  no sign. The bot adds no money (Rule 2). The live score line carries it after
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
- The pair's label ([`pairLabel`](pairs-catalog.md#the-pairs-label-428), #428): the symbol capped
  at 64 characters, « OTC» by `isOtc`; without a catalog «актив #<id>» stands in. The stake is
  `settings.stake.baseStake` through `formatUsd`, never a number.

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
| `no_signal_timeout` (#509) | ⏳ Сессия остановлена: 2 мин по паре не было сигнала. Выбери другую пару. (`sessionStopNoSignalTimeout`, the minutes from `SESSION_NO_SIGNAL_TIMEOUT_MS`) |

The map is `satisfies Record<Exclude<TradingSessionStopReason, 'completed' | 'no_signal_timeout'>, …>`;
`no_signal_timeout`'s line carries a variable, so `sessionClosingLines` builds it beside the map.

**Keyboards.** A live session: [«🔄 Обновить»][«⏹ Остановить сессию»]. A stopped one: «🔄 Обновить»,
because its last trade can still settle, and under it «🔁 Ещё сессия» (#320) on the same pair and
duration — drawn only when the view has `settings` and its duration is one the demo still offers
(`durationOf`), so a session of before #313 gets none — then the end of the path (#350,
([bot-navigation.md](bot-navigation.md))): «📊 Новый анализ» on the same pair and duration (when the demo still offers
it), «📡 К сигналам», «💳 Пополнить» (#27, [deposit.md](deposit.md), only when `WEB_PUBLIC_URL` is
https), «👥 Пригласить друга» (#115, [referrals.md](referrals.md)), «🏠 В меню»; without `settings`
only «💳 Пополнить», «👥 Пригласить друга» and «🏠 В меню». A session stopped by the no-signal limit
(`no_signal_timeout`, #509) offers another pair, not the same one again: no «🔁 Ещё сессия» and no
«📊 Новый анализ», and «🔀 Выбрать другую пару» in place of «📡 К сигналам», on the same data
(`demo:sig:<sec>`; `appendEndOfPath(…, { otherPair: true })`). The tracker's edits redraw
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

## /stop (#122)

`/stop` (in the command menu and `/help`, after `/menu`) stops every active session of the user in
one request, `POST /trading/sessions/stop`
([trading-session.md](trading-session.md#post-tradingsessionsstop-122)), with no confirmation and
no retry, as the stop button. `readPairs` runs beside it for the symbol only; its failure names the
asset by its id. One message answers, always with a keyboard (Rule 31):

| The route answered | The message | Keyboard | Tracking |
|---|---|---|---|
| no session (`[]`) | «Активных сессий нет.» (`sessionNoneActive`) | «🏠 В меню» | — |
| one session | its status, «⏳ Открытая сделка доиграет до конца.» while its trade is open | the session's (`sessionKeyboard`) | `track()` on the new message, as after the stop button: a finished session too, for its summary card |
| two or more | «⏹ Остановлено сессий: N. Открытые сделки доиграют до конца.» (`sessionsStopped`) | «🏠 В меню» | — |
| any failure (`Unreachable`, non-2xx, `ContractViolation`) | `unavailable`, `warn` `trading sessions not stopped` | «🏠 В меню», no «🔄 Повторить» — `/stop` is a write | — |

- **Nothing is closed at the broker.** The route writes only `trading_sessions`; an open trade plays
  out on its own path and its session's message says so. The one broker call the route can make is
  the balance GET of a finished session (#337), a read.
- **The summary card of #318** comes through the same `track()`, as after the stop button; `/stop`
  has no code of its own for it, and the two-or-more answer tracks nothing.
- **In the email dialog** `/stop` answers and leaves the step as it was, as `/help`; in groups it is
  ignored. `/stop@bot` and a trailing text are the command (grammY `command()`).
- **Two or more** active sessions are not reachable from the bot (one account per start, and two
  active accounts refuse the start as `ambiguous_broker_account`); the internal API and the CLI can
  make them.

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
- **The card** (#318): an entry calls it as it ends on a done view whose final edit landed and
  whose `noticesDone` is set (the backend's summary message went out, #464) — on the poll that sees
  it, or at the deadline — so once. A done view without `noticesDone` is polled on with no edit
  (the render key leaves the flag out), and at the deadline it gets its final edit and no card. A
  failed edit means no card yet; a card that failed is not tried again: the entry has ended
  ([The summary card](#the-summary-card-318)).
- `SESSION_TRACKER_MAX_ENTRIES` (10 000): the oldest entry goes first. `stop()` clears every timer,
  refuses new entries and waits for every attempt in flight; `runBot` drains it as its
  `session tracker` step.

## Timing

- `HANDLER_CALLS.sessionStart` = 3 backend calls and 4 Bot API calls: the catalog read beside the
  answer (counted as sequential, as in `confirm`), `startSession` and its retry, the status, then
  the launch screen's `deleteMessage` refused as forbidden and `editMessageReplyMarkup` (#418):
  47 s, equal to `demoAnalysis`.
- `HANDLER_CALLS.cycleStakePreset` = 3 / 4 (#476): `setStake` and the catalog read beside the
  answer (counted as sequential), `startSession` in one attempt — its retry would make it 4 / 4 =
  52 s, past the shutdown budget — the status, then the amount screen's `deleteMessage` refused as
  forbidden and `editMessageReplyMarkup`: 47 s. `HANDLER_CALLS.cycleStakeText` = 4 / 1: `setStake`
  beside the catalog read, `startSession` and its retry, the status: 28 s.
  `HANDLER_CALLS.cycleStakeCustom` = 0 / 3: the prompt's edit refused as gone and sent anew.
- `HANDLER_CALLS.sessionRefresh` = 2 / 3: the edit refused as gone, then sent anew: 34 s.
- `HANDLER_CALLS.sessionStop` = 3 / 3: `stopSession`, the read after a 409, the edit refused as
  gone and sent anew: 39 s.
- `HANDLER_CALLS.stop` = 2 / 1 (#122): `stopSessions` beside `readPairs` (counted as sequential),
  then the message: 18 s.
- `HANDLER_CALLS.sessionShare` = 2 / 1 (#321): `readSession` beside `readPairs` (counted as
  sequential), then `answerInlineQuery`: 18 s. `HANDLER_CALLS.sessionShared` = 0 / 0: a log line.
- All stay at or below the longest path (`demoAnalysis` and, since #418, `sessionStart`, 47 s —
  [bot-demo-trade.md](bot-demo-trade.md#timing)), inside the shutdown budget. `timing.test.ts` runs every terminal branch of the nine.
- `SESSION_TRACK_FIRST_POLL_MS` = 3 s, `SESSION_TRACK_POLL_MS` = 10 s (a trade's open-to-settle
  cycle is at least the worker's catch-up grace, 10 s), `SESSION_TRACK_DEADLINE_MS` = `SESSION_MAX_DURATION_MS` + 10 min,
  `SESSION_TRACK_DRAIN_MS` = 2 × 5 s + 3 × 8 s = 34 s: an attempt's read and edit, then the card's
  claim and `sendPhoto` (#318) and the `editMessageReplyMarkup` that adds «📤 Поделиться» (#321).
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
- `trading sessions not stopped` (`/stop`, #122)
- `trading session message not edited`
- `the launch screen was not deleted` (#418): the delete refused other than gone or forbidden, or
  failed in transport (`method: deleteMessage`, `telegramErrorCode` or `transportError`, `updateId`)
- `the launch screen keyboard was not removed` (#418): the strip after a forbidden delete failed
  (`method: editMessageReplyMarkup`, `updateId`)
- `the launch screen was already gone` (#418, `info`): the delete found no message
- `trading session tracking failed` (`error`)
- `trading session card not sent` (#318): the claim failed (`backendStatus`, `backendReason`), the
  photo failed (`method: sendPhoto`, `telegramErrorCode`), or the render threw; with `sessionId`.
  A refused claim (409 `summary_unavailable`) logs nothing.
- `trading session share button not attached` (#321): the card is sent but has no «📤 Поделиться»:
  `reason: no_file_id` (the send's result named no size), `reason: query_too_long` (the query would
  pass 256 characters), or the edit failed (`method: editMessageReplyMarkup`, `telegramErrorCode`);
  with `sessionId`.
- `trading session not shared` (#321): the inline handler's read failed other than 404
  (`backendStatus`, `backendReason`, `sessionId`). A 404 — another user's or a missing session —
  logs nothing.
- `inline query not answered` (#321): `answerInlineQuery` failed (`method`, `telegramErrorCode`,
  `sessionId` when the query named one); a forged file id ends here, refused by Telegram.
- `trading session card shared` (#321, `info`): a chosen result, `sessionId` = its `result_id`.
  Neither the query nor the file id is logged.

## Trade messages and the summary (#464)

Every settled trade of a session comes as a new message, **without sound**
(`disable_notification: true`) and without buttons, in the trades' order; once the session is
finished, one summary message comes **with sound**. The status message with «🔄 Обновить» and
«⏹ Остановить сессию» stays as it was. The backend sends both, not the bot: a restart of either,
and any number of «🔄 Обновить» presses, sends nothing twice and skips nothing but what the
endings below lose.

```text
⚡ Цикл 3 Шаг 1
🟢 Ставка: $11.50 → +$22.08          (in a code block: Telegram shows it with «copy»)
📊 Цена: 0.49803 → 0.49820
```

- **The figures** (the owner's sample, manager's decision 3b): a win 🟢 `stake → +payout` (stake
  plus profit), a loss 🔴 `stake → -loss` (the broker trade's profit, `-$5.00` for a full loss), a
  tie ⚪ `stake → +stake, ставка вернулась`. The stake is the intent's amount, printed by
  `formatStake` (every fraction digit, at least two); the figure after «→» is one SQL `numeric`
  column of the claim (`case` on the profit's sign, Rule 2) printed by `formatSignedStake`; the
  class is the same SQL `case` the view's counters use, so `0.001` is a win. The lines need not add
  up to the summary's «💰 Результат»: a win's line is its payout, the result is the profits' sum.
- **The prices** are `broker_trades.open_price` → `close_price`, `formatPrice` with the pair's
  `digits` from the backend's pairs catalog; with no catalog or the pair gone, as the double prints
  (`String()`).
- **Cycle and step** follow the stake sizer's series (`readHistory` in
  `apps/trading-worker/src/stake/size.ts`; `steps-parity.test.ts` holds them equal for every
  history of up to six trades): under the fixed strategy every trade is step 1 of the next cycle;
  under martingale the step is the losses in a row plus one, a win ends the series, a tie leaves it
  as it is, and a cycle is a series. The sender passes the session's own strategy,
  `sessionStakeParams(settings).strategy` (#450): settings v1 and settings that cannot be read count
  as `fixed`.
- **«🔄 Адаптивная ставка включена»** is the first line of a trade whose stake is above the
  session's base stake (`decimalLessThan`, bigint): under martingale, every step after a loss.
  Under the fixed strategy the stake is the base stake, so the line does not appear. No text says
  «Мартингейл».
- **The summary** is the pair («📈 {symbol}», `sessionSummarySymbol`, or «актив #N»), then the
  status message's own closing lines (`sessionClosingLines`): «🏁 Сессия завершена: …» for a
  completed session, otherwise the stop line and «📊 Итог: …», then «💰 Результат» (the SQL sum,
  #337), the balance of the session's mode and its age line when it predates the last trade. Its
  balance is read as the route reads it (`readFinishedSessionView`): at most one broker GET per
  session, `mayRefresh: false`. Under it «🏠 В меню»; under a `no_signal_timeout` stop (#509)
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
  nothing, and the cursor moves on. The notification level does not apply: trade results are
  outside it (Rule 19).

### The state

`trading_sessions.notified_trades` is the cursor: how many of the session's settled trades (a
settled intent with its broker trade), in creation order, were claimed for sending. A session's
trades are strictly sequential (one non-terminal intent per account, Rule 7), so settlement order
is creation order and a count is the whole state. `final_notice_sent_at` is the summary's mark.
Every send is claimed by a CAS UPDATE before the Telegram call (`claimSessionTradeNotice`,
`claimSessionFinalNotice` in `packages/db/src/session-notice-ops.ts`): at most once, the mailing
engine's rule. The migration's backfill (0050) set every existing session's cursor at its settled
trades and marked every stopped session, so nothing settled before the deploy is sent.

### Every way a send ends

| Ending | Cursor / mark | Then |
|---|---|---|
| sent | stays claimed | the session's next trade in the same tick |
| the user blocked the bot (read flag) | claimed, no call | the next trade |
| 403 | stays claimed; the user is marked unreachable | later trades claimed without a call |
| 429 | put back (`releaseSessionTradeNotice`; the summary's by `releaseSessionFinalNotice`) | the whole sender pauses for `retry_after`; the same send first after it |
| another 4xx | put back, an attempt counted in memory | tried again on the next tick; at `SESSION_NOTICE_MAX_ATTEMPTS` (3) left claimed and `warn` … `dropped` |
| 5xx, a timeout, the transport | stays claimed | `warn` … `outcome unknown`; never sent again |
| the process dies between the claim and the send | stays claimed | lost, at most one per session per crash |
| the message cannot be built (a bug) | a trade stays claimed; the summary is built before its claim | `error`; the session waits for the next tick |
| `stop()` mid-tick | the send in flight ends or times out | nothing is claimed after it |

The summary's 429 or refusal takes its mark back only while the card (#318) has not been claimed
on it; the card waits for the mark, so in practice always.

### Rate and timing

`SESSION_NOTICE_SEND_PER_SECOND` = 9, its own pacer; with the mailings' 20 it stays under
Telegram's 30 a second for one bot (`TIMING_CHAIN_HOLDS`). `SESSION_NOTICE_SCAN` = 200 pending
sessions a tick, oldest first (`trading_sessions_notice_pending_idx`). `stop()` waits for the send
in flight: the pace's gap, a summary's balance refresh and its send, under phase 1's budget.

### Logs (backend)

With `sessionId` (and `claimed` for a trade), the error's name and code and the Telegram method and
code; no Telegram id, no text.

- `session trade notice refused`, `… dropped`, `… outcome unknown`, `… refused: the user is
  unreachable` (`warn`); `session summary refused`, `… dropped`, `… outcome unknown`, `… refused:
  the user is unreachable` (`warn`)
- `session notices paused: Telegram asked to wait` (`warn`, `pauseMs`)
- `session trade notice not built`, `session summary not built`, `session notices failed for a
  session`, `session notice tick failed` (`error`)

## The summary card (#318)

One PNG per finished session, demo and real alike, sent to the status message's chat under the
backend's summary message (#464), without sound (`disable_notification: true`): the summary
carries the session's one sound. Sharing it is «📤 Поделиться» ([Sharing the card](#sharing-the-card-321)) or
Telegram's own forwarding.

- **When.** The tracker's entry ends on a done view (stopped, the last trade settled or rejected),
  the final status is on screen and the summary message went out (`noticesDone`, #464; the claim
  below refuses the card before it). A last trade on `manual_review` is not done, so no card yet:
  an operator settling it later gives one on the tracker's next poll while its entry lives (until
  `SESSION_TRACK_DEADLINE_MS`), otherwise on the user's «🔄 Обновить». A session with no settled
  trade gets none.
- **At most once.** `POST /trading/sessions/:id/summary` ([trading-session.md](trading-session.md#routes))
  sets `trading_sessions.summary_sent_at` by one CAS UPDATE — only once `final_notice_sent_at` is
  set (#464) — and answers the card's rows; every
  other answer is 409 `summary_unavailable`, and the bot then sends nothing. Two entries of one
  session (a refresh while it is tracked, a start's 409) race the claim and one wins.
- **The numbers.** Each trade's result is its `broker_trades.profit`, the total the same SQL sum
  the status prints (`sessionProfitSumSql`, #337); the bot formats them (`formatSignedUsd`) and
  adds nothing. Win, loss and tie go by the exact decimal's sign, as the view counts them, so
  `0.001` is a win that prints `+$0.001` (every digit, #450). The prices are
  `broker_trades.open_price`/`close_price`: the line runs through each trade's entry (a quarter
  into its column) and exit (three quarters), scaled between the lowest and the highest price, in
  the middle when all are equal. It is not the
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
  «📡 К сигналам», «💳 Пополнить» (#27, https only), «👥 Пригласить друга» (#115), «🏠 В меню»;
  «💳 Пополнить», «👥 Пригласить друга» and «🏠 В меню» alone without `settings`
  (`sessionCardKeyboard`); under a `no_signal_timeout` stop «🔀 Выбрать другую пару» in place of the
  first three (#509). «📤 Поделиться» comes on top of these rows by
  an edit right after the send (#321).
  «📡 К сигналам» edits the pressed message; under the card Telegram refuses that with «there is
  no text in the message to edit», `editRefusal` (`screen.ts`) reads it as gone, and the screen
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
posts the card there with its own caption, «via @bot». Nothing is stored: the button's query
carries the card's `file_id`, and the owner proof is the backend's read of the session.

- **The button.** The `file_id` exists only once `sendPhoto` returns, so the card is sent with its
  #318 keyboard and then gets the row `switch_inline_query_chosen_chat` = `share:<sessionId>:<fileId>`
  on top, by one `editMessageReplyMarkup` that sets the whole keyboard again (the share row, then
  every row of `sessionCardKeyboard`). The `file_id` is the largest size's (`photo.at(-1)`). No
  `file_id`, a query over 256 characters (`INLINE_QUERY_LIMIT`) or a failed edit → no button, one
  `warn`, no retry; the card keeps its #318 keyboard, and the card's own `trading session card not
  sent` does not fire.
- **The answer.** `SHARE_PATTERN` parses the query (a lower-case uuid, a file id of 1–213
  non-space characters); anything else is answered empty with no backend call. A matching query
  reads `GET /trading/sessions/:id?telegramUserId=<from.id>` beside `GET /trading/pairs`: the route
  is scoped by the owner, so another user's id is the same 404 as a missing session and gets the
  empty answer (Rule 13). A session that is not done (`sessionTrackingDone`: stopped, the last trade
  settled or rejected) gets the empty answer too, so the counts in the caption are final; the same
  button works once the last trade settles. The asset is the settings', or the last trade's when the
  settings could not be read — the card's own rule; with neither, the empty answer.
- **The result** is `InlineQueryResultCachedPhoto` with `id` = the session's id, the query's
  `file_id`, and the caption `sessionShareCaption` through `answerInlineQueryPhotoHtml`
  (`send.ts`): «🏁 {symbol}: {result}» and «🤖 https://t.me/{botUsername}?start=share». No $ sum
  (it is on the image), no keyboard (docs/bot-navigation.md → Exceptions). The URL is plain text,
  which Telegram turns into a link; the payload `share` is recorded as `acquisition_source` by the
  first `/start` of a new user ([bot-start.md](bot-start.md)). The found answer is
  `is_personal`, cached by Telegram for its default 300 s; the empty one `cache_time: 0`.
- **The file id is Telegram's to check.** It is this bot's own identifier of the user's own card;
  a forged or foreign one makes `answerInlineQuery` fail with 400 (`inline query not answered`).
- **Owner steps.** BotFather, the client bot: `/setinline` with a placeholder («Поделиться итогом
  сессии»), `/setinlinefeedback` → Enabled. Until `/setinline` is set, inline mode is off for the
  bot and Telegram delivers no inline queries.

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
    tracking and no summary card: the state is not reachable from the bot; each session's own
    message, if tracked, still follows it. Falsifiable: two active sessions of one user, both
    started from the bot.
18. **No repeat on an unknown outcome of `/stop`** (#122): the stop may have committed; the truth is
    in the session's status message (tracker or «🔄 Обновить»), and a second `/stop` answers
    «Активных сессий нет.».
19. **One more Bot API call per card** (#321): a failed `editMessageReplyMarkup` leaves the card
    without «📤 Поделиться», and nothing retries it — a done session sends no second card.
20. **The `file_id` is visible in the input field** for a moment after the press (#321): it is this
    bot's identifier of the user's own card, and Telegram refuses any other value.
21. **A public inline surface** (#321): anyone can send the bot inline queries; each one that does
    not match costs one empty answer and nothing else. Falsifiable: inline-query volume above the
    bot's other update volume on the pilot.
22. **Telegram caches the found answer** for 300 s per user and query (#321): a text override of
    `sessionShareCaption` reaches an already-answered query after that.
23. **`switch_inline_query_chosen_chat` is Bot API 6.7+** (#321): that it opens the picker on the
    owner's clients is the owner's check.
24. **Cards sent before #321** have no «📤 Поделиться» and get none: a done session's claim answers
    409, so no new card is sent.
25. **Two «📤 Поделиться» buttons** (#321): the URL button on `/invite` (`inviteShareButton`) and the
    one under the card (`sessionShareButton`); different screens, separate keys.
26. **At most once for the trade messages and the summary** (#464, manager's decision 2a): an
    unknown Telegram outcome or a crash between the claim and the send loses that one message; no
    duplicate is possible. Falsifiable: `session trade notice outcome unknown` above 0.1 % of
    sends.
27. **The notices' rate** (#464): at most 9 a second (540 a minute) for every session together;
    above it the messages lag behind the trades, never drop. The bot's own replies and edits are
    outside that budget, as before.
28. **Latency** (#464): a trade's message comes up to `SESSION_NOTICE_TICK_MS` plus the pacing
    after its settle.
29. **The trade lines do not add up to «💰 Результат»** for wins and ties (#464): the owner's
    sample prints the payout and the returned stake.
30. **A stopped session stuck on manual review** stays in the sender's scan until settled or
    rejected (#464): one cheap row each.
31. **No card** when the backend has not sent the summary by the tracker's deadline (#464, about
    70 min after the start); «🔄 Обновить» later gives it once the mark is set.
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

## Running it locally

The bot's presses are covered by `trading-session.test.ts`, `session-tracker.test.ts`,
`demo.test.ts` and `timing.test.ts` against the real handlers; they need no services. The summary
card is drawn and rendered by `session-card.test.ts` on the host's resvg build. The routes
the bot calls are run end to end by [trading-session.md → Running it locally](trading-session.md#running-it-locally).
That a started session trades and its counters move needs #287's orchestrator in the worker.
The steps in Telegram — «🎮 Демо-торговля», «🧭 Выбрать пару вручную», a pair, 15 s, «📊 Анализ»,
«🚀 Сессия из 5 сделок» first, with or without a signal, then an amount of the amount screen
(#476; or a pair of «Сигналы сейчас» and an amount), the status moving, «⏹ Остановить сессию»; on a
signal, «➕ Ещё», the stake button, and the row «🚀 Сессия из 5 сделок» under the trade's result
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
- **#321** — «📤 Поделиться» under the summary card ([Sharing the card](#sharing-the-card-321)); a
  referral link in its caption in place of `?start=share` is the owner's open question.
- **#121**, **#327** — real mode and real sessions ([trading-mode.md](trading-mode.md)); **#473**
  extends `/stop` with the switch back to demo, **#474**'s mode screen tells the sessions a switch
  stopped.
  **#201** — levels and rewards.
