# The demo trade: the stake press and the intent's status (issue #127)

The analysis screen ([bot-demo.md](bot-demo.md#the-analysis)) draws «➕ Ещё» on a signal; its
press (#360) draws «🚀 Открыть сделку: ⬆️ Вверх · $1.00» in place, with «💵 Сумма» beside it
([The stake](#the-stake-297)). Pressing it creates a demo intent through `POST /trading/intents`
([trade-intent-transport.md](trade-intent-transport.md)) and sends one status message. The message
follows the intent's real status, read through `GET /trading/intents/:id`. It never marks the trade
open because the button was pressed: «✅ Сделка открыта у брокера.» comes only from `accepted`.

```bash
pnpm test --project unit apps/bot/src   # needs no database or Redis
```

## Components

- `apps/bot/src/demo-trade.ts` — `createDemoTradeComposer({ backend, logger, now, intentTracker,
  connectKeyboard })`, which holds the stake press and the refresh press. Also `intentCallbackData`,
  `INTENT_CALLBACK_PATTERN` and `intentKeyboard`. `bot.ts` mounts it under its private-chat
  filter, right after the demo's composer.
- `apps/bot/src/intent-tracker.ts` — `createIntentTracker({ backend, logger, firstPollMs, pollMs,
  deadlineMs, maxEntries?, now? })` → `{ track, stop, size }`. Also `TRACKER_STOP_STATUSES`,
  `sessionOfferOf` (#360), `INTENT_TRACKER_MAX_ENTRIES` and `INTENT_NOT_FOUND`. `index.ts` builds one and hands it to
  `createBot` and to `runBot`.
- `apps/bot/src/demo.ts` — the stake button's data
  `demo:stake:<assetId>:<sec>:<up|down>:<nonce>:<fingerprint>`, `newStakeNonce`,
  `stakeFingerprint`, `effectiveStake`, `STAKE_CALLBACK_PATTERN` and `stakeDataOf`.
- `apps/bot/src/stake-picker.ts` — `createStakePicker({ backend, logger, dialog,
  connectKeyboard })` → `{ composer, onStakeText }`: the stake picker (#297).
- `apps/bot/src/backend-client.ts` — `createIntent(request)` → the intent; a 201 and a 200 replay
  read the same, since the bot treats them the same. `readIntent(id, telegramUserId)` →
  `GET trading/intents/<id>?telegramUserId=<id>`. Both parse `intent` with
  `safeParseTradeIntentView`.
- `apps/bot/src/send.ts` — `editMessageTextByIdHtml`, the tracker's edit, which runs outside any
  update.
- `apps/bot/src/texts.ts` — `intentStatusText`, the `intent*` and `stake*` entries of `TEXTS`,
  and `LABELS.refreshIntentButton`; the texts are catalog entries ([bot-texts.md](bot-texts.md)).
- `apps/bot/src/timing.ts` — `HANDLER_CALLS.stake`, `.intentRefresh` and the four
  `INTENT_TRACK_*` constants ([Timing](#timing)).
- `apps/backend/src/trading/routes.ts` and `packages/db/src/trade-intent-ops.ts` — the read
  scoped by the owner ([trade-intent-transport.md → GET /trading/intents/:id](trade-intent-transport.md#get-tradingintentsid-127)).

## Sequence

```text
demo:more:<assetId>:<sec>:<up|down>:<s|n>   («➕ Ещё» under the analysis, #360; the floor's token, #379)
  bot → answerCallbackQuery ∥ POST /trading/access
  bot → editMessageReplyMarkup: the stake button (a new nonce, the amount's fingerprint) and «💵 Сумма»
demo:stake:<assetId>:<sec>:<up|down>:<nonce>:<fingerprint>
  bot → answerCallbackQuery ∥ GET /trading/pairs (readDemoTrade) ∥ POST /trading/access
  bot → POST /trading/intents { telegramUserId, mode: demo, assetId,
                                amount: demoStake ?? broker.minTradeAmount, action, durationSec,
                                clientRequestId: demo:<telegramUserId>:<nonce> }
  bot → sendMessage: the status, with «🔄 Обновить статус» (intent:<id>)
  tracker: after 1 s, then every 3 s → GET /trading/intents/<id>?telegramUserId=<id>
           → editMessageText of that message when the status changes; on accepted, settled or
             rejected the session offer and «🚀 Сессия из 5 сделок» (demo:sess:<assetId>:<sec>, #360)
intent:<id>                («🔄 Обновить статус»)
  bot → answerCallbackQuery ∥ GET /trading/intents/<id>?telegramUserId=<presser> ∥ GET /trading/pairs
  bot → editMessageText: the status in place
```

The checks run in this order, and the first one that fails answers:

1. **The catalog.** `readDemoTrade` runs again at the press, because the pair can close or
   disappear between the analysis and the press. A failure sends #125's text as a new message
   with the «↩️» buttons only: `demoCatalogUnavailable`, `demoCatalogStale`, `demoPairMissing`,
   `demoPairClosed`, `demoDurationUnsupported`, or `unavailable` with `warn` `demo catalog not read`.
   There is no «🔄 Повторить» button that carries the stake data, because that would be a second
   stake button.
2. **The access.** If the read fails, the bot answers `unavailable` and writes `warn`
   `trading access not read`. A `blocked` user gets `blocked`. With `broker: null` the answer
   depends on the reason: `no_account` gets `accountNone` with the connect button,
   `ambiguous_account` gets `statusAmbiguous`, and any other reason gets
   «⏳ Баланс Binodex ещё не получен…».
3. **The fingerprint.** The amount is the broker's `minTradeAmount` in real mode (#121), in demo
   the user's saved demo stake (`access.demoStake`) or the broker's `minTradeAmount` without one,
   a string exactly as the backend sent it. The bot never computes it (Rule 2). The button
   carries the first 6 hex of `sha256` of the amount its label showed, prefixed by `real:` in real
   mode. When the amount or the mode in effect now has another fingerprint — the stake was saved
   or reset since the expansion, the broker moved its minimum, the user switched the mode, the
   label had no amount, or the button is older than #297 and has none — the bot answers «⚠️
   Режим или сумма сделки изменились — открой анализ заново.» with «↩️ Назад к анализу», and
   nothing is created.
4. **The intent.** `POST /trading/intents` with that amount. The backend checks it against the
   account's stored snapshot (Rule 29). A session's stake comes from the same saved stake
   ([trading-session.md](trading-session.md)); the sizer in the worker sizes each of its trades.

## Idempotency

The button's nonce is 6 random bytes in hex, drawn once per «➕ Ещё» press (#360; before it, once
per render of the analysis screen). It is the trade's key: `clientRequestId =
<mode>:<telegramUserId>:<nonce>` (#121: `demo:` or `real:`, so a demo button never replays as a
real intent). Pressing the same button again replays the same intent (200) and
never opens a second trade (`trade_intents_user_request_idx`, Rule 7). That covers a double tap, an
old message and a press after a restart. A new expansion carries a new nonce, so its button can
open a new trade; a double tap on «➕ Ещё» draws two, as two renders of «🔄 Повторить анализ» did.
An analysis message from before #360 keeps its stake button and its nonce. A replay sends the intent's current state as a new message. It is tracked only when
the status is live and the tracker is not already following that id: `track()` does nothing for
an id it already has. So after a restart, pressing the stake button again restarts tracking.

## Outcomes of POST /trading/intents

Every 4xx is answered before a row is committed, so a 4xx means nothing was created.

| Answer | What the bot shows |
| --- | --- |
| 201 / 200 `{ intent }` | the status message, tracked unless the status is already accepted, settled or rejected |
| 404 `broker_account_not_found` | `accountNone` + the connect button |
| 409 `account_revoked` | `accountRevoked` + the connect button |
| 409 `user_blocked` | `blocked` |
| 409 `ambiguous_broker_account` | `statusAmbiguous` |
| 409 `account_not_confirmed` | «⏳ Привязка Binodex ждёт подтверждения — открой /account.» |
| 409 `account_halted` | «⛔ Торговля по аккаунту остановлена — напиши в поддержку: /support» |
| 409 `insufficient_tokens` | «🪙 Не хватает токенов для сделки.» |
| 409 `active_intent_exists` | «⏳ Предыдущая сделка ещё не завершена…» |
| 409 `client_request_id_conflict` | «⚠️ Эта кнопка уже использована…» (the same button with a changed amount; the fingerprint normally refuses it first) |
| 409 `trading_paused` | «⏸ Торговля временно приостановлена, попробуйте позже.» (the global switch, [kill-switch.md](kill-switch.md)) |
| 409 `demo_only` | «⚠️ Реальные сделки на этом сервере отключены — доступен только демо-режим.» (the backend runs `DEMO_ONLY`, #396; unreachable while the bot sends `demo`) |
| 409 `balance_unavailable` | «⏳ Баланс Binodex ещё не получен…» (no snapshot to check the amount against) |
| 409 `stake_below_minimum` | «⚠️ Минимальная ставка брокера сейчас $X…», X from this press's access read, + «💵 Сумма» |
| 409 `insufficient_demo_balance` | «⚠️ На демо-счёте недостаточно средств для этой суммы…» + «💵 Сумма» |
| 409 `stake_precision` | «⚠️ В сумме слишком много знаков после запятой…» + «💵 Сумма» (the minimum's scale changed after the save) |
| 404 `user_not_found`, 400 `validation`, any other 4xx | `unavailable`; `warn` `trade intent not created` |
| 5xx, no answer, a broken 2xx body | the outcome is unknown: one more `createIntent` with the same key; if that also fails this way, «⚠️ Не удалось узнать, принята ли заявка…» and `warn` `trade intent not created` |

The refusals are an exhaustive `Record<TradeIntentErrorCode, …>`, so a code added to the contract
fails `tsc` in `demo-trade.ts`. A row with no button of its own gets «↩️ Назад к анализу» and
«🏠 В меню» (#350, [bot-navigation.md](bot-navigation.md)), `blocked` the support link: the press is
a write, so it is never offered again; the same holds for the access read's refusals before it.

## The stake (#297)

The user's demo stake is `users.demo_stake`: `NULL` means the broker's minimum at each trade,
which is what every user had before. One stake serves the single trade and the session.

**The picker** (`stake-picker.ts`) opens from «💵 Сумма» beside the stake button (drawn by
«➕ Ещё», #360), from «💵 Изменить»
in /settings ([bot-menu.md](bot-menu.md)), from «💵 Изменить ставку» on the launch screen (#320,
[bot-demo.md](bot-demo.md#the-launch-screen-320)) and from the stake refusals. It edits the message it was
opened from:

```text
💵 Сумма демо-сделки
Сейчас: $5.00                         (or «минимальная ставка брокера ($1.00)»)
Минимум брокера: $1.00
Доступно: $9 990.00
[$1.00] [$2.00] [$5.00 ✅] [$10.00]    minTradeAmount × 1, 2, 5, 10, only those <= available
[✏️ Своя сумма]
[🔁 Минимальная брокера]               only while a stake is saved
[↩️ Назад к анализу | ↩️ Назад к настройкам | ↩️ К запуску]
```

The presets and the input syntax come from `packages/shared/src/demo-stake.ts`, bigint at scale 8.
No preset fits → «На демо-счёте недостаточно средств даже для минимальной ставки.», custom and back
only. An access refusal shows the stake press's texts (blocked, no account with the connect
buttons, two accounts, no balance yet) with the way back.

| Callback (≤ 45 bytes) | Action |
| --- | --- |
| `stk:o:<origin>` | open: read access, edit to the picker; also ends a stake input step |
| `stk:s:<amount>:<origin>` | a preset: save exactly this amount |
| `stk:z:<origin>` | reset to the broker minimum (`amount: null`) |
| `stk:c:<origin>` | custom: the input step, the prompt in place with «↩️ Назад» → `stk:o:<origin>` |

`<origin>` is `s` (/settings, way back `settings`), `a:<assetId>:<sec>` (way back
`demo:an:<assetId>:<sec>`, a fresh analysis with a new nonce) or `p:<assetId>:<sec>` (#320, the
launch screen, way back `demo:l:<assetId>:<sec>`; the duration since #382, and `p:<assetId>` from
before it is a legacy origin whose press removes the keyboard). The longest datum is
`stk:s:999999999999.99999999:a:2147483647:15`, 43 bytes, and the launch origin's is the same
length. The three
switches over the origin (`originData`, `backTo`, `savedScreen`) are exhaustive (`satisfies
never`), so a fourth kind fails `tsc` until each of them handles it; the parser `stakeOriginOf` and
the `PICKER` pattern are extended by hand.

**The return to the launch screen (#320).** A save opened from a launch screen (a preset, the
reset or a typed amount) returns to that screen, not to «✅ Сумма»: «✅ Демо-ставка сохранена: $5.00»
above the three lines, with «💵 Ставка» at the saved amount (after the reset, «минимальная брокера»)
and the screen's three buttons. One read gives the symbol and the payout: `readPairs`, any
catalog, a stale one included, as the session start reads it. A pair in it paying below the cycle
floor (`!pairPayoutAccepted`, #379) gets, under «✅ Демо-ставка сохранена», the launch press's refusal
`demoPayoutTooLow` with «↩️ К списку» and «🧭 Выбрать пару вручную» instead of «🚀 Запустить цикл»
(`stake-picker.test.ts`, at 79 and 80 % on 15 and 5 s). Without a catalog the symbol line is
dropped and `warn` `pairs not read for the launch screen` is logged; without a catalog or without
the pair in it the launch stays, since the start checks the pair itself. A preset or the reset edits in place, a typed amount sends the screen as a new message. A
refusal keeps the picker's texts with «💵 Сумма» and «↩️ К запуску», and reads no catalog.

**The custom input** is a step of the login dialog store (`login-dialog.ts`): one entry per user,
so the email login and the stake input replace each other. `parseDemoStakeInput` takes digits with
one `,` or `.` («2,50», «1.5», «01.5» → `1.5`); «abc», «-5», «0», «1 000», «1e3» get «❌ Введи
сумму числом…» and the step stays. A restart drops the step, as for the login. The result of a
typed amount is a new message.

**The save** is `POST /trading/demo-stake` ([trading-access.md](trading-access.md#post-tradingdemo-stake-297)).
What its answer does:

| Answer | Source | Message | The input step |
| --- | --- | --- | --- |
| 200 | saved | «✅ Демо-ставка: $5.00» / «✅ Демо-ставка: минимальная ставка брокера» + back | ended |
| 409 `stake_precision` | refused before the write | «❌ Не больше N знаков после запятой.» (`limits.scale`) + «💵 Сумма» + back | kept, TTL anew |
| 409 `stake_below_minimum` | refused before the write | «⚠️ Минимальная ставка брокера сейчас $X…» + «💵 Сумма» + back | kept |
| 409 `insufficient_demo_balance` | refused before the write | «⚠️ На демо-счёте доступно $Y…» + «💵 Сумма» + back | kept |
| 409 `balance_unavailable` | refused before the write | «⏳ Баланс Binodex ещё не получен…» + back | kept |
| 404 `user_not_found` | no users row | `unavailable`, `warn` `demo stake not saved` | ended |
| 400 `validation`, any other 4xx | the bot's own bug | `unavailable`, `error` `demo stake not saved` | ended |
| no answer, 5xx, a broken body | unknown: the UPDATE may have committed | «⚠️ Не удалось сохранить сумму…» + «💵 Сумма» + back, `warn` `demo stake save outcome unknown` | kept |

The save overwrites with the same value, so a retry is harmless, and the picker's «Сейчас:» line
shows what is saved. The bot never infers the saved state from a failure.

Amounts print with `formatStake`: every fraction digit, at least two («$5.00», «$0.005»). The
status line of an intent and a session's stake use it too; balances keep `formatUsd`.

## The status message

`intentStatusText(symbol, view, { deadline?, sessionOffer? })` builds the message from four parts: a
header, the trade line (`EUR/USD OTC · ⬆️ Вверх · ⏱ 15 с · ставка $1.00`, the symbol capped at 64
characters), a blank line, and the status line; then, after a blank line, the deadline hint or the
session offer (#360) when the caller asks for one. The callers never ask for both. The status line is chosen by `view.status`, or by
`view.lastError` when the status is `rejected`:

| Status | Line |
| --- | --- |
| planned, reserved, queued | ⏳ Заявка создана и ждёт отправки брокеру… |
| submitting | 📤 Отправляем заявку брокеру… |
| accepted | ✅ Сделка открыта у брокера. |
| settled | 🏁 Сделка закрыта. (the result is not in the intent) |
| unknown, reconciling | 🔎 Результат сделки уточняется у брокера. Токен пока зарезервирован. |
| manual_review | 🛠 Сделка на ручной проверке — напиши в поддержку: /support |
| rejected / executor_not_configured | ⚠️ Сделка не отправлена: исполнение сделок ещё не подключено. Токен возвращён. |
| rejected / expired, broker_rejected, publish_failed, reconciliation_not_found, manual_rejected, trading_paused, demo_only | each has its own line, ending «Токен возвращён.» (`trading_paused`: «⏸ Торговля временно приостановлена, попробуйте позже. Токен возвращён.»; `demo_only`, #396: «⚠️ Сделка отклонена: реальные сделки на этом сервере отключены. Токен возвращён.») |
| rejected / any other reason, or none | ❌ Сделка не открыта. Токен возвращён. |

Both maps are exhaustive (`satisfies Record<…>`). `texts.test.ts` checks that «открыта» appears
(not as «не открыта») for `accepted` and for no other status.

**The keyboard** (`intentKeyboard(view)`, #350) follows the status: «🔄 Обновить статус» while the
status has an edge out of it in the shared graph (accepted until it settles); once the tracker stops
(`TRACKER_STOP_STATUSES`), the session offer (#360) and the end of the path under it —
«🚀 Сессия из 5 сделок», then «📊 Новый анализ» (the same pair and duration), «📡 К сигналам»,
«🏠 В меню» ([bot-navigation.md](bot-navigation.md)). An accepted trade gets all five rows.

**The session offer (#360).** On `accepted`, `settled` and `rejected` alike, the message ends with
«🤖 Дальше бот может торговать сам: сессия из 5 сделок на этой паре, сигнал он проверяет перед
каждой сделкой.» and the keyboard carries «🚀 Сессия из 5 сделок» with `demo:sess:<assetId>:<sec>`
of that trade — the session button's own data, so its press is the start handler with its
refusals and its `{ active }` answer: a press while a session runs shows the running one and starts
none ([bot-session.md](bot-session.md#the-button)). One predicate decides the line and the row,
`sessionOfferOf(view, payoutAccepted)`: the status is a stop status, the duration is one of
`DEMO_DURATIONS_SEC`, a session of five fits it, and the pair paid at least the cycle floor (#379)
as the catalog had it at the press (the tracker carries the fact, `IntentTrackRequest.payoutAccepted`)
or at the refresh; unknown — the refresh's catalog read failed or the id is not listed — draws no
offer. The payout can move during a 5–15 s trade: the message shows the press-time fact, and a
press after the change meets the route's 409 `payout_too_low`. A trade from before #313 (60 s) gets neither, as it gets no
«📊 Новый анализ». The tracker's edits and «🔄 Обновить статус» draw it; the message right after
the press (`planned`) never does; the deadline edit of a live status carries the hint and no
offer, and the deadline edit of a stop status whose edit never landed carries the offer; the 404
edit carries neither. The number of trades is the catalog's `{trades}`, from
`DEFAULT_SESSION_TRADES`. A rejection whose cause also refuses a session (`trading_paused`,
`account_halted`) still shows the offer; the start's refusal explains it (owner, #320). The tracker's
edit takes the view and, for an edit that is not a status, why (`IntentTrackRequest.edit(text,
view, end?)`): the deadline on a live status adds «🏠 В меню» under the refresh, and an intent gone
while tracked (404) leaves «🏠 В меню» only. So its last edit draws the next step. A failed
refresh offers the same refresh and the menu; a 404 the menu only. Until the trade command executor
(#100) is deployed, every intent ends as `rejected / executor_not_configured`.

## The tracker

There is one entry per intent id, held in process memory by the owner's decision, like the login
dialog. The first poll comes `INTENT_TRACK_FIRST_POLL_MS` after the status message, then one every
`INTENT_TRACK_POLL_MS`. The message is edited only when the status changes; for `rejected`, also
when the reason changes. Tracking stops at a status in `TRACKER_STOP_STATUSES`: the statuses with
no outgoing edge in `TRADE_INTENT_TRANSITIONS`, plus `accepted`.

| An attempt ends with | The entry |
| --- | --- |
| a changed status | edited; on a stop status the entry ends once the edit has landed, otherwise the edit is retried on every poll until the deadline |
| the same status | not edited; polls again, or reaches the deadline |
| past `INTENT_TRACK_DEADLINE_MS` | one last edit, then stops: «⏳ Сделка всё ещё обрабатывается — нажми «🔄 Обновить статус» чуть позже.» under a live status, the status text itself for a stop status whose edit never landed. This edit is not retried, because the deadline is what ends every entry, even one whose every edit is refused (a 403 once the user blocked the bot) |
| 404 `not_found` | «⚠️ Статус сделки недоступен.»; `warn` `trade intent status not read` with `intentId`; stops. That edit is not retried: polling cannot fix a missing or foreign id, and the refresh button gives the same answer |
| any other read failure | `warn` once per entry; polls again until the deadline |
| the edit refused as «message is not modified» | treated as shown |
| the edit refused as gone | `warn` `trade intent message not edited` (always); stops |
| any other refusal of the edit, or a transport failure | `warn` once per entry, then only counted; not recorded as shown, so the next poll edits again (the poll interval is the retry cadence; a 429's `retry_after` is not read) |
| anything else thrown, anywhere in the attempt | `error` `trade intent tracking failed`; stops |

When `INTENT_TRACKER_MAX_ENTRIES` (10 000) is reached, the oldest entry is dropped and its message
keeps its last state. `stop()` clears every timer, refuses new entries and waits for every
attempt in flight.

What a restart loses: the tracking. Every message stays at its last state with its
«🔄 Обновить статус» button, which is the recovery.

## The refresh button

`intent:<uuid>` takes only a lowercase uuid; any other data matches no handler. The read is scoped
by the presser (`ctx.from`), so a forwarded message pressed by someone else answers 404, and the
bot replies «⚠️ Статус сделки недоступен.» without a log line. Any other read failure gets
`unavailable` and `warn` `trade intent status not read`. When the read succeeds, the status is
edited in place, with the symbol taken from `GET /trading/pairs`; a stale catalog is accepted for
this. On a stop status it draws the session offer and its row, as the tracker does (#360). When the catalog cannot answer, «актив #<id>» stands in for the symbol. The edit outcomes:
«not modified» means done; gone means the status is sent anew with its button; a transport failure
gets `warn` and nothing more. This press never starts tracking.

## Timing

- `HANDLER_CALLS.stake` = 4 backend calls and 2 Bot API calls: the catalog and the access reads
  (counted one after the other, as in `confirm`), `createIntent` and its retry, the answer and the
  message. That is 36 s.
- `HANDLER_CALLS.intentRefresh` = 2 backend calls and 3 Bot API calls: the edit refused as gone,
  then sent anew. That is 34 s.
- The picker (#297): `stakePickerOpen` and `settingsShow` are 1 / 3 (29 s), `stakeCustom` 0 / 3
  (24 s). `stakePreset` and `stakeReset` are 3 / 3 (39 s) and `stakeText` 3 / 1 (23 s) since #121:
  a save opened from a launch screen reads the catalog for its symbol and payout (#320) and access
  for the user's mode (#121).
- `HANDLER_CALLS.demoAnalysis` is 3 / 4 = 47 s since #121: the access read for the mode, beside
  the catalog, decides the session row; `HANDLER_CALLS.analysisMore` = 1 / 2 = 21 s. It is the
  longest path; the chain holds below `SHUTDOWN_BUDGET_MS` (50 s), with 3 s to spare.
- `INTENT_TRACK_FIRST_POLL_MS` = 1 s, `INTENT_TRACK_POLL_MS` = 3 s, `INTENT_TRACK_DEADLINE_MS` =
  120 s. The deadline is the worker's `INTENT_MAX_AGE_MS` (60 s) plus `SUBMIT_ACK_TIMEOUT_MS`
  (10 s), with room. That relation is stated, not checked, because the worker's constants cannot
  be imported here.
- `INTENT_TRACK_DRAIN_MS` = 5 s + 8 s, one read and one edit, which is what `runBot`'s
  `intent tracker` drain step can wait for.
- The chain at import requires first poll < poll < deadline, and drain < `SHUTDOWN_BUDGET_MS`.

## Logs

Each of these lines carries `err` with the error's name and code, plus `backendStatus` and
`backendReason`, or the method and the Telegram code. None carries the Telegram id, the symbol,
the amount or the nonce. `logging.test.ts` reads them back from the pino sink.

- `trade intent not created`
- `trade intent status not read` (with `intentId` when the tracker writes it)
- `trading access not read for the stake label` (written by «➕ Ещё» since #360), `trading access
  not read for the stake picker`,
  `demo stake save outcome unknown` (`warn`), `demo stake not saved` (`warn` for
  `user_not_found`, `error` otherwise) — #297
- `pairs not read for the launch screen` (`warn`) — #320
- `trade intent message not edited` (with `intentId` when the tracker writes it)

## Boundaries

- **#125 / #126** — the screens, the check and the stake button ([bot-demo.md](bot-demo.md)).
- **#360** — «➕ Ещё», which draws the stake button, and the session offer under a finished trade.
- **#100** — the executor; until it is deployed, every intent is `rejected / executor_not_configured`.
- **#90 / #101 / #29** — the trade's close and result, and the notification after `accepted`. The
  tracker stops at `accepted`.
- **#284** — the session of five in the bot: [bot-session.md](bot-session.md); its worker half is
  shipped (#287, [trading-session.md](trading-session.md)).
- **#121** — real mode: the press trades in the user's mode, at the broker's minimum in real
  ([trading-mode.md](trading-mode.md)); **#326** — the real stake.
