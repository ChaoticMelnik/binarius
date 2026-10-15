# Trading mode

A user trades either demo or real, one mode at a time (#121). The mode is a persisted user
state, `users.trading_mode`, switched only by `POST /trading/mode`: the bot's mode screen is #474,
`/stop` returning the user to demo is #473. In real mode the bot's single trade goes to the
broker with real money at the user's real stake (#326: the saved real stake, the broker's minimum
without one), and a session runs in the user's mode (#327): a real session trades real money at
the real stake.

## Components

- `packages/db/src/schema/users.ts` — `trading_mode text not null default 'demo'`,
  `users_trading_mode_check` from `TradeMode` (Rule 1). Every existing user is `demo`.
- `packages/db/src/user-ops.ts` — `setTradingMode`, the one writer.
- `packages/db/src/trade-intent-ops.ts` — the gate in `createInTransaction`.
- `packages/db/src/trading-session-ops.ts` — `checkTradingSessionStart` refuses a user in real
  mode.
- `packages/db/src/token-balance-ops.ts` — `tradingMode` in `POST /trading/access`.
- `packages/shared/src/trading-mode.ts` — the route's contract; `decimalLessThan` in
  `stake.ts`.
- `apps/backend/src/trading/trading-mode.ts` — `POST /trading/mode`.
- `apps/bot/src/keyboards.ts` → `statusCardKeyboard(mode)`; `analysis.ts`, `demo.ts`, `demo-trade.ts`, `stake-picker.ts`, `trading-session.ts` — the paths that follow the
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
replay → `demo_only` → the switch → the account → the stake check (either mode, #326) → the
reserve with this predicate. The replay runs first, so a retry finds its real intent after the user went back to
demo.

The gate is one-directional: a demo intent is never refused by the mode. «One mode at a time»
for the bot's own buttons is held by the access read and the fingerprint (below). Tests:
`trade-intent-ops.db.test.ts` M1–M4, `routes.db.test.ts`.

Sessions (#327): a session runs only in its user's mode. `POST /trading/sessions` carries `mode`;
`checkTradingSessionStart` refuses `mode_not_allowed` when it is not the user's, after the blocked
check and before any account read (`trading-session-start.db.test.ts` E9,
`session-routes.db.test.ts` R21, R23), and `createTradingSession` compares it again in the
statement that locks the `users` row (`trading-session-ops.db.test.ts` C6, C6b, C8, C5c;
`session-routes.db.test.ts` R26). A switch of the mode stops the user's active sessions
`user_stopped` in its own transaction (below), so a session never outlives its mode: a switch
committed before the creation's lock is seen by the comparison, one after it waits and then stops
the new session.

The orchestrator maps `real_mode_off` to a stop `account_unavailable` with `code:
real_mode_off` (`orchestrator.db.test.ts` E9i: a `trading_mode` written by hand under a real
session). A switch through `setTradingMode` during an attempt stops the session `user_stopped`
first; the attempt's reserve then meets `real_mode_off`, whose stop finds the row already stopped
and logs nothing (E9j). A demo session after a switch to real is ended by the switch itself.

## The route

`POST /trading/mode { telegramUserId, mode }` (strict body), inside `tradingRoutes` under the
internal bearer hook.

| Request | Answer |
| --- | --- |
| `mode: demo` | 200 `{ tradingMode: 'demo', changed, stoppedSessions }`; 404 `user_not_found` only |
| `mode: real` on a `DEMO_ONLY` process | 409 `demo_only`, before any read (Rule 33) |
| `mode: real`, no users row | 404 `user_not_found` |
| `mode: real`, no single active account, or no balance snapshot | 409 `balance_unavailable` |
| `mode: real`, `real.available < minTradeAmount` (bigint, `decimalLessThan`) | 409 `real_balance_below_minimum` |
| `mode: real` otherwise | 200 `{ tradingMode: 'real', changed, stoppedSessions }` |
| a body with another key or mode | 400 |

The snapshot is the stored one of any age; there is no broker call. The read and the write are
not one transaction, as for `POST /trading/stake`: the bound is a UX gate, and the broker
refuses a real order above the balance (`broker_rejected`, the token returned). `users.status` and
the kill-switch are not read: a blocked user's trades and a closed switch are refused at creation.

`stoppedSessions` (#327, required in `setTradingModeResponseSchema`) counts the user's active
sessions the switch stopped: `setTradingMode` calls `stopUserSessions` in its transaction after the
`users` UPDATE returned a row (lock order `users` → `trading_sessions`, Rule 5), so the new mode
and the stopped sessions commit together; `0` when the user was in that mode already. No bot reads
it yet: the mode screen (#474) prints «⏹ Активная сессия остановлена.» on `stoppedSessions >= 1`.
Tests: `trading-mode.db.test.ts` T1–T10, `user-ops.db.test.ts` U-mode 6–8.

## The bot

The mode comes from `POST /trading/access` only (`tradingMode`, required: a backend older than
#121 is a contract violation for the bot).

**The card.** The header prints `MODE_LABELS[tradingMode]`, the hint is `statusHint` in demo and
`statusHintReal` in real: «⚠️ Реальный режим: сделки идут на реальные деньги на сумму $X.», X the
real stake in force (#326). The entry is «🎮 Демо-торговля» in demo and «🚀 Торговать» in real, both
`demo`; then «👥 Пригласить друга».

**The mode screen — #474.** Until it lands, real mode is switched only through `POST /trading/mode`
(internal bearer); the bot has no way in or out of real. The screen (enable with a confirm, the
cancel in place, back to demo, the card's mode button) is #474; `/stop` returning the user to demo
is #473, after it.

**The class rule** (Plan 5): the screens of the real path that read no mode (the signals, the
manual choice, the summary) have neutral default texts; the screens that read the mode (the card,
the launch, the analysis and its expansion, the trade's status) speak of it. `real-path.test.ts`
walks every screen a real-mode user can reach on the catalog's defaults and fails on any demo
wording, with a demo control case; a new screen on the path is added to its scenes. Staff
overrides of the texts are not checked by it. The first-session reminders («🎮 Демо-торговля»)
are planned and sent only to a user in demo ([mailing.md](mailing.md)); the «🎮 Демо-торговля»
button under `/account`, the account card and the re-login push stays for a real-mode user too
(accepted: it leads to the neutral duration screen, and every screen with a real-money button
after it says REAL).

**The single trade.** `effectiveStake` is the saved real stake in real mode, or
`broker.minTradeAmount` without one (#326), whatever the demo stake. The analysis reads access for the mode: in real mode the session row marked `· REAL` (#327),
«➕ Ещё» on a signal, the real disclaimer, and the cycle-floor note as in demo
([bot-demo.md](bot-demo.md) → Keyboards). «➕ Ещё»
carries the mode its text was drawn in and draws a stake button only when the expansion's read
gives the same mode.
The expansion in real mode draws the stake button, labelled `… · $Y · REAL`, and «💵 Сумма» of the
real picker (`stk:o:r:a:…`, #326), under the real session row (#327). The fingerprint hashes `real:<amount>` in real mode and the bare
amount in demo (as before #121, so an older demo button still trades): a button drawn in one mode
and pressed in the other is refused with «⚠️ Режим или сумма сделки изменились — открой анализ
заново.» and nothing is created. The press sends `mode: tradingMode` and the key
`<mode>:<telegramUserId>:<nonce>`. `real_mode_off` (the mode went demo between the read and the
POST) → «⚠️ Реальный режим выключен — открой анализ заново.». The status
message's header is «💼 Реальная сделка» for a real view, and a finished real trade offers a real
session («🚀 Сессия из 5 сделок · REAL», #327).

**The launch screen** in real mode (#327) is the one demo drew before #476, drawn by the mode
(demo now draws the amount screen, [bot-demo.md](bot-demo.md#the-amount-screen-476)): «💵 Ставка:
$X» with the real stake in force, «🤖 Бот проведёт 5 сделок подряд… Реальный режим: сделки идут на реальные
деньги.» (`launchCycleReal`), «🚀 Запустить цикл · REAL» (`real:sess:…`), «💵 Изменить ставку» of
the real picker (`stk:o:r:p:…`) and «↩️ К списку»; a pair below the cycle floor gets the floor's
refusal as in demo. The single real trade stays on the manual path. A stake saved from a launch
screen reads the mode the same way and draws the same screen under the saved line of the saved
stake's mode. A failed access read draws the amount screen's refusal («⚠️ Сервис временно
недоступен…» with «🔄 Повторить», #476): without the read no screen of either mode can be drawn.

**Sessions** (#327): every real session door carries `real:sess:…`
([bot-session.md](bot-session.md)), its label `· REAL`, and the status message is headed
«💼 Реальная сессия» for a real session. The demo doors open the amount screen (#476) and carry
`demo:l:…`; an amount starts a demo session.

**`/stop`** (#122) is unchanged: it stops the sessions and leaves the mode. Returning the user to
demo from it is #473 (part 2 of #121, split off by the size rule).

## Timing

`HANDLER_CALLS`: `demoAnalysis` 3 / 4 (47 s, the longest handler with `sessionStart` since #418
and `cycleStakePreset` since #476, under the 50 s shutdown budget), `stakePreset` and `stakeReset` 3 / 3, `stakeText` 3 / 1. `timing.test.ts` runs
every terminal branch.

## Logs

`trading access not read for the launch screen` (warn): `errorLogFields` and `backendErrorFields`, never the Telegram id or an amount (`logging.test.ts`).

## Running it locally

Against the mock broker only, `DEMO_ONLY` unset, with the stand of
[trading-access.md](trading-access.md) plus the worker and the bot:

1. Switch the user to real with the `access` helper of trading-access.md (the internal bearer):
   `access /trading/mode '{"telegramUserId":"<id>","mode":"real"}'` → 200
   `{"tradingMode":"real","changed":true,"stoppedSessions":0}`.
2. `/menu` shows REAL, the real hint and «🚀 Торговать»; «Сигналы сейчас» has no «запустит цикл».
3. A pair opens the launch screen with «🚀 Запустить цикл · REAL» and the real stake; the press
   starts a real session («💼 Реальная сессия», the worker's `trading session intent created`
   lines with `mode: real`, the mock broker's trades `is_demo: false`). The analysis ends with «Реальный режим: сделка идёт на реальные деньги»; «➕ Ещё» shows
   «… · $1.00 · REAL» and «💵 Сумма»; the press gives «💼 Реальная сделка». The manual choice
   reads «🧭 Выбор пары». The real stake (#326): «💵 Сумма» or «💼 Реал» in `/settings` opens the
   real picker («💼 Сумма реальной сделки», «Реальный баланс»); after `$5` is saved the hint reads
   «на сумму $5.00», «➕ Ещё» shows «… · $5.00 · REAL» and the press trades `$5`
   (`trade_intents.amount`).
4. Switch back with `"mode":"demo"` → `"stoppedSessions":1` while the real session runs, the
   session `user_stopped`: the card is DEMO, and the old REAL buttons (stake and session) answer
   «Режим или сумма сделки изменились». With `DEMO_ONLY=true`, `"mode":"real"` → 409 `demo_only`,
   and a session button pressed by a user left in real answers «Реальные сделки на этом сервере
   отключены».

## Boundaries

- **#474** — the mode screen in the bot; then **#473** — `/stop` returning the user to demo.
- **#326** — the real stake and its picker ([bot-demo-trade.md](bot-demo-trade.md#the-stake-297-326));
  the mode screen's stake line and confirm amount are #474's. **#327** (shipped) — real sessions;
  the line «⏹ Активная сессия остановлена.» on the mode screen is #474's, `/stop` → demo #473's.
- **#37** — the grant for real trades with Binodex. The real branch of `open_trade` was not
  observed live ([broker-rest.md](broker-rest.md) → Observed live: one demo trade); the mock
  broker holds both modes.
- A loss limit for real — a future issue. `/settings` names both stakes (#326); the CLI
  `session-start` stays demo.
