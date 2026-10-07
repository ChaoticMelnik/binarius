# Trading sessions (issue #130)

A trading session is a run of up to `settings.trades` trades on one broker account, one trade at
a time, in the session's `mode`. #130 lays the data layer: the `trading_sessions` table with its
constraints, the `settings` contract and the stop reasons in `packages/shared`, and the database
operations the session orchestrator calls. #283 adds the backend routes that start, read and stop
a session ([Routes](#routes)); they create demo sessions only. The orchestrator itself (the
worker's tick, the signal and pairs calls, the stake sizer, the `session-start` CLI and the
owner's pilot step) is **#287**: until it lands, a started session stays `active` with no intent
until its stop.

```bash
pnpm test --project unit packages/shared/src/trading-session.test.ts packages/shared/src/catalog.test.ts
# TEST_DATABASE_URL: README -> Test database
pnpm test --project integration packages/db/src/trading-session-ops.db.test.ts packages/db/src/trading-session-start.db.test.ts packages/db/src/schema.db.test.ts apps/backend/src/trading/session-routes.db.test.ts
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

## The table

| Column | Meaning |
|---|---|
| `status` | `active` → `stopped`; `paused` exists in the status list and nothing writes it |
| `settings` | jsonb object (CHECK `trading_sessions_settings_object_check`), settings v1 below; the column default `'{}'` is not valid v1 |
| `stop_reason` | one of `TradingSessionStopReason` (CHECK `trading_sessions_stop_reason_check`) |
| `started_at`, `ended_at` | the insert's `now()`; the stop's `now()` |
| `last_decision_at` | the runnable scan's order key; NULL until the orchestrator first reached an ending |

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
`invalid_settings`, so a row written by hand is a boundary too.

`stakeSettingsFor(minTradeAmount)` derives the fixed stake from the account's broker minimum:
the canonical spelling (leading and trailing zeros stripped, as `normalizeDecimal` in
`@binarius/db`; `trading-session-ops.db.test.ts` holds the two equal) and its own fraction length
as the scale — `'1.00000000'` → `{ '1', 0 }`, `'0.50000000'` → `{ '0.5', 1 }`, `'0.00000001'` →
`{ '0.00000001', 8 }`. Every valid minimum therefore passes the sizer's parameter check.

## Stop reasons

| Reason | Meaning | Writer |
|---|---|---|
| `completed` | settled trades reached `settings.trades` | #287 |
| `manual_review` | the account is halted, or an intent of the session is in `manual_review` | `stopHaltedSessions`; #287 |
| `rejected_twice` | the last two intents of the session are `rejected` | #287 |
| `timeout` | `started_at` + the maximum duration passed (database clock) | `stopExpiredSessions` |
| `stake_stop` | the stake sizer answered stop | #287 |
| `account_unavailable` | intent creation refused for a durable reason | #287 |
| `pair_unavailable` | the pair left the catalog or refuses the duration | #287 |
| `balance_unavailable` | no balance snapshot row for the account | #287 |
| `invalid_settings` | settings fail the schema or the sizer's parameter rules | #287 |
| `user_stopped` | the stop route | #283 |
| `kill_switch` | the global trading switch is closed ([kill-switch.md](kill-switch.md)) | `stopPausedSessions` (#144), run by #287's tick |

## Operations

| Operation | Statement | Notes |
|---|---|---|
| `createTradingSession(db, { telegramUserId, brokerAccountId, mode, settings })` | one transaction | refuses any mode but `demo` before it reads anything (`mode_not_allowed`, #144 review m1: since #144 nothing else fences a real session's intents); reads the account of that owner (an unknown id or another user's account → `account_not_found`), locks `users` `FOR NO KEY UPDATE` with `status = active` (`user_not_active`), then `broker_accounts` `FOR NO KEY UPDATE` (`account_revoked`, `account_not_confirmed` for `pending`, `account_halted`), then reads the trading switch without a lock (`trading_paused` while it is closed or its row is missing, #144); the active-session index → `active_session_exists`. Errors are `TradingSessionError` with a `TradingSessionDbErrorCode`, not a wire contract: the start route maps each one ([Routes](#routes)) |
| `checkTradingSessionStart(db, { telegramUserId, brokerAccountId? })` | plain selects, no lock | the start route's refusals, the first that applies wins: the trading switch (`trading_paused` while it is closed, #144), the user (`user_not_found`, `user_blocked`), the account by `resolveTradingAccount` — the single trade's rule (`broker_account_not_found`, `account_not_confirmed`, `ambiguous_broker_account`) —, its status (`account_revoked`, `account_not_confirmed`, `account_halted`), an active session of the account (`active_session_exists` with its id), then fewer than one available token (`insufficient_tokens`). On success: the account and its token expiry |
| `readTradingSessionView(db, id, telegramUserId)` | three selects in one `REPEATABLE READ` read-only transaction | the session joined to its account's user, so another user's id and a missing one are both `undefined`; the counters over the session's own intents (`settled`, `rejected`; `won`/`lost`/`tied` by the sign of the linked `broker_trades.profit`, compared in SQL); the newest intent by `created_at desc, id desc`. `settings` that fail v1 read as `null` with `planned: 0` |
| `readActiveTradingSessionView(db, brokerAccountId, telegramUserId)` | two reads | the account's active session as its owner sees it; `undefined` when none, or when it ended between the reads |
| `listRunnableSessions(db, { limit, exclude })` | one select (`trading_sessions_runnable_idx`) | `active`, and no non-terminal intent on the account (the active-intent index's own predicate, so a bot trade holds the session too); `last_decision_at asc nulls first, created_at`; `settings` raw |
| `stopExpiredSessions(db, { maxDurationMs, limit })` | one UPDATE | `started_at < now() − maxDurationMs` → `stopped`/`timeout` |
| `stopHaltedSessions(db, { limit })` | one UPDATE | the account `trading_halted`, or an intent of the session in `manual_review` → `stopped`/`manual_review` |
| `stopPausedSessions(db, { limit })` | one UPDATE | every active session while the trading switch is closed (`not tradingOpenSql`) → `stopped`/`kill_switch` (#144); only a person starts one again. Nothing calls it before #287's tick |
| `stopTradingSession(db, { id, reason })` | one UPDATE | CAS on `status = active`: a second stop finds nothing and the first reason stays |
| `markSessionDecision(db, { id })` | one UPDATE | `last_decision_at = now()` on an active session |
| `readSessionHistory(db, sessionId)` | two selects | the owner's `telegram_user_id` and the session's own intents in creation order with `status`, `amount`, `last_error` and the linked `broker_trades.profit` |
| `createSessionIntent(db, input)` | `createTradeIntent`'s transaction | the request key `session:<id>:<step>`, so a repeated step is a replay and the same step with other terms is `client_request_id_conflict`; the session lock below |

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
| 5 | `touchBalanceRequested`, then the stored balance snapshot, of any age (the sizer checks the balance before every trade) | — |
| 5a | no snapshot and the access token expires within `ACCESS_SKEW_MS`: the refresh runs in the background | 409 `balance_unavailable` at once; the caller retries |
| 5b | no snapshot: `balance.refresh` awaited for at most `TRADING_ACCESS_REFRESH_BUDGET_MS` (3 s), then a re-read | 409 `balance_unavailable` when still none |
| 6 | settings v1 with `stake = stakeSettingsFor(minTradeAmount)` | 409 `balance_unavailable` when the stored minimum is 0 (a valid snapshot value that gives `baseStake '0'`, which v1 refuses), with a `warn` line |
| 7 | `createTradingSession(…, mode: demo)` | its refusal mapped: `account_not_found` → 404 `broker_account_not_found`; `account_revoked`, `account_not_confirmed`, `account_halted`; `user_not_active` → `user_blocked`; `active_session_exists`; `trading_paused`; `mode_not_allowed` (unreachable: the route passes `demo`) |
| 8 | 201 `{ session }` | — |

- **The view on `active_session_exists`.** A second start — a double press, or a retry after a
  timeout that fired once the first had committed — gets the account's active session in
  `session`, so the caller learns what exists from the answer rather than from the code. `null`
  when that session ended before it was read.
- **The race between steps 3 and 7.** The creation transaction re-checks the user, the account
  (status, halt) and the one active session under its locks, and reads the trading switch, so a
  switch closed in between still refuses with `trading_paused`; a close committed after the
  insert is #287's `stopPausedSessions` sweep.
  **The tokens are checked only in step 3** (stated): a reserve that takes the last token in
  between leaves a session whose first attempt stops `account_unavailable` (#287).
- **A refused start may already have written refresh state:** steps 5–5b move
  `last_requested_at` and may write the balance snapshot before step 7 refuses. Both are the
  balance's state, not the session's.
- **Time.** Step 5b dominates: under `TRADING_SESSION_START_BUDGET_MS` (4 s), which is inside the
  backend's shutdown phase 1 (`apps/backend/src/timing.ts`, asserted at import).

### GET /trading/sessions/:id?telegramUserId=

200 `{ session }`; a non-uuid id, another user's session and a missing one are all 404
`not_found` with the same body (Rule 13); a missing `telegramUserId` is 400.

The view is an allowlist built key by key: `{ id, mode, status, stopReason, settings, startedAt,
endedAt, trades: { planned, settled, rejected, won, lost, tied }, lastIntent }` — `planned` is
`settings.trades`, `lastIntent` the same view `GET /trading/intents/:id` answers, or `null`.
Bounded: counters, one settings object, one intent; no list.

### POST /trading/sessions/:id/stop

Body `{ telegramUserId }`. The owner-scoped read first (404 `not_found` as above), then
`stopTradingSession(id, user_stopped)`: 200 `{ session }` stopped, or 409 `session_not_active` when
it was no longer active. The CAS is by id: a session's account and the account's user never
change, so no interleaving lets it stop another user's session. A live intent of the session
finishes on its own path.

### For #284

- The bot's request timeout must be at least `TRADING_SESSION_START_BUDGET_MS`; the link belongs
  to the bot's timing chain, which #284 extends when it adds the caller.
- `sessionFitsDeadline` is exported so the bot can hide a start the route would refuse.

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
# a fresh database starts with trading closed (docs/kill-switch.md)
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

## Boundaries

- #287: the orchestrator in the worker (the tick, the attempt and its endings, the backend signal
  and pairs clients, the stake sizer wiring, the `session-start` CLI, the owner's pilot step).
- #283 (shipped): the backend routes (start, status, stop — the writer of `user_stopped`); #284:
  the bot.
- #131: restart recovery; #135: `grant_revoked` as a stop reason; #93: the lease for more than one
  worker container.
- Real sessions: the schema takes `mode`, and `createTradingSession` refuses anything but `demo`
  (`mode_not_allowed`); real sessions (#121/#135) lift that refusal with their own fence. A real
  session row can only be written by hand (`seedTradingSession` in the tests).
- The invariant is Architecture Rules → "Торговая сессия" in `.claude/skills/architect/SKILL.md`.
