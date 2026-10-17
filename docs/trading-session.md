# Trading sessions (issues #130, #283, #287)

A trading session is a run of `settings.cycles` cycles on one broker account (#552; a row of
before it, `settings.trades` trades), one trade at a time, in the session's `mode`. A cycle is the
stake sizer's series: under martingale it ends with a win, so its trades are one to
`MARTINGALE_MAX_STEPS`; under fixed every trade is its own cycle. #130 lays the data layer: the `trading_sessions` table with its
constraints, the `settings` contract and the stop reasons in `packages/shared`, and the database
operations the session orchestrator calls. #283 adds the backend routes that start, read and stop
a session ([Routes](#routes)); since #327 a session runs in the user's trading mode, demo or real
([trading-mode.md](trading-mode.md)). #287 adds the orchestrator in the
worker ([The orchestrator](#the-orchestrator)): every tick it stops the sessions the kill switch,
the deadline or a halt ends, then asks the backend for the pair and the signal, sizes the stake
and creates the session's next intent, which the existing intent path sends to the broker. The
`session-start` CLI ([The CLI](#the-cli)) starts a demo session without the bot.

```bash
pnpm test --project unit packages/shared/src/trading-session.test.ts packages/shared/src/catalog.test.ts
# TEST_DATABASE_URL: README -> Test database
pnpm test --project integration packages/db/src/trading-session-ops.db.test.ts packages/db/src/trading-session-start.db.test.ts packages/db/src/schema.db.test.ts apps/backend/src/trading/session-routes.db.test.ts
pnpm test --project unit apps/trading-worker/src/trading-session apps/trading-worker/src/intents/config.test.ts
pnpm test --project integration apps/trading-worker/src/trading-session/orchestrator.db.test.ts apps/trading-worker/src/cli/session-start.db.test.ts
```

## Components

| Piece | Where | What |
|---|---|---|
| Settings v1/v2/v3, statuses, stop reasons | `packages/shared/src/trading-session.ts` (`@binarius/shared/trading-session`) | `tradingSessionSettingsSchema`, `buildSessionSettings`, `sessionStakeParams`, `martingaleLimitsFor` (#450), `sessionProgress` (#552), `TradingSessionStatus`, `TradingSessionStopReason`, `stakeSettingsFor`, `MAX_SESSION_CYCLES` 20, `DEFAULT_SESSION_CYCLES` 5, `MIN_SESSION_DURATION_SEC` 5, `MAX_SESSION_SUMMARY_TRADES` 720 |
| Wire contracts (#283) | the same file | the routes' request, view and refusal schemas, `TradingSessionErrorCode`, `sessionFitsDeadline`, `SESSION_MAX_DURATION_MS`, `TRADING_SESSION_START_BUDGET_MS` |
| Pair predicates (#283) | `packages/shared/src/catalog.ts` | `isPairOpen`, `pairAcceptsDuration`; the bot's demo checks and the start route both call them |
| Routes (#283) | `apps/backend/src/trading/session-routes.ts` | `POST /trading/sessions`, `GET /trading/sessions/:id`, `POST /trading/sessions/:id/stop`, `POST /trading/sessions/:id/summary` (#318), `POST /trading/sessions/stop` (#122), `POST /trading/sessions/:id/status-message`, `POST /trading/sessions/:id/status-message/lost` and `GET /trading/sessions/tracked` (#567) behind the internal bearer |
| Table | `packages/db/src/schema/trading-sessions.ts`, migration `0018_trading_session_orchestration` | the columns and constraints below |
| Operations | `packages/db/src/trading-session-ops.ts` | create, the runnable scan, the two stop sweeps, the history, the CAS stop, the decision mark, the session intent; the start check and the owner-scoped view (#283) |
| Session lock | `packages/db/src/trade-intent-ops.ts` → `createInTransaction` | the session row locked inside the intent's creation transaction |
| Orchestrator (#287) | `apps/trading-worker/src/trading-session/orchestrator.ts` | the tick, the three sweeps, the attempt and its endings |
| Backend clients (#287) | `apps/trading-worker/src/trading-session/backend.ts` | `POST /trading/signal`, `GET /trading/pairs` under the internal bearer |
| Constants (#287) | `apps/trading-worker/src/trading-session/config.ts` | `TRADING_SESSION_*`, the chain checked at import |
| CLI (#287) | `apps/trading-worker/src/cli/session-start.ts`, `trading-session/start.ts` | `session-start`: a demo session for a user's account |

## The table

| Column | Meaning |
|---|---|
| `status` | `active` → `stopped`; `paused` exists in the status list and nothing writes it |
| `settings` | jsonb object (CHECK `trading_sessions_settings_object_check`), settings v3 (v1 and v2 read) below; the column default `'{}'` is valid in neither |
| `stop_reason` | one of `TradingSessionStopReason` (CHECK `trading_sessions_stop_reason_check`) |
| `started_at`, `ended_at` | the insert's `now()`; the stop's `now()` |
| `last_decision_at` | the runnable scan's order key; NULL until the orchestrator first reached an ending |
| `summary_sent_at` | NULL until the session's summary card is claimed (#318): set once by `claimSessionSummary`'s CAS, never cleared; no CHECK and no index (the claim updates by primary key) |
| `notified_trades` | the session notices' cursor (#464, [bot-session.md](bot-session.md#trade-messages-and-the-summary-464)): how many of the session's settled trades, in creation order, the backend's sender claimed for sending; NOT NULL default 0, CHECK `trading_sessions_notified_trades_check` (`>= 0`); raised by one by `claimSessionTradeNotice`'s CAS, lowered by one only by `releaseSessionTradeNotice` |
| `final_notice_sent_at` | NULL until the session's summary message is claimed (#464): set by `claimSessionFinalNotice`'s CAS — since #536 only with `waiting_message_id is null`, so the summary comes after the waiting message is gone — taken back only by `releaseSessionFinalNotice` while `summary_sent_at` is NULL; `trading_sessions_notice_pending_idx (created_at) where final_notice_sent_at is null` is the sender's scan |
| `cycle_message_id`, `cycle_message_from` | the session's cycle message (#551, migration 0054, [bot-session.md](bot-session.md#the-state)): Telegram's `message_id` of the message the next step of the same martingale cycle edits, and the index (from 0, in the cursor's order) of the first settled trade it shows; both NULL until a new message of the session was sent, never cleared. CHECKs `trading_sessions_cycle_message_pair_check` (both or neither), `…_id_check` (`> 0`), `…_from_check` (`>= 0`). One writer: `recordSessionCycleMessage`, a CAS on `notified_trades = claimed + 1` and `final_notice_sent_at is null`, after Telegram answered the send |
| `waiting_message_id`, `waiting_after_message` | the waiting message under the session's messages (#536, migration 0061, [bot-session.md](bot-session.md#the-waiting-message-536)): Telegram's `message_id` of the live «🔎 Ждём сигнал…» with its «⏹», NULL when there is none; and its slot, `coalesce(cycle_message_id, 0)` when it was claimed, NULL while none is claimed. CHECKs `trading_sessions_waiting_message_id_check` (`> 0`), `…_waiting_after_message_check` (`>= 0`), `…_waiting_pair_check` (an id only on a claimed slot). Written only by the backend's sender, each a CAS on the row: `claimSessionWaiting` (the slot, before the send), `recordSessionWaitingMessage` (the id on its own slot, while active), `releaseSessionWaiting` (the slot freed after a certain refusal), `clearSessionWaitingMessage` (the id dropped and the slot freed after the delete). No backfill: NULL at the deploy, so a running session is due at the backend's start |
| `status_message_id` | the bot's status message of the session (#567, migration 0055, [bot-session.md](bot-session.md#recovery-after-a-restart-567)): Telegram's `message_id` of the first status message the bot tracked the session on, NULL until its first poll recorded one, and again once the bot reports it lost; CHECK `trading_sessions_status_message_id_check` (`> 0`). Two writers, both CAS with the owner in the predicate: `recordSessionStatusMessage` on `status_message_id is null`, or equal to `replacesMessageId` when the record names the message it was sent in place of (the first id wins while it lives) and `forgetSessionStatusMessage` on `status_message_id = $messageId` (sets NULL); `trading_sessions_tracked_idx (started_at) where status_message_id is not null and summary_sent_at is null` is the recovery list's scan |
| `last_signal_action` | `up`/`down` (CHECK `trading_sessions_last_signal_action_check` from `TradeAction`) or NULL: the direction the last deciding attempt saw — the traded action, the paused one — and NULL after a `no_signal` or before any decision ([The pause after two losses](#the-pause-after-two-losses-379), #379) |

- **One active session per account:** `trading_sessions_active_account_idx`, unique on
  `broker_account_id` where `status = 'active'`. Stopped sessions are unlimited.
- **`stop_reason` and `ended_at` exactly on `stopped` rows:** two CHECKs,
  `trading_sessions_stop_reason_pair_check` (`(status = 'stopped') = (stop_reason is not null)`)
  and `trading_sessions_ended_at_pair_check` (the same for `ended_at`). One combined CHECK would
  accept `paused`/reason/no end and `active`/no reason/an end, since `false = false` holds.
- `trading_sessions_runnable_idx (last_decision_at asc nulls first, created_at) where status =
  'active'` has the scan's predicate and order, so the scan reads it in order and stops at its
  limit (no sort step).
- A session intent ties to its session through the existing composite FK
  `trade_intents_session_account_fk (trading_session_id, broker_account_id, mode)`: a demo session
  cannot parent a real intent, nor an intent of another account.

## Settings

Version 3 is the one written (#552): the session's length is `cycles`, 1–`MAX_SESSION_CYCLES`
(20). The stake carries the strategy, and martingale its limits (#450):

```json
{ "version": 3, "assetId": 101, "durationSec": 60, "cycles": 5,
  "stake": { "strategy": "martingale", "baseStake": "1.55", "stakeScale": 2,
             "limits": { "maxSteps": 4, "maxStake": "18.6", "maxSessionLoss": "31",
                         "maxSessionDurationMs": 3600000 } } }
```

`stake` is `{ strategy: 'fixed', baseStake, stakeScale }` or `{ strategy: 'martingale', baseStake,
stakeScale, limits }`, a union on `strategy`: a fixed stake with `limits` and a martingale one
without are refused. `limits.maxSteps` is an integer ≥ 2, `maxStake` and `maxSessionLoss` amounts
inside `numeric(20,8)`, `maxSessionDurationMs` an integer ≥ 1; the rules against `baseStake` are
the sizer's `assertStakeParams`, which the CLI and the orchestrator run.

Version 2, the rows of #450 to #552, has the same stake and its length in `trades`, 1–20; it is
still read, and such a session completes on its `trades`-th settled trade, as it did
(`sessionProgress`, `orchestrator.db.test.ts` G10). Version 1, the rows of before #450, is still
read too:

```json
{ "version": 1, "assetId": 101, "durationSec": 60, "trades": 5,
  "stake": { "baseStake": "1", "stakeScale": 0 } }
```

It has no strategy and reads as `fixed`: `sessionStakeParams(settings)` turns every version into
the sizer's parameters, and the orchestrator and the trade messages read the strategy only
through it. So a session started before the deploy trades on as it started.

All are strict objects: an unknown key or version is refused, `trades` in v3 and `cycles` in v1/v2
too. `assetId` is the intent request's own schema; `durationSec` is the intent request's and at
least `MIN_SESSION_DURATION_SEC` (5, #552) in every version: a trade shorter than the shortest
candle its signal is decided on (`SIGNAL_SHORTEST_INTERVAL_MS`, pinned in
`trading-session.test.ts`) has no signal of its own, and the floor bounds the trades an hour holds
(`MAX_SESSION_SUMMARY_TRADES`). `baseStake` is in `numeric(20,8)` and `stakeScale` 0–8. The column is checked when it is read, not when it is written: the orchestrator parses it and
stops a session whose settings fail as `invalid_settings`, so a row written by hand is a boundary
too. The bot's view and the admin list ([admin-pages.md](admin-pages.md), #330) show such settings
as null.

**The session's progress** is `sessionProgress(settings, { settled, won })` → `{ planned, done }`,
the one rule both the orchestrator's completion and the view's `cycles` read: v1/v2 — `planned =
trades`, `done = settled`; v3 fixed — `planned = cycles`, `done = settled`; v3 martingale —
`planned = cycles`, `done = won` (only a win closes a cycle, as the sizer's `readHistory` resets its
series on a positive profit and the trade messages' `sessionTradeSteps` start a new cycle after
one; `session-steps.test.ts` holds the two equal over every history of up to six trades). A loss,
a tie and a `rejected` intent close no cycle.

**The strategy is frozen at the start.** Both writers, the start route and the `session-start`
CLI, build the row with `buildSessionSettings({ assetId, durationSec, cycles, stake, strategy })`
from `SESSION_STAKE_STRATEGY` (`parseSessionStakeStrategyEnv`: `martingale` or `fixed`, unset
`martingale`, anything else stops the process at start; compose forwards it valueless through
`x-broker-environment`, so `backend` and `trading-worker` read one value of `.env`). For
`martingale` it adds `martingaleLimitsFor(baseStake)` ([stake.md](stake.md#defaults): 4 steps,
12 × B, 20 × B, 1 h). The orchestrator never reads the variable, so switching it changes new
sessions only (`session-routes.db.test.ts` R41, `orchestrator.db.test.ts` G7). After a change,
`docker compose up -d backend trading-worker`.

`stakeSettingsFor(minTradeAmount)` derives the fixed stake from the account's broker minimum:
the canonical spelling (leading and trailing zeros stripped, as `normalizeDecimal` in
`@binarius/db`; `trading-session-ops.db.test.ts` holds the two equal) and its own fraction length
as the scale — `'1.00000000'` → `{ '1', 0 }`, `'0.50000000'` → `{ '0.5', 1 }`, `'0.00000001'` →
`{ '0.00000001', 8 }`. Every positive minimum therefore passes the sizer's parameter check. A
stored minimum of 0 is valid in the snapshot but gives `baseStake '0'`, which the settings refuse: the start
route answers `balance_unavailable` and the CLI `zero_min_trade_amount`, both before writing (#130
review n1).

The start route takes the user's saved stake of the session's mode (#297 demo, `users.demo_stake`;
#327 real, `users.real_stake`; read with `readStakes`) through `stakeSettingsFrom(savedStake,
minTradeAmount)`: `NULL` gives
`stakeSettingsFor(minTradeAmount)` exactly as before; a saved stake gives `{ baseStake: its
canonical spelling, stakeScale: max(2, scale(minimum)) }` (`stakeScale`, the minimum's grid). The
route ran `checkStake` against the same minimum first (step 6a), so a saved stake never has more
fraction digits than that grid and stays on the grid the sizer steps on. The CLI `session-start`
keeps the broker minimum.

## Stop reasons

| Reason | Meaning | Writer |
|---|---|---|
| `completed` | the session's last cycle closed: `sessionProgress` done reached planned (#552; v1/v2 — settled trades reached `settings.trades`) | the orchestrator (#287) |
| `manual_review` | the account is halted, or an intent of the session is in `manual_review` | `stopHaltedSessions`; the orchestrator's attempt on `account_halted` |
| `rejected_twice` | the last two intents of the session are `rejected` | the orchestrator (#287) |
| `timeout` | `started_at` + the maximum duration passed (database clock) | `stopExpiredSessions` |
| `stake_stop` | the stake sizer answered stop with a data, minimum or balance code (in the log line) | the orchestrator (#287) |
| `max_steps_exceeded`, `max_stake_exceeded`, `max_session_loss_exceeded`, `session_duration_exceeded` | the sizer's martingale limit of the same name ([stake.md](stake.md#defaults)); `session_duration_exceeded` is the hour on the worker's clock, which `timeout` on the database's clock usually ends first | the orchestrator (#450, `STAKE_STOP_REASONS`) |
| `account_unavailable` | intent creation refused for a durable reason | the orchestrator (#287) |
| `pair_unavailable` | the pair left the catalog or refuses the duration | the orchestrator (#287) |
| `balance_unavailable` | no balance snapshot row for the account | the orchestrator (#287) |
| `invalid_settings` | settings fail the schema or the sizer's parameter rules | the orchestrator (#287) |
| `user_stopped` | the stop routes; a switch of the user's trading mode (`setTradingMode`) | #283, #122, #327 |
| `kill_switch` | the global trading switch is closed ([kill-switch.md](kill-switch.md)) | `stopPausedSessions` (#144), the tick's first sweep; the attempt on `trading_paused` |
| `no_signal_timeout` | the session waited for a signal `SESSION_NO_SIGNAL_TIMEOUT_MS` (2 min) — a closed pair, `no_signal`, the pause after two losses ([The no-signal limit](#the-no-signal-limit-509)) | the orchestrator (#509) |

Since #509 a pair whose payout fell below the floor after the start neither waits nor stops: the
session trades on its signals ([The payout floor](#the-payout-floor-379)).

## Operations

| Operation | Statement | Notes |
|---|---|---|
| `createTradingSession(db, { telegramUserId, brokerAccountId, mode, settings }, { demoOnly })` | one transaction | with `demoOnly` (required: the process's `DEMO_ONLY`, #396) refuses a `real` session first, before any read (`demo_only`); reads the account of that owner (an unknown id or another user's account → `account_not_found`), locks `users` `FOR NO KEY UPDATE` with `status = active` (`user_not_active`) and compares the session's mode with `users.trading_mode` in the same statement's row (`mode_not_allowed`, #327: a switch committed before the lock is seen, one after it waits for the creation and then stops the session), then `broker_accounts` `FOR NO KEY UPDATE` (`account_revoked`, `account_not_confirmed` for `pending`, `account_halted`), then reads the trading switch without a lock (`trading_paused` while it is closed or its row is missing, #144); the active-session index → `active_session_exists`. Errors are `TradingSessionError` with a `TradingSessionDbErrorCode`, not a wire contract: the start route maps each one ([Routes](#routes)) |
| `checkTradingSessionStart(db, { telegramUserId, brokerAccountId? })` | plain selects, no lock | the start route's refusals, the first that applies wins: the trading switch (`trading_paused` while it is closed, #144), the user (`user_not_found`, `user_blocked`), the account by `resolveTradingAccount` — the single trade's rule (`broker_account_not_found`, `account_not_confirmed`, `ambiguous_broker_account`) —, its status (`account_revoked`, `account_not_confirmed`, `account_halted`), an active session of the account (`active_session_exists` with its id), then fewer than one available token (`insufficient_tokens`). On success: the account and its token expiry |
| `readTradingSessionView(db, id, telegramUserId)` | three selects in one `REPEATABLE READ` read-only transaction | the session joined to its account's user, so another user's id and a missing one are both `undefined`; the counters over the session's own intents (`settled`, `rejected`; `won`/`lost`/`tied` by the sign of the linked `broker_trades.profit`, compared in SQL); the newest intent by `created_at desc, id desc`. `settings` that fail every version read as `null`, with `cycles` `{ planned: 0, closed: 0 }`; otherwise `cycles` is `sessionProgress` over the same counters (#552) |
| `readActiveTradingSessionView(db, brokerAccountId, telegramUserId)` | two reads | the account's active session as its owner sees it; `undefined` when none, or when it ended between the reads |
| `listRunnableSessions(db, { limit, maxDurationMs, exclude })` | one select (`trading_sessions_runnable_idx`) | `active`, within the deadline (`started_at >= now() − maxDurationMs`, the expiry sweep's boundary on the database clock, so a session the capped sweep left over is never listed), and no non-terminal intent on the account (the active-intent index's own predicate, so a bot trade holds the session too); `last_decision_at asc nulls first, created_at`; `settings` raw, `last_signal_action` with the row |
| `stopExpiredSessions(db, { maxDurationMs, limit })` | one UPDATE | `started_at < now() − maxDurationMs` → `stopped`/`timeout` |
| `stopHaltedSessions(db, { limit })` | one UPDATE | the account `trading_halted`, or an intent of the session in `manual_review` → `stopped`/`manual_review` |
| `stopPausedSessions(db, { limit })` | one UPDATE | every active session while the trading switch is closed (`not tradingOpenSql`) → `stopped`/`kill_switch` (#144); only a person starts one again. The orchestrator's tick runs it first |
| `stopTradingSession(db, { id, reason })` | one UPDATE | CAS on `status = active`: a second stop finds nothing and the first reason stays |
| `stopUserSessions(exec, { telegramUserId })` | one UPDATE | the stop routes pass `db`, `setTradingMode` its transaction (#327); every `active` session whose account belongs to `users.telegram_user_id` → `stopped`/`user_stopped` (#122); the owner is the predicate (a subquery joining `broker_accounts` and `users`, no lock on them), so another user's id stops nothing; `status = active` is the CAS, so a session another writer stopped first keeps its reason and is not returned. No limit: one active session per account |
| `markSessionDecision(db, { id, signalAction? })` | one UPDATE | `last_decision_at = now()` on an active session; `signalAction` (#379): absent leaves `last_signal_action`, `null` clears it, an action sets it |
| `readSessionHistory(db, sessionId, { maxDurationMs })` | two selects | the owner's `telegram_user_id`, `expired` (the same deadline boundary, database clock, at this read) and the session's own intents in creation order with `action`, `status`, `amount`, `last_error` and the linked `broker_trades.profit` |
| `createSessionIntent(db, input)` | `createTradeIntent`'s transaction | the request key `session:<id>:<step>`, so a repeated step is a replay and the same step with other terms is `client_request_id_conflict`; the session lock below; after the INSERT, `last_signal_action` = the intent's action on the session row the transaction holds (#379, D6) — a replay and a refused session leave it |

Every stop writes `ended_at`, `last_decision_at` and `updated_at` as `now()`; every UPDATE that
changes `status` carries `status = 'active'` in its WHERE.

**The session lock.** `createTradeIntent(db, input, session?)` takes an optional session;
with one, `createInTransaction` locks the session row `FOR NO KEY UPDATE` with the account, the
intent's mode and `status = active` after the account lock and before the insert, and throws
`TradingSessionNotActiveError` when no such row exists — the transaction rolls back with its reserve.
A stop committed after the orchestrator read the session therefore never gets an intent, and a
stop that arrives during the insert waits for the commit. The route never passes a session; its
intents keep `trading_session_id` NULL.

**Lock order** (Rule 5): `users → broker_accounts → trading_sessions → trade_intents`. The stops
and the decision mark are single UPDATEs of `trading_sessions` that take no lock on another
table, so they never hold a lock a creator waits for while waiting on one it holds (stated: no
test holds a lock against them).

The session argument is public: `createTradeIntent` is exported from `@binarius/db`, and nothing
but convention keeps callers other than `createSessionIntent` from passing one (stated). The
lock still applies to any caller, so such an intent is always tied to an active session of its
account and mode.

## Routes

Every route here sits behind the internal bearer (`internalBearerAuth`, an encapsulated plugin like
`pairsRoutes`); a refusal body is `{ error }` with a `TradingSessionErrorCode`, except
`active_session_exists` (`{ error, session }`), the summary's `summary_unavailable` and a 400
(`{ error: 'validation', issues }`). `safeParseTradingSessionResponse` and
`safeParseTradingSessionRefusal` read them; the summary's own `safeParseSessionSummary*`.

### POST /trading/sessions

Body `{ telegramUserId, brokerAccountId?, mode, assetId, durationSec, cycles? }` (strict; `mode`
is required, `demo` or `real`, the mode the bot's button was drawn in, #327; `cycles` defaults to
`DEFAULT_SESSION_CYCLES`, 1–20 like the settings, and `trades` is refused since #552;
`durationSec` is at least `MIN_SESSION_DURATION_SEC`, 5). The steps in order; every refusal
comes before `createTradingSession`, so no 4xx leaves a `trading_sessions` row:

| # | Step | Refusal |
|---|---|---|
| 1 | the body | 400 `validation` |
| 2 | `sessionFitsDeadline(cycles, durationSec, strategy)` with the process's `SESSION_STAKE_STRATEGY` (#552): the worst case, `cycles × steps × (durationSec + 120 s)` within `SESSION_MAX_DURATION_MS` (1 h), `steps` `MARTINGALE_MAX_STEPS` (4) under martingale and 1 under fixed; ties add trades nothing bounds, and such a session ends with `timeout` (accepted) | 409 `session_too_long` (5 cycles of 300 s: 201 under fixed, 409 under martingale, R5b) |
| 3 | `checkTradingSessionStart({ mode })` | 409 `trading_paused` first; 404 `user_not_found`; 409 `user_blocked`; 409 `mode_not_allowed` when `mode` is not the user's `trading_mode` (#327, before any account read); 404 `broker_account_not_found`; 409 `ambiguous_broker_account`, `account_not_confirmed`, `account_revoked`, `account_halted`, `insufficient_tokens`, `active_session_exists` |
| 4 | the pairs cache: missing or not `fresh` | 503 `catalog_unavailable` (the string `GET /trading/pairs` answers) |
| 4 | the pair absent, `!isPairOpen(pair, now)`, or `!pairAcceptsDuration(pair, durationSec)` | 409 `pair_unavailable` |
| 4b | `!pairPayoutAccepted(pair)`: the payout below `MIN_CYCLE_PAYOUT_PCT` (#379) | 409 `payout_too_low` (R19; exactly 80 starts, R20); the signal is not asked (R33) |
| 4c | the pair's signal on the current candle (#509): `signals.evaluate({ assetId, interval: intervalForDuration(durationSec), digits })`, the cached feed `POST /trading/signal` reads, in parallel with steps 5–5b; its refusal answers before theirs (R32b) | 503 `signal_unavailable` on `fetch_failed` (`rate_limited` included) or a throw (R29); 409 `no_signal` on a `no_signal` decision (R28) |
| 5 | `touchBalanceRequested`, then the stored balance snapshot, of any age (the sizer checks the balance before every trade) | — |
| 5a | no snapshot and the access token expires within `ACCESS_SKEW_MS`: the refresh runs in the background | 409 `balance_unavailable` at once; the caller retries |
| 5b | no snapshot: `balance.refresh` awaited for at most `TRADING_ACCESS_REFRESH_BUDGET_MS` (3 s), then a re-read | 409 `balance_unavailable` when still none |
| 6a | `checkStake(savedStake ?? minTradeAmount, { minTradeAmount, available })` on the same snapshot (#297): the saved stake and `available` of the session's mode, `demo_stake`/`demo.available` or `real_stake`/`real.available` (#327) | 409 `stake_precision`, `stake_below_minimum` or `insufficient_balance`; without a saved stake, a minimum above that mode's balance is refused here rather than as `stake_stop` on the first trade |
| 6 | `buildSessionSettings` with `stake = stakeSettingsFrom(savedStake, minTradeAmount)` and the process's `SESSION_STAKE_STRATEGY` (#450): settings v3, for martingale with the limits of that stake | 409 `balance_unavailable` when the stored minimum is 0 (a valid snapshot value that gives `baseStake '0'`, which the settings refuse) or a martingale limit would leave `numeric(20,8)`, with a `warn` line |
| 7 | `createTradingSession(…, mode)` | its refusal mapped: `account_not_found` → 404 `broker_account_not_found`; `account_revoked`, `account_not_confirmed`, `account_halted`; `user_not_active` → `user_blocked`; `active_session_exists`; `trading_paused`; `mode_not_allowed` (409: a switch of the mode between step 3 and the users lock, #327); `demo_only` (409, #396: a real session on a `DEMO_ONLY` backend from a user whose `trading_mode` is `real` — set before the flag or by hand) |
| 8 | 201 `{ session }` | — |

- **The view on `active_session_exists`.** A second start — a double press, or a retry after a
  timeout that fired once the first had committed — gets the account's active session in
  `session`, so the caller learns what exists from the answer rather than from the code. `null`
  when that session ended before it was read.
- **The race between steps 3 and 7.** The creation transaction re-checks the user, the account
  (status, halt) and the one active session under its locks, and reads the trading switch, so a
  switch closed in between still refuses with `trading_paused`; a close committed after the
  insert is the orchestrator's `stopPausedSessions` sweep.
  **The tokens are checked only in step 3** (stated): a reserve that takes the last token in
  between leaves a session whose first attempt stops `account_unavailable`.
- **A refused start may already have written refresh state:** steps 5–5b move
  `last_requested_at` and may write the balance snapshot before step 7 refuses. Both are the
  balance's state, not the session's.
- **No session without a signal (#509).** Step 4c covers every door of the bot and a direct call
  alike. A refusal of the signal also leaves steps 5–5b's refresh state, as any later refusal.
  The CLI `session-start` (an operator's tool, demo only) does not ask for the signal (stated).
- **Time.** Step 5b dominates: under `TRADING_SESSION_START_BUDGET_MS` (4 s), which is inside the
  backend's shutdown phase 1 (`apps/backend/src/timing.ts`, asserted at import). Step 4c runs
  beside it, so the route waits for the longer of the two, and its chart GET is bounded by
  `SIGNAL_FETCH_BUDGET_MS` (3 s) `< TRADING_SESSION_START_BUDGET_MS` (the backend's chain, #509).

### GET /trading/sessions/:id?telegramUserId=

200 `{ session }`; a non-uuid id, another user's session and a missing one are all 404
`not_found` with the same body (Rule 13); a missing `telegramUserId` is 400.

The view is an allowlist built key by key: `{ id, mode, status, stopReason, settings, startedAt,
endedAt, trades: { settled, rejected, won, lost, tied, profit }, cycles: { planned, closed },
lastIntent, balance, noticesDone }` — `noticesDone` is `final_notice_sent_at is not null` (#464: the bot's card waits
for it);
`cycles` is `sessionProgress` (#552: `planned` the session's length, `closed` its closed cycles;
a v1/v2 row counts its trades), `lastIntent` the same view `GET /trading/intents/:id` answers, or
`null`. Bounded: counters, one settings object, one intent; no list.

- `trades.profit` (#337) is `coalesce(sum(broker_trades.profit) filter (where settled), round(0, 8))`
  in the same REPEATABLE READ snapshot as the counters: a `DecimalString` at scale 8
  (`'-0.15000000'`, `'0.00000000'` with no settled trade), never summed in JS (Rule 2).
- `balance` (#337) is `{ available, ageSec, current }` from the account's
  `broker_balance_snapshots` row in the session's mode, or `null` with no row. `ageSec` is the age
  of the newest observation, `greatest(rest_observed_at, <mode>_event_at)`, by the database clock;
  `current` is true when no `settle` row of `token_ledger` for the session's intents is newer than
  that observation (true with no settlement at all). The account id stays out of the view.
- **The refresh** (`readFinishedSessionView` in `session-view.ts`, which the routes' `viewForReply`
  and the session notices' summary (#464) both call, #337): when the view is finished
  (`isTradingSessionFinished`: stopped, and the last intent has no transition left), `settled > 0`
  and `balance.current` is not true, the route reads the session's account
  (`readTradingSessionAccount`, owner-scoped) and calls `balance.refresh(accountId, { signal:
  AbortSignal.timeout(TRADING_ACCESS_REFRESH_BUDGET_MS), mayRefresh: false })` — no token exchange
  from a timer-driven poll (Rule 12), no `requested`. On `'ok'` it reads the view again; any other
  outcome answers the stored snapshot, which the bot shows with its age. A thrown refresh is the
  opaque 500. After one `'ok'` the snapshot is current for good (nothing of a finished session
  can settle any more), so a session costs at most one broker GET. A `manual_review` session is
  not finished and is not refreshed.
- **Time**: under `TRADING_SESSION_VIEW_BUDGET_MS` (4 s), inside the backend's shutdown phase 1
  and no longer than the bot's request timeout (both chains asserted at import). The same bound
  covers both stop routes.

### POST /trading/sessions/:id/stop

Body `{ telegramUserId }`. The owner-scoped read first (404 `not_found` as above), then
`stopTradingSession(id, user_stopped)`: 200 `{ session }` stopped, or 409 `session_not_active` when
it was no longer active. The final read is the GET's `viewForReply`: a stop between trades is a
finished session, so its answer carries the balance after the last trade (#337). The CAS is by id: a session's account and the account's user never
change, so no interleaving lets it stop another user's session. A live intent of the session
finishes on its own path.

### POST /trading/sessions/:id/summary (#318)

Body `{ telegramUserId }` (`stopTradingSessionRequestSchema`). `claimSessionSummary` runs one
`UPDATE trading_sessions SET summary_sent_at = now() … RETURNING` whose WHERE holds: the owner
(`broker_accounts` → `users.telegram_user_id`, Rule 13), `status = 'stopped'`,
`summary_sent_at is null`, `final_notice_sent_at is not null` (the card follows the backend's
summary message, #464), no intent of the session outside `TERMINAL_TRADE_INTENT_STATUSES`, and at
least one `settled` intent with its broker trade. In the same transaction it reads the settled
intents' trades in creation order (`profit`, `open_price`, `close_price`) and their sum by
`sessionProfitSumSql` — the fragment the view's `trades.profit` is — over the same rows. 200
`{ summary: { result, trades: [{ profit, openPrice, closePrice }] } }`, built field by field. Every
miss — not the owner's or missing, not stopped, the summary message not sent yet, a trade still
able to move, no settled trade, sent already — and a non-uuid id are one 409 `{ error: 'summary_unavailable' }` that writes nothing. A
bad body is 400. No broker call. Terminal intents and a stopped session cannot change, so the rows
read after the claim are the ones it checked. Two claims at once: the row lock serialises them and
the second re-checks `summary_sent_at is null`, so one wins. A lost answer after the commit loses
the card (accepted, [bot-session.md](bot-session.md#the-summary-card-318)).

### POST /trading/sessions/stop (#122)

Body `{ telegramUserId }` (the same schema as the stop by id); 400 `validation` on any other body,
401 without the bearer. `stopUserSessions` stops every active session of the user in one UPDATE,
then each stopped session is read through `viewForReply`, in parallel: 200 `{ sessions }`
(`tradingSessionsStoppedResponseSchema`). An empty list is an answer, not a refusal: no active
session, no `users` row, and another user's id all answer `[]` (Rule 13 — the owner is the
UPDATE's predicate). A row gone between the UPDATE and its read is left out.

- **Nothing is closed at the broker.** The route's deps are `db`, `catalog` and `balance`: a live
  intent of a stopped session plays out on its own path, and a new one is refused by the session
  lock (`TradingSessionNotActiveError`). The only broker call is `viewForReply`'s balance GET of a
  finished session, one per account at most.
- A thrown refresh is the opaque 500 after the stop committed; a second call answers `[]`.
- **Time**: the reads run in parallel, one account each under its own
  `TRADING_ACCESS_REFRESH_BUDGET_MS`, so the route stays under `TRADING_SESSION_VIEW_BUDGET_MS`.
- `GET /trading/sessions/stop` is the GET by id with `id = 'stop'`: not a uuid, 404 `not_found`.

### POST /trading/sessions/:id/status-message (#567)

Body `{ telegramUserId, messageId, replacesMessageId? }` (strict; `messageId` and
`replacesMessageId` ints from 1 to `INT4_MAX`, the bounds of the column and its CHECK, so an id
past them is a 400 rather than a 500). The bot's first poll
of a status message ([bot-session.md](bot-session.md#recovery-after-a-restart-567)) calls it in
place of the GET by id. The steps: a non-uuid id is 404 `not_found`; a body outside the schema is
400 `validation`; `recordSessionStatusMessage` — one UPDATE `set status_message_id = $messageId
where id = $id and status_message_id is null and <the owner, broker_accounts → users>`, with
`replacesMessageId` the slot condition `(status_message_id is null or status_message_id =
$replacesMessageId)` — then,
whatever it wrote, the GET's `viewForReply`: 200 `{ session }`, the same view with the same balance
refresh of a finished session (#337), or 404 `not_found` when the view is undefined. **The first
id wins**: a second call with another id writes nothing and answers 200 with the view, unless it
names the recorded id as `replacesMessageId`. The bot sends that field only for a session message
it sent anew after an old status message's «⏹» (data without `:w`, #536) had the pressed
message's edit refused as gone; the field is the pressed message. Another
user's `telegramUserId` writes nothing (the owner is in the CAS) and answers as a missing session
(Rule 13). Time: one statement plus the view, under `TRADING_SESSION_VIEW_BUDGET_MS`.

### POST /trading/sessions/:id/status-message/lost (#567)

Body: `{ telegramUserId, messageId }` (strict, its own schema: `replacesMessageId` is a 400). The
bot calls it
when Telegram refused an edit of the status message for good — gone or any 403
([bot-session.md](bot-session.md#recovery-after-a-restart-567)). The steps: a non-uuid id is 404
`not_found`; a body outside the schema is 400 `validation`; `forgetSessionStatusMessage` — one
UPDATE `set status_message_id = null where id = $id and status_message_id = $messageId and <the
owner, broker_accounts → users>` — then 200 `{ forgotten }` (`forgetSessionStatusMessageResponseSchema`).
The CAS is on the same id, so a message recorded after the lost one stays. Another user's
`telegramUserId`, a missing session and another message all answer `{ forgotten: false }` and
write nothing (Rule 13: a foreign id is not told apart, as `[]` of `POST /trading/sessions/stop`).
The row then leaves `GET /trading/sessions/tracked`, and the next record writes again. Time: one
statement, no external call, under the bot's `BACKEND_REQUEST_TIMEOUT_MS`.

### GET /trading/sessions/tracked?limit= (#567)

The bot's recovery list: `listTrackedSessions` returns the sessions with a recorded status
message and no summary card (`summary_sent_at is null`), except the finished ones with no settled
trade whose summary message was sent (`final_notice_sent_at is not null` and no settled intent
with its broker trade: they never get a card); a row also leaves when its message is lost (the
column cleared by the route above); oldest first (`started_at`, then `id`), at most
`limit`. `limit` is an int from 1 to `TRACKED_SESSIONS_MAX` (2 000), the ceiling by default; any
other value is 400 `validation`. 200 `{ sessions: [{ id, telegramUserId, messageId, assetId,
startedAt }] }` (`trackedSessionsResponseSchema`): `telegramUserId` is the owner's (the chat of the
message), `assetId` is `settings->>'assetId'` as an int4 or `null` for settings that do not read.
**Not scoped by a user** (Rule 13): an internal list for the bot's recovery, behind the bearer;
it carries session ids, owners' Telegram ids and message ids, no secrets. A static path, so
find-my-way picks it before `/:id` whatever the registration order (`session-routes.db.test.ts`
T3). One indexed read, no broker call.

### For #284

- The bot's request timeout must be at least `TRADING_SESSION_START_BUDGET_MS`; the link is in the
  bot's timing chain (`apps/bot/src/timing.ts`).
- `sessionFitsDeadline` is exported so the bot can hide a start the route would refuse. The bot
  does not know the backend's strategy and counts martingale's worst case, the default and the
  longer one (#552), so it never offers a start the route refuses.
- The bot's side — the button, the status message, the stop — is [bot-session.md](bot-session.md).

## The orchestrator

`createSessionOrchestrator({ db, signals, pairs, logger, config })` in the worker, started in
`worker.ts` (`start()`) after the settlement catch-up. It runs whether or not a session exists: an idle tick is
three UPDATEs that match nothing and one indexed scan. There is no env variable.

**The tick** (every `TRADING_SESSION_TICK_MS`, one at a time, the first at `start()`), in this
order:

1. `stopPausedSessions` → `stopped`/`kill_switch` while the trading switch is closed (at most
   `TRADING_SESSION_BATCH_SIZE` per tick). It runs first, so a switch closed before the tick stops
   a session before its signal call (`orchestrator.db.test.ts` K1). A switch closed during a tick
   does not interrupt it: an attempt under way, or a later one in the same batch, still calls the
   signal, and its intent creation refuses `trading_paused` → `kill_switch` (K2). A tick runs its
   attempts one after another, so it can take far longer than `TRADING_SESSION_TICK_MS`.
2. `stopExpiredSessions` with `SESSION_MAX_DURATION_MS` → `timeout`, even with a live intent (E7).
3. `stopHaltedSessions` → `manual_review` (E6).
4. The in-memory hold-backs whose time has passed are dropped.
5. `listRunnableSessions({ limit: TRADING_SESSION_BATCH_SIZE, maxDurationMs, exclude: <held back> })`:
   a session past the deadline is never listed, even when more expired than the sweep's cap (E7b).
6. One attempt per runnable session, one after another. Each runs under
   `TRADING_SESSION_ATTEMPT_TIMEOUT_MS` (a race, as in the settlement catch-up: the race bounds the
   tick's wait, not a statement; a statement that outlives it still lands, and the next attempt
   reads its result).
7. One `debug` line `trading session tick`.

A throw out of steps 1–5, or out of an ending's write after an attempt (`stopTradingSession`,
`markSessionDecision`), is one `error` line, `trading session tick failed`; the rest of that tick's
batch is skipped and the next tick runs as usual. Every sweep carries `status = 'active'` in its WHERE, so a session stopped by one writer
keeps the first reason.

**The attempt.** The first row that applies is the ending:

| Step | Outcome | Ending |
|---|---|---|
| `settings` (`safeParseTradingSessionSettings`), the sizer from `sessionStakeParams(settings)` (#450: the row's strategy and limits) | fails | stop `invalid_settings` |
| `readSessionHistory` (with `waitExpired`, [the no-signal limit](#the-no-signal-limit-509)) | the row is gone (a race with a delete) | hold back `TRADING_SESSION_RETRY_MS` |
| | `expired`: the deadline passed since the scan (database clock) | stop `timeout`, before any backend call (E7c) |
| | an intent of the session is live (a race with the scan) | reschedule |
| | `sessionProgress(settings, { settled, won })`: done ≥ planned (#552; `won` — a settled intent whose profit reads positive) | stop `completed` (E1; a loss never completes a martingale session, G9′–G12) |
| | the last two intents are `rejected` | stop `rejected_twice` (E2) |
| `readBalanceSnapshot` | no row | stop `balance_unavailable` |
| | a row | `available` = the balance of the session's mode (`real.available` for a real session, E9a) |
| `touchBalanceRequested` | — | keeps the account "in work", so the balance refresh and the broker socket stay on it between trades |
| `pairs.read` | `catalog_unavailable`, a backend failure, or `fresh: false` | hold back `TRADING_SESSION_RETRY_MS` (E9f) |
| | the pair absent, or `!pairAcceptsDuration(pair, durationSec)` | stop `pair_unavailable` (E9c, E9d) |
| | `!isPairOpen(pair, now)` and `waitExpired` | stop `no_signal_timeout`, `waited: pair_closed` (W5) |
| | `!isPairOpen(pair, now)` | hold back `min(scheduledUntil − now, TRADING_SESSION_RETRY_MS)` (E9e) |
| | the payout below `MIN_CYCLE_PAYOUT_PCT` | nothing: the floor is the start's alone since #509, the session trades on (P6) |
| `signals.evaluate({ assetId, interval: intervalForDuration(durationSec) })` | a backend failure | hold back `TRADING_SESSION_RETRY_MS` (E5) |
| | `fetch_failed` | hold back `retryAfterSec` when given (0 included), else `TRADING_SESSION_RETRY_MS` (E5) |
| | `no_signal` and `waitExpired` | stop `no_signal_timeout`, `waited: no_signal` (W1) |
| | `no_signal` | hold back until the next candle boundary + `TRADING_SESSION_CANDLE_SLACK_MS` (E4); `last_signal_action` = NULL |
| | `signal` in the paused direction while `last_signal_action` holds it, and `waitExpired` | stop `no_signal_timeout`, `waited: paused` (W4) |
| | `signal` in the paused direction while `last_signal_action` holds it ([the pause](#the-pause-after-two-losses-379)) | hold back as for `no_signal`; `last_signal_action` stays the action (P1) |
| | `signal` | the action |
| the sizer (`nowMs = max(now, started_at)`, E11) | `stop` | a martingale limit: stop with its own reason (#450, G3–G6); any other code: stop `stake_stop` (E3, G8); the code in the line |
| | `stake` | the amount |
| `createSessionIntent` (step = the session's intents + 1) | `created: true` | done; `last_signal_action` was written by the intent's own transaction (D6) |
| | `created: false` (a replay) | reschedule (E9g) |
| | `trading_paused` | stop `kill_switch` (K2) |
| | `account_halted` | stop `manual_review` (E9b) |
| | `user_not_found`, `user_blocked`, `broker_account_not_found`, `ambiguous_broker_account`, `account_revoked`, `account_not_confirmed`, `insufficient_tokens`; `demo_only` (a real session on a `DEMO_ONLY` worker, #396: the creation passes the flag and refuses before the reserve) | stop `account_unavailable` (E9c, F1) |
| | `active_intent_exists`, `client_request_id_conflict` | reschedule (E9g) |
| | `TradingSessionNotActiveError` | nothing: another writer stopped it (E9h) |
| anywhere | the attempt's deadline, a throw, or `stop()` | no ending written; hold back `TRADING_SESSION_RETRY_MS` in memory |

The refusal map is `satisfies Record<TradeIntentErrorCode, …>`, so a code added to
`TradeIntentErrorCode` fails `tsc` until it has an ending.

- **The progress rule.** Every ending that leaves the session `active` and was reached — done,
  reschedule, every hold-back — moves `last_decision_at` (`markSessionDecision`), and every
  hold-back is at least one tick. So a session never sits at the head of the scan twice in a row,
  and with a full batch the head rotates. Only "no ending written" leaves the key unmoved, and it
  is a hold-back in memory. The same write carries `last_signal_action` on the two hold-backs that
  decided a direction (`no_signal`, the pause); the traded action is written by the intent's own
  transaction; every other ending leaves it.
- **The step comes from the database.** The step is the session's intents + 1 and the request key
  `session:<id>:<step>`, so a new process continues where the old one stopped (E8), and a repeated
  step is a replay.
- **The deadline.** The scan never lists an expired session, and the attempt stops one whose
  deadline passed after the scan before any backend call. The residual window: a deadline that
  passes after the history read, during the backend calls, still lets that attempt create its
  intent. The creation *starts* at most `TRADING_SESSION_ATTEMPT_TIMEOUT_MS` (10 s) after the
  deadline; the creating transaction itself, its lock waits included, has no time bound (no
  `statement_timeout` or `lock_timeout`), so its commit can land later (stated).
- **Clocks.** The deadline and the order key are the database's. The hold-backs, the candle boundary
  and the sizer's `nowMs` are the worker's; `nowMs` is clamped to `started_at`, because the sizer
  throws when the clock is behind the session's start (E11).
- **`stop()`** clears the timer, aborts the attempt's backend call and waits for the running tick:
  one attempt at most, which `intents/config.ts` keeps inside the shutdown's phase 1. An attempt cut
  by the stop writes nothing (E10).
- **Hold-backs live in memory**, keyed by session id, in one worker container (two during a
  deploy's overlap or until an operator resolves an interrupted run, #95, worker-deploy.md; #94:
  several processes; #93's lease covers the broker sockets only);
  a restart drops them, and the next attempt is idempotent
  ([Recovery after a restart](#recovery-after-a-restart-131)).

## Recovery after a restart (#131)

A worker that dies or restarts mid-session leaves the session `active` and at most one intent of it
live. The new worker needs nothing from the old one's memory: the step, the pause and the live
intent are all in the database. What resolves the intent is the transport's table,
[trade-intent-transport.md](trade-intent-transport.md) → "After a crash or restart"; this section is
what the session does meanwhile. The cases are `orchestrator.db.test.ts` → "restart recovery
(#131)" (R1–R7, one orchestrator, pass and catch-up per worker over one database) and
`worker.handoff.db.test.ts` H9 (the production composition, the old worker dying dirty).

**(a) Per stage of the live intent.** While an intent of the session is live, the scan does not list
the session (`listRunnableSessions` skips an account with a non-terminal intent), so it waits.

| The intent was left in | The session |
|---|---|
| `planned`/`reserved` | cannot happen: created and queued in one transaction |
| `queued` | waits; a job delivered after `INTENT_MAX_AGE_MS` (60 s) ends `expired`, which counts towards `rejected_twice` like any `rejected` (R3) |
| `submitting`, `unknown`, `reconciling`, `reconciling` with the dead worker's claim | waits; a redelivered job never sends again (R1b); the claim is a lease of `RECONCILE_RETRY_MS` (60 s) (R1) |
| …and the pass finds the trade | the intent goes `accepted`/`settled`, then the next step (R1, H9) |
| …and the pass finds nothing | `manual_review` and the account halted; the next tick stops the session `manual_review`, the reserve kept (R2; #274 replaces the halt with a release on a proven absence) |
| `accepted` | waits for `close_trade` on the socket or the settlement catch-up (R4) |

A hold-back is lost with the worker's memory; the new worker asks again and the attempt is
idempotent (R5). The pause after two losses survives, because it is read from the rows (P4, P8).

**(b) No new limit.** A restart adds none: the 1 h deadline (`SESSION_MAX_DURATION_MS`) and every
normal stop condition apply, so a session that waited 40 minutes trades its next step (R7). A
session whose deadline passed while the worker was down reads `active` in the bot until a tick
stops it as `timeout`, at most `TRADING_SESSION_BATCH_SIZE` (200) a tick; the rest are already out
of the scan (E7, E7b).

**(c) Two workers at once.** When and how long two run, and each component's guard:
[Accepted risks](#accepted-risks-287) → 4 and [worker-deploy.md](worker-deploy.md) → "Why two
workers at once are safe". For the session after a crash: two orchestrators in one tick create one
intent for the step (R6), and an old worker that dies dirty with the step's REST submit in flight
costs no second trade (H9).

**(d) The socket after a restart.** The new worker rebuilds the sessions for the accounts in work
under the lease (Rule 32); a dead owner's lease lapses after `SESSION_LEASE_TTL_MS`
([broker-session.md](broker-session.md) → The lease). Until `user.data` is verified orders go by
REST (Rules 15, 27). A `close_trade` sent while the worker was down is lost; the catch-up settles
that trade (R4).

## The payout floor (#379)

`MIN_CYCLE_PAYOUT_PCT = 80` (`packages/shared/src/catalog.ts`, `pairPayoutAccepted`): no cycle of
trades starts or continues on a pair paying less. A win pays `stake × payout / 100`, a loss costs
the stake, so a fixed stake breaks even at `100 / (100 + payout)` right forecasts
(`breakEvenPct`). The owner's seven demo sessions of 2026-10-07…08 (Signal v1) had three on pairs
paying 54–56 %, which break even only at 64–65 % right forecasts; at 80 % the share is 55.6 %. The
value is an expert one (owner, 2026-10-09); the backtest stand (#381) tunes it.

Where it applies — every place a cycle starts: the start route (step 4b, 409 `payout_too_low`),
the backend's scanner (a pair below the floor is neither scanned nor served,
[signal.md](signal.md) → The scanner), and the bot's cycle entries ([bot-demo.md](bot-demo.md) →
The check). A running session is not held by it (owner, #509): a payout that fell below the floor
after the start leaves the session trading on its signals (P6); until #509 the orchestrator's
attempt waited for the payout. The manual path's single trade and its pair lists are not
restricted (owner, #379); the pair screens show the payout and the break-even share.

## The no-signal limit (#509)

A session that cannot open a trade for want of a signal stops with `no_signal_timeout` after
`SESSION_NO_SIGNAL_TIMEOUT_MS` (120 000, `packages/shared/src/trading-session.ts`; the worker's
`noSignalTimeoutMs`, the bot's stop line prints it in minutes). Owner, #509: the session should not
stand waiting with no word to the user.

- **The count** — `readSessionHistory`'s `waitExpired`, in the attempt's first statement:
  `greatest(started_at, max(updated_at) of the session's own intents) < now() - limit`, on the
  database clock. A session without an intent counts from its start; a bot trade on the account
  (`trading_session_id` NULL) and another session's intents do not count (NS1–NS5). A worker
  restart changes nothing: the count is the rows' (W8).
- **The clock of `updated_at`.** Both UPDATEs of `trade_intents` — `transitionIntent` and
  `claimReconciling` — write `updated_at = now()`, the transaction's start, not the column's
  `$onUpdate` (the process's date) (T-clock). So the `updated_at` of a terminal intent is its last
  change on the database clock. A future writer of the table keeps it (stated). Rows written before
  #509 carry the worker's clock; worker and database share one host, so the drift is seconds
  against a 120 s limit (accepted).
- **What stops.** The three waits for a signal, once `waitExpired`: the pair closed by its
  schedule (`waited: pair_closed`, W5), `no_signal` (W1), the pause after two losses (`paused`,
  W4). A signal is an ordinary trade at any age: the decision comes after the signal's answer, so a
  session with a signal now is never stopped by the limit (W7).
- **What does not.** A backend or broker failure — the pairs unavailable, the signal unavailable,
  `fetch_failed` — is not a wait for a signal: it neither stops the session nor moves the count,
  and the first `no_signal` after it stops at once (W6).
- **Lateness.** The count is read at the start of the attempt, so the stop comes at most one
  attempt late, and on a closed pair at most one hold-back (`TRADING_SESSION_RETRY_MS`) late.
- **Tokens.** The start reserves nothing; a reserve is an intent's (Rule 2). A stop with no intent
  writes nothing to `token_ledger` or `users` (W1).
- **Long candles (accepted risk).** A session whose candle is 2 min or longer — only a direct
  `POST /trading/sessions` or the CLI; the bot offers 5 and 15 s (`DEMO_DURATIONS_SEC`, and
  `LEGACY_DURATION_PATTERNS` take every older button) — waits a whole candle after a `no_signal`,
  so it stops on its first or second decision without a signal. The chain keeps the longest
  candle the bot offers (the scanner's, 15 s) below the limit; a new duration in the bot is a
  reason to revisit the limit.
- **The user.** The status message and the summary card (#318) end with «🔀 Выбрать другую пару»
  (the signals of the session's duration) instead of «🔁 Ещё сессия» and «📊 Новый анализ», and the
  backend's summary (#464) is sent with sound even without a trade ([bot-session.md](bot-session.md)).

## The pause after two losses (#379)

After two consecutive settled losses in one direction the session does not enter that direction
again until the orchestrator sees a decision that is not a signal in it (issue #379, session
`716ed06d`: five `down` in a row, four lost after the price turned). Since #509 the pause is one of
the waits the no-signal limit ends: 2 min after the second loss settled, the session stops
`no_signal_timeout` ([The no-signal limit](#the-no-signal-limit-509)).

- **The streak** (`pausedDirection(history.intents)`): the last two trades of the session, a trade
  being an intent that is not `rejected`; both `settled` with a linked profit below zero
  (`parseAmount(profit) < 0n`, the sizer's reading), in the same `action`. A tie, a win, a
  `manual_review` intent or a `settled` one without its profit breaks it (P7); a `rejected` intent
  between the two is skipped (P5); after the second loss it ends the pause (P9): that intent was
  created only once the pause had lifted (a `no_signal` cleared the column, or the signal changed),
  and the rule re-arms on the next settled loss, not on a refusal. Two refusals in a row still stop
  the session `rejected_twice` (E2), before the pause is checked.
- **A session active at the deploy** that added the column (migration 0038) has it NULL, and no
  backfill sets it: if its last two trades are already losses in one direction, its first signal in
  that direction after the deploy trades once more, as it did before #379. A one-off per such
  session; from that attempt on the column is written as below.
- **"The signal has not changed since"** is the column `last_signal_action`, written by the
  intent's own transaction when an intent is created (`createTradeIntent` with `session`), by the
  ending with NULL on `no_signal` and with the paused action on the pause — so a lost ending (the
  deadline, a restart, a throw after the INSERT) cannot lose the traded action (P8); a lost
  `no_signal` ending leaves the previous action and costs one more wait, never a trade, and a lost
  pause ending rewrites the same value (stated). After the attempt that created the second losing
  intent it holds that action. Only those three write it: a `signal(B)` whose create is refused
  (`active_intent_exists`, `client_request_id_conflict`: the attempt is rescheduled) or replayed
  leaves it at `A`, so the next `signal(A)` waits once more although the signal changed — one extra
  wait, never an extra trade; a `signal(B)` the sizer answers with `stake_stop` does not write it
  either, and the session stops. The fact is in the row, so a worker restart pauses the same way
  (P4).
- **The rule:** `signal(A)` with `pausedDirection === A` and `last_signal_action === A` holds the
  session until the next candle boundary + `TRADING_SESSION_CANDLE_SLACK_MS` (P1). A `no_signal`
  clears the column, and the next `signal(A)` trades; `signal(B)` trades at once (P2). If that trade
  loses too, the two most recent trades are again losses in `A` and the pause re-arms — that is the
  rule, not a repeat bug.
- **Seen at the attempts only** (stated): a signal that flipped and came back inside one candle is
  not a change.

## Backend calls

`backend.ts`, under the internal bearer, shaped like `broker/access-token.ts`: an expected failure
is an answer, never a throw. Neither client logs; the orchestrator logs the outcome codes.

| Client | Request | Answers |
|---|---|---|
| `createBackendSignalSource` | `POST /trading/signal` `{ assetId, interval }`, `TRADING_SIGNAL_BUDGET_MS` | the parsed `tradingSignalResponseSchema` (`decided` or `fetch_failed`) |
| `createBackendPairsSource` | `GET /trading/pairs`, `TRADING_SESSION_PAIRS_TIMEOUT_MS` | the parsed `pairsCatalogResponseSchema`; a 503 `{ error: 'catalog_unavailable' }` → `catalog_unavailable` |

Both: a fetch error, the timeout or the caller's abort → `backend_unreachable` (its cause dropped:
it may name the URL); any other status → `backend_status` with the status; a body the schema
refuses → `contract_violation`. The body is read up to `MAX_BACKEND_BODY_BYTES` (1 MiB); over it, a
200 (or the pairs' 503) answers `contract_violation`, any other status `backend_status`
(`backend.test.ts` → body size). The body text never enters a result (`backend.test.ts` B6).

## Constants and the chain

| Constant | Value | Bounds |
|---|---|---|
| `TRADING_SESSION_TICK_MS` | 5 000 | the scan interval |
| `TRADING_SESSION_BATCH_SIZE` | 200 | runnable sessions attempted per tick |
| `TRADING_SESSION_ATTEMPT_TIMEOUT_MS` | 10 000 | one attempt: both backend calls and the statements |
| `TRADING_SESSION_PAIRS_TIMEOUT_MS` | 4 000 | the pairs GET |
| `TRADING_SESSION_RETRY_MS` | 60 000 | a hold-back after a transient failure or a throw |
| `TRADING_SESSION_CANDLE_SLACK_MS` | 2 000 | how long after a candle boundary the signal is asked again. The backend's signal cache keeps a decision until the boundary on its own clock; both processes run on one host, so the two boundaries agree within the slack |
| `SESSION_MAX_DURATION_MS` (shared) | 3 600 000 | the deadline from `started_at`; the start route and the CLI refuse a session whose strategy's worst case cannot fit it (`sessionFitsDeadline(cycles, durationSec, strategy)`, #552) |
| `MIN_SESSION_DURATION_SEC` (shared) | 5 | a session trade's shortest duration (#552): `SIGNAL_SHORTEST_INTERVAL_MS / 1000`, in the settings, the start request and the CLI's `DURATION_SEC` |
| `MAX_SESSION_SUMMARY_TRADES` (shared) | 720 | `SESSION_MAX_DURATION_MS / (MIN_SESSION_DURATION_SEC × 1000)`, an integer checked at import: a session's intents run one at a time and each settles no earlier than its duration, so an hour holds no more; the bound of the summary's trades and the card's columns. Without ties the fit and `maxSteps` keep a session at 28 settled trades (7 cycles × 4 at 5 s) |
| `SESSION_NO_SIGNAL_TIMEOUT_MS` (shared) | 120 000 | the wait for a signal before `no_signal_timeout` (#509), from the later of `started_at` and the session's last intent change |

`TRADING_SESSION_CHAIN_HOLDS` is checked at import (`config.test.ts` restates it):
`PAIRS + TRADING_SIGNAL_BUDGET_MS < ATTEMPT`, `TICK < RETRY`, `CANDLE_SLACK <
SIGNAL_SHORTEST_INTERVAL_MS` (5 000 since #313: the wait never skips a 5 s candle),
`RETRY < NO_SIGNAL < SESSION_MAX_DURATION_MS`, the longest candle the scanner lists (15 s) `<
NO_SIGNAL` (#509: a session the bot offers gets several decisions before the limit), every value a
timer-safe integer. The worker chain
(`intents/config.ts`) adds `TRADING_SESSION_ATTEMPT_TIMEOUT_MS < SHUTDOWN_PHASE1_BUDGET_MS`: phase 1
runs its steps at once, so the orchestrator's stop has to fit it on its own.

## Logs

Every line of the orchestrator carries `sessionId` and `brokerAccountId`, except the tick's own
two. No line carries an access token, a URL or an amount; `stake_stop`'s `detail` is the sizer's
echo of its limits (`minTradeAmount`, `available`, the candidate). `orchestrator.db.test.ts` L1
reads this table: every row not marked "race" is produced by a case, and every `trading session …`
line is in it with its level.

| msg | level | When |
|---|---|---|
| `trading session stopped` | warn | a sweep or an attempt stopped the session; `reason`, plus `code` (`account_unavailable`, `kill_switch` from the attempt), `stopReason`/`detail` (`stake_stop`), `issues` or `error` (`invalid_settings`), `lastErrors` (`rejected_twice`), `assetId`/`listed` (`pair_unavailable`), `waited` (`no_signal_timeout`: `pair_closed`, `no_signal` or `paused`, #509) |
| `trading session stopped for manual review` | error | the halt sweep, or `account_halted` from the attempt (`code`) |
| `trading session completed` | info | the session's last cycle closed (`sessionProgress`, #552): `settled` and `cycles` (the closed ones) |
| `trading session vanished` | warn | a race: the row was gone between the scan and the history |
| `trading session has a live intent` | info | a race: the history shows a live intent the scan did not |
| `trading session pairs unavailable` | warn | `catalog_unavailable`, a backend failure (`reason`, `status`), or `reason: 'stale'` |
| `trading session waits for the pair to open` | info | `scheduledUntil` is ahead (`assetId`) |
| `trading session signal unavailable` | warn | the signal call failed (`reason`, `status`) |
| `trading session signal fetch failed` | warn | the backend answered `fetch_failed` (`code`, `retryAfterSec`) |
| `trading session waits for the next candle` | info | `no_signal` (`reason`) |
| `trading session waits for the signal to change` | info | the pause after two losses in `action` (#379) |
| `trading session intent refused` | warn | `active_intent_exists` or `client_request_id_conflict` (`step`, `code`) |
| `trading session stopped meanwhile` | info | `TradingSessionNotActiveError`: another writer stopped it during the attempt |
| `trading session step replayed` | info | `createSessionIntent` answered `created: false` (`step`, `intentId`) |
| `trading session intent created` | info | `step`, `intentId`, `action` |
| `trading session attempt timed out` | warn | the attempt passed `TRADING_SESSION_ATTEMPT_TIMEOUT_MS` |
| `trading session attempt failed` | error | a throw in the attempt (`errorLogFields`); not on the stop signal |
| `trading session tick failed` | error | a throw in a sweep, the scan or an ending's write (`errorLogFields`); the rest of the batch is skipped |
| `trading session tick` | debug | `{ runnable, attempted, created, held, stopped }` |

## The CLI

```bash
docker compose exec -T -e TELEGRAM_USER_ID=REPLACE_WITH_TG_ID -e ASSET_ID=REPLACE_WITH_PAIR_ID \
  trading-worker pnpm --filter @binarius/trading-worker --fail-if-no-match session-start
```

`--fail-if-no-match` turns a filter that matches nothing (a wrong package name, a checkout without
the script) into exit 1; pnpm's own errors stay visible, so a refusal of the CLI is never confused
with one of pnpm. (REPLACE_WITH_TG_ID: the user's Telegram id; REPLACE_WITH_PAIR_ID: the pair's id from
`GET /trading/pairs`.)

| Env | Rule |
|---|---|
| `DATABASE_URL` | the worker's own (set in its container) |
| `TELEGRAM_USER_ID` | required, a positive integer |
| `ACCOUNT_ID` | optional, a uuid; needed only when the user has more than one active account. It must be one of the user's accounts as `readUserAccounts` lists them (the 10 newest), compared without case; the listed (lower-case) spelling is what `createTradingSession` gets; another user's id and an unknown one are both `account_not_found`, before anything of that account is read. An own account older than the 10 newest is not found either (accepted) |
| `ASSET_ID` | required, 1 – int4 max |
| `DURATION_SEC` | default 15 (#313: the demo's set is 5 and 15 s), `MIN_SESSION_DURATION_SEC` (5, #552) – int4 max |
| `CYCLES` | default `DEFAULT_SESSION_CYCLES` (5), 1 – 20 (#552; `TRADES` before it) |
| `DEMO_ONLY` | optional, `true` or `false` (default `false`), as the worker reads it (#396); passed to `createTradingSession`. The CLI creates demo sessions only, so the flag refuses nothing; a user in real mode is refused `mode_not_allowed` (#327) |
| `SESSION_STAKE_STRATEGY` | optional, `martingale` or `fixed` (default `martingale`), the start route's variable (#450); written into the session's settings |

Steps: the user's accounts (`readUserAccounts`); with `ACCOUNT_ID` that one if it is in the list,
else `account_not_found`; without it the only active one, two or more → refused with each `<id> <status>` on stderr (no email); the balance snapshot (none → refused:
open the trade screen in the bot once, `POST /trading/access` writes it); `planSessionStart`
(`sessionFitsDeadline` by the CLI's strategy → `session_too_long`, «уменьшите CYCLES или DURATION_SEC»; a minimum of 0 → `zero_min_trade_amount`; settings v3
from `buildSessionSettings` with `stakeSettingsFor` and the strategy, then `assertStakeParams`; a
failure of either → `invalid_settings`); `createTradingSession(…, mode: demo)`. The session id goes to stdout,
exit 0. Every refusal goes to stderr with exit 1 and writes nothing: one Russian line, except the
two-accounts refusal (a Russian line, then one `<id> <status>` line per account) and an env error
(one English line naming the variable, as every env check of the repository prints). A
`TradingSessionError` is mapped by `SESSION_START_REFUSALS`
(`satisfies Record<TradingSessionDbErrorCode, string>`); a user in real mode gets `mode_not_allowed`
from the users lock (#327): «Пользователь в реальном режиме: CLI создаёт только demo-сессии —
запустите сессию из бота или верните пользователя в demo». Any other failure is the one door:
`Не удалось создать сессию: <name> <code>`, with the query to re-read the account's sessions,
because a commit whose acknowledgement was lost leaves the state unknown. The pair and the
duration are checked by the first attempt, which stops a wrong `ASSET_ID` as `pair_unavailable`.

## Running it locally

In a compose project of its own, so neither the `binarius` stack nor its volume is touched; both
bot tokens are dummies (the backend polls `ADMIN_BOT_TOKEN`). The pairs cache reads the broker's
public pair list; the account and its balance snapshot are seeded by hand, so no broker token is
used. Run from the repository root, with `.env` filled in:

```bash
dc() {
  COMPOSE_PROJECT_NAME=binarius-trading-session \
  POSTGRES_PORT=55433 REDIS_PORT=56380 BACKEND_PORT=53001 \
  ADMIN_BOT_TOKEN=local-only-admin-token TELEGRAM_BOT_TOKEN=local-only-public-token \
  docker compose "$@"
}
dc down -v
dc up --build --wait backend
dc exec -T backend pnpm db:migrate
# the start needs the trading switch open (docs/kill-switch.md); a fresh database already has
# it open, and the command then prints «Торговля уже открыта»
dc exec -T backend pnpm --filter @binarius/backend kill-switch off
INTERNAL_API_TOKEN="$(dc exec -T backend printenv INTERNAL_API_TOKEN)"
api() {
  printf 'Authorization: Bearer %s\n' "$INTERNAL_API_TOKEN" |
  curl -s -w '\nHTTP %{http_code}\n' -X "$1" "127.0.0.1:53001$2" \
    -H @- -H 'Content-Type: application/json' ${3:+-d "$3"}
}
api POST /users/start '{"telegramUserId":"1","displayName":"Ada"}' >/dev/null
# an active account with a snapshot (min_trade_amount 1) and five tokens through the ledger
dc exec -T postgres psql -U binarius -d binarius -v ON_ERROR_STOP=1 <<'SQL'
begin;
insert into broker_accounts (user_id, broker_user_id, access_token_enc, refresh_token_enc,
  token_key_id, access_token_expires_at, status)
select id, 'local-1', '\x00', '\x00', 'k1', now() + interval '1 hour', 'active'
  from users where telegram_user_id = 1;
insert into broker_balance_snapshots (broker_account_id, real_available, real_held, real_total,
  demo_available, demo_held, demo_total, min_trade_amount, level_code, level_rank,
  rest_observed_at)
select id, 0, 0, 0, 10000, 0, 10000, 1, 'standard', 1, now() from broker_accounts
 where broker_user_id = 'local-1';
insert into token_ledger (user_id, kind, balance_delta, note)
select id, 'adjustment', 5, 'local run' from users where telegram_user_id = 1;
update users set token_balance = token_balance + 5 where telegram_user_id = 1;
commit;
SQL
# an open pair that takes 60 s, from the same cache the route reads
ASSET="$(api GET /trading/pairs | head -1 | node -e '
  const c = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const p = c.pairs.find((x) => x.scheduledUntil <= Date.now() && x.minTimeframe <= 60 && 60 <= x.maxTimeframe);
  process.stdout.write(String(p.id));')"
STARTED="$(api POST /trading/sessions "{\"telegramUserId\":\"1\",\"assetId\":$ASSET,\"durationSec\":60,\"cycles\":3}")"
echo "$STARTED"   # HTTP 201, status active, stake { "1", 0 }
SESSION="$(echo "$STARTED" | head -1 | node -e '
  process.stdout.write(JSON.parse(require("fs").readFileSync(0, "utf8")).session.id);')"
api GET "/trading/sessions/$SESSION?telegramUserId=1"
api POST "/trading/sessions/$SESSION/stop" '{"telegramUserId":"1"}'
dc exec -T postgres psql -U binarius -d binarius -c 'select status, stop_reason from trading_sessions'
dc down -v   # this project's containers and volume only
```

## Running the orchestrator locally

The same seed as above, in a compose project of its own with the worker running too. The pairs and
the signal come from the broker's public endpoints through the backend; the account's tokens are
placeholders, so the backend's token route refuses each REST open (`key_unavailable`), every
intent ends `rejected` before anything reaches the broker, and the session stops
`rejected_twice`. That run shows the whole loop without a trade. Run from the repository root,
with `.env` filled in:

```bash
dc() {
  COMPOSE_PROJECT_NAME=binarius-impl-287 \
  POSTGRES_PORT=55487 REDIS_PORT=56387 BACKEND_PORT=53087 \
  ADMIN_BOT_TOKEN=local-only-admin-token TELEGRAM_BOT_TOKEN=local-only-public-token \
  docker compose "$@"
}
dc down -v
dc up --build --wait backend
dc exec -T backend pnpm db:migrate
# after the migration: a worker started before it logs `trading session tick failed` (42P01)
dc up --build --wait trading-worker
INTERNAL_API_TOKEN="$(dc exec -T backend printenv INTERNAL_API_TOKEN)"
api() {
  printf 'Authorization: Bearer %s\n' "$INTERNAL_API_TOKEN" |
  curl -s -w '\nHTTP %{http_code}\n' -X "$1" "127.0.0.1:53087$2" \
    -H @- -H 'Content-Type: application/json' ${3:+-d "$3"}
}
api POST /users/start '{"telegramUserId":"1","displayName":"Ada"}' >/dev/null
dc exec -T postgres psql -U binarius -d binarius -v ON_ERROR_STOP=1 <<'SQL'
begin;
insert into broker_accounts (user_id, broker_user_id, access_token_enc, refresh_token_enc,
  token_key_id, access_token_expires_at, status)
select id, 'local-1', '\x00', '\x00', 'k1', now() + interval '1 hour', 'active'
  from users where telegram_user_id = 1;
insert into broker_balance_snapshots (broker_account_id, real_available, real_held, real_total,
  demo_available, demo_held, demo_total, min_trade_amount, level_code, level_rank,
  rest_observed_at)
select id, 0, 0, 0, 10000, 0, 10000, 1, 'standard', 1, now() from broker_accounts
 where broker_user_id = 'local-1';
insert into token_ledger (user_id, kind, balance_delta, note)
select id, 'adjustment', 5, 'local run' from users where telegram_user_id = 1;
update users set token_balance = token_balance + 5 where telegram_user_id = 1;
commit;
SQL
ASSET="$(api GET /trading/pairs | head -1 | node -e '
  const c = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const p = c.pairs.find((x) => x.scheduledUntil <= Date.now() && x.minTimeframe <= 15 && 120 <= x.maxTimeframe);
  process.stdout.write(String(p.id));')"   # takes both durations used below, 15 and 120 s
start() {
  dc exec -T -e TELEGRAM_USER_ID=1 -e ASSET_ID="$ASSET" "$@" trading-worker \
    pnpm --filter @binarius/trading-worker --fail-if-no-match session-start
}
start -e CYCLES=2   # prints the session id
# each no_signal waits for the next 15 s candle
until dc exec -T postgres psql -U binarius -d binarius -tA -c \
  "select count(*) from trading_sessions where status = 'stopped'" | grep -qx 1; do sleep 10; done
dc logs trading-worker | grep -E 'trading session|trade command refused'
# expect: "trading session intent created" step 1 and 2, each "trade command refused"
# stage token, then "trading session stopped" reason rejected_twice
# the kill switch: a start while it is closed is refused, a running session stops on the next tick
dc exec -T backend pnpm --filter @binarius/backend --fail-if-no-match kill-switch on --reason 'local check'
start; echo "exit $?"   # «Торговля остановлена — сессия не создана», then pnpm's
                        # ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL line for the script's exit 1; exit 1
dc exec -T backend pnpm --filter @binarius/backend --fail-if-no-match kill-switch off
start -e CYCLES=1 -e DURATION_SEC=120   # martingale's worst case: 4 × (120 + 120) s fits the hour
dc exec -T backend pnpm --filter @binarius/backend --fail-if-no-match kill-switch on --reason 'local check'
sleep 7
dc exec -T postgres psql -U binarius -d binarius -c \
  'select status, stop_reason from trading_sessions order by created_at'
# expect: stopped | rejected_twice, then stopped | kill_switch
dc down -v   # this project's containers and volume only
```

## The owner's pilot step

After deploy, on the pilot, for an account with a real Binodex login (until #285 every trade goes
over REST and settles through the settlement catch-up, 10-15 s after its close since #313):

```bash
# 0. the account needs a balance snapshot: open the trade screen in the bot once
docker compose exec -T -e TELEGRAM_USER_ID=REPLACE_WITH_TG_ID -e ASSET_ID=REPLACE_WITH_PAIR_ID \
  trading-worker pnpm --filter @binarius/trading-worker --fail-if-no-match session-start
docker compose logs -f trading-worker | grep -E 'trading session|intent outcome recorded|trade command'
# expect: one intent at a time at min_trade_amount in the signal's direction, or "waits for the
# next candle"; the session ends "trading session completed" after five closed cycles (under
# martingale the fifth win; under SESSION_STAKE_STRATEGY=fixed five settled trades), or
# "trading session stopped" with its reason
# to end it early: /stop in the bot (POST /trading/sessions/stop, #122), the stop route
# (POST /trading/sessions/:id/stop, #283) or kill-switch on
```

(REPLACE_WITH_TG_ID: your Telegram id; REPLACE_WITH_PAIR_ID: an open pair from `GET /trading/pairs`
that takes 15 s, the default `DURATION_SEC`, and pays at least 80 %; since #509 a session without a
signal for 2 min stops with `no_signal_timeout`.) `ACCOUNT_ID` is needed only with more than one active account.

After the #379 deploy (the owner's step: the agent has no SSH, and these ran on no pilot before
the merge), the floor and the pause:

```bash
# every listed signal is on a pair paying >= 80; scanned <= 25
docker compose exec -T backend sh -c 'wget -qO- --header "Authorization: Bearer $INTERNAL_API_TOKEN" http://127.0.0.1:3000/trading/signals'
# the pause and the no-signal limit inside a session (#509)
docker compose logs --since 1h trading-worker | grep -E 'waits for the signal to change|no_signal_timeout|intent created'
```

## Accepted risks (#287)

1. **A transient refusal counts as `rejected`.** A broker 429 on the REST open, or a token refusal,
   ends the intent `rejected`, which the history cannot tell from a durable refusal; two in a row
   stop the session `rejected_twice`. Falsifiable: sessions stopped `rejected_twice` whose intents'
   worker lines show `stage: 'token'` or a REST status 429.
2. **The pairs body is not size-capped.** The source is our own backend under the bearer (Rule 13).
3. **Two clocks.** The deadline is the database's; the hold-backs, the candle boundary and the
   sizer's `nowMs` are the worker's. Both run on one host under compose; the sizer reads elapsed
   time only for Martingale, which is off.
4. **One container, two during a deploy.** The hold-backs live in memory and two workers would attempt the same session;
   the step key makes the second a replay or a `client_request_id_conflict` (reschedule), never a
   second trade on the step. Two workers run for the deploy's overlap, the readiness wait (up to
   `READY_TIMEOUT_S`, 120 s) plus the drain (≤ 40 s), or until an operator resolves an interrupted
   run ([worker-deploy.md](worker-deploy.md) → The overlap's length, #95, `worker.handoff.db.test.ts`
   H4; an old worker dying dirty mid-step: H9); several workers are #94 (#93's lease covers the
   broker sockets only).
5. **An intent past the deadline.** The scan and the history read guard the deadline on the
   database clock; a deadline that passes during the attempt's backend calls lets that attempt
   create its intent. The creation starts at most `TRADING_SESSION_ATTEMPT_TIMEOUT_MS` (10 s) late;
   its transaction's lock waits are not time-bounded.
   Falsifiable: an intent whose `created_at` is after its session's `started_at + 1 h`.
6. **The CLI sees the user's 10 newest accounts.** An own `ACCOUNT_ID` older than those is refused
   `account_not_found`, like a foreign one.
7. **A real session row trades.** `createTradingSession` refuses anything but demo, but the
   orchestrator runs any active row, sized against the mode's balance (E9a). Only a hand-written row
   can be real.

## Boundaries

- #287 (shipped): the orchestrator in the worker and the `session-start` CLI. #285: the broker
  socket on the pilot (`BROKER_WS_URL`); until then every session trade goes over REST and settles
  through the settlement catch-up.
- #283 (shipped): the backend routes (start, status, stop — the writer of `user_stopped`, with
  #122's stop of all); #284: the bot ([bot-session.md](bot-session.md)).
- #131 (shipped): restart recovery, [above](#recovery-after-a-restart-131); a process-level kill
  in the tests is #105, a release on a proven absence instead of the halt is #274. #135:
  `grant_revoked` as a stop reason; #94: the orchestrator under more than one worker container
  (#93's lease covers the broker sockets only).
- Real sessions (#327): a session runs only in its user's mode — the start route's pre-check and
  `createTradingSession` under the users lock refuse another (`mode_not_allowed`), and a switch of
  the mode stops the user's active sessions in its transaction ([trading-mode.md](trading-mode.md)).
  The `demo_only` refusal (#396) comes before both. The CLI `session-start` creates demo sessions
  only. A loss limit or a daily cap for real sessions is a later issue.
- The invariant is Architecture Rules → "Торговая сессия" in `.claude/skills/architect/SKILL.md`.
