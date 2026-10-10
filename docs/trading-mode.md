# Trading mode

A user trades either demo or real, one mode at a time (#121). The mode is a persisted user
state, `users.trading_mode`, switched on only from the mode screen behind the status card and
switched back from that screen or by `/stop`. In real mode the bot's single trade goes to the
broker with real money at the broker's minimum stake; sessions stay demo only.

## Components

- `packages/db/src/schema/users.ts` — `trading_mode text not null default 'demo'`,
  `users_trading_mode_check` from `TradeMode` (Rule 1). Every existing user is `demo`.
- `packages/db/src/user-ops.ts` — `setTradingMode`, the one writer.
- `packages/db/src/trade-intent-ops.ts` — the gate in `createInTransaction`.
- `packages/db/src/trading-session-ops.ts` — `checkTradingSessionStart` refuses a user in real
  mode.
- `packages/db/src/token-balance-ops.ts` — `tradingMode` in `POST /trading/access`.
- `packages/shared/src/trading-mode.ts` — the route's contract; `decimalLessThan` in
  `demo-stake.ts`.
- `apps/backend/src/trading/trading-mode.ts` — `POST /trading/mode`.
- `apps/bot/src/trading-mode.ts` — the mode screen; `keyboards.ts` → `statusCardKeyboard(mode)`;
  `demo.ts`, `demo-trade.ts`, `stake-picker.ts`, `trading-session.ts` — the paths that follow the
  mode.

## The column and its writer

`setTradingMode(db, telegramUserId, mode)` runs one transaction: `UPDATE users SET trading_mode
= $mode WHERE telegram_user_id = $id AND trading_mode <> $mode RETURNING id`. A row means a
change: one `audit_log` row in the same transaction (`actor_type = user`, `actor_id` = the
Telegram id as text, `action = trading_mode_changed`, `entity_type = user`, `entity_id` =
`users.id`, `payload = { from, to }`) and `{ tradingMode, changed: true }`. No row: a
`SELECT` tells «already in that mode» (`changed: false`, nothing written) from «no user»
(`undefined`). Two concurrent switches serialize on the row lock, so one actual change writes one
audit row. It locks only the users row (Rule 5). Tests: `user-ops.db.test.ts` U-mode 1–5.

## The gate

`createInTransaction`'s reserve UPDATE carries `trading_mode = 'real'` for a `mode: real` intent.
The predicate is in the statement that locks the users row: a switch to demo either committed
before it (the predicate is false) or waits for the creation to commit. Zero rows are diagnosed
by one fresh read, in this order: `blocked` → `user_blocked`; a real input with the mode not
`real` → 409 `real_mode_off`; otherwise `insufficient_tokens`. The whole order of creation:
replay → `demo_only` → the switch → the account → the demo-stake check → the reserve with this
predicate. The replay runs first, so a retry finds its real intent after the user went back to
demo.

The gate is one-directional: a demo intent is never refused by the mode. «One mode at a time»
for the bot's own buttons is held by the access read and the fingerprint (below). Tests:
`trade-intent-ops.db.test.ts` M1–M4, `routes.db.test.ts`.

The orchestrator maps `real_mode_off` to a stop `account_unavailable` with `code:
real_mode_off`; it is reachable only for a real session row, which nothing creates until #327
(`orchestrator.db.test.ts` E9i).

Sessions: `checkTradingSessionStart` refuses `mode_not_allowed` for a user whose mode is not
`demo`, after the blocked check and before any account read (`trading-session-start.db.test.ts`
E9, `session-routes.db.test.ts` R21). It is not re-read inside `createTradingSession`'s
transaction: a switch to real between the two reads leaves a demo session trading demo money.

## The route

`POST /trading/mode { telegramUserId, mode }` (strict body), inside `tradingRoutes` under the
internal bearer hook.

| Request | Answer |
| --- | --- |
| `mode: demo` | 200 `{ tradingMode: 'demo', changed }`; 404 `user_not_found` only |
| `mode: real` on a `DEMO_ONLY` process | 409 `demo_only`, before any read (Rule 33) |
| `mode: real`, no users row | 404 `user_not_found` |
| `mode: real`, no single active account, or no balance snapshot | 409 `balance_unavailable` |
| `mode: real`, `real.available < minTradeAmount` (bigint, `decimalLessThan`) | 409 `real_balance_below_minimum` |
| `mode: real` otherwise | 200 `{ tradingMode: 'real', changed }` |
| a body with another key or mode | 400 |

The snapshot is the stored one of any age; there is no broker call. The read and the write are
not one transaction, as for `POST /trading/demo-stake`: the bound is a UX gate, and the broker
refuses a real order above the balance (`broker_rejected`, the token returned). `users.status` and
the kill-switch are not read: a blocked user's trades and a closed switch are refused at creation.
Tests: `trading-mode.db.test.ts` T1–T8.

## The bot

The mode comes from `POST /trading/access` only (`tradingMode`, required: a backend older than
#121 is a contract violation for the bot).

**The card.** The header prints `MODE_LABELS[tradingMode]`, the hint is `statusHint` in demo and
`statusHintReal` in real. The first row is the entry and the mode button: demo → «🎮
Демо-торговля» `demo` + «💼 Реальный режим» `mode`; real → «🚀 Торговать» `demo` + «🎮 Вернуться в
демо» `mode`; then «👥 Пригласить друга».

**The mode screen.** `mode` sends it as a new message (the card is a photo); `mode:r`, `mode:r:ok`
and `mode:d` edit in place (shown → done, gone → sent anew, transport → nothing more, anything
else → `bot.catch`). The screen: «⚙️ Режим торговли», «Сейчас: DEMO|REAL», the real balance and
the broker's minimum when there is a snapshot, the warning, «⏸ Торговля сейчас приостановлена…»
while the switch is closed (the enable step stays: the kill-switch does not refuse it), then
«💼 Включить реальный режим» (`mode:r`) in demo or «🎮 Вернуться в демо» (`mode:d`) in real, and
«🏠 В меню». A user in demo mode with no balance gets the stake picker's reason instead
(`accountNone` + the connect button, `statusAmbiguous`, `stakeBalanceMissing`) and no enable step;
a user in real mode always gets the screen, so the way back stays open. `mode:r` reads access
again for the confirm: «Включить реальный режим? Сделки пойдут на реальные деньги по минимальной
ставке брокера ($Y).» with «✅ Подтверждаю» (`mode:r:ok`) and «↩️ Отмена» (`mode`).

| Switch answer | Bot |
| --- | --- |
| 200 | `modeEnabled` / `modeDisabled` by the mode the server answered, «🏠 В меню» |
| 409 `real_balance_below_minimum` | `modeBelowMinimum`, «⚙️ Режим» + menu |
| 409 `balance_unavailable` | `stakeBalanceMissing`, the same buttons |
| 409 `demo_only` | `tradingDemoOnly`, the same buttons |
| 404 `user_not_found` | `unavailable` + warn `trading mode not changed` |
| 400, another 4xx | `unavailable` + error `trading mode not changed` |
| 5xx, no answer, a broken body | warn `trading mode outcome unknown`, access read again, the screen with the mode found; that read failing → `modeOutcomeUnknown` |

`mode:r:ok` and `mode:d` are writes (`WRITE_CALLBACK_PREFIXES`): no «🔄 Повторить» carries them.

**The single trade.** `effectiveStake` is `broker.minTradeAmount` in real mode, whatever the demo
stake. The analysis reads access for the mode: in real mode no session row, «➕ Ещё» on a signal.
The expansion in real mode draws only the stake button, labelled `… · $Y · REAL`; no «💵 Сумма»
(#326), no session row (#327). The fingerprint hashes `real:<amount>` in real mode and the bare
amount in demo (as before #121, so an older demo button still trades): a button drawn in one mode
and pressed in the other is refused with «⚠️ Режим или сумма сделки изменились — открой анализ
заново.» and nothing is created. The press sends `mode: tradingMode` and the key
`<mode>:<telegramUserId>:<nonce>`. `real_mode_off` (the mode went demo between the read and the
POST) → «⚠️ Реальный режим выключен — включи его в меню и открой анализ заново.». The status
message's header is «💼 Реальная сделка» for a real view, and a real trade gets no session offer.

**The launch screen** in real mode keeps the pair's lines and shows «💼 Циклы — только в демо; в
реальном режиме — разовая сделка по анализу.» with «📊 Анализ пары» (the analysis) and «↩️ К
списку». A stake saved from a launch screen reads the mode the same way. A failed access read
keeps the demo screen: its cycle press gets `mode_not_allowed` → «Сессии пока доступны только в
демо-режиме — вернись в демо через меню.».

**`/stop`** (#122) also calls `setTradingMode(demo)` beside `stopSessions` and `readPairs`. On
`changed: true` it sends «🎮 Режим: DEMO — следующие сделки пойдут на демо.» before #122's message;
a user already in demo gets #122's message alone; no users row says nothing more; any other
failure → warn `trading mode not reset` and «⚠️ Режим не переключён — открой /menu.». The sessions
are stopped either way.

## Timing

`HANDLER_CALLS`: `modeOpen` 1 / 2, `modeConfirm` 1 / 3, `modeSet` 2 / 3 (the access read on an
unknown outcome), `stop` 3 / 2, `demoAnalysis` 3 / 4 (47 s, the longest handler, under the 50 s
shutdown budget), `stakePreset` and `stakeReset` 3 / 3, `stakeText` 3 / 1. `timing.test.ts` runs
every terminal branch.

## Logs

`trading access not read for the mode screen` (warn), `trading mode not changed` (warn for
`user_not_found`, error otherwise), `trading mode outcome unknown` (warn), `trading mode not
reset` (warn), `trading access not read for the launch screen` (warn): `errorLogFields` and
`backendErrorFields`, never the Telegram id or an amount (`logging.test.ts`).

## Running it locally

Against the mock broker only, with the stand of [trading-access.md](trading-access.md) plus the
worker: `/menu` → «💼 Реальный режим» → «💼 Включить реальный режим» → «✅ Подтверждаю»; `/menu`
shows REAL; «🚀 Торговать» → a duration → a pair → «📊 Анализ пары» → «➕ Ещё» → the REAL stake
button; the status message reads «💼 Реальная сделка». `/stop` returns the user to demo.

## Boundaries

- **#326** — the real stake amount and its picker. **#327** — real sessions: lifting
  `mode_not_allowed`, the session route in the user's mode.
- **#37** — the grant for real trades with Binodex. The real branch of `open_trade` was not
  observed live ([broker-rest.md](broker-rest.md) → Observed live: one demo trade); the mock
  broker holds both modes.
- A loss limit for real — a future issue. `/settings` and the CLI `session-start` stay demo.
