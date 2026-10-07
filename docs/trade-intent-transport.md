# Trade intent transport (ARCH-03, issue #42)

How an order travels from the Telegram bot to the trading worker. Nothing calls the worker
directly: the backend records the intent in PostgreSQL, an outbox row carries it to BullMQ, and
the worker takes it from there. PostgreSQL is the source of truth throughout; Redis/BullMQ is a
delivery channel that can be rebuilt from the database.

## Components

| Component      | Package                                                           | Role                                                                                                           |
| -------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Contract       | `packages/shared/src/trading.ts`                                  | request/response schemas, statuses, allowlisted failure reasons, queue payload                                 |
| Operations     | `packages/db/src/trade-intent-ops.ts`                             | every status transition, the creation transaction, the token reserve/release                                   |
| API            | `apps/backend/src/trading/routes.ts`                              | `POST /trading/intents`, `GET /trading/intents/:id` behind the internal Bearer token                           |
| Publisher      | `apps/backend/src/outbox/`                                        | turns pending `outbox_events` rows into BullMQ jobs, re-publishes lost ones                                    |
| Consumer       | `apps/trading-worker/src/intents/`                                | processes `trading-intents` jobs through the `TradeExecutor` port                                              |
| Reconciliation | `apps/trading-worker/src/intents/reconciliation.ts`               | `trading-reconciliation` jobs hand `unknown` intents to the pass, which asks the `IntentReconciler` port (#89) |
| REST reconciler | `apps/trading-worker/src/intents/rest-reconciler.ts`             | the port's implementation: the broker's open and closed lists matched against the intent (#90)                 |
| Catch-up       | `apps/trading-worker/src/intents/settlement-catchup.ts`           | settles `accepted` intents past their expected close from the closed list (#90)                                |
| Session manager | `apps/trading-worker/src/broker/session-manager.ts`              | one broker socket session per account in work when `BROKER_WS_URL` is set; `close_trade.success` → `settleClosedTrades` (#101, [broker-session.md](broker-session.md)) |
| Token route    | `apps/backend/src/trading/routes.ts` → `POST /trading/accounts/:id/access-token` | the worker's only way to a broker access token (#90); the worker holds no broker credentials   |
| Real-mode gate | `packages/db` → `createInTransaction`; worker → `realTradingGate` | `REAL_TRADING_ENABLED` (#134): no real intent is created or sent while it is not `true`                        |

## Sequence

```
bot ──POST /trading/intents──▶ backend ──tx──▶ trade_intents (queued) + outbox_events (pending)
                                   │  201 { intent }                     │
                                   ◀─────────────────────────────────────┘
                              publisher: pending row ──add(jobId = intent id)──▶ BullMQ trading-intents
                              worker: re-read ──CAS queued→submitting──▶ executor.submit ──▶ CAS submitting→accepted|rejected|unknown
unknown ──outbox──▶ BullMQ trading-reconciliation ──CAS unknown→reconciling──▶ pass (next tick): claim
        ──token (backend route) + GETs only──▶ CAS reconciling→accepted(→settled) | manual_review(+halt)   (rejected: #274)
bot ──GET /trading/intents/:id?telegramUserId=…──▶ backend ──▶ { intent }   (status, lastError, version)
```

### Creation transaction (`createTradeIntent`)

1. Resolve the user by `telegramUserId` (404 `user_not_found`).
2. **Idempotent replay first**: a row with the same `(user, clientRequestId)` is returned as-is
   (200) whatever the user's or account's flags are now; the same id with different parameters —
   including a different explicit `brokerAccountId` — is 409 `client_request_id_conflict`.
   `clientRequestId` is unique per user, enforced by the unique index
   `trade_intents_user_request_idx (user_id, client_request_id)` (migration 0002 replaced the
   per-account key: an account belongs to one user, so this is strictly stronger).
   2a. **Real-mode grant (#134).** `mode = real` while this backend runs with
   `REAL_TRADING_ENABLED` not `true` → 409 `real_trading_disabled`, before any read of the
   account and before the reserve. The replay above runs first, so a retry still finds a real
   intent created while the flag was on.
3. Resolve the broker account: the given `brokerAccountId` must belong to the user (404
   `broker_account_not_found`), or the user's single active account (0 → 404, more than one →
   409 `ambiguous_broker_account`).
4. Reserve one token with a guarded update on `users` (`status = active`,
   `token_balance - token_reserved >= 1`); zero rows → 409 `user_blocked` or `insufficient_tokens`.
5. Lock the account with `FOR NO KEY UPDATE` and the predicates `status = active`,
   `trading_halted = false`; zero rows → 409 `account_revoked`, `account_not_confirmed` (linked but not confirmed in the bot, see docs/binodex-oauth.md) or `account_halted`.
6. Insert the intent (`planned`, `tokens_reserved = 1`), the ledger `reserve` row, move it to
   `reserved`, insert the outbox row, move it to `queued`, commit.
7. After the commit the publisher is woken; a failed wake only logs (the poll picks the row up).

A unique violation on `trade_intents_user_request_idx` or `trade_intents_active_account_idx`
(two identical or two competing requests) rolls back and re-runs step 2: found → replay or
conflict, not found → 409 `active_intent_exists`. That 409 is a snapshot — the competing intent
may already be terminal when the bot reads it; retrying with the same `clientRequestId` is the
intended reaction.

`409 real_trading_disabled` comes from the process configuration, before any side effect: no
row, no reserve, no wake. The caller (#121) tells the user real mode is unavailable and offers
demo; retrying is pointless until the deployment's configuration changes.

**Lock order is `users` → `broker_accounts` → `trade_intents`, for every writer.** Creation
takes the user row (reserve `UPDATE`), then the account (`FOR NO KEY UPDATE`), then inserts the
intent; a rejection takes the user row (`FOR NO KEY UPDATE`) before it locks the intent it
releases. The intent-first order deadlocked against a creation whose `INSERT` was waiting on
the active-intent index while holding the user row. OAuth linking, revocation and ARCH-04 must
keep the same order.

Unexpected errors (a database failure, a bug) are answered with `500 { "error": "internal" }`
and a log line; the response never carries the error message, because a query error's message
contains the SQL text and its parameters.

### GET /trading/intents/:id (#127)

The bot reads an intent by the id it carries in the «🔄 Обновить статус» button's callback data
([bot-demo-trade.md](bot-demo-trade.md)), so the read is scoped by its owner: `:id` is the intent's
uuid and the query carries `telegramUserId` (the same `telegramUserIdSchema` as every request
body). `getTradeIntentView(db, id, telegramUserId)` adds the owner to the join's `where`.

| Answer | When |
| --- | --- |
| 200 `{ intent }` | the id is the user's — the same view `POST /trading/intents` answers |
| 400 `{ error: 'validation', issues }` | no `telegramUserId`, or one the schema refuses |
| 404 `{ error: 'not_found' }` | `:id` is not a uuid, the intent does not exist, or it is another user's — byte-identical, so an id's existence is not answerable |
| 401 | the bearer is missing or wrong |

`routes.db.test.ts` and `trade-intent-ops.db.test.ts` hold the foreign-id case.

## Statuses and who sets them

| Status                            | Set by                                                                                                                                                                                                                                                                          | Meaning                                                                                                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `planned` → `reserved` → `queued` | backend, creation transaction                                                                                                                                                                                                                                                   | intent and outbox row persisted, token reserved. `queued` is what the API returns                                                                                            |
| `submitting`                      | worker, `takeIntent` CAS                                                                                                                                                                                                                                                        | the job was taken; `submitted_at` is set on the database clock                                                                                                               |
| `accepted`                        | worker, an explicit executor result that carries the broker's open trade (`markIntentAccepted`); the reconciliation pass, `concludeReconciled` from `reconciling` with the trade the reconciler found (open → `accepted`; closed → `accepted` and `settled` in one transaction) | the broker confirmed the order and its trade matches the intent; the open `broker_trades` row is written in the same transaction. `socket.emit` or a local `ok` never counts |
| `rejected`                        | worker (executor said no, the intent expired, or the grant gate: a real intent while the worker's `REAL_TRADING_ENABLED` is not `true`, `real_trading_disabled`), publisher (delivery exhausted); #274: the reconciliation pass on a proven absence                              | terminal; the token reserve is released in the same transaction                                                                                                              |
| `unknown`                         | worker (executor timeout, throw, a stale `submitting`, an order sent with no answer, `broker_unavailable`, or an accepted trade that does not match the intent, `trade_mismatch`), sweeper                                                                                     | the order may have reached the broker; reserve kept; a `trading-reconciliation` outbox row is written for reconciliation (#89)                                               |
| `settled`                         | `settleIntent` from `accepted` (a `close_trade.success` or a REST closed snapshot through `settleClosedTrades`) or from `manual_review` (operator)                                                                                                                              | terminal; the token is debited in the same transaction whatever the trade's profit; `broker_trades` closed                                                                   |
| `reconciling`                     | worker, `trading-reconciliation` job: `startReconciling` CAS from `unknown`; the pass claims it (`reconcile_claimed_at`, database clock) and asks the `IntentReconciler`                                                                                                        | the outcome is being established; the reserve is kept and the account stays blocked; `unavailable` leaves it here and the pass retries after `RECONCILE_RETRY_MS`            |
| `manual_review`                   | the reconciliation pass: the reconciler answered `ambiguous` (`reconciliation_ambiguous`), found nothing once the window closed (`reconciliation_not_found`, absence not proven: #274) or offered a trade that does not match (`trade_mismatch`); operator (`manual_review → settled \| rejected`: the ops exist, the tool is a later issue)                                 | the reserve is kept; the same transaction halts the account (`trading_halted`, `halted_reason`) and an `error` line alerts after the commit (#90) |

Every transition bumps `version`; every transition is a compare-and-set on `status` (and usually
`version`), so a duplicate or late writer gets zero rows instead of overwriting newer state. The
database enforces the graph and the bump itself (trigger `trade_intents_transition_guard`) and
that a live intent holds its token while a finished one holds none
(`trade_intents_terminal_reserve_check`) — see [State machine](#state-machine-17).

## State machine (#17)

```
planned       → reserved | rejected
reserved      → queued | rejected
queued        → submitting | rejected
submitting    → accepted | rejected | unknown
accepted      → settled
unknown       → reconciling
reconciling   → accepted | rejected | manual_review
manual_review → settled | rejected
settled, rejected: terminal
```

The graph is `TRADE_INTENT_TRANSITIONS` in `packages/shared/src/trading.ts`.

**Ledger effect per edge.** `reserve` at creation (`reserved_delta +1`); `release` on every edge
into `rejected` (`reserved_delta −1`, the balance untouched); `settle` on every edge into `settled`
(`reserved_delta −1`, `balance_delta −1`: the token is spent whatever the trade's profit, a draw
or a refund included). Every other edge leaves the ledger alone. The `users` cache moves in the
same transaction as the row.

**What the database guarantees.**

| Guarantee                                                                                          | Where                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| every UPDATE that changes `status` follows an edge of the graph and bumps `version` by exactly one | trigger `trade_intents_transition_guard` (migration 0014, `BEFORE UPDATE OF status`); an UPDATE that keeps the status passes, the CAS predicate stays in each writer's `WHERE`; an INSERT may carry any status — the creation path inserts `planned` only (stated) |
| a live intent holds its token, a `rejected`/`settled` one holds none                               | CHECK `trade_intents_terminal_reserve_check` (0013)                                                                                                                                                                                                                |
| one live intent per account (`reconciling`/`manual_review` included)                               | `trade_intents_active_account_idx`                                                                                                                                                                                                                                 |
| a broker trade links to one intent, an intent to one trade, of the same account and mode           | `broker_trades_account_trade_key`, `broker_trades_intent_id_key`, `broker_trades_intent_account_fk`                                                                                                                                                                |
| at most one terminal ledger row (`release` or `settle`) per intent                                 | `token_ledger_terminal_intent_idx`; that one exists is the writers' rule (`rejectIntent`/`settleIntent` read the reserve under lock and write the row when it is > 0)                                                                                              |

The trigger's pairs are a copy of the shared table; the transition grid in
`packages/db/src/schema.db.test.ts` tries every ordered pair and fails when the two disagree. A
graph change is a new migration that replaces the function.

**Transport state is not trade state.** The trade state is `trade_intents.status`; the socket's
state (`BrokerSocketState`, #99) is never stored on the intent. A disconnect can produce only
`unknown`, through the executor; the trigger refuses `submitting → settled` and
`unknown → rejected`, so no transport event ends an intent without the broker's answer or a
reconciliation.

**Acceptance carries proof.** `SubmitResult.accepted` is `{ transport, trade: OpenTrade }`, both
required. `markIntentAccepted` checks the trade against the intent (`isDemo` against `mode`,
`assetId`, `action`, `amount` compared as decimals) before anything is written, then runs the CAS
and inserts the open `broker_trades` row. A mismatch throws `TradeIntentMismatchError` with the
intent untouched; a trade already linked throws it from the insert, which has aborted the
transaction, so a caller writes its follow-up in a fresh one. The processor then marks the intent
`unknown` (`trade_mismatch`) with a reconciliation row and logs the intent id, the broker trade id
and the reason code.
`broker_trades.raw` holds the parsed domain trade, not the broker's bytes: shared's parsers strip
unknown keys, and no token is in a trade.

**Settlement.** `settleIntent` (from `accepted` or `manual_review`, with a `ClosedTrade`) locks
`users → trade_intents → broker_trades`, then moves the intent, writes the `settle` row and
closes the `broker_trades` row. On the linked path only the broker trade id is checked (another id
→ `trade_already_linked`) and the close is applied as received: the row's open fields are the
broker's own and the close does not overwrite them. For a `manual_review` intent never linked, the
closed trade is checked against the intent (the four fields above) and the row is inserted closed
under the intent's account; a `ClosedTrade` carries no account, so the caller takes it from that
account's own closed list. `settleClosedTrades(db, { brokerAccountId, trades })` is the one applier
of a `close_trade.success` payload and of a REST closed snapshot: one transaction per trade, an
outcome per trade. It looks a trade up by `(broker_account_id, broker_trade_id)`, so it never
meets a mismatch —

| Outcome               | Meaning                                                                            | Caller's action                             |
| --------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------- |
| `settled`             | settled now                                                                        | done                                        |
| `already_settled`     | an earlier pass settled it                                                         | nothing                                     |
| `not_ours`            | no intent behind this trade (a platform trade, or an acceptance not persisted yet) | ignore; a later snapshot links it           |
| `intent_not_accepted` | the intent is `reconciling`/`manual_review`                                        | leave to #89/#90/the operator; never settle |

A thrown error (a database failure) propagates with nothing of that trade written; the trades
before it stay applied, and a replay is safe. The polling loop (#90) logs it with `errorLogFields`
and holds that account back for the tick, as the balance reconciler does for a throwing attempt
(Architecture Rule 21), so one account cannot block the batch on every pass.
`listOverdueAcceptedIntents(db, { graceMs, limit })` is the one definition of "accepted past its
expected close": the broker's open time plus the intent's `duration_sec` plus `graceMs`, against
the database clock, oldest first.

**`last_error` is the last failure on the way, not the current state.** Acceptance and settlement
leave it as it is: an intent that went `unknown` (`stale_submitting`) → `reconciling` →
`accepted` → `settled` keeps `stale_submitting`. A reader looks at `status` first.

**After a crash or restart** every op is one transaction, so nothing is half-applied, and the
trigger, the two `broker_trades` keys and the terminal ledger index keep a stage from being
entered twice. What resolves an intent left at each stage:

| Left in                                                | Resolved by                                                                                                                                                                | Owner                                        |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `planned`/`reserved`                                   | cannot persist: created and queued in one transaction                                                                                                                      | #42                                          |
| `queued`                                               | the publisher's lost-job sweep, or `expired` at take                                                                                                                       | #42 (in `main`)                              |
| `submitting`                                           | the stale sweep → `unknown` (`stale_submitting`)                                                                                                                           | #42 (in `main`)                              |
| `accepted`                                             | `close_trade.success` → `settleClosedTrades` (the session's writer); the REST catch-up `listOverdueAcceptedIntents` + `listTrades(closed)` + `settleClosedTrades` for a close the session missed or dropped at stop | #101 (socket), #90 (catch-up) |
| `accepted`, closed before the acceptance was persisted | `settleClosedTrades` answered `not_ours`; the catch-up applies the closed snapshot once the intent is overdue                                                              | #90, #101                                    |
| `unknown`                                              | the `trading-reconciliation` job (`processReconciliationJob`) → `reconciling`                                                                                              | #89                                          |
| `reconciling`                                          | the reconciliation pass: first tick at worker start, then every 15 s; a claim is a 60 s lease → `accepted` / `settled` / `manual_review` (`rejected` only through #274)  | #89 (the pass), #90 (the reconciler)         |
| `manual_review`                                        | the operator: `settleIntent` (with the closed trade from that account's own closed list) or `rejectIntent` (`manual_rejected`)                                             | a later issue (the tool)                     |

With `BROKER_WS_URL` set, `close_trade.success` on the account's session (#101) is the main path
and the catch-up (#90) resolves from the closed list what the session missed, once the intent is
overdue. Without it there is no session: every intent reaches the broker over REST
(`rest_fallback`, the trade command executor, [trade-executor.md](trade-executor.md)) and the
catch-up settles every one.

## Reconciliation matching (#90)

**Keys.** A broker trade is a candidate for an intent when its `asset_id`, mode (`is_demo`),
`action` and `amount` (compared as decimals, `normalizeDecimal`) equal the intent's and its
`open_timestamp` lies in `[submitted_at − 60 s, submitted_at + 90 s]`, inclusive
(`RECONCILE_WINDOW_BEFORE_MS` / `RECONCILE_WINDOW_AFTER_MS`). `duration` is not a key. Trades
already linked to an intent of the account (`listLinkedBrokerTradeIds`) are dropped before
counting, so an earlier trade with the same keys is not a second match.

**Reads.** One token from the backend (`mayRefresh: true`), then the open list, then the closed
list, in the intent's mode, each through `readTradePages` (`intents/trade-pages.ts`, the one page
reader): pages asked with `limit` 50 (`RECONCILE_TRADES_PAGE_SIZE`), up to 2 GETs per list
(`RECONCILE_MAX_TRADE_PAGES`). A page's length is never the list's end: a list is covered only by
an empty page or by a page holding a trade older than the window. The next offset is the previous
one plus the page's length minus one, so every page after the first starts with a trade already
read. A page that grows in `open_timestamp` (`order`), does not start with a trade read
(`continuity`), repeats what was read (`no_progress`) or whose first unread trade is newer than the
previous page's last (`seam`) answers `unavailable/broker_contract`; an empty page after a page of
two or more trades is a `continuity` violation too (the request stood on a trade already read). A
capped or ignored `limit` shortens the reach, and a cap of 1 fails on the second page
(`continuity`). `covered` gates `found` and the choice between a retry and manual review; nothing
is released on it. The trades are merged by `id`, the
closed form winning (a trade that closed between the two reads). The order is the mock's and
broker-web's, not yet observed live (docs/broker-rest.md → Trades list).

**Answers.**

A *near match* is an unlinked trade in the window with the intent's asset, action and mode but
another amount — the one key the broker may round. It is never `found`.

| Candidates                                          | Covered | Window closed by `reconcile_claimed_at` | Answer                                                          |
| --------------------------------------------------- | ------- | --------------------------------------- | --------------------------------------------------------------- |
| ≥ 2 exact                                           | any     | any                                     | `ambiguous` → `manual_review` + halt                            |
| 1 exact                                             | yes     | any                                     | `found`                                                         |
| any other                                           | no      | no                                      | `unavailable/window_not_covered`                                |
| any other                                           | yes     | no                                      | `unavailable/window_open`                                       |
| 1 exact                                             | no      | yes                                     | `ambiguous` (a twin beyond the pages cannot be ruled out)       |
| 0 exact, ≥ 1 near                                   | any     | yes                                     | `ambiguous` → `manual_review` + halt                            |
| 0 exact, the intent's `last_error = trade_mismatch` | any     | yes                                     | `ambiguous` → `manual_review` + halt                            |
| 0 exact, nothing near                               | any     | yes                                     | `unresolved` → `manual_review` (`reconciliation_not_found`) + halt |

No reconciler in `main` answers `not_found`: an intent with no candidate once the window has
closed is parked (`manual_review`, `last_error = reconciliation_not_found`) and the account halted,
in demo as in real; releasing the reserve on a proven absence is #274, after the live probe of the
trades list. The pass keeps `rejectIntent` on `not_found` as the port's contract (Rule 24). The token
route refusing (`token_unavailable`) or failing (`backend_unavailable`) and every broker error
(`rate_limited`, `unauthorized` → `token_unavailable`, `rejected`/`contract_violation` →
`broker_contract`, `unavailable`, `aborted` → `timeout`) answer `unavailable` with a `warn`;
anything else is thrown and the pass logs it by name.

**Halt and alert.** Every `manual_review` the pass writes — `ambiguous`, `unresolved`
(`reconciliation_not_found`) and a found trade that does not match (`trade_mismatch`) — goes through `haltAccountForManualReview`: `broker_accounts`
`FOR NO KEY UPDATE`, then the intent's CAS, then `trading_halted = true` with `halted_reason`
from `AccountHaltReason`, in one transaction. After the commit one line
`error { intentId, brokerAccountId, reason } account halted for manual review` is the alert (a
source for #69). A lost CAS writes and alerts nothing. Only an operator lifts the halt, writing
both columns (the pair CHECK).

**Settlement catch-up.** `listOverdueAcceptedIntents` (open time + duration + 30 s grace by the
database clock), then per intent the token with `mayRefresh: false`, the closed list (the same
page reader) until the trade or the list's end, and `settleClosedTrades` over every closed trade
read. Each ending:

| Ending                                                              | Account held back for 120 s |
| ------------------------------------------------------------------- | --------------------------- |
| `settled`, `already_settled`, `intent_not_accepted` (left the queue) | no                          |
| trade not in the pages read (still open, or past the cap)           | yes                         |
| token refused or the backend failing                                | yes, one `warn` per attempt |
| broker error other than `rate_limited`, inconsistent pages          | yes                         |
| `rate_limited`                                                      | no; the tick ends           |
| the attempt's deadline, a throw                                     | yes                         |
| `stop()` during the attempt, the token fetch included              | no                          |

**Budget.** The broker allows 600 requests a minute per IP and the backend's balance refresh
takes up to 200 by default. The worker's worst case is 20 × 2 lists × 2 pages × 4 ticks + 20 × 2
pages × 2 ticks = 400 GETs a minute (`WORKER_BROKER_GETS_PER_MINUTE`, checked at import). It is a
true bound because both loops tick only on their intervals — the reconciliation job does not start
a tick, and a tick never overlaps the next. Reconciliation handles at most 80 intents a minute; a
new `reconciling` intent waits for the next tick (≤ 15 s). A 429 ends a tick and the attempt is
retried on the lease or the next tick. Its one real cost is a refresh exchange in flight on the
backend: a 429 on `/user-auth/refresh` is classified `rejected` → `refresh_outcome_unknown` → the
account is revoked (Rule 12, one attempt). The worker's share keeps its own traffic from driving
the IP to 429; the sum with the backend's when `BALANCE_POLL_MAX_PER_MINUTE` is above 200 is
stated, not enforced.

## Delivery, ACK and timeout semantics

| Stage                                                                                                                                             | Retry policy                                                                                                                                                              | Timeout                                                                                                                                                   | On failure                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Publisher `queue.add`, topic `trading-intents`                                                                                                    | outbox `attempts` with backoff 1 s, 2 s, 4 s, 8 s (cap 16 s), max 5                                                                                                       | 5 s per add (`Promise.race`; a late success is harmless, the job id dedupes)                                                                              | 5th failure: outbox `failed` **and**, in the same transaction, a still-`queued` intent → `rejected` (`publish_failed`) with token release                                                                                                                                |
| Publisher `queue.add`, topic `trading-reconciliation`                                                                                             | same backoff, **no cap** — the row stays `pending` for as long as it takes; `attempts` keeps counting and every attempt from the 5th on logs a warning                    | 5 s per add                                                                                                                                               | never `failed`: giving up would strand an `unknown` intent with its reserve and no reconciliation                                                                                                                                                                        |
| Lost job (published row, job absent after 30 s while the intent is still `queued` for `trading-intents` / `unknown` for `trading-reconciliation`) | counted as a failed delivery under the topic's policy                                                                                                                     | sweep every 15 s                                                                                                                                          | row back to `pending`, republished                                                                                                                                                                                                                                       |
| BullMQ job                                                                                                                                        | `attempts: 1` — the trade command is never retried by the queue                                                                                                           | `lockDuration` 60 s, `stalledInterval` 30 s, `maxStalledCount` 1                                                                                          | a job that throws is dead-lettered; a stalled job is redelivered once                                                                                                                                                                                                    |
| Worker shutdown                                                                                                                                   | —                                                                                                                                                                         | phase 1 budget 35 s (`SHUTDOWN_PHASE1_BUDGET_MS`) > longest ack timeout 30 s, phase 2 4 s; compose `stop_grace_period` 40 s                               | a job in flight finishes and its dead-letter write is awaited before any connection closes; an overrun exits 1 and the sweeper resolves the intent after the restart                                                                                                     |
| Backend shutdown                                                                                                                                  | —                                                                                                                                                                         | phase 1 budget 10 s (`SHUTDOWN_PHASE1_BUDGET_MS`, `apps/backend/src/timing.ts`) > publish/has deadline 5 s, phase 2 4 s; compose `stop_grace_period` 20 s | `publisher.stop()` finishes the row in flight and leaves the rest of the batch `pending`; an overrun (a database timing out every statement, a request that hangs) exits 1 with the transaction rolled back and the outbox row replayed                                  |
| `takeIntent`                                                                                                                                      | —                                                                                                                                                                         | `INTENT_MAX_AGE_MS` (60 s) in the CAS predicate, database clock                                                                                           | too old → `rejected` (`expired`), executor never called                                                                                                                                                                                                                  |
| `executor.submit`                                                                                                                                 | none                                                                                                                                                                      | `SUBMIT_ACK_TIMEOUT_MS` (10 s), enforced by the processor with `Promise.race`; the executor also receives an `AbortSignal`                                | `realTradingGate` first (`buildExecutor`): a real intent with the flag off → `rejected` (`real_trading_disabled`), the inner executor never called. Then the trade command executor: socket when the account's session is ready, REST only when nothing was emitted; an order sent with no answer → `unknown` (`broker_unavailable`), a refusal → `rejected` (`broker_rejected`) ([trade-executor.md](trade-executor.md) → Outcomes). Timeout → `unknown` (`executor_timeout`); throw → `unknown` (`executor_error`) |
| Outcome write                                                                                                                                     | none                                                                                                                                                                      | —                                                                                                                                                         | `accepted` writes the open `broker_trades` row in the same transaction; a trade that does not match the intent → `unknown` (`trade_mismatch`) + reconciliation row. A database failure here fails the job (dead letter); the intent stays `submitting` until the sweeper |
| Stale `submitting` (redelivery or sweeper, every 15 s)                                                                                            | —                                                                                                                                                                         | `STALE_SUBMITTING_MS` 60 s ≥ `lockDuration` > max ack timeout                                                                                             | → `unknown` (`stale_submitting`) + reconciliation row                                                                                                                                                                                                                    |
| Reconciliation job, topic `trading-reconciliation`                                                                                                | `attempts: 1`, as above                                                                                                                                                   | the BullMQ job options above                                                                                                                              | `unknown → reconciling`; the pass takes it on its next tick, within `RECONCILE_TICK_MS`; the job never asks the broker. A throw dead-letters with `topic`, and the outbox re-pends the row after 30 s while the intent is still `unknown`                                                                              |
| Reconciliation attempt (the pass, every 15 s, at most 20 candidates, one after another)                                                           | after the lease: the claim (`reconcile_claimed_at = now()`, `version + 1`) is the first write and keeps the intent from being a candidate for `RECONCILE_RETRY_MS` (60 s) | `RECONCILE_ATTEMPT_TIMEOUT_MS` (30 s) per `reconcile()` call (the token plus up to four GETs), enforced by the pass with `Promise.race`; the reconciler also receives an `AbortSignal`     | `unavailable`, a deadline or a throw write nothing beyond the claim; `rate_limited` ends the tick. Every outcome is a CAS on `status = reconciling` and the claim's `version`, so an attempt whose lease was re-claimed cannot write                                     |
| Settlement catch-up (every 30 s, at most 20 overdue intents, one after another)                                                                   | an attempt that does not take its intent out of `accepted` holds the account back for `CATCHUP_STALLED_RETRY_MS` (120 s), in memory                                     | `CATCHUP_ATTEMPT_TIMEOUT_MS` (20 s): the token (`mayRefresh: false`) and up to two closed pages                                                          | `rate_limited` ends the tick and holds nobody; a throw is logged with `errorLogFields` and holds the account. `settleClosedTrades` is idempotent, so a repeat is safe                                     |

Invariants these numbers encode (asserted at import in `apps/trading-worker/src/intents/config.ts`
and `apps/backend/src/timing.ts`, and held against `compose.yaml` by tests): worker
`SUBMIT_ACK_TIMEOUT_MS ≤ 30 s < phase 1 35 s`, `35 s + phase 2 4 s < stop_grace_period 40 s <
lockDuration 60 s ≤ STALE_SUBMITTING_MS 60 s`; backend `publish deadline 5 s < phase 1 10 s`,
`10 s + 4 s < stop_grace_period 20 s`; reconciliation `BROKER_REST_TIMEOUT_MS 5 s < attempt 30 s <
lease 60 s`, `attempt 30 s < phase 1 35 s` (phase 1 also waits for `pass.stop()`: the attempt in
flight plus one outcome write), `tick 15 s ≤ lease 60 s`; #90 adds `token route 7 s + 4 × 5 s <
attempt 30 s`, `ack cap 30 s < window after 90 s`, `token 7 s + 2 × 5 s < catch-up attempt 20 s <
phase 1 35 s` (`catchup.stop()` runs alongside `pass.stop()`), `catch-up tick 30 s < hold 120 s`,
and on the backend `exchange 5 s < token route 7 s < phase 1 10 s`. No live worker can still be inside its ack deadline when a
redelivery or the sweeper calls its intent unknown; a routine deploy never kills a submit or a
publish mid-flight; and the broker command is never sent twice — a redelivered job only checks
state. The budgets cover the bounded operations plus ordinary database latency, not a database
that times out every statement: that is the exit(1) path, and it loses nothing.

The sweeper can win a race against a slow executor: the late `accepted` is then dropped (the CAS
sees `unknown`, not `submitting`) and reconciliation recovers the real result.

## Dead-letter queue

`trading-intents-dead-letter` receives one entry per failed job of either topic: `{ intentId |
null, topic, reason, failedAt }` with `reason` from the allowlist (`invalid_job` for a malformed payload or a missing
intent, `processing_failed` otherwise). No exception text is stored — it can carry connection
details — the log line next to it has the error. A failure to write the entry is logged as
`dlq_publish_failed`; the worker keeps running. Writes started by jobs that fail during a
shutdown drain are awaited before the queue connection closes. Nothing consumes the queue
automatically; inspect it with the BullMQ tooling of your choice. A `trading-reconciliation`
entry is a record, not a loss: the outbox re-publishes the row while the intent is `unknown`.

## Persisted reasons and secrets

`trade_intents.last_error`, `outbox_events.last_error` and dead-letter entries only ever hold
`TradeIntentFailureReason` codes — a database CHECK on both columns refuses anything else. The
executor may return a free-text `detail`; it is truncated to 200 characters and logged, never
stored. An executor that throws is logged by the error's name and code only: a client library's
message can embed a header or a response body, and key-based redaction cannot scrub a string.
`trade_mismatch` (the accepted trade does not match the intent) and `manual_rejected` (the
operator's rejection from `manual_review`) are two of those codes (#17);
`reconciliation_not_found` (a parked intent in #90, a release in #274) and `reconciliation_ambiguous` are the reconciler's two (#89);
`broker_unavailable` is the trade command executor's "sent, no answer says whether it opened"
(#100), and `executor_not_configured` stays in the list for rows written before it. Queue
payloads carry the intent id only. Neither the publisher nor the worker loads broker tokens. Both loggers are built from `logOptions` in `packages/shared`: they redact `authorization`
and token-like keys at every depth from zero to five (`LOG_REDACT_PATHS`, exercised against real
pino by a worker test), deeper nesting and string contents not covered, and their serializers
reduce an error object under `err`, `error`, `cause` or `exception` at the top level of a log line
to its name, string code and one level of cause (docs/binodex-oauth.md → Secrets).

## Configuration

Backend: `INTERNAL_API_TOKEN` (required, ≥ 16 characters, no whitespace). No default a deployment
could inherit: `compose.yaml` uses `${VAR:?}`, `.env.example` leaves it empty, and the only values
in the tree are CI's and the tests' own fixtures — see `.env.example` and
docs/binodex-oauth.md → Configuration. Publisher constants live in
`apps/backend/src/outbox/publisher.ts` (`DEFAULT_PUBLISHER_CONFIG`).

Worker, required (#90): `BACKEND_URL` (compose: `http://backend:3000`), `INTERNAL_API_TOKEN` (the
backend's value), `BROKER_API_BASE_URL` (https, the backend's value through compose's
`x-broker-environment`).

Worker (optional, code defaults in `apps/trading-worker/src/env.ts`):

| Variable                | Default | Bounds                                                                                     |
| ----------------------- | ------- | ------------------------------------------------------------------------------------------ |
| `INTENT_MAX_AGE_MS`     | 60000   | 1000–600000                                                                                |
| `SUBMIT_ACK_TIMEOUT_MS` | 10000   | 500–30000 (`MAX_SUBMIT_ACK_TIMEOUT_MS`, below the shutdown budget and the stale threshold) |
| `WORKER_CONCURRENCY`    | 5       | 1–100                                                                                      |
| `BROKER_WS_URL`         | none    | `https://` or `wss://`; unset → no broker sessions, every order over REST; empty → the worker does not start (#101, [broker-session.md](broker-session.md)) |

Fixed constants and why they relate the way they do: `apps/trading-worker/src/intents/config.ts`
— among them the reconciliation pass's `RECONCILE_ATTEMPT_TIMEOUT_MS` (30 s),
`RECONCILE_RETRY_MS` (60 s, the lease), `RECONCILE_TICK_MS` (15 s) and `RECONCILE_BATCH_SIZE`
(20), the matching window and pages (`RECONCILE_WINDOW_*`, `RECONCILE_TRADES_PAGE_SIZE`,
`RECONCILE_MAX_TRADE_PAGES`) and the catch-up's `CATCHUP_*`; none has an environment variable.

Backend and worker: `REAL_TRADING_ENABLED` — the Binodex trading grant (#134). Default `false`;
exactly `true` or `false`, any other value (empty included) stops the process at start. Compose
passes the one `.env` value to both services (`REAL_TRADING_ENABLED:` under each, forwarded
only when set); each process reads its own environment when it starts, so a change takes a
restart of both. With `false`, the backend refuses to create real intents (409
`real_trading_disabled`) and the worker rejects any real intent that still reaches it, releasing
its reserve. The name, the default and the parsing live in `parseRealTradingEnabledEnv`
(`packages/shared/src/env.ts`). Demo is not affected.

## Boundaries

- **#100** implements `TradeExecutor` (`apps/trading-worker/src/intents/executor.ts`) with
  `createTradeCommandExecutor`, composed under `realTradingGate` by `buildExecutor`
  ([trade-executor.md](trade-executor.md)).
- **#89** (this pipeline's reconciliation half): the `trading-reconciliation` consumer, the
  pass, the `IntentReconciler` port (`apps/trading-worker/src/intents/reconciler.ts`) and the
  outcome writes. The port only reads: it never opens a trade.
- **#90** (shipped): the REST reconciler, the halt and alert on `manual_review`, the settlement
  catch-up and the backend's token route — Reconciliation matching above; it never releases a
  reserve on absence. **#274**: `not_found` and the release after the live probe. **#91**: no second open
  after `unknown` (the executor side is proven in #100, [trade-executor.md](trade-executor.md) →
  The two-cases rule). **#92**: the broker balance check after a reconciliation and a
  DLQ for unprocessable events.
- **#101** (shipped): the session manager feeds `close_trade.success` into `settleClosedTrades` and
  takes `noTradeSessions`' place when `BROKER_WS_URL` is set ([broker-session.md](broker-session.md)).
  The operator tool for `manual_review` is a later issue.
- Real-mode eligibility: **#134** the grant gate
  (this document); **#135** what a revoked grant does to running sessions; **#21/#121** starting
  real mode from the bot; **#144** the kill switch, a separate operational flag. Country
  restrictions are deferred: there is no data source (`GET /v1/broker/user` has no country, the
  Partner API reports `country` as `unknown`, #14). There are no per-account real-mode flags;
  the account predicates `status = active` and `trading_halted = false` apply as before. #15 is
  split into #136 (the token balance, [trading-access.md](trading-access.md)), #137 (the broker
  balance snapshot, [broker-balance.md](broker-balance.md)) and #138 (the pair catalog).
- **#127 / #29**: the bot tracks by `intent.id` ([bot-demo-trade.md](bot-demo-trade.md)).
  `GET /trading/intents/:id` is the status source, scoped by the owner since #127 because the id
  travels in a button's callback data ([GET /trading/intents/:id](#get-tradingintentsid-127));
  a notification dedupe key (#29) should be derived from the intent id and status.
- `trading_session_id` stays `NULL` until #20 links intents to sessions.

## Running it locally

```bash
docker compose up --build --wait
# read it back from the running container rather than re-parsing .env: this is the value compose
# itself resolved, and only this one variable enters the shell
INTERNAL_API_TOKEN="$(docker compose exec -T backend printenv INTERNAL_API_TOKEN)"
# the header arrives on stdin, so the token is neither in argv nor in a file on disk
printf 'Authorization: Bearer %s\n' "$INTERNAL_API_TOKEN" |
curl -s -X POST 127.0.0.1:3000/trading/intents \
  -H @- -H 'Content-Type: application/json' \
  -d '{"telegramUserId":"1","mode":"demo","assetId":1,"amount":"10.00","action":"up","durationSec":60,"clientRequestId":"demo-1"}'
# 404 user_not_found until a user and broker account exist (OAuth, #9); with them: 201 queued,
# then GET /trading/intents/<id>?telegramUserId=1 shows accepted / rest_fallback within the
# submit timeout, or rejected / broker_rejected when the token source or the broker refused
```
