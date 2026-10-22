# Trade log (#666, #668)

Every decision a trading session acted on is a row of `signal_decisions`, written by the process
that acted, with its outcome: the journal entry the decision was computed from, the clocks of the
chain up to the broker, the pair's payout and last tick. A session's intent names the row it was
created from. A redeploy loses nothing of it: the log's `signal decision` lines stay as they were
([signal.md → The journal line](signal.md#the-journal-line)), and the trade log keeps the same
entry in the database. `trade-log export` reads it back as JSON lines or as the stand's trades
file.

Part 2 (#668) adds the ticks around each intent decision and around a 1-in-20 sample of the
shadow rows ([The ticks around a decision](#the-ticks-around-a-decision)), and the retention of
decisions without a trade ([Retention](#retention)).

| Piece | Where |
|---|---|
| The table | `packages/db/src/schema/signal-decisions.ts`, migrations `0068_signal_decisions`, `0069_decision_session_check` |
| The writer | `recordSignalDecision(exec, input)`, `signalDecisionInput(record, facts)` in `packages/db/src/signal-decision-ops.ts` |
| The reads | `readTradeLogPage`, `readSessionTradeSteps`, `journalEntryOf`, `readTradeLogEnd` (same file) |
| The constants and the line shapes | `packages/shared/src/trade-log.ts`; the entry and the record in `packages/shared/src/signal.ts` |
| The last tick and the tick window | `createTickStore` in `apps/backend/src/market-data/ticks.ts` |
| The ticks table | `packages/db/src/schema/decision-ticks.ts`, migration `0071_decision_ticks` |
| The keeper's reads and writes | `listDecisionTicksCandidates`, `insertDecisionTicks`, `sweepSignalDecisions` in `packages/db/src/decision-ticks-ops.ts` |
| The keeper | `createTradeLogKeeper` in `apps/backend/src/trade-log/keeper.ts` |
| The export | `apps/backend/src/cli/trade-log.ts` |

## The table

| Column | Meaning | Clock / source |
|---|---|---|
| `id` | uuid | |
| `context` | who decided: `session` (the orchestrator), `session_start` (`POST /trading/sessions`), `shadow` (the H1 shadow, #669, [h1.md](h1.md#the-row)) — `SignalDecisionContext`, CHECK `signal_decisions_context_check` | |
| `trading_session_id` | the session; NULL for a start that created none and for `shadow` (`signal_decisions_session_pair_check`: required for `session` and for `started`) | |
| `broker_account_id` | the account; required for `session` and `session_start` (`signal_decisions_account_pair_check`); with a session, the session's own account (`signal_decisions_session_account_fk → trading_sessions (id, broker_account_id)`, Rule 4) | |
| `step` | the session's intents + 1 when the decision was taken — the step the intent key `session:<id>:<step>` names; only for `session` (`signal_decisions_step_pair_check`), `> 0` | |
| `asset_id`, `interval` | the pair and the candle interval; `interval` in `SIGNAL_INTERVALS`, NULL allowed for a version that decides on ticks | |
| `version` | the signal version (`v2`); an identifier, CHECK by `SIGNAL_VERSION_PATTERN` (`^[a-z0-9_-]{1,16}$`), not a list: a later detector adds one without a migration | |
| `decided_at_ms` | the decider's `nowMs` (the entry's); a shadow row's: the end label `f` of the closed second it decided on | backend clock, read by the cache before its fetch; a shadow row's: the broker's (a second's label) |
| `taken_at_ms` | when the writer took the decision | the orchestrator's clock right after `evaluate` returned; the start route's after its signal and balance reads; the shadow's right after its detector |
| `recorded_at` | the row's insert | database clock, the transaction's start |
| `kind`, `action` | the decision's kind (`SignalKind`) and, for a signal only, its direction (`signal_decisions_action_pair_check`) | |
| `payout` | the pair's payout when the decision was taken, `numeric(8,4)` as `broker_trades.payout`; NULL allowed, and NULL also when the catalog's value is outside the column (`signalDecisionPayout`) | the catalog the writer read |
| `digits` | the pair's quote precision the decider used, 0..`MAX_PAIR_DIGITS` | |
| `params`, `decision`, `source`, `series` | the journal entry's fields as the backend answered them (jsonb, objects and an array) | |
| `last_tick` | `{ price, timestamp, receivedAtMs }`, the pair's newest data-socket tick when `POST /trading/signal` answered; NULL without the socket or before the pair's first tick | `timestamp` the broker's, `receivedAtMs` the backend's |
| `outcome`, `detail` | what the writer did with the decision (below); `detail` the code of a refusal or of the sizer's stop, CHECK by `SIGNAL_DECISION_DETAIL_PATTERN`, present exactly for `refused` and `stake_stop` (`signal_decisions_detail_pair_check`) | |
| `result` | a shadow row's outcome by the broker's prices, `{ entries: [{ entryDelaySec, entryPrice, exitPrice, outcome }] }` (#669, [h1.md](h1.md#the-row)); NULL on the rows of sessions (jsonb object) | |
| `ticks_until_ms` | the last broker second a row's prices rest on: a shadow row's `decided_at_ms + 7 000` (#669), the end of its tick window ([The ticks around a decision](#the-ticks-around-a-decision)); NULL on the rows of sessions. `signal_decisions_ticks_until_check` (`> decided_at_ms`), `signal_decisions_ticks_until_pair_check` (required for `shadow`), migration 0070 | broker |

`signal_decisions_outcome_kind_check`: a `no_signal` decision has outcome `no_signal`, and only it.
Indexes: `signal_decisions_recorded_idx (recorded_at, id)` (the export's range and order),
`signal_decisions_session_idx (trading_session_id, recorded_at)`,
`signal_decisions_shadow_recorded_idx (recorded_at) where context = 'shadow'` (the retention
sweep's shadow band, #668). Every CHECK is exercised on the
rows its writers build and on the NULL and boundary rows next to them (`schema.db.test.ts` →
signal_decisions).

`trade_intents.signal_decision_id` names the decision a session's intent was created from:
`trade_intents_decision_session_fk (signal_decision_id, trading_session_id) → signal_decisions (id,
trading_session_id)` — a decision of the intent's own session — and `trade_intents_decision_key`
— one intent per decision. The FK is MATCH SIMPLE and checks nothing while `trading_session_id` is
NULL, so `trade_intents_decision_session_check` (0069) names a decision only with the intent's
session: together they hold that a named decision is always of the intent's own session. NULL on
one-off bot intents (`POST /trading/intents`, not recorded), on every intent before 0068 (no
backfill), on a session intent created while the backend answered no usable record, and on one
whose decision row the database refused (E14′). The column is not in the intent's wire view.

No row is ever updated. The table is not a ledger and has no TRUNCATE guard; its only DELETE is the
retention sweep ([Retention](#retention)).

## The writers and their outcomes

One rule for both writers: the acting process writes one row per answer it gave after a decision
was read, with the outcome it reached, except the balance wait (E7′), which acts on no decision:
the step's decision is asked again. A path that ends before a decision exists writes nothing.

### The orchestrator (`context = session`)

`step` is read once, right after the session's history.

| # | Path (`orchestrator.ts`) | Ending | Row: `outcome` / `detail` | Test |
|---|---|---|---|---|
| — | every ending before `evaluate` (settings, history, balance, pairs, a closed pair at or before the limit) | as before | none: no decision | — |
| E1 | the backend call failed | hold `retryMs` | none: no answer | O7 |
| E2 | `fetch_failed` | hold | none: no record on a failure | O7 |
| E3 | `no_signal` past the no-signal limit | stop `no_signal_timeout` | `no_signal` / NULL | O9 |
| E4 | `no_signal` | hold to the next candle (the candle wake, #697) | `no_signal` / NULL | O2 |
| E5 | the paused direction past the limit | stop `no_signal_timeout` | `paused` / NULL (`action` the paused direction) | O10 |
| E6 | the paused direction | hold to the next candle (the candle wake, #697) | `paused` / NULL | O3 |
| E7′ | the sizer's `insufficient_balance` while a settlement on the account in the session's mode is newer than the balance, inside the no-signal limit from that settlement (#696) | hold `TRADING_SESSION_TICK_MS` | none: the step's decision is asked again on a current balance; the retry's row is the step's | BW1, BW5 |
| E7 | the sizer's stop | stop (`STAKE_STOP_REASONS`) | `stake_stop` / the sizer's `StopReason` code | O4 |
| E8 | the deadline, a throw or `stop()` after `evaluate` | no ending | none (risk 2) | — |
| E9 | `TradingSessionNotActiveError` | gone | none: thrown before the decision's INSERT, rolled back | O5 |
| E10 | `active_intent_exists`, `client_request_id_conflict` | reschedule | `refused` / the code | O5 |
| E11 | every other `createSessionIntent` refusal | stop | `refused` / the code | O5 |
| E12 | any other throw of `createSessionIntent` | failed | none: rolled back with the intent | — |
| E13 | `created: false` (a replay) | reschedule | `replayed` / NULL | O6 |
| E14 | `created: true` | created | `intent` / NULL, in the intent's transaction | O1, O14 |
| E14′ | `created: true` with the decision's INSERT refused (`decisionError`) | created | none: the savepoint rolled the row back, the intent names no decision; `warn` `insert_refused` (risk 1) | O13, D11 |
| E15 | a `decided` answer without a usable record (`record_missing`, `record_invalid`, `record_mismatch`) | as without | none this attempt; its intent names no decision | O7 |

E10/E11: a refusal thrown after the decision's INSERT (`active_intent_exists` comes from the
intent's INSERT) rolls that row back with the transaction, so the `refused` row is the step's only
one (O5). E13: the first process's transaction recorded its own `intent` row (or none, with an
old backend), this attempt records `replayed` with the same `step`: the lost ending is visible.

A stop after the no-signal limit (E3, E5) records the wait's outcome; the stop itself is a session
fact with one source, `trading_sessions.stop_reason`, which the export's `session.stopReason`
carries. When it is `no_signal_timeout`, the stopping decision is the session's last row by
`(recorded_at, id)` — unless that row's write failed (a `warn`), or a second worker's attempt in a
deploy overlap landed after the stop.

**The order of writes.** The intent's row is inserted inside `createInTransaction`, after the
session's lock and before the intent (Rule 5: it locks no existing row; its FKs take `KEY SHARE` on
rows the transaction already holds), in a savepoint (drizzle's nested transaction): a refusal rolls
back the row alone, the intent is created without its link and `createSessionIntent` returns the
error as `decisionError`, which the orchestrator logs as the `warn` below with
`reason: 'insert_refused'`. Every other row follows the ending the attempt reached, after
that ending's own write in `apply` (`markSessionDecision` or `stopTradingSession`), whether that
write's CAS matched or not: a session the user stopped while its signal was read still records the
decision, and its `stop_reason` stays the user's (O12). If the ending's write throws, no row is
written and the tick fails as before. The row's own write is best-effort: a throw is `warn`
`trading session decision not recorded` with `step` and the error's name and code (Rule 8), and the
ending stands (O8). A `decided` answer without a usable record is the same `warn`, once per
attempt, with `reason: 'record_missing'` (a backend before #666), `'record_invalid'` (the record
failed its schema) or `'record_mismatch'` (it is not the answer's decision, pair or interval); the
attempt goes on and its intent names no decision (O7).

### The H1 driver (`context = session`, `version = h1`, #707)

The backend's driver ([h1.md → The driver](h1.md#the-driver-707)) writes rows only for the
signals it acts on; a `no_signal` and a skip (a live intent, the limits, an ineligible pair) are
the counters of its `h1 driver` line. `params` is the shadow row's shape with `set = session`, so
the export prints the row as an entry `replayH1Entry` decides again; `interval` and
`ticks_until_ms` are NULL, `source` is the series' (`kind: ticks`).

| # | Path (`apps/backend/src/h1/driver.ts`) | Ending | Row: `outcome` / `detail` | Test |
|---|---|---|---|---|
| D1 | `created: true` | the intent, `submit_deadline_at = taken_at_ms + H1_SUBMIT_BUDGET_MS`; a wake | `intent` / NULL, in the intent's transaction | H1-DR1, H1-DB1 |
| D2 | `created: true` with the decision's INSERT refused | the intent without the link; `warn` `insert_refused` | none | H1-DR13 |
| D3 | `created: false` (a replay) | the cadence held | none | H1-DR12 |
| D4 | a stop refusal of `SESSION_INTENT_REFUSALS` | `stopTradingSession` with its reason, the session forgotten | `refused` / the code, after the stop, best-effort (`warn` `h1 driver decision not recorded`) | H1-DR10 |
| D5 | `active_intent_exists`, `client_request_id_conflict` | the session kept | `refused` / the code | H1-DR11 |
| D6 | `TradingSessionNotActiveError`, the history gone | forgotten | none | H1-DR17 |
| D7 | a skip of `sessionIntentBlock` (the hour, a live intent, N trades, the loss limit, two rejections) | none: the orchestrator stops it | none | H1-DR4, H1-DR6 |
| D8 | `no_signal` | none | none (В3 (a) #670) | H1-DR20 |
| D9 | any other throw of `createSessionIntent` | `errors`, a `warn` | none: rolled back with the intent | — |

`docs/h1.md` → Comparing with the shadow joins these rows with their trades and the shadow's R1
row of the same pair and second.

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

The worker reads `record` apart from the answer (`backend.ts`): it takes the key out before the
answer's own parse, so a bad record never refuses the answer. Beside a `decided` answer it parses
the record by `signalRecordSchema`, whose entry is narrowed to its row's columns (`nowMs` a positive
safe integer, `digits` 0..`MAX_PAIR_DIGITS`); then it checks that `entry.decision` equals the
answer's `decision` and that `entry.assetId` and `entry.interval` are the request's. A record that
fails either is dropped (`recordProblem` `invalid` or `mismatch`) and the answer trades: no row
rather than a wrong row (B7). A `record` beside a `fetch_failed` answer is ignored.

The entry's wire shape is `signalJournalEntrySchema` (shared), pinned to `packages/signal`'s
`SignalJournalEntry` both ways (`journal.test.ts` J8). `journalEntryOf(row)` rebuilds the entry
from the row (`intervalMs` from the interval, `nowMs` = `decided_at_ms`), so the export's `signal`
replays to the recorded decision (`trade-log.db.test.ts` X3 for a signal, X9 for a `no_signal`).

## The last tick

`createTickStore` keeps one tick per pair: the active data socket's `price.update`, pushed by the
market data manager next to the ring, with the backend's receipt time. A tick the ring would refuse
(`tickProblem`: invalid, or a minute and more from its receipt) is dropped, and one older than the
pair's newest does not replace it (`ticks.test.ts` T1–T4, `manager.test.ts` M28). The same store
keeps a window of ticks per pair for the keeper ([The ticks around a decision](#the-ticks-around-a-decision)); `last` is unchanged by it. It exists only
with `BROKER_WS_URL`. The tick is read when the route answers, not at the cache's `nowMs`: for a
cached decision the two can be up to one candle apart, and both clocks are stored (risk 4).

The tick is kept until a newer one; it is not cleared on a socket drop, a failover or a quiet pair.
`last_tick`'s age at the decision is `taken_at_ms - last_tick.receivedAtMs` (the backend's and the
worker's clocks, one host on the pilot, risk 6). A reader of `TickStore.last` bounds the age itself.

## The ticks around a decision

One `decision_ticks` row per captured decision: the pair's data-socket ticks over
`[decided_at_ms − TRADE_TICKS_BEFORE_MS, until]` by the broker's tick time, written once by the
backend's trade log keeper when the window has closed, never updated (Rule 45).

| Column | Meaning |
|---|---|
| `decision_id` | PK and FK → `signal_decisions.id` (restrict): one row per decision |
| `from_ms`, `until_ms` | the window, `from_ms > 0`, `until_ms >= from_ms` (`decision_ticks_from_ms_check`, `decision_ticks_window_check`) |
| `status` | `complete`, `truncated`, `unavailable` (`DecisionTicksStatus`, `decision_ticks_status_check`) |
| `detail` | why a window is not `complete`: `uncovered`, `hole`, `max_wait`, `quiet` (`DecisionTicksDetail`); present exactly when the status is not `complete` (`decision_ticks_detail_pair_check`) |
| `count` | the ticks in the row, `>= 0`; `0` exactly for `unavailable` (`decision_ticks_count_pair_check`) |
| `ticks` | a jsonb array of `count` tuples `[timestamp, receivedAtMs, price]`, ascending by broker time then receipt (`decision_ticks_ticks_check`) |
| `captured_at` | the insert, database clock |

**The candidates.** A keeper tick (every `TRADE_TICKS_SCAN_MS`) reads the decisions recorded within
`TRADE_TICKS_HORIZON_MS` (the database clock) that have no row: every `outcome = 'intent'` row, and
the `shadow` rows whose uuid is in the sample — the first four hex digits modulo
`TRADE_TICKS_SHADOW_SAMPLE` (20) are 0, `shadowTicksSampled` in JS and the same expression in the
SQL (`decision-ticks-ops.db.test.ts` K13). No other outcome gets ticks (owner, #668 В1).

**The window's end**, one source per decision kind:

| Decision | `until` | Clock |
|---|---|---|
| `shadow` | `ticks_until_ms` (`f + 7 000`, #669) | broker |
| `intent`, the broker trade closed | `close_timestamp_ms + TRADE_TICKS_AFTER_CLOSE_MS` | broker |
| `intent`, the intent `rejected` (or `settled` without a close) | its `updated_at + TRADE_TICKS_AFTER_CLOSE_MS` | database (Rule 28) |
| `intent` not closed by `decided_at_ms + TRADE_TICKS_MAX_WAIT_MS`, or ending after it | `decided_at_ms + TRADE_TICKS_MAX_WAIT_MS`, detail `max_wait` | backend |

A window is closed by the ring's rule: the pair's watermark ≥ `until`, or the keeper's clock ≥
`until + MARKET_DATA_SKEW_MARGIN_MS`. The keeper then asks the store for the window and writes the
row. Zero ticks make `unavailable`; otherwise `truncated` when the coverage is not whole or the
window was cut by the max wait, else `complete`. The detail is the first that applies:
`uncovered` > `hole` > `max_wait` > `quiet` (`quiet`: no ticks under whole coverage — a quiet
pair, or a pair the manager never pushed).

**The tick window** (`createTickStore`). Per pair, the ticks of the active data socket over the last
`TRADE_TICKS_BUFFER_MS` behind the pair's watermark, at most `TRADE_TICKS_MAX_PER_PAIR`. What it
knows of its own gaps decides the coverage:
- **uncovered** — the window starts before the store's first tick (the process started inside it),
  or below the pair's pruning floor (`watermark − buffer`, raised past a tick the cap pushed out);
- **hole** — the manager's `onDrop` (next to `ring.onDrop()`, both sites) opens a hole per pair
  from its watermark to its next tick past it, as in the ring; a window overlapping a hole, or
  reaching a mark no tick has closed yet, reads `hole`. The hole ends at that tick's own broker
  time, even when the tick is ahead of its receipt (conservative: `truncated`, never a false
  `complete`).
- **A tick stamped in the future** (up to `TICK_MAX_SKEW_MS` past its receipt) is kept with its own
  time and returned in its own window, but moves the pair's watermark only to its receipt +
  `TRADE_TICKS_AHEAD_MS` (500 ms), so it neither closes windows early nor prunes the buffer early;
  counted `ahead`. The store's first-tick mark takes the same clamped value, so one such tick does
  not make every window of the next minute `uncovered` (owner, #668 clarify).

The `market data` line carries `buffer: { pairs, held, ahead, dropped, holes }` (the last three
per period).

**How an attempt ends** (a candidate is a row of the query above):

| # | Candidate | Ending | What takes it out of the list |
|---|---|---|---|
| T1 | `shadow`, sampled | the row when `ticks_until_ms` closes | the row |
| T2 | `shadow`, unsampled | never a candidate | the predicate |
| T3 | `intent`, trade closed | the row when `close + 5 s` closes | the row |
| T4 | `intent`, intent `rejected` (or `settled` without a close) | the row when `updated_at + 5 s` closes | the row |
| T6 | `intent` in flight, trade open, or no intent row, before the max wait | nothing | bounded by T7 |
| T7 | as T6 at `decided + max wait`, or a trade ending after it | the row, `truncated`/`max_wait` (or `unavailable`) | the row |
| T8 | due but not closed yet | nothing | closes within `skew` of its end |
| T9 | the INSERT throws | `warn` `trade log ticks insert failed` (`errorLogFields`, `rows`); the chunk's candidates stay | the next tick; the horizon at the latest |
| T10 | the candidates query throws | `error` `trade log ticks tick failed` | the next tick |
| T11 | `stop()` between INSERT chunks | the rest is not written | the next start re-scans the horizon |
| T12 | recorded before the horizon (a restart longer than it, or no row in time) | never selected | the export prints `ticks: null` |
| T13 | another backend (a deploy overlap) wrote the row first | `on conflict do nothing` | the row |
| — | a window that fails its own bounds (`until <= from`, not finite — a writer's defect) | `warn` `trade log ticks invalid window` once per decision per process, counted `invalidWindow` | the horizon |

The line `trade log ticks` (`info`, only when a row was written or a window refused):
`{ scanned, captured: { complete, truncated, unavailable }, waiting, invalidWindow }`.

**Restart.** Nothing written is touched. Windows in flight lose the ticks before the new process's
first tick (`truncated`/`uncovered`, or `unavailable`/`uncovered`); a decision recorded more than
the horizon before the start stays without a row. Without `BROKER_WS_URL` there is no store and no
capture (`trade log keeper { capture: false }`); the sweep still runs.

## Retention

Decisions no intent names are deleted by age, with their `decision_ticks` row; a decision a
`trade_intents.signal_decision_id` names is kept forever (owner, #668 В2, В3):

| Rows | Kept |
|---|---|
| `context = 'shadow'` | `SIGNAL_DECISION_SHADOW_RETENTION_DAYS` (7) |
| every other row without an intent (`no_signal`, `paused`, `refused`, `started`, `session_start`, …) | `SIGNAL_DECISION_RETENTION_DAYS` (30) |
| a row an intent names | forever |

The age is `recorded_at` against the database's `now()`, never the process clock. The keeper's
sweep runs every `SIGNAL_DECISION_SWEEP_MS` (first one an hour after the start): one statement per
batch of `SIGNAL_DECISION_SWEEP_BATCH` victims, oldest first, deleting their ticks rows and then
the decisions, repeated while a batch is full, at most `SIGNAL_DECISION_SWEEP_MAX_BATCHES` a tick
and never after `stop()`. `info` `trade log sweep { decisions, ticks, batches }` when it deleted
anything; a throw is `error` `trade log sweep failed`, retried next hour. The shadow band is served
by `signal_decisions_shadow_recorded_idx`, the 30-day band by `signal_decisions_recorded_idx`, the
kept-forever test by `trade_intents_decision_key`. The sweep locks only `decision_ticks` and
`signal_decisions` rows (outside Rule 5's chain). A first run on a long-lived database deletes at
most the batch cap an hour and continues the next hour.

A report over shadow rows (#681's `h1 shadow report`) sees only what the sweep kept: a period longer
than 7 days holds only the last 7 days of shadow rows.

## The record's columns

Every value of the row that comes from outside the writer's own code, and what keeps it inside its
column, so that recording never stops trading.

| Column | Source | Guard | Test |
|---|---|---|---|
| `payout` | the writer's catalog read (the worker's and the start route's `pair.payout`), the broker's `z.number()`, unbounded by design (#631) | `signalDecisionPayout` in `recordSignalDecision`, the only INSERT: NULL unless finite and in `[0, SIGNAL_DECISION_PAYOUT_MAX]` (9999.9999, from the column's precision and scale) | SD14, O14, R43 |
| `digits` | `entry.digits`, the backend's catalog | the record's entry schema: 0..`MAX_PAIR_DIGITS`, the CHECK's constant; out of range drops the record | B7, S-rec4 |
| `decided_at_ms` | `entry.nowMs`, the backend's clock | the record's entry schema: a positive safe integer | B7, S-rec4 |
| `asset_id`, `interval` | the entry | pinned to the request (`assetId` is the request's positive int4) | B7 |
| `version`, `kind`, `action`, `params`, `decision`, `source`, `series` | the entry | the schemas' own lists and shapes, the CHECKs' constants; numbers finite (zod, the broker's candle schema, the ring's `tickProblem`) | S-rec2 |
| `last_tick` | the tick store | `tickProblem` at push, `lastTickSchema` on the wire | T1–T4, B7 |
| `taken_at_ms`, `step`, `context`, `outcome`, `detail`, the session and account ids | the writer's own clock, facts and closed code lists | internal | — |
| any column this table missed | — | the savepoint inside `createInTransaction` (the intent is created unlinked); the record read apart from the answer | D11, O13, B7 |

The start route parses no record: its entry is the feed's own object (`digits` from `assertDigits`,
`nowMs` from the cache's `Date.now()`, `assetId` its validated request's), and its `payout` goes
through the same guard. Its write stays autocommit and best-effort (R39).

## The export

```bash
pnpm --silent --filter @binarius/backend trade-log export --from <ISO 8601> [--to <ISO 8601>] [--format jsonl|trades-json] [--session <uuid>]
```

`DATABASE_URL` as the backend's. `--from` and `--to` are instants with a zone, up to milliseconds
(`2026-10-20T00:00:00Z`, `2026-10-20T00:00:00.123Z`); a finer fraction is refused (exit 2): the
export holds instants as milliseconds while `recorded_at` has microseconds, so a bound is always a
whole millisecond and `[from, to)` is exact (X1, X10). They are compared with `recorded_at`,
half-open `[from, to)`; without `--to` the
end is the database's clock at the export's start, rounded up to the next millisecond (the clock
`recorded_at` is written by: a decision recorded just before the export is in it). `--session`
keeps one session's rows. Rows are read in pages of 200 by `(recorded_at, id)`, the cursor kept as
the database's text so microseconds survive. The data goes to stdout, the count to stderr
(`строк: N`); `--silent` keeps pnpm's own banner out of stdout.

| Exit | When |
|---|---|
| 0 | done, no rows included (an export is not a gate) |
| 1 | `DATABASE_URL` missing or invalid, or a database failure (name and code; a JSONL export cut there has printed whole lines only) |
| 2 | not understood; the usage on stderr |

**`jsonl`** (the default): one line per decision, `tradeLogLineSchema`:

| Key | Content |
|---|---|
| `decision` | `id`, `context`, `outcome`, `detail`, `version`, `assetId`, `interval`, `step`, `kind`, `action`, `decidedAtMs`, `takenAtMs`, `recordedAtMs`, `ticksUntilMs`, `payout`, `lastTick`, `result` |
| `signal` | the journal entry (`journalEntryOf`); the stand's `parseJournalLine` reads it from this key, as from a log line. A shadow row's entry is `h1ShadowEntrySchema`'s, which `replayH1Entry` decides again ([h1.md](h1.md#replay-and-reading)) |
| `session` | `id`, `userId`, `brokerAccountId`, `mode`, `strategy`, `baseStake`, `durationSec` (from the row's settings; NULL when they do not parse), `stopReason`; `null` for a start without a session |
| `trade` | the decision's intent: `intentId`, `status`, `mode`, `action`, `amount`, `durationSec`, `createdAtMs`, `submittedAtMs`, `lastError` (the intent's failure reason, `null` without one; `entry_window_missed` when an H1 session's entry window closed before the take, #670), `submitDeadlineAtMs` (`trade_intents.submit_deadline_at`, `null` without a window, #670), `cycle` and `cycleStep` (the bot's numbering, `sessionTradeSteps`, settled trades only), and `broker`: `status`, `payout`, `openPrice`, `openTimestampMs`, `closePrice`, `closeTimestampMs`, `profit`, or `null` before the broker trade; `null` without an intent. A trade on a later page keeps its session's numbering (X8) |
| `ticks` | the decision's `decision_ticks` row (`tradeLogTicksSchema`): `status`, `detail`, `fromMs`, `untilMs`, `count`, `rows` (the stored `[timestamp, receivedAtMs, price]` tuples, `[]` for none); `null` without a row — not a candidate, not captured yet, or past the horizon |

The chain of a trade is `decision.decidedAtMs → decision.takenAtMs → trade.createdAtMs →
trade.submittedAtMs → trade.broker.openTimestampMs`, printed raw in ms: the backend's, the worker's,
the database's twice and the broker's clocks ([trade-executor.md](trade-executor.md#timing-for-analysis-666)).

**`trades-json`**: one JSON array of the closed session trades among those decisions, in the
stand's `calibrate --trades` shape (`tradeLogTradeJsonSchema`): `trading_session_id`, `asset_id`,
`action`, `duration_sec`, `created_at_ms`, `open_timestamp_ms`, `open_price`,
`close_timestamp_ms`, `close_price`, `profit` (the #381 export's ten), plus `submitted_at_ms`,
`payout`, `intent_id`, `decision_id`, `mode`, `amount`. A decision without an intent, an intent
without a broker trade (a `rejected` one) and an open broker trade are left out; they are in the
JSONL (`trade-log.db.test.ts` X3 for every field of the line, X4 for every field of the row). The
ticks are in the JSONL only; `trades-json` is the same with or without them (X14).

**Identifiers.** Internal uuids only. The read names its columns (Rule 9): no
`users.telegram_user_id`, no `broker_accounts.broker_user_id`, no token column, no
`broker_trades.raw` (`signal-decision-ops.db.test.ts` SD11, `trade-log.db.test.ts` X5 with
sentinels).

### On the pilot

Deploy order: backend, then worker (the migration applies at the backend's start; a new worker
against an old backend trades on without rows, a `warn` per attempt). After a demo session:

```bash
docker compose exec -T backend pnpm --silent --filter @binarius/backend trade-log export --from 2026-10-20T00:00:00Z > trade-log.jsonl
docker compose exec -T backend pnpm --silent --filter @binarius/backend trade-log export --from 2026-10-20T00:00:00Z --format trades-json > trades.json
# on the Mac, with the stand's cache (docs/signal-stand.md → Calibration)
STAND_DIR=~/binarius-stand/stand pnpm --filter @binarius/signal-stand stand calibrate --journal trade-log.jsonl --trades trades.json --session-candles ~/binarius-stand/candles
```

## Tests

- `packages/shared`: `signal.test.ts` S-rec1–S-rec4 (the request flag, the record, the stored
  union, the record narrowed to its columns), `trade-log.test.ts` (the patterns; every refusal
  code fits `detail`; TL1 the shadow sample, TL2 the export's `ticks` shape),
  `contract-coverage.test.ts` (the answer's keys).
- `packages/signal`: `journal.test.ts` J8 (the shared schema is the module's type, both ways).
- `packages/db`: `schema.db.test.ts` → signal_decisions (every CHECK, both FKs, the unique keys,
  `trade_intents_decision_session_check`); `signal-decision-ops.db.test.ts` SD1–SD14 (SD14: the
  payout guard); `trading-session-ops.db.test.ts` D7–D11 (the intent's transaction, the
  savepoint); `schema.db.test.ts` → decision_ticks (#668: every CHECK, the PK, the restrict FK,
  the partial index); `decision-ticks-ops.db.test.ts` K1–K13 (the candidates, the insert, the
  sweep on the database clock, the sample in SQL); `signal-decision-ops.db.test.ts` SD18 (the
  export's ticks).
- `apps/backend`: `ticks.test.ts` T1–T4 and the window T5–T15, `manager.test.ts` M28, M32 and M32b (the
  holes at both `onDrop` sites, the `buffer` line), `signal-routes.test.ts` R19–R21,
  `session-routes.db.test.ts` R36–R39, R42 and R43, `cli/trade-log.db.test.ts` X1–X14,
  `trade-log/keeper.test.ts` C1–C15 (one case per ending, the sweep loop),
  `trade-log/keeper.db.test.ts` D1–D4, `timing.test.ts` (the #668 chain).
- `apps/trading-worker`: `backend.test.ts` B1 (the flag), B7 (the record read apart) and S4,
  `orchestrator.db.test.ts` O1–O14, L1 (the `warn` row of [trading-session.md → Logs](trading-session.md#logs)).
- `packages/signal-stand`: `journal-line.test.ts` JL and `calibrate.test.ts` unchanged; C12 (an
  export reads as the log did).

## Accepted risks

1. **The intent's row is in the intent's transaction, in a savepoint.** A row the database
   refuses rolls back alone: the intent is created without its link and the attempt logs
   `insert_refused`. The columns' guards ([The record's columns](#the-records-columns)) keep
   outside values inside the columns, so the savepoint is a backstop: an unlinked intent is a
   defect to look for, never a stopped session. Falsifiable: no `signal_decisions` insert ever
   fails an intent's creation (D11, O13).
2. **A decision without an ending writes nothing** (the deadline, a throw, `stop()` between
   `evaluate` and the ending): it made no trade, and the next attempt decides again. Visible as a
   gap in the steps.
3. **A new worker against an old backend records nothing** (a `warn` per attempt); deploy the
   backend first.
4. **`last_tick` is the newest tick at the route's answer**, not at the cache's `nowMs`; the
   decision's `decision_ticks` row (intent decisions) gives the tick at any instant of its window.
5. **Volume:** about 4 KB per decision (the series is at most the decision's 60-row window), one
   decision per candle while a session waits: about 30 MB a day at ten session-hours on 5 s
   candles, kept 30 days without a trade, forever with one. An `intent` window is about 340 ticks,
   about 11 KB of jsonb before TOAST compression, kept with its trade; the shadow sample is about
   3 500 rows a day, kept 7 days.
6. **The clocks are three processes' and the broker's**; on the pilot the three share one host.
   Printed raw, never aligned.
7. **`version` and `detail` are pattern-checked, not listed**; a wrong version shows at replay
   (`RangeError`), not at insert.
8. **`recorded_at` of an `intent` row is its transaction's start**, at or before the intent's
   `created_at`; the export orders by it.
9. **Export memory:** a page of 200 rows; `trades-json` holds its whole array (about 300 bytes a
   trade).
10. **No audit row for an export**: an operator's CLI on the server, like `kill-switch status`.
11. **Three clocks in one ticks window**: `from` is the backend's `decided_at_ms − 60 s`, the ticks'
    `timestamp` the broker's, `until` the broker's (a close), the database's (`updated_at`) or the
    backend's (the max wait); printed raw. Falsifiable: a trade's `open_timestamp_ms` lies inside its
    window's ticks (D1).
12. **A trade longer than about 165 s is cut** (`truncated`/`max_wait`): sessions trade 5 s (5 and 15 s until #685).
13. **A restart loses the ticks of windows in flight** (`uncovered`), and one longer than the
    horizon leaves those decisions without a row; visible in `status` and `ticks: null`.
14. **No socket, no ticks**: without `BROKER_WS_URL` no decision gets a row.
15. **The sample is uniform over the uuid**, not stratified by pair or hour (≈ 1 in 20 ± binomial
    noise).
16. **One capture per decision**: a tick arriving after the capture (the clock rule closed the
    window first, or a watermark moved by a tick up to 500 ms ahead of its receipt) is not in the
    row.
17. **The statuses rest on the store's own knowledge of its gaps**: a drop the manager does not
    report (`onDrop` not called) reads `complete`; the sites are the two `ring.onDrop()` calls
    (M32 covers the failover's, M32b the active leaving `ready`). A pair whose first tick of the process
    comes after a drop has no hole mark for that drop.
18. **Memory**: about 5 MB at the measured stream (556 ticks/s on 144 pairs, 240 s), 35 MB at the
    cap on every pair; not measured on the pilot.

## Boundaries

- Out of #668: a continuous table of every tick (rejected, #666); ticks for decisions other than
  `intent` and the sampled `shadow` rows; a report or dashboard; the worker (it neither reads nor
  writes `decision_ticks`).
- #669: the H1 shadow's rows (`context: shadow`, `version: h1`, `result`, `ticks_until_ms`),
  [h1.md](h1.md). #670's creators of session intents must pass `decision` to
  `createSessionIntent` (the type requires it).
- One-off bot trades and the bot's analyses are not recorded (owner, #666). Reports:
  `h1 shadow report` over the shadow rows (#681, [h1.md → The report](h1.md#the-report)); otherwise
  only the export.
