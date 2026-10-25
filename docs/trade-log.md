# Trade log (#666, #668, #502)

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

#502 adds the fingerprint of a row's parameters (`params_hash`) and `trade-log report`: win rate,
95 % CI, break-even and P&L of the closed trades by version × parameters × pair × interval ×
duration ([The report](#the-report)).

| Piece | Where |
|---|---|
| The table | `packages/db/src/schema/signal-decisions.ts`, migrations `0068_signal_decisions`, `0069_decision_session_check`, `0082_signal_decision_params_hash` (#502) |
| The writer | `recordSignalDecision(exec, input)`, `signalDecisionInput(record, facts)` in `packages/db/src/signal-decision-ops.ts` |
| The reads | `readTradeLogPage`, `readSessionTradeSteps`, `journalEntryOf`, `readTradeLogEnd` (same file) |
| A reader outside the export | the session notices' sender (#722): `waitingForSignalSql` in `packages/db/src/session-notice-ops.ts` reads a session's latest row of `context = session` on `signal_decisions_session_idx` — `no_signal` is «the session waits for a signal», which shows the waiting message ([bot-session.md](bot-session.md#the-waiting-message-536)); a failed write of that row delays the message by a candle |
| The constants and the line shapes | `packages/shared/src/trade-log.ts`; the entry and the record in `packages/shared/src/signal.ts` |
| The last tick and the tick window | `createTickStore` in `apps/backend/src/market-data/ticks.ts` |
| The ticks table | `packages/db/src/schema/decision-ticks.ts`, migration `0071_decision_ticks` |
| The keeper's reads and writes | `listDecisionTicksCandidates`, `insertDecisionTicks`, `sweepSignalDecisions` in `packages/db/src/decision-ticks-ops.ts` |
| The keeper | `createTradeLogKeeper` in `apps/backend/src/trade-log/keeper.ts` |
| The export | `apps/backend/src/cli/trade-log.ts` |
| The report (#502) | `readTradeReportStats` in `packages/db/src/signal-decision-ops.ts`; `apps/backend/src/cli/trade-report.ts`, dispatched from `trade-log.ts`; the window parser and the labels shared with `h1 shadow report` in `apps/backend/src/cli/report.ts` |

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
| `payout` | the pair's payout when the decision was taken, `numeric(8,4)` as `broker_trades.payout`; NULL allowed, and NULL also when the catalog's value is outside the column (`payoutInColumn`, `packages/db/src/schema/columns.ts`, shared with `broker_trades.payout`, #675) | the catalog the writer read |
| `digits` | the pair's quote precision the decider used, 0..`MAX_PAIR_DIGITS` | |
| `params`, `decision`, `source`, `series` | the journal entry's fields as the backend answered them (jsonb, objects and an array) | |
| `params_hash` | the parameters' fingerprint (#502): `text generated always as (md5(params::text)) stored not null`, migration 0082. The database computes it for every row, old rows included; no writer names it (an INSERT or UPDATE naming the column fails `428C9`, and drizzle's insert type has no such key). jsonb's text is canonical, so one parameter set in any key order is one fingerprint; `5` and `5.0` are two (jsonb keeps the number's text; `JSON.stringify` never writes `5.0`). The report groups by it: parameters changed without a new `version` are a row of their own | database |
| `last_tick` | `{ price, timestamp, receivedAtMs }`, the pair's newest data-socket tick when `POST /trading/signal` answered; NULL without the socket or before the pair's first tick | `timestamp` the broker's, `receivedAtMs` the backend's |
| `outcome`, `detail` | what the writer did with the decision (below); `detail` the code of a refusal or of the sizer's stop, CHECK by `SIGNAL_DECISION_DETAIL_PATTERN`, present exactly for `refused` and `stake_stop` (`signal_decisions_detail_pair_check`) | |
| `result` | a shadow row's outcome by the broker's prices, `{ entries: [{ entryDelaySec, entryPrice, exitPrice, outcome }] }` (#669, [h1.md](h1.md#the-row)); NULL on the rows of sessions (jsonb object) | |
| `ticks_until_ms` | the last broker second a row's prices rest on: a shadow row's `decided_at_ms + 7 000` (#669), the end of its tick window ([The ticks around a decision](#the-ticks-around-a-decision)); NULL on the rows of sessions. `signal_decisions_ticks_until_check` (`> decided_at_ms`), `signal_decisions_ticks_until_pair_check` (required for `shadow`), migration 0070 | broker |

`signal_decisions_outcome_kind_check`: a `no_signal` decision has outcome `no_signal`, and only it.
Indexes: `signal_decisions_recorded_idx (recorded_at, id)` (the export's range and order),
`signal_decisions_session_idx (trading_session_id, recorded_at)`,
`signal_decisions_shadow_recorded_idx (recorded_at) where context = 'shadow'` (the retention
sweep's shadow band, #668), `signal_decisions_version_params_idx (version, params_hash)` (the
report's grouping, #502). Every CHECK is exercised on the
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
| E5/E6 | the paused direction (#379…#698) | — | `paused` / NULL: no writer since #698; rows before it read and export (X-tests) | — |
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

A stop after the no-signal limit (E3) records the wait's outcome; the stop itself is a session
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

### The H1 driver (`context = session`, `version = h1`, `h1-repeat` or `h1-start`, #707, #775, #829)

The backend's driver ([h1.md → The driver](h1.md#the-driver-707)) writes rows for the signals it
acts on, for the repeat steps (#775), for one `no_signal` per waiting period (#775) and for the
second it stops a session at the no-signal limit (#775, review round 1); a skip (a
live intent, the limits, the sizer, an ineligible pair) is a counter of its `h1 driver` line.
`params` of a `version = h1` row is the shadow row's shape with `set = session`, so the export
prints the row as an entry `replayH1Entry` decides again; `interval` and `ticks_until_ms` are
NULL, `source` is the series' (`kind: ticks`). A repeat row (`version = h1-repeat`) is decided by
the rule, not the detector: `params = { rule: repeat_step_2, strategy }`, `decision.after` the
settled trade it repeats, `source = { kind: settlement, trigger }`, `series = []`, `digits` NULL;
the export prints it as stored, the stand reports `unsupported_version`. A shown start's Шаг 1
(`version = h1-start`, #829) is decided by the scanner when the bot drew the screen:
`decided_at_ms` the shown second, `params = { rule: shown_signal, …H1_SCANNER_PARAMS }`,
`decision.shown = { second, decidedAt, source }`, `source = { kind: shown, source, shownAtMs }`,
`series = []`, `digits` NULL ([h1.md → The shown direction](h1.md#the-shown-direction-829)); the
export prints it as stored, the stand reports `unsupported_version`.

| # | Path (`apps/backend/src/h1/driver.ts`) | Ending | Row: `outcome` / `detail` | Test |
|---|---|---|---|---|
| D1 | `created: true` | the intent, `submit_deadline_at = taken_at_ms + H1_SUBMIT_BUDGET_MS`; a wake | `intent` / NULL, in the intent's transaction | H1-DR1, H1-DB1 |
| D2 | `created: true` with the decision's INSERT refused | the intent without the link; `warn` `insert_refused` | none | H1-DR13 |
| D3 | `created: false` (a replay) | the cadence held | none | H1-DR12 |
| D4 | a stop refusal of `SESSION_INTENT_REFUSALS` | `stopTradingSession` with its reason, the session forgotten | `refused` / the code, after the stop, best-effort (`warn` `h1 driver decision not recorded`) | H1-DR10 |
| D5 | `active_intent_exists`, `client_request_id_conflict` | the session kept | `refused` / the code | H1-DR11 |
| D6 | `TradingSessionNotActiveError`, the history gone | forgotten | none | H1-DR17 |
| D7 | a skip of `sessionIntentBlock` (the hour, a live intent, the cycles, two rejections) or of the sizer (its stops, no balance, a balance hold) | none: the orchestrator stops it | none | H1-DR4, H1-DR6, H1-DR22–DR24 |
| D8 | `no_signal` opening a waiting period (`below_threshold` or `no_volatility`, not `no_price`; not busy, past the cadence, no block, none written since the last intent or notice); a due repeat writes none: `repeatPending` (H1-DR37) | the waiting message is due | `no_signal` / NULL, `version = h1`, the detector's decision and series; refused: `failed`, tried again after `scanMs` | H1-DR29, H1-DR30, H1-DR37, H1-DB5 |
| D9 | the repeat step (Шаг 2 after a lost or tied Шаг 1, #775) | the intent without a submit deadline, at the sizer's stake, in the lost trade's direction; a wake | `intent` / NULL (or `refused` / the code), `version = h1-repeat` | H1-DR25–DR28, H1-DR31, H1-DB4 |
| D10 | any other throw of `createSessionIntent` | `errors`, a `warn` | none: rolled back with the intent | — |
| D11 | the no-signal limit reached (`noSignalSeconds ≥ 100`, `waitExpired`, the waiting row written, no block, no due repeat; #775, review round 1) | `stopTradingSession` `no_signal_timeout`, forgotten | `no_signal` / NULL of the stopping second, after the stop, best-effort | H1-DR32–DR36, H1-DB6 |
| D12 | a shown start's Шаг 1 (`adopt` with `{ shown, pair }`, #829; not busy, past the cadence, no due repeat) | the intent without a submit deadline, at the sizer's stake, in the shown direction; the next decision at its creation + 6 s; a wake | `intent` / NULL (or `refused` / the code), `version = h1-start` | H1-DR45–DR49, H1-DB8, H1-R22 |

Tests of the shapes: `signal-decision-ops.db.test.ts` SD19, `driver.db.test.ts` SD20 (the three
`h1-start` rows), `trade-log.db.test.ts` X17, X19.

`docs/h1.md` → Comparing with the shadow joins these rows with their trades and the shadow's R1
row of the same pair and second.

### The start route (`context = session_start`, no `step`)

Since #828 every start is an H1 start (rows S0, S1′–S8 below); the v2 rows of the candle start
(S1–S7 until #828: `no_signal` without a session, `refused` after a candle signal, `started` with
the candle entry) have no writer and stay readable.

| # | Path (`session-routes.ts`) | Answer | Row: `outcome` / `detail` | Test |
|---|---|---|---|---|
| S0 | `session_too_long`, the eligibility refusals (`active_session_exists` included), `catalog_unavailable`, `pair_unavailable`, the H1 fence (`h1_duration_unsupported`, every start since #828; no payout floor since #775) | 4xx/503 | none: before the reading | R42, H1-R4, H1-R5′, H1-R15 |
| S8 | a throw of the snapshot read, the stakes read or the creation (not a `TradingSessionError`) | 500 | none | — |
| S1′ | no H1 reading (no data socket, the source down, no series, a stale second, unknown digits, a warming window) | 201, waiting | none: no decision; `info` `h1 start without a reading` | H1-R11 |
| S2′ | a no-signal H1 reading | 201, waiting | `no_signal` / NULL, with the new session | H1-R9b |
| S3′–S5′ | refused by the balance, the stake or the settings | 409 | none: before the reading | H1-R13 |
| S6′ | `createTradingSession` refuses | 409 | after a signal `refused` / the wire code; after a no-signal reading `no_signal` / NULL without a session | H1-R6′, H1-R12 |
| S7′ | a signal, `createTradingSession` returns | 201 | `started` / NULL, with the new session, after the hand-over to the driver (a catalog payout the column cannot hold: `payout` NULL, R43) | H1-R9, H1-R10, R43 |
| S9 | a shown signal (`shownSignal`, #829), `createTradingSession` returns | 201 | `started` / NULL, `version = h1-start`, with the new session, after the hand-over; no reading | H1-R17, H1-R18, H1-R22 |
| S10 | a shown signal, `createTradingSession` refuses | 409 | `refused` / the wire code, `version = h1-start`, without a session | H1-R19 |

`broker_account_id` is the eligible account, `payout` the catalog's, `taken_at_ms` the route's
clock after its reads. Every session from the bot (#745, #828) starts with this `session_start` row of
version `h1` since #796 (the H1 reading, [h1.md → The start](h1.md#the-start-796)): the driver's
row shape with `step` NULL, `decided_at_ms` the reading's second `f`, `taken_at_ms` the reading's
clock, so `taken_at_ms − decided_at_ms` is the reading's age; then the driver's `version = h1` and
`h1-repeat` rows (with a signal, the driver's step-1 `intent` row carries the same `decided_at_ms`:
two writers' answers to one decision, Rule 42). The export replays each by its version (X18). A
start with a shown direction (#829) writes the `session_start` row of version `h1-start` instead
(S9, S10): no reading, `decided_at_ms` the shown second, `taken_at_ms` the route's clock — so
`taken_at_ms − decided_at_ms` is the shown direction's age at the start — and `source.shownAtMs`
the bot's clock when the screen went out; the driver's step-1 `intent` row (D12) carries the same
`decided_at_ms`. The write is best-effort: a throw is `warn` `session start decision not
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

The series of a traded row is kept with it, so its replay holds for the row's whole life. The
issue's 30-day clearing of candles (owner 2026-10-15, #502) is superseded by #668 В2/В3: manager's
decision 2026-10-23 on #502 (В2), the owner confirms it on the PR.

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
| `payout` | the writer's catalog read (the worker's and the start route's `pair.payout`), the broker's `z.number()`, unbounded by design (#631) | `payoutInColumn` (`schema/columns.ts`, shared with `broker_trades.payout`, #675) in `recordSignalDecision`, the only INSERT: NULL unless finite and in `[0, PAYOUT_MAX]` (9999.9999, from the column's precision and scale) | SD14, O14, R43 |
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
| `trade` | the decision's intent: `intentId`, `status`, `mode`, `action`, `amount`, `durationSec`, `createdAtMs`, `submittedAtMs`, `lastError` (the intent's failure reason, `null` without one; `entry_window_missed` when an H1 session's entry window closed before the take, #670), `submitDeadlineAtMs` (`trade_intents.submit_deadline_at`, `null` without a window, #670), `cycle` and `cycleStep` (the bot's numbering, `sessionTradeSteps`, settled trades only), and `broker`: `status`, `payout` (`null` when the broker's payout was outside the column, #675), `openPrice`, `openTimestampMs`, `closePrice`, `closeTimestampMs`, `profit`, or `null` before the broker trade; `null` without an intent. A trade on a later page keeps its session's numbering (X8) |
| `ticks` | the decision's `decision_ticks` row (`tradeLogTicksSchema`): `status`, `detail`, `fromMs`, `untilMs`, `count`, `rows` (the stored `[timestamp, receivedAtMs, price]` tuples, `[]` for none); `null` without a row — not a candidate, not captured yet, or past the horizon |

The chain of a trade is `decision.decidedAtMs → decision.takenAtMs → trade.createdAtMs →
trade.submittedAtMs → trade.broker.openTimestampMs`, printed raw in ms: the backend's, the worker's,
the database's twice and the broker's clocks ([trade-executor.md](trade-executor.md#timing-for-analysis-666)).

**`trades-json`**: one JSON array of the closed session trades among those decisions, in the
stand's `calibrate --trades` shape (`tradeLogTradeJsonSchema`): `trading_session_id`, `asset_id`,
`action`, `duration_sec`, `created_at_ms`, `open_timestamp_ms`, `open_price`,
`close_timestamp_ms`, `close_price`, `profit` (the #381 export's ten), plus `submitted_at_ms`,
`payout` (absent when the broker's payout was outside the column, #675; X16), `intent_id`,
`decision_id`, `mode`, `amount`. A decision without an intent, an intent
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

## The report

```bash
pnpm --silent --filter @binarius/backend trade-log report --since <ISO 8601 | Nh | Nd> [--until <ISO 8601>]
pnpm --silent --filter @binarius/backend trade-log report --since 7d
```

`DATABASE_URL` as the backend's. The window is `[since, until)` on `trade_intents.created_at` (the
database's clock), for every trade with or without a decision row. `--since` is an instant with a
zone, up to milliseconds, or `Nh` / `Nd` (N 1…9999) back from `--until`; without `--until` the end
is the database's clock at the start, as for the export (`readTradeLogEnd`). The window parser is
`h1 shadow report`'s (`apps/backend/src/cli/report.ts`).

**What is counted.** One intent of the window is one unit; a **trade** is its closed broker trade.
Win, loss and tie are `tradeResultSql` (`profit > 0`, `< 0`, else), the result the session
messages use. An intent without a closed trade (refused, open, queued, on review) is counted in
`не закрыто` and broken down by status on stderr. Counts, sums and `ROI %` are computed in SQL
(`readTradeReportStats`: three aggregates, money as `numeric` text, Rule 2); the process lays out
the groups. The read names its columns (Rule 9): no telegram id, no broker user id, no token, no
`broker_trades.raw`.

**The rows.** A section per mode with intents, `## demo` first, then `## real`. In a section, the
groups of trades by a decision row (`origin = signal`): by `version`, fingerprint, interval
(`SIGNAL_INTERVALS` order, `—` — a version that decides on ticks, as H1 — last) and duration; each
group's pairs by trades (most first) and asset id, then its `все пары` row, always printed (a group
of one pair prints the same numbers twice). Then the trades without a decision row, by duration and
pair, without a pooled row: `разовые сделки (без решения)` — one-off trades (`POST
/trading/intents`, no session) — and `сессия без записи решения` — a session's intent without a row
(before 0068, or `record_missing`). A pair is its asset id; `<symbol> (<id>)` where the decision row
carries `source.symbol` (H1).

| Column | Meaning |
|---|---|
| `версия`, `параметры` | the row's `version` and the first 8 characters of `params_hash`; the label of the rows without a decision and `—` |
| `пара`, `интервал`, `длит., с` | the intent's pair, the decision's interval, the intent's duration |
| `сделок`, `не закрыто` | closed trades; intents of the group without one |
| `W`, `L`, `T`, `win %`, `95 % CI` | `win %` = W / (W + L), ties out; Wilson's interval of `packages/shared/src/wilson.ts` |
| `выплата, средн. (min-max)` | the mean `broker_trades.payout` of the group's closed trades and its range; `-` when none has one (#675) |
| `безубыточность %`, `вердикт` | `breakEvenPct(mean payout)`; `beats break-even` only when the whole interval is above it (`verdictOf`); `нет сделок` without a decided trade, `нет выплаты` without a payout — neither ever passes |
| `ставок`, `P&L`, `ROI %` | `sum(trade_intents.amount)`, `sum(broker_trades.profit)` of the closed trades, and `100 × P&L / ставок` rounded to 2 in SQL; `-` for a group without a closed trade |

`### Параметры` closes the report: per version × fingerprint, the closed trades, the first and the
last trade's `created_at` inside the window (the version's period, to compare versions on like
spans) and the parameters as stored (jsonb text).

Example (the `cli/trade-report.db.test.ts` RP4 session and an H1 session):

```text
## demo

| версия | параметры | пара | интервал | длит., с | сделок | не закрыто | W | L | T | win % | 95 % CI | выплата, средн. (min-max) | безубыточность % | вердикт | ставок | P&L | ROI % |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| h1 | 9dfe5704 | EUR/USD (7) | — | 5 | 2 | 0 | 1 | 1 | 0 | 50.00 | 9.45-90.55 | 94.00 (94-94) | 51.55 | inconclusive | $2.00 | -$0.06 | -3.00 |
| h1 | 9dfe5704 | все пары | — | 5 | 2 | 0 | 1 | 1 | 0 | 50.00 | 9.45-90.55 | 94.00 (94-94) | 51.55 | inconclusive | $2.00 | -$0.06 | -3.00 |
| v2 | f86ee2d6 | 101 | 15s | 60 | 4 | 2 | 2 | 1 | 1 | 66.67 | 20.77-93.85 | 85.00 (85-85) | 54.05 | inconclusive | $4.00 | +$0.70 | +17.50 |
| v2 | f86ee2d6 | все пары | 15s | 60 | 4 | 2 | 2 | 1 | 1 | 66.67 | 20.77-93.85 | 85.00 (85-85) | 54.05 | inconclusive | $4.00 | +$0.70 | +17.50 |

### Параметры

| версия | отпечаток | сделок | первая сделка | последняя сделка | params |
| --- | --- | --- | --- | --- | --- |
| h1 | 9dfe57045a4f97e9097fb7c9456e81be | 2 | 2003-01-03T00:00:00.000Z | 2003-01-03T00:00:00.000Z | {"set": "session", "sdWindowSec": 60} |
| v2 | f86ee2d69d5f9944b91e85259950783d | 4 | 2003-01-03T00:00:00.000Z | 2003-01-03T00:00:00.000Z | {"emaFast": 9, …} |
```

stderr: `intent'ов без закрытой сделки: K (<status>: n, …)` when K > 0, then `сделок: M`.

| Exit | When |
|---|---|
| 0 | the report is printed |
| 1 | no closed trade in the window (`нет закрытых сделок за период`, stdout empty: an empty sample is not a pass), `DATABASE_URL` missing or invalid, or a database failure (name and code) |
| 2 | not understood, or a `--since` at or after the end; the usage on stderr |

On the pilot: `docker compose exec -T backend pnpm --silent --filter @binarius/backend trade-log report --since 7d`.

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
  export's ticks); #502: `schema.db.test.ts` → signal_decisions → params_hash PH1–PH3 (the hash,
  key order, `428C9` on INSERT and UPDATE, the index), `signal-decision-ops.db.test.ts` TR1–TR8
  (the report's aggregates: W/L/T, money as SQL text, the fingerprint groups, the origins, the
  window, the modes, the pooled row, the statuses, no ids).
- `apps/backend`: `ticks.test.ts` T1–T4 and the window T5–T15, `manager.test.ts` M28, M32 and M32b (the
  holes at both `onDrop` sites, the `buffer` line), `signal-routes.test.ts` R19–R21,
  `session-routes.db.test.ts` R39, R42, R43, H1-R6′, H1-R17–R22 (#829), `cli/trade-log.db.test.ts`
  X1–X14, X19 (#829), `h1/driver.db.test.ts` SD20 (#829),
  `cli/trade-report.db.test.ts` RP1–RP12 and `cli/report.test.ts` W1–W2 (#502: the report through
  the entry point, the window parser),
  `trade-log/keeper.test.ts` C1–C15 (one case per ending, the sweep loop),
  `trade-log/keeper.db.test.ts` D1–D4, `timing.test.ts` (the #668 chain).
- `apps/trading-worker`: `backend.test.ts` B1 (the flag), B7 (the record read apart) and S4,
  `orchestrator.db.test.ts` O1–O2, O4–O8, O12–O14, L1 (the `warn` row of [trading-session.md → Logs](trading-session.md#logs)).
- `packages/signal-stand`: `journal-line.test.ts` JL and `calibrate.test.ts` unchanged; C12 (an
  export reads as the log did); JL-h1start (#829: an `h1-start` line is `unsupported_version`).

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
19. **md5 is a fingerprint, not a key** (#502): two parameter texts with one hash would merge into
    one group; «Параметры» prints the group's `min(params::text)`. Negligible for a handful of sets.
20. **The migration 0082 rewrites `signal_decisions` once** (`STORED`), in the `migrate` one-shot
    before the services start: 30 days of rows without a trade plus the traded ones.
21. **The report's window is the intent's `created_at`, the export's `recorded_at`**: a decision
    recorded just before a bound whose intent was created just after falls on different sides of
    it in the two commands.
22. **Trades in flight are `не закрыто`**; break-even is on the group's mean payout (a group mixing
    payouts has one mean, the pooled row most); `ROI %` is per stake dollar, not an EV per trade
    (under martingale the two differ; `win %` is printed beside it); v2 rows print asset ids (no
    catalog in the database); no audit row for a report; the window is the only filter.

## Boundaries

- Out of #668: a continuous table of every tick (rejected, #666); ticks for decisions other than
  `intent` and the sampled `shadow` rows; a report or dashboard; the worker (it neither reads nor
  writes `decision_ticks`).
- #669: the H1 shadow's rows (`context: shadow`, `version: h1`, `result`, `ticks_until_ms`),
  [h1.md](h1.md). #670's creators of session intents must pass `decision` to
  `createSessionIntent` (the type requires it).
- The sender of the session messages reads the rows (#722), never writes them.
- One-off bot trades and the bot's analyses are not recorded (owner, #666). Reports:
  `h1 shadow report` over the shadow rows (#681, [h1.md → The report](h1.md#the-report)) and
  `trade-log report` over the trades (#502, [The report](#the-report)); decisions without a trade
  are only in the export.
