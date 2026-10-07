# Trading sessions (issue #130)

A trading session is a run of up to `settings.trades` trades on one broker account, one trade at
a time, in the session's `mode` (the first writer, #287's CLI, creates demo sessions). #130 lays the data layer: the `trading_sessions` table with its constraints, the
`settings` contract and the stop reasons in `packages/shared`, and the database operations the
session orchestrator calls. The orchestrator itself (the worker's tick, the signal and pairs
calls, the stake sizer, the `session-start` CLI and the owner's pilot step) is **#287**; nothing in
`main` creates a session or a session intent yet.

```bash
pnpm test --project unit packages/shared/src/trading-session.test.ts
# TEST_DATABASE_URL: README -> Test database
pnpm test --project integration packages/db/src/trading-session-ops.db.test.ts packages/db/src/schema.db.test.ts
```

## Components

| Piece | Where | What |
|---|---|---|
| Settings v1, stop reasons | `packages/shared/src/trading-session.ts` (`@binarius/shared/trading-session`) | `tradingSessionSettingsSchema`, `TradingSessionStopReason`, `stakeSettingsFor`, `MAX_SESSION_TRADES` 20, `DEFAULT_SESSION_TRADES` 5 |
| Table | `packages/db/src/schema/trading-sessions.ts`, migration `0018_trading_session_orchestration` | the columns and constraints below |
| Operations | `packages/db/src/trading-session-ops.ts` | create, the runnable scan, the two stop sweeps, the history, the CAS stop, the decision mark, the session intent |
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
| `createTradingSession(db, { telegramUserId, brokerAccountId, mode, settings })` | one transaction | reads the account of that owner (an unknown id or another user's account → `account_not_found`), locks `users` `FOR NO KEY UPDATE` with `status = active` (`user_not_active`), then `broker_accounts` `FOR NO KEY UPDATE` (`account_not_active` unless `active`, `account_halted`), then reads the trading switch without a lock (`trading_paused` while it is closed or its row is missing, #144); no account → `account_not_found`; the active-session index → `active_session_exists`. Errors are `TradingSessionError` with a db-local code, not a wire contract |
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

## Boundaries

- #287: the orchestrator in the worker (the tick, the attempt and its endings, the backend signal
  and pairs clients, the stake sizer wiring, the `session-start` CLI, the owner's pilot step).
- #283: the backend routes (start, status, stop — the writer of `user_stopped`); #284: the bot.
- #131: restart recovery; #135: `grant_revoked` as a stop reason; #93: the lease for more than one
  worker container.
- Real sessions: the schema and the operations take `mode`; a real session would trade under
  Rule 22's switch, the same one as demo (#144). No writer creates one.
- The invariant is Architecture Rules → "Торговая сессия" in `.claude/skills/architect/SKILL.md`.
