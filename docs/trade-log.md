# Trade log (#666)

Every decision a trading session acted on is a row of `signal_decisions`, written by the process
that acted, with its outcome: the journal entry the decision was computed from, the clocks of the
chain up to the broker, the pair's payout and last tick. A session's intent names the row it was
created from. A redeploy loses nothing of it: the log's `signal decision` lines stay as they were
([signal.md → The journal line](signal.md#the-journal-line)), and the trade log keeps the same
entry in the database. The export that reads it back, `trade-log export` (JSON lines and the
stand's trades file), is the second PR of #666 ([The export](#the-export)).

This is part 1. Part 2 (#668) adds the ticks around each trade, their buffer and the retention
sweep.

| Piece | Where |
|---|---|
| The table | `packages/db/src/schema/signal-decisions.ts`, migration `0068_signal_decisions` |
| The writer | `recordSignalDecision(exec, input)`, `signalDecisionInput(record, facts)` in `packages/db/src/signal-decision-ops.ts` |
| The constants and the line shapes | `packages/shared/src/trade-log.ts`; the entry and the record in `packages/shared/src/signal.ts` |
| The last tick | `createTickStore` in `apps/backend/src/market-data/ticks.ts` |

## The table

| Column | Meaning | Clock / source |
|---|---|---|
| `id` | uuid | |
| `context` | who decided: `session` (the orchestrator), `session_start` (`POST /trading/sessions`), `shadow` (no writer yet, #667) — `SignalDecisionContext`, CHECK `signal_decisions_context_check` | |
| `trading_session_id` | the session; NULL for a start that created none and for `shadow` (`signal_decisions_session_pair_check`: required for `session` and for `started`) | |
| `broker_account_id` | the account; required for `session` and `session_start` (`signal_decisions_account_pair_check`); with a session, the session's own account (`signal_decisions_session_account_fk → trading_sessions (id, broker_account_id)`, Rule 4) | |
| `step` | the session's intents + 1 when the decision was taken — the step the intent key `session:<id>:<step>` names; only for `session` (`signal_decisions_step_pair_check`), `> 0` | |
| `asset_id`, `interval` | the pair and the candle interval; `interval` in `SIGNAL_INTERVALS`, NULL allowed for a version that decides on ticks | |
| `version` | the signal version (`v2`); an identifier, CHECK by `SIGNAL_VERSION_PATTERN` (`^[a-z0-9_-]{1,16}$`), not a list: a later detector adds one without a migration | |
| `decided_at_ms` | the decider's `nowMs` (the entry's) | backend clock, read by the cache before its fetch |
| `taken_at_ms` | when the writer took the decision | the orchestrator's clock right after `evaluate` returned; the start route's after its signal and balance reads |
| `recorded_at` | the row's insert | database clock, the transaction's start |
| `kind`, `action` | the decision's kind (`SignalKind`) and, for a signal only, its direction (`signal_decisions_action_pair_check`) | |
| `payout` | the pair's payout when the decision was taken, `numeric(8,4)` as `broker_trades.payout`; NULL allowed | the catalog the writer read |
| `digits` | the pair's quote precision the decider used, 0..`MAX_PAIR_DIGITS` | |
| `params`, `decision`, `source`, `series` | the journal entry's fields as the backend answered them (jsonb, objects and an array) | |
| `last_tick` | `{ price, timestamp, receivedAtMs }`, the pair's newest data-socket tick when `POST /trading/signal` answered; NULL without the socket or before the pair's first tick | `timestamp` the broker's, `receivedAtMs` the backend's |
| `outcome`, `detail` | what the writer did with the decision (below); `detail` the code of a refusal or of the sizer's stop, CHECK by `SIGNAL_DECISION_DETAIL_PATTERN`, present exactly for `refused` and `stake_stop` (`signal_decisions_detail_pair_check`) | |
| `result` | reserved for #667's shadow outcome (jsonb object) | |

`signal_decisions_outcome_kind_check`: a `no_signal` decision has outcome `no_signal`, and only it.
Indexes: `signal_decisions_recorded_idx (recorded_at, id)` (the export's range and order),
`signal_decisions_session_idx (trading_session_id, recorded_at)`. Every CHECK is exercised on the
rows its writers build and on the NULL and boundary rows next to them (`schema.db.test.ts` →
signal_decisions).

`trade_intents.signal_decision_id` names the decision a session's intent was created from:
`trade_intents_decision_session_fk (signal_decision_id, trading_session_id) → signal_decisions (id,
trading_session_id)` — a decision of the intent's own session — and `trade_intents_decision_key`
— one intent per decision. NULL on one-off bot intents (`POST /trading/intents`, not recorded),
on every intent before 0068 (no backfill), and on a session intent created while the backend
answered no record. The column is not in the intent's wire view.

No row is ever updated. The table is not a ledger and has no TRUNCATE guard.

## The writers and their outcomes

One rule for both writers: the acting process writes one row per answer it gave after a decision
was read, with the outcome it reached. A path that ends before a decision exists writes nothing.

### The orchestrator (`context = session`)

`step` is read once, right after the session's history.

| # | Path (`orchestrator.ts`) | Ending | Row: `outcome` / `detail` | Test |
|---|---|---|---|---|
| — | every ending before `evaluate` (settings, history, balance, pairs, a closed pair at or before the limit) | as before | none: no decision | — |
| E1 | the backend call failed | hold `retryMs` | none: no answer | O7 |
| E2 | `fetch_failed` | hold | none: no record on a failure | O7 |
| E3 | `no_signal` past the no-signal limit | stop `no_signal_timeout` | `no_signal` / NULL | O9 |
| E4 | `no_signal` | hold to the next candle | `no_signal` / NULL | O2 |
| E5 | the paused direction past the limit | stop `no_signal_timeout` | `paused` / NULL (`action` the paused direction) | O10 |
| E6 | the paused direction | hold to the next candle | `paused` / NULL | O3 |
| E7 | the sizer's stop | stop (`STAKE_STOP_REASONS`) | `stake_stop` / the sizer's `StopReason` code | O4 |
| E8 | the deadline, a throw or `stop()` after `evaluate` | no ending | none (risk 2) | — |
| E9 | `TradingSessionNotActiveError` | gone | none: thrown before the decision's INSERT, rolled back | O5 |
| E10 | `active_intent_exists`, `client_request_id_conflict` | reschedule | `refused` / the code | O5 |
| E11 | every other `createSessionIntent` refusal | stop | `refused` / the code | O5 |
| E12 | any other throw of `createSessionIntent`, a CHECK of the decision's INSERT included | failed | none: rolled back with the intent (risk 1) | — |
| E13 | `created: false` (a replay) | reschedule | `replayed` / NULL | O6 |
| E14 | `created: true` | created | `intent` / NULL, in the intent's transaction | O1 |

E10/E11: a refusal thrown after the decision's INSERT (`active_intent_exists` comes from the
intent's INSERT) rolls that row back with the transaction, so the `refused` row is the step's only
one (O5). E13: the first process's transaction recorded its own `intent` row (or none, with an
old backend), this attempt records `replayed` with the same `step`: the lost ending is visible.

A stop after the no-signal limit (E3, E5) records the wait's outcome; the stop itself is a session
fact with one source, `trading_sessions.stop_reason`. When it is `no_signal_timeout`, the stopping decision is the session's last row by
`(recorded_at, id)` — unless that row's write failed (a `warn`), or a second worker's attempt in a
deploy overlap landed after the stop.

**The order of writes.** The intent's row is inserted inside `createInTransaction`, after the
session's lock and before the intent (Rule 5: it locks no existing row; its FKs take `KEY SHARE` on
rows the transaction already holds). Every other row follows the ending the attempt reached, after
that ending's own write in `apply` (`markSessionDecision` or `stopTradingSession`), whether that
write's CAS matched or not: a session the user stopped while its signal was read still records the
decision, and its `stop_reason` stays the user's (O12). If the ending's write throws, no row is
written and the tick fails as before. The row's own write is best-effort: a throw is `warn`
`trading session decision not recorded` with `step` and the error's name and code (Rule 8), and the
ending stands (O8). A `decided` answer without `record` (a backend before #666) is the same `warn`
with `reason: 'record_missing'`, once per attempt; the attempt goes on and its intent names no
decision (O7).

### The start route (`context = session_start`, no `step`)

| # | Path (`session-routes.ts`) | Answer | Row: `outcome` / `detail` | Test |
|---|---|---|---|---|
| S0 | `session_too_long`, the eligibility refusals (`active_session_exists` included), `catalog_unavailable`, `pair_unavailable` | 4xx/503 | none: before the signal read | R42 |
| S1 | `fetch_failed` or a throw of the feed | 503 `signal_unavailable` | none: no entry | R42 |
| S2 | `no_signal` | 409 | `no_signal` / NULL, no session | R37 |
| S3 | a signal, no balance snapshot | 409 `balance_unavailable` | `refused` / `balance_unavailable` | R38 |
| S4 | `checkStake` refuses | 409 | `refused` / `stake_precision`, `stake_below_minimum` or `insufficient_balance` | R38 |
| S5 | `buildSessionSettings` fails (a zero minimum) | 409 `balance_unavailable` | `refused` / `balance_unavailable` | R38 |
| S6 | `createTradingSession` refuses | 409 | `refused` / the wire code (`active_session_exists` included) | R38 (`demo_only`; the others are races with the eligibility check and go through the same line) |
| S7 | `createTradingSession` returns | 201 | `started` / NULL, with the new session, written before the view's read | R36 |
| S8 | a throw of the snapshot read, the stakes read or the creation (not a `TradingSessionError`) | 500 | none | — |

`broker_account_id` is the eligible account, `payout` the catalog's, `taken_at_ms` the route's
clock after its reads. The write is best-effort: a throw is `warn` `session start decision not
recorded` (account, asset, name and code), the answer unchanged (R39).

## The record of POST /trading/signal

The worker's session source sends `{ assetId, interval, record: true }`. With the flag, a
`decided` answer carries `record: { entry, lastTick }` (`signalRecordSchema`): `entry` is the
cache's held journal entry — the same object the `signal decision` line carries — and `lastTick`
the tick store's newest tick of the pair at the answer, or `null`. Without the flag the answer is
exactly as before; the bot never sends it. A `fetch_failed` answer has no record. The answer grows
by one entry, about 5 KB, far below the worker's `MAX_BACKEND_BODY_BYTES` (`backend.test.ts` S4
sizes a 300-row series). The start route reads the feed in-process and stores the evaluation's own
entry.

The entry's wire shape is `signalJournalEntrySchema` (shared), pinned to `packages/signal`'s
`SignalJournalEntry` both ways (`journal.test.ts` J8). The row stores the entry's fields as the
backend answered them, so the entry is rebuilt from the row alone (`intervalMs` from the interval,
`nowMs` = `decided_at_ms`; `trading-session-ops.db.test.ts` D7, `orchestrator.db.test.ts` O1
compare the stored series, source and tick with the answered record).

## The last tick

`createTickStore` keeps one tick per pair: the active data socket's `price.update`, pushed by the
market data manager next to the ring, with the backend's receipt time. A tick the ring would refuse
(`tickProblem`: invalid, or a minute and more from its receipt) is dropped, and one older than the
pair's newest does not replace it (`ticks.test.ts` T1–T4, `manager.test.ts` M28). It exists only
with `BROKER_WS_URL`. The tick is read when the route answers, not at the cache's `nowMs`: for a
cached decision the two can be up to one candle apart, and both clocks are stored (risk 4).

## The export

`trade-log export` and the reads it is built on (a page of decisions by `(recorded_at, id)`, the
cycle and step of each trade, the entry rebuilt from a row) come with the second PR of #666.

Deploy order on the pilot: backend, then worker (the migration applies at the backend's start; a
new worker against an old backend trades on without rows, a `warn` per attempt).

## Tests

- `packages/shared`: `signal.test.ts` S-rec1–S-rec3 (the request flag, the record, the stored
  union), `trade-log.test.ts` (the patterns; every refusal code fits `detail`),
  `contract-coverage.test.ts` (the answer's keys).
- `packages/signal`: `journal.test.ts` J8 (the shared schema is the module's type, both ways).
- `packages/db`: `schema.db.test.ts` → signal_decisions (every CHECK, both FKs, the unique keys);
  `signal-decision-ops.db.test.ts` SD1–SD3; `trading-session-ops.db.test.ts` D7–D10 (the
  intent's transaction).
- `apps/backend`: `ticks.test.ts` T1–T4, `manager.test.ts` M28, `signal-routes.test.ts` R19–R21,
  `session-routes.db.test.ts` R36–R39 and R42.
- `apps/trading-worker`: `backend.test.ts` B1 (the flag) and S4, `orchestrator.db.test.ts`
  O1–O12, L1 (the `warn` row of [trading-session.md → Logs](trading-session.md#logs)).

## Accepted risks

1. **The intent's row is in the intent's transaction.** A failing insert fails that attempt's
   creation; a CHECK broken by a programming error would block session trading until fixed. The
   input comes from a wire-validated entry and typed constants, and every CHECK has an accepted-row
   test. Two transactions would lose the atomic link.
2. **A decision without an ending writes nothing** (the deadline, a throw, `stop()` between
   `evaluate` and the ending): it made no trade, and the next attempt decides again. Visible as a
   gap in the steps.
3. **A new worker against an old backend records nothing** (a `warn` per attempt); deploy the
   backend first.
4. **`last_tick` is the newest tick at the route's answer**, not at the cache's `nowMs`; #668's
   window gives the tick at any instant.
5. **Volume until #668:** about 4 KB per decision (the series is at most the decision's 60-row
   window), one decision per candle while a session waits: about 30 MB a day at ten session-hours
   on 5 s candles. No sweep in part 1.
6. **The clocks are three processes' and the broker's**; on the pilot the three share one host.
   Stored raw, never aligned.
7. **`version` and `detail` are pattern-checked, not listed**; a wrong version shows at replay
   (`RangeError`), not at insert.
8. **`recorded_at` of an `intent` row is its transaction's start**, at or before the intent's
   `created_at`; the export orders by it.

## Boundaries

- #668: the ticks around each trade (`decision_ticks`, from `decision − 60 s` to `close + 5 s`), the
  tick store's window, the retention sweep (rows without an intent after 30 days), the ticks of
  the export.
- #667: the shadow detector's rows (`context: shadow`, `version: h1`, `result`); its new creators of
  session intents must pass `decision` to `createSessionIntent` (the type requires it).
- One-off bot trades and the bot's analyses are not recorded (owner, #666). Reports and dashboards:
  none, only the export (the second PR of #666).
