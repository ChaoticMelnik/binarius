# Trade log (#666)

Every decision a trading session acted on is a row of `signal_decisions`, written by the process
that acted, with its outcome: the journal entry the decision was computed from, the clocks of the
chain up to the broker, the pair's payout and last tick. A session's intent names the row it was
created from. A redeploy loses nothing of it: the log's `signal decision` lines stay as they were
([signal.md → The journal line](signal.md#the-journal-line)), and the trade log keeps the same
entry in the database. `trade-log export` reads it back as JSON lines or as the stand's trades
file.

This is part 1. Part 2 (#668) adds the ticks around each trade, their buffer and the retention
sweep; the export's `ticks` is `null` until then.

| Piece | Where |
|---|---|
| The table | `packages/db/src/schema/signal-decisions.ts`, migrations `0068_signal_decisions`, `0069_decision_session_check` |
| The writer | `recordSignalDecision(exec, input)`, `signalDecisionInput(record, facts)` in `packages/db/src/signal-decision-ops.ts` |
| The reads | `readTradeLogPage`, `readSessionTradeSteps`, `journalEntryOf`, `readTradeLogEnd` (same file) |
| The constants and the line shapes | `packages/shared/src/trade-log.ts`; the entry and the record in `packages/shared/src/signal.ts` |
| The last tick | `createTickStore` in `apps/backend/src/market-data/ticks.ts` |
| The export | `apps/backend/src/cli/trade-log.ts` |

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
| `payout` | the pair's payout when the decision was taken, `numeric(8,4)` as `broker_trades.payout`; NULL allowed, and NULL also when the catalog's value is outside the column (`signalDecisionPayout`) | the catalog the writer read |
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
— one intent per decision. The FK is MATCH SIMPLE and checks nothing while `trading_session_id` is
NULL, so `trade_intents_decision_session_check` (0069) names a decision only with the intent's
session: together they hold that a named decision is always of the intent's own session. NULL on
one-off bot intents (`POST /trading/intents`, not recorded), on every intent before 0068 (no
backfill), on a session intent created while the backend answered no usable record, and on one
whose decision row the database refused (E14′). The column is not in the intent's wire view.

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
replays to the recorded decision (`trade-log.db.test.ts` X3).

## The last tick

`createTickStore` keeps one tick per pair: the active data socket's `price.update`, pushed by the
market data manager next to the ring, with the backend's receipt time. A tick the ring would refuse
(`tickProblem`: invalid, or a minute and more from its receipt) is dropped, and one older than the
pair's newest does not replace it (`ticks.test.ts` T1–T4, `manager.test.ts` M28). It exists only
with `BROKER_WS_URL`. The tick is read when the route answers, not at the cache's `nowMs`: for a
cached decision the two can be up to one candle apart, and both clocks are stored (risk 4).

The tick is kept until a newer one; it is not cleared on a socket drop, a failover or a quiet pair.
`last_tick`'s age at the decision is `taken_at_ms - last_tick.receivedAtMs` (the backend's and the
worker's clocks, one host on the pilot, risk 6). A reader of `TickStore.last` bounds the age itself.

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

`DATABASE_URL` as the backend's. `--from` and `--to` are instants with a zone
(`2026-10-20T00:00:00Z`), compared with `recorded_at`, half-open `[from, to)`; without `--to` the
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
| `decision` | `id`, `context`, `outcome`, `detail`, `version`, `assetId`, `interval`, `step`, `kind`, `action`, `decidedAtMs`, `takenAtMs`, `recordedAtMs`, `payout`, `lastTick`, `result` |
| `signal` | the journal entry (`journalEntryOf`); the stand's `parseJournalLine` reads it from this key, as from a log line |
| `session` | `id`, `userId`, `brokerAccountId`, `mode`, `strategy`, `baseStake`, `durationSec` (from the row's settings; NULL when they do not parse), `stopReason`; `null` for a start without a session |
| `trade` | the decision's intent: `intentId`, `status`, `mode`, `action`, `amount`, `durationSec`, `createdAtMs`, `submittedAtMs`, `cycle` and `cycleStep` (the bot's numbering, `sessionTradeSteps`, settled trades only), and `broker`: `status`, `payout`, `openPrice`, `openTimestampMs`, `closePrice`, `closeTimestampMs`, `profit`, or `null` before the broker trade; `null` without an intent |
| `ticks` | `null` (#668) |

The chain of a trade is `decision.decidedAtMs → decision.takenAtMs → trade.createdAtMs →
trade.submittedAtMs → trade.broker.openTimestampMs`, printed raw in ms: the backend's, the worker's,
the database's twice and the broker's clocks ([trade-executor.md](trade-executor.md#timing-for-analysis-666)).

**`trades-json`**: one JSON array of the closed session trades among those decisions, in the
stand's `calibrate --trades` shape (`tradeLogTradeJsonSchema`): `trading_session_id`, `asset_id`,
`action`, `duration_sec`, `created_at_ms`, `open_timestamp_ms`, `open_price`,
`close_timestamp_ms`, `close_price`, `profit` (the #381 export's ten), plus `submitted_at_ms`,
`payout`, `intent_id`, `decision_id`, `mode`, `amount`. A decision without an intent, an intent
without a broker trade (a `rejected` one) and an open broker trade are left out; they are in the
JSONL (`trade-log.db.test.ts` X4).

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
  code fits `detail`), `contract-coverage.test.ts` (the answer's keys).
- `packages/signal`: `journal.test.ts` J8 (the shared schema is the module's type, both ways).
- `packages/db`: `schema.db.test.ts` → signal_decisions (every CHECK, both FKs, the unique keys,
  `trade_intents_decision_session_check`); `signal-decision-ops.db.test.ts` SD1–SD14 (SD14: the
  payout guard); `trading-session-ops.db.test.ts` D7–D11 (the intent's transaction, the
  savepoint).
- `apps/backend`: `ticks.test.ts` T1–T4, `manager.test.ts` M28, `signal-routes.test.ts` R19–R21,
  `session-routes.db.test.ts` R36–R39, R42 and R43, `cli/trade-log.db.test.ts` X1–X8.
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
4. **`last_tick` is the newest tick at the route's answer**, not at the cache's `nowMs`; #668's
   window gives the tick at any instant.
5. **Volume until #668:** about 4 KB per decision (the series is at most the decision's 60-row
   window), one decision per candle while a session waits: about 30 MB a day at ten session-hours
   on 5 s candles. No sweep in part 1.
6. **The clocks are three processes' and the broker's**; on the pilot the three share one host.
   Printed raw, never aligned.
7. **`version` and `detail` are pattern-checked, not listed**; a wrong version shows at replay
   (`RangeError`), not at insert.
8. **`recorded_at` of an `intent` row is its transaction's start**, at or before the intent's
   `created_at`; the export orders by it.
9. **Export memory:** a page of 200 rows; `trades-json` holds its whole array (about 300 bytes a
   trade).
10. **No audit row for an export**: an operator's CLI on the server, like `kill-switch status`.

## Boundaries

- #668: the ticks around each trade (`decision_ticks`, from `decision − 60 s` to `close + 5 s`), the
  tick store's window, the retention sweep (rows without an intent after 30 days), the export's
  `ticks`.
- #667: the shadow detector's rows (`context: shadow`, `version: h1`, `result`); its new creators of
  session intents must pass `decision` to `createSessionIntent` (the type requires it).
- One-off bot trades and the bot's analyses are not recorded (owner, #666). Reports and dashboards:
  none, only the export.
