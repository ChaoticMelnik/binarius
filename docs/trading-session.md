# Trading sessions (issues #130, #283, #287)

A trading session is a run of up to `settings.trades` trades on one broker account, one trade at
a time, in the session's `mode`. #130 lays the data layer: the `trading_sessions` table with its
constraints, the `settings` contract and the stop reasons in `packages/shared`, and the database
operations the session orchestrator calls. #283 adds the backend routes that start, read and stop
a session ([Routes](#routes)); they create demo sessions only. #287 adds the orchestrator in the
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
| Settings v1, statuses, stop reasons | `packages/shared/src/trading-session.ts` (`@binarius/shared/trading-session`) | `tradingSessionSettingsSchema`, `TradingSessionStatus`, `TradingSessionStopReason`, `stakeSettingsFor`, `MAX_SESSION_TRADES` 20, `DEFAULT_SESSION_TRADES` 5 |
| Wire contracts (#283) | the same file | the routes' request, view and refusal schemas, `TradingSessionErrorCode`, `sessionFitsDeadline`, `SESSION_MAX_DURATION_MS`, `TRADING_SESSION_START_BUDGET_MS` |
| Pair predicates (#283) | `packages/shared/src/catalog.ts` | `isPairOpen`, `pairAcceptsDuration`; the bot's demo checks and the start route both call them |
| Routes (#283) | `apps/backend/src/trading/session-routes.ts` | `POST /trading/sessions`, `GET /trading/sessions/:id`, `POST /trading/sessions/:id/stop` behind the internal bearer |
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
| `settings` | jsonb object (CHECK `trading_sessions_settings_object_check`), settings v1 below; the column default `'{}'` is not valid v1 |
| `stop_reason` | one of `TradingSessionStopReason` (CHECK `trading_sessions_stop_reason_check`) |
| `started_at`, `ended_at` | the insert's `now()`; the stop's `now()` |
| `last_decision_at` | the runnable scan's order key; NULL until the orchestrator first reached an ending |
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

## Settings v1

```json
{ "version": 1, "assetId": 101, "durationSec": 60, "trades": 5,
  "stake": { "baseStake": "1", "stakeScale": 0 } }
```

A strict object: an unknown key or version is refused. `assetId` and `durationSec` are the intent
request's own schemas; `trades` is 1–20; `stake` is the fixed strategy only (Rule 23), with
`baseStake` in `numeric(20,8)` and `stakeScale` 0–8. The column is checked when it is read, not
when it is written: the orchestrator parses it and stops a session whose settings fail as
`invalid_settings`, so a row written by hand is a boundary too. The bot's view and the admin list
([admin-pages.md](admin-pages.md), #330) show such settings as null.

`stakeSettingsFor(minTradeAmount)` derives the fixed stake from the account's broker minimum:
the canonical spelling (leading and trailing zeros stripped, as `normalizeDecimal` in
`@binarius/db`; `trading-session-ops.db.test.ts` holds the two equal) and its own fraction length
as the scale — `'1.00000000'` → `{ '1', 0 }`, `'0.50000000'` → `{ '0.5', 1 }`, `'0.00000001'` →
`{ '0.00000001', 8 }`. Every positive minimum therefore passes the sizer's parameter check. A
stored minimum of 0 is valid in the snapshot but gives `baseStake '0'`, which v1 refuses: the start
route answers `balance_unavailable` and the CLI `zero_min_trade_amount`, both before writing (#130
review n1).

The start route takes the user's saved demo stake (#297, `users.demo_stake`) through
`demoStakeSettings(demoStake, minTradeAmount)`: `NULL` gives `stakeSettingsFor(minTradeAmount)`
exactly as before; a saved stake gives `{ baseStake: its canonical spelling, stakeScale: max(2,
scale(minimum), scale(stake)) }`, so a stake saved under a finer minimum stays on the grid the
sizer steps on. The CLI `session-start` keeps the broker minimum.

## Stop reasons

| Reason | Meaning | Writer |
|---|---|---|
| `completed` | settled trades reached `settings.trades` | the orchestrator (#287) |
| `manual_review` | the account is halted, or an intent of the session is in `manual_review` | `stopHaltedSessions`; the orchestrator's attempt on `account_halted` |
| `rejected_twice` | the last two intents of the session are `rejected` | the orchestrator (#287) |
| `timeout` | `started_at` + the maximum duration passed (database clock) | `stopExpiredSessions` |
| `stake_stop` | the stake sizer answered stop | the orchestrator (#287) |
| `account_unavailable` | intent creation refused for a durable reason | the orchestrator (#287) |
| `pair_unavailable` | the pair left the catalog or refuses the duration | the orchestrator (#287) |
| `balance_unavailable` | no balance snapshot row for the account | the orchestrator (#287) |
| `invalid_settings` | settings fail the schema or the sizer's parameter rules | the orchestrator (#287) |
| `user_stopped` | the stop route | #283 |
| `kill_switch` | the global trading switch is closed ([kill-switch.md](kill-switch.md)) | `stopPausedSessions` (#144), the tick's first sweep; the attempt on `trading_paused` |

Unchanged by #379: a pair whose payout fell below the floor makes the session wait, it does not
stop it ([The payout floor](#the-payout-floor-379)).

## Operations

| Operation | Statement | Notes |
|---|---|---|
| `createTradingSession(db, { telegramUserId, brokerAccountId, mode, settings }, { demoOnly })` | one transaction | with `demoOnly` (required: the process's `DEMO_ONLY`, #396) refuses a `real` session first (`demo_only`); refuses any mode but `demo` before it reads anything (`mode_not_allowed`, #144 review m1: since #144 nothing else fences a real session's intents); reads the account of that owner (an unknown id or another user's account → `account_not_found`), locks `users` `FOR NO KEY UPDATE` with `status = active` (`user_not_active`), then `broker_accounts` `FOR NO KEY UPDATE` (`account_revoked`, `account_not_confirmed` for `pending`, `account_halted`), then reads the trading switch without a lock (`trading_paused` while it is closed or its row is missing, #144); the active-session index → `active_session_exists`. Errors are `TradingSessionError` with a `TradingSessionDbErrorCode`, not a wire contract: the start route maps each one ([Routes](#routes)) |
| `checkTradingSessionStart(db, { telegramUserId, brokerAccountId? })` | plain selects, no lock | the start route's refusals, the first that applies wins: the trading switch (`trading_paused` while it is closed, #144), the user (`user_not_found`, `user_blocked`), the account by `resolveTradingAccount` — the single trade's rule (`broker_account_not_found`, `account_not_confirmed`, `ambiguous_broker_account`) —, its status (`account_revoked`, `account_not_confirmed`, `account_halted`), an active session of the account (`active_session_exists` with its id), then fewer than one available token (`insufficient_tokens`). On success: the account and its token expiry |
| `readTradingSessionView(db, id, telegramUserId)` | three selects in one `REPEATABLE READ` read-only transaction | the session joined to its account's user, so another user's id and a missing one are both `undefined`; the counters over the session's own intents (`settled`, `rejected`; `won`/`lost`/`tied` by the sign of the linked `broker_trades.profit`, compared in SQL); the newest intent by `created_at desc, id desc`. `settings` that fail v1 read as `null` with `planned: 0` |
| `readActiveTradingSessionView(db, brokerAccountId, telegramUserId)` | two reads | the account's active session as its owner sees it; `undefined` when none, or when it ended between the reads |
| `listRunnableSessions(db, { limit, maxDurationMs, exclude })` | one select (`trading_sessions_runnable_idx`) | `active`, within the deadline (`started_at >= now() − maxDurationMs`, the expiry sweep's boundary on the database clock, so a session the capped sweep left over is never listed), and no non-terminal intent on the account (the active-intent index's own predicate, so a bot trade holds the session too); `last_decision_at asc nulls first, created_at`; `settings` raw, `last_signal_action` with the row |
| `stopExpiredSessions(db, { maxDurationMs, limit })` | one UPDATE | `started_at < now() − maxDurationMs` → `stopped`/`timeout` |
| `stopHaltedSessions(db, { limit })` | one UPDATE | the account `trading_halted`, or an intent of the session in `manual_review` → `stopped`/`manual_review` |
| `stopPausedSessions(db, { limit })` | one UPDATE | every active session while the trading switch is closed (`not tradingOpenSql`) → `stopped`/`kill_switch` (#144); only a person starts one again. The orchestrator's tick runs it first |
| `stopTradingSession(db, { id, reason })` | one UPDATE | CAS on `status = active`: a second stop finds nothing and the first reason stays |
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

All three sit behind the internal bearer (`internalBearerAuth`, an encapsulated plugin like
`pairsRoutes`); a refusal body is `{ error }` with a `TradingSessionErrorCode`, except
`active_session_exists` (`{ error, session }`) and a 400 (`{ error: 'validation', issues }`).
`safeParseTradingSessionResponse` and `safeParseTradingSessionRefusal` read them.

### POST /trading/sessions

Body `{ telegramUserId, brokerAccountId?, assetId, durationSec, trades? }` (strict; `trades`
defaults to `DEFAULT_SESSION_TRADES`, 1–20 like settings v1). The steps in order; every refusal
comes before `createTradingSession`, so no 4xx leaves a `trading_sessions` row:

| # | Step | Refusal |
|---|---|---|
| 1 | the body | 400 `validation` |
| 2 | `sessionFitsDeadline(trades, durationSec)`: `trades × (durationSec + 120 s)` within `SESSION_MAX_DURATION_MS` (1 h) | 409 `session_too_long` |
| 3 | `checkTradingSessionStart` | 409 `trading_paused` first; 404 `user_not_found` / `broker_account_not_found`; 409 `user_blocked`, `ambiguous_broker_account`, `account_not_confirmed`, `account_revoked`, `account_halted`, `insufficient_tokens`, `active_session_exists` |
| 4 | the pairs cache: missing or not `fresh` | 503 `catalog_unavailable` (the string `GET /trading/pairs` answers) |
| 4 | the pair absent, `!isPairOpen(pair, now)`, or `!pairAcceptsDuration(pair, durationSec)` | 409 `pair_unavailable` |
| 4b | `!pairPayoutAccepted(pair)`: the payout below `MIN_CYCLE_PAYOUT_PCT` (#379) | 409 `payout_too_low` (R19; exactly 80 starts, R20) |
| 5 | `touchBalanceRequested`, then the stored balance snapshot, of any age (the sizer checks the balance before every trade) | — |
| 5a | no snapshot and the access token expires within `ACCESS_SKEW_MS`: the refresh runs in the background | 409 `balance_unavailable` at once; the caller retries |
| 5b | no snapshot: `balance.refresh` awaited for at most `TRADING_ACCESS_REFRESH_BUDGET_MS` (3 s), then a re-read | 409 `balance_unavailable` when still none |
| 6a | `checkDemoStake(demoStake ?? minTradeAmount, { minTradeAmount, demoAvailable })` on the same snapshot (#297) | 409 `stake_precision`, `stake_below_minimum` or `insufficient_demo_balance`; without a saved stake, a minimum above the demo balance is refused here rather than as `stake_stop` on the first trade |
| 6 | settings v1 with `stake = demoStakeSettings(demoStake, minTradeAmount)` | 409 `balance_unavailable` when the stored minimum is 0 (a valid snapshot value that gives `baseStake '0'`, which v1 refuses), with a `warn` line |
| 7 | `createTradingSession(…, mode: demo)` | its refusal mapped: `account_not_found` → 404 `broker_account_not_found`; `account_revoked`, `account_not_confirmed`, `account_halted`; `user_not_active` → `user_blocked`; `active_session_exists`; `trading_paused`; `mode_not_allowed` and `demo_only` (409, #396; both unreachable: the route passes `demo`) |
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
- **Time.** Step 5b dominates: under `TRADING_SESSION_START_BUDGET_MS` (4 s), which is inside the
  backend's shutdown phase 1 (`apps/backend/src/timing.ts`, asserted at import).

### GET /trading/sessions/:id?telegramUserId=

200 `{ session }`; a non-uuid id, another user's session and a missing one are all 404
`not_found` with the same body (Rule 13); a missing `telegramUserId` is 400.

The view is an allowlist built key by key: `{ id, mode, status, stopReason, settings, startedAt,
endedAt, trades: { planned, settled, rejected, won, lost, tied, profit }, lastIntent, balance }` —
`planned` is `settings.trades`, `lastIntent` the same view `GET /trading/intents/:id` answers, or
`null`. Bounded: counters, one settings object, one intent; no list.

- `trades.profit` (#337) is `coalesce(sum(broker_trades.profit) filter (where settled), round(0, 8))`
  in the same REPEATABLE READ snapshot as the counters: a `DecimalString` at scale 8
  (`'-0.15000000'`, `'0.00000000'` with no settled trade), never summed in JS (Rule 2).
- `balance` (#337) is `{ available, ageSec, current }` from the account's
  `broker_balance_snapshots` row in the session's mode, or `null` with no row. `ageSec` is the age
  of the newest observation, `greatest(rest_observed_at, <mode>_event_at)`, by the database clock;
  `current` is true when no `settle` row of `token_ledger` for the session's intents is newer than
  that observation (true with no settlement at all). The account id stays out of the view.
- **The refresh** (`viewForReply` in `session-routes.ts`, #337): when the view is finished
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
  and no longer than the bot's request timeout (both chains asserted at import).

### POST /trading/sessions/:id/stop

Body `{ telegramUserId }`. The owner-scoped read first (404 `not_found` as above), then
`stopTradingSession(id, user_stopped)`: 200 `{ session }` stopped, or 409 `session_not_active` when
it was no longer active. The final read is the GET's `viewForReply`: a stop between trades is a
finished session, so its answer carries the balance after the last trade (#337). The CAS is by id: a session's account and the account's user never
change, so no interleaving lets it stop another user's session. A live intent of the session
finishes on its own path.

### For #284

- The bot's request timeout must be at least `TRADING_SESSION_START_BUDGET_MS`; the link is in the
  bot's timing chain (`apps/bot/src/timing.ts`).
- `sessionFitsDeadline` is exported so the bot can hide a start the route would refuse.
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
| `settings` (`safeParseTradingSessionSettings`), the sizer from `{ strategy: 'fixed', ...stake }` | fails | stop `invalid_settings` |
| `readSessionHistory` | the row is gone (a race with a delete) | hold back `TRADING_SESSION_RETRY_MS` |
| | `expired`: the deadline passed since the scan (database clock) | stop `timeout`, before any backend call (E7c) |
| | an intent of the session is live (a race with the scan) | reschedule |
| | settled intents ≥ `settings.trades` | stop `completed` (E1) |
| | the last two intents are `rejected` | stop `rejected_twice` (E2) |
| `readBalanceSnapshot` | no row | stop `balance_unavailable` |
| | a row | `available` = the balance of the session's mode (`real.available` for a real session, E9a) |
| `touchBalanceRequested` | — | keeps the account "in work", so the balance refresh and the broker socket stay on it between trades |
| `pairs.read` | `catalog_unavailable`, a backend failure, or `fresh: false` | hold back `TRADING_SESSION_RETRY_MS` (E9f) |
| | the pair absent, or `!pairAcceptsDuration(pair, durationSec)` | stop `pair_unavailable` (E9c, E9d) |
| | `!isPairOpen(pair, now)` | hold back `min(scheduledUntil − now, TRADING_SESSION_RETRY_MS)` (E9e) |
| | `!pairPayoutAccepted(pair)`: the payout below `MIN_CYCLE_PAYOUT_PCT` (#379) | hold back `TRADING_SESSION_RETRY_MS`, no signal asked; `last_signal_action` untouched (P6) |
| `signals.evaluate({ assetId, interval: intervalForDuration(durationSec) })` | a backend failure | hold back `TRADING_SESSION_RETRY_MS` (E5) |
| | `fetch_failed` | hold back `retryAfterSec` when given (0 included), else `TRADING_SESSION_RETRY_MS` (E5) |
| | `no_signal` | hold back until the next candle boundary + `TRADING_SESSION_CANDLE_SLACK_MS` (E4); `last_signal_action` = NULL |
| | `signal` in the paused direction while `last_signal_action` holds it ([the pause](#the-pause-after-two-losses-379)) | hold back as for `no_signal`; `last_signal_action` stays the action (P1) |
| | `signal` | the action |
| the sizer (`nowMs = max(now, started_at)`, E11) | `stop` | stop `stake_stop`, the code in the line (E3) |
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
  a restart drops them, and the next attempt is idempotent.

## The payout floor (#379)

`MIN_CYCLE_PAYOUT_PCT = 80` (`packages/shared/src/catalog.ts`, `pairPayoutAccepted`): no cycle of
trades starts or continues on a pair paying less. A win pays `stake × payout / 100`, a loss costs
the stake, so a fixed stake breaks even at `100 / (100 + payout)` right forecasts
(`breakEvenPct`). The owner's seven demo sessions of 2026-10-07…08 (Signal v1) had three on pairs
paying 54–56 %, which break even only at 64–65 % right forecasts; at 80 % the share is 55.6 %. The
value is an expert one (owner, 2026-10-09); the backtest stand (#381) tunes it.

Where it applies — every place a cycle starts or runs: the start route (step 4b, 409
`payout_too_low`), the orchestrator's attempt (a wait, not a stop: owner's choice, the deadline
ends a session whose payout never returns), the backend's scanner (a pair below the floor is
neither scanned nor served, [signal.md](signal.md) → The scanner), and the bot's cycle entries
([bot-demo.md](bot-demo.md) → The check). The manual path's single trade and its pair lists are
not restricted (owner, #379); the pair screens show the payout and the break-even share.

## The pause after two losses (#379)

After two consecutive settled losses in one direction the session does not enter that direction
again until the orchestrator sees a decision that is not a signal in it (issue #379, session
`716ed06d`: five `down` in a row, four lost after the price turned).

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
refuses → `contract_violation`. The body text never enters a result (`backend.test.ts` B6).

## Constants and the chain

| Constant | Value | Bounds |
|---|---|---|
| `TRADING_SESSION_TICK_MS` | 5 000 | the scan interval |
| `TRADING_SESSION_BATCH_SIZE` | 200 | runnable sessions attempted per tick |
| `TRADING_SESSION_ATTEMPT_TIMEOUT_MS` | 10 000 | one attempt: both backend calls and the statements |
| `TRADING_SESSION_PAIRS_TIMEOUT_MS` | 4 000 | the pairs GET |
| `TRADING_SESSION_RETRY_MS` | 60 000 | a hold-back after a transient failure or a throw |
| `TRADING_SESSION_CANDLE_SLACK_MS` | 2 000 | how long after a candle boundary the signal is asked again. The backend's signal cache keeps a decision until the boundary on its own clock; both processes run on one host, so the two boundaries agree within the slack |
| `SESSION_MAX_DURATION_MS` (shared) | 3 600 000 | the deadline from `started_at`; the start route and the CLI refuse a session that cannot fit it (`sessionFitsDeadline`) |

`TRADING_SESSION_CHAIN_HOLDS` is checked at import (`config.test.ts` restates it):
`PAIRS + TRADING_SIGNAL_BUDGET_MS < ATTEMPT`, `TICK < RETRY`, `CANDLE_SLACK <
SIGNAL_SHORTEST_INTERVAL_MS` (5 000 since #313: the wait never skips a 5 s candle),
`RETRY < SESSION_MAX_DURATION_MS`, every value a timer-safe integer. The worker chain
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
| `trading session stopped` | warn | a sweep or an attempt stopped the session; `reason`, plus `code` (`account_unavailable`, `kill_switch` from the attempt), `stopReason`/`detail` (`stake_stop`), `issues` or `error` (`invalid_settings`), `lastErrors` (`rejected_twice`), `assetId`/`listed` (`pair_unavailable`) |
| `trading session stopped for manual review` | error | the halt sweep, or `account_halted` from the attempt (`code`) |
| `trading session completed` | info | settled trades reached `settings.trades` (`settled`) |
| `trading session vanished` | warn | a race: the row was gone between the scan and the history |
| `trading session has a live intent` | info | a race: the history shows a live intent the scan did not |
| `trading session pairs unavailable` | warn | `catalog_unavailable`, a backend failure (`reason`, `status`), or `reason: 'stale'` |
| `trading session waits for the pair to open` | info | `scheduledUntil` is ahead (`assetId`) |
| `trading session signal unavailable` | warn | the signal call failed (`reason`, `status`) |
| `trading session signal fetch failed` | warn | the backend answered `fetch_failed` (`code`, `retryAfterSec`) |
| `trading session waits for the next candle` | info | `no_signal` (`reason`) |
| `trading session waits for the payout` | info | the pair pays less than `MIN_CYCLE_PAYOUT_PCT` (`assetId`, `payout`, `floor`; #379) |
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
| `DURATION_SEC` | default 15 (#313: the demo's set is 5 and 15 s), 1 – int4 max |
| `TRADES` | default `DEFAULT_SESSION_TRADES` (5), 1 – 20 |
| `DEMO_ONLY` | optional, `true` or `false` (default `false`), as the worker reads it (#396); passed to `createTradingSession`. The CLI creates demo sessions only, so it refuses nothing today |

Steps: the user's accounts (`readUserAccounts`); with `ACCOUNT_ID` that one if it is in the list,
else `account_not_found`; without it the only active one, two or more → refused with each `<id> <status>` on stderr (no email); the balance snapshot (none → refused:
open the trade screen in the bot once, `POST /trading/access` writes it); `planSessionStart`
(`sessionFitsDeadline` → `session_too_long`; a minimum of 0 → `zero_min_trade_amount`; settings v1
from `stakeSettingsFor`); `createTradingSession(…, mode: demo)`. The session id goes to stdout,
exit 0. Every refusal goes to stderr with exit 1 and writes nothing: one Russian line, except the
two-accounts refusal (a Russian line, then one `<id> <status>` line per account) and an env error
(one English line naming the variable, as every env check of the repository prints). A
`TradingSessionError` is mapped by `SESSION_START_REFUSALS`
(`satisfies Record<TradingSessionDbErrorCode, string>`). Any other failure is the one door:
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
STARTED="$(api POST /trading/sessions "{\"telegramUserId\":\"1\",\"assetId\":$ASSET,\"durationSec\":60,\"trades\":3}")"
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
start -e TRADES=2   # prints the session id
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
start -e DURATION_SEC=120
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
# next candle"; the session ends "trading session completed" after five settled trades, or
# "trading session stopped" with its reason
# to end it early: the stop route (POST /trading/sessions/:id/stop, #283) or kill-switch on
```

(REPLACE_WITH_TG_ID: your Telegram id; REPLACE_WITH_PAIR_ID: an open pair from `GET /trading/pairs`
that takes 15 s, the default `DURATION_SEC`, and pays at least 80 %: below the floor the CLI's
session waits for the payout.) `ACCOUNT_ID` is needed only with more than one active account.

After the #379 deploy (the owner's step: the agent has no SSH, and these ran on no pilot before
the merge), the floor and the pause:

```bash
# every listed signal is on a pair paying >= 80; scanned <= 25
docker compose exec -T backend sh -c 'wget -qO- --header "Authorization: Bearer $INTERNAL_API_TOKEN" http://127.0.0.1:3000/trading/signals'
# the pause and the payout wait inside a session
docker compose logs --since 1h trading-worker | grep -E 'waits for the signal to change|waits for the payout|intent created'
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
   H4); several workers are #94 (#93's lease covers the broker sockets only).
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
- #283 (shipped): the backend routes (start, status, stop — the writer of `user_stopped`); #284:
  the bot ([bot-session.md](bot-session.md)).
- #131: restart recovery; #135: `grant_revoked` as a stop reason; #94: the orchestrator under more than
  one worker container (#93's lease covers the broker sockets only).
- Real sessions: the schema takes `mode`, and `createTradingSession` refuses anything but `demo`
  (`mode_not_allowed`); real sessions (#121/#135) lift that refusal with their own fence. The
  `demo_only` refusal above it stays (#396). A real
  session row can only be written by hand (`seedTradingSession` in the tests).
- The invariant is Architecture Rules → "Торговая сессия" in `.claude/skills/architect/SKILL.md`.
