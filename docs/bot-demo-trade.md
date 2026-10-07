# The demo trade: the stake press and the intent's status (issue #127)

The analysis screen ([bot-demo.md](bot-demo.md#the-analysis)) draws «🚀 Открыть сделку: ⬆️ Вверх»
on a signal. Pressing it creates a demo intent through `POST /trading/intents`
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
  `INTENT_TRACKER_MAX_ENTRIES` and `INTENT_NOT_FOUND`. `index.ts` builds one and hands it to
  `createBot` and to `runBot`.
- `apps/bot/src/demo.ts` — the stake button's data `demo:stake:<assetId>:<sec>:<up|down>:<nonce>`,
  `newStakeNonce`, `STAKE_CALLBACK_PATTERN` and `stakeDataOf`.
- `apps/bot/src/backend-client.ts` — `createIntent(request)` → the intent; a 201 and a 200 replay
  read the same, since the bot treats them the same. `readIntent(id, telegramUserId)` →
  `GET trading/intents/<id>?telegramUserId=<id>`. Both parse `intent` with
  `safeParseTradeIntentView`.
- `apps/bot/src/send.ts` — `editMessageTextByIdHtml`, the tracker's edit, which runs outside any
  update.
- `apps/bot/src/texts.ts` — `intentStatusText`, the `intent*` and `stake*` entries of `TEXTS`,
  and `LABELS.refreshIntentButton`.
- `apps/bot/src/timing.ts` — `HANDLER_CALLS.stake`, `.intentRefresh` and the four
  `INTENT_TRACK_*` constants ([Timing](#timing)).
- `apps/backend/src/trading/routes.ts` and `packages/db/src/trade-intent-ops.ts` — the read
  scoped by the owner ([trade-intent-transport.md → GET /trading/intents/:id](trade-intent-transport.md#get-tradingintentsid-127)).

## Sequence

```text
demo:stake:<assetId>:<sec>:<up|down>:<nonce>
  bot → answerCallbackQuery ∥ GET /trading/pairs (readDemoTrade) ∥ POST /trading/access
  bot → POST /trading/intents { telegramUserId, mode: demo, assetId, amount: broker.minTradeAmount,
                                action, durationSec, clientRequestId: demo:<telegramUserId>:<nonce> }
  bot → sendMessage: the status, with «🔄 Обновить статус» (intent:<id>)
  tracker: after 1 s, then every 3 s → GET /trading/intents/<id>?telegramUserId=<id>
           → editMessageText of that message when the status changes
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
   depends on the reason: `no_account` gets `accountNone` with the connect buttons,
   `ambiguous_account` gets `statusAmbiguous`, and any other reason gets
   «⏳ Баланс Binodex ещё не получен…».
3. **The intent.** The amount is the broker's `minTradeAmount` string exactly as the backend sent
   it. The bot never computes it (Rule 2). The stake sizer (#287) will replace this source later.

## Idempotency

The button's nonce is 6 random bytes in hex, drawn once per render of the analysis screen,
including each «🔄 Повторить анализ». It is the trade's key: `clientRequestId =
demo:<telegramUserId>:<nonce>`. Pressing the same button again replays the same intent (200) and
never opens a second trade (`trade_intents_user_request_idx`, Rule 7). That covers a double tap, an
old message and a press after a restart. A new render carries a new nonce, so its button can open
a new trade. A replay sends the intent's current state as a new message. It is tracked only when
the status is live and the tracker is not already following that id: `track()` does nothing for
an id it already has. So after a restart, pressing the stake button again restarts tracking.

## Outcomes of POST /trading/intents

Every 4xx is answered before a row is committed, so a 4xx means nothing was created.

| Answer | What the bot shows |
| --- | --- |
| 201 / 200 `{ intent }` | the status message, tracked unless the status is already accepted, settled or rejected |
| 404 `broker_account_not_found` | `accountNone` + the connect buttons |
| 409 `account_revoked` | `accountRevoked` + the connect buttons |
| 409 `user_blocked` | `blocked` |
| 409 `ambiguous_broker_account` | `statusAmbiguous` |
| 409 `account_not_confirmed` | «⏳ Привязка Binodex ждёт подтверждения — открой /account.» |
| 409 `account_halted` | «⛔ Торговля по аккаунту остановлена — напиши в поддержку: /support» |
| 409 `insufficient_tokens` | «🪙 Не хватает токенов для сделки.» |
| 409 `active_intent_exists` | «⏳ Предыдущая сделка ещё не завершена…» |
| 409 `client_request_id_conflict` | «⚠️ Эта кнопка уже использована…» (the same button with a changed `minTradeAmount`) |
| 404 `user_not_found`, 409 `real_trading_disabled`, 400 `validation`, any other 4xx | `unavailable`; `warn` `trade intent not created` |
| 5xx, no answer, a broken 2xx body | the outcome is unknown: one more `createIntent` with the same key; if that also fails this way, «⚠️ Не удалось узнать, принята ли заявка…» and `warn` `trade intent not created` |

The refusals are an exhaustive `Record<TradeIntentErrorCode, …>`, so a code added to the contract
fails `tsc` in `demo-trade.ts`.

## The status message

`intentStatusText(symbol, view, { deadline? })` builds the message from four parts: a header, the
trade line (`EUR/USD OTC · ⬆️ Вверх · ⏱ 1 мин · ставка $1.00`, the symbol capped at 64 characters),
a blank line, and the status line. The status line is chosen by `view.status`, or by
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
| rejected / expired, broker_rejected, publish_failed, reconciliation_not_found, manual_rejected, real_trading_disabled | each has its own line, ending «Токен возвращён.» |
| rejected / any other reason, or none | ❌ Сделка не открыта. Токен возвращён. |

Both maps are exhaustive (`satisfies Record<…>`). `texts.test.ts` checks that «открыта» appears
(not as «не открыта») for `accepted` and for no other status. Until the trade command executor
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
this. When the catalog cannot answer, «актив #<id>» stands in for the symbol. The edit outcomes:
«not modified» means done; gone means the status is sent anew with its button; a transport failure
gets `warn` and nothing more. This press never starts tracking.

## Timing

- `HANDLER_CALLS.stake` = 4 backend calls and 2 Bot API calls: the catalog and the access reads
  (counted one after the other, as in `oauth`), `createIntent` and its retry, the answer and the
  message. That is 36 s.
- `HANDLER_CALLS.intentRefresh` = 2 backend calls and 3 Bot API calls: the edit refused as gone,
  then sent anew. That is 34 s.
- Both stay below `confirm`'s 45 s, so the shutdown budget does not move.
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
- `trade intent message not edited` (with `intentId` when the tracker writes it)

## Boundaries

- **#125 / #126** — the screens, the check and the stake button ([bot-demo.md](bot-demo.md)).
- **#100** — the executor; until it is deployed, every intent is `rejected / executor_not_configured`.
- **#90 / #101 / #29** — the trade's close and result, and the notification after `accepted`. The
  tracker stops at `accepted`.
- **#287 / #284** — the stake chosen by the sizer and the session of five (worker / bot); today the stake is the broker's
  minimum.
- **#121** — real mode.
