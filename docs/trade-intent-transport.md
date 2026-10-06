# Trade intent transport (ARCH-03, issue #42)

How an order travels from the Telegram bot to the trading worker. Nothing calls the worker
directly: the backend records the intent in PostgreSQL, an outbox row carries it to BullMQ, and
the worker takes it from there. PostgreSQL is the source of truth throughout; Redis/BullMQ is a
delivery channel that can be rebuilt from the database.

## Components

| Component      | Package                                                           | Role                                                                                    |
| -------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Contract       | `packages/shared/src/trading.ts`                                  | request/response schemas, statuses, allowlisted failure reasons, queue payload          |
| Operations     | `packages/db/src/trade-intent-ops.ts`                             | every status transition, the creation transaction, the token reserve/release            |
| API            | `apps/backend/src/trading/routes.ts`                              | `POST /trading/intents`, `GET /trading/intents/:id` behind the internal Bearer token    |
| Publisher      | `apps/backend/src/outbox/`                                        | turns pending `outbox_events` rows into BullMQ jobs, re-publishes lost ones             |
| Consumer       | `apps/trading-worker/src/intents/`                                | processes `trading-intents` jobs through the `TradeExecutor` port                       |
| Real-mode gate | `packages/db` → `createInTransaction`; worker → `realTradingGate` | `REAL_TRADING_ENABLED` (#134): no real intent is created or sent while it is not `true` |

## Sequence

```
bot ──POST /trading/intents──▶ backend ──tx──▶ trade_intents (queued) + outbox_events (pending)
                                   │  201 { intent }                     │
                                   ◀─────────────────────────────────────┘
                              publisher: pending row ──add(jobId = intent id)──▶ BullMQ trading-intents
                              worker: re-read ──CAS queued→submitting──▶ executor.submit ──▶ CAS submitting→accepted|rejected|unknown
bot ──GET /trading/intents/:id──▶ backend ──▶ { intent }   (status, lastError, version)
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

## Statuses and who sets them

| Status                            | Set by                                                                                                                                                                                           | Meaning                                                                                                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `planned` → `reserved` → `queued` | backend, creation transaction                                                                                                                                                                    | intent and outbox row persisted, token reserved. `queued` is what the API returns                                                                                            |
| `submitting`                      | worker, `takeIntent` CAS                                                                                                                                                                         | the job was taken; `submitted_at` is set on the database clock                                                                                                               |
| `accepted`                        | worker, an explicit executor result that carries the broker's open trade (`markIntentAccepted`); #89 from `reconciling` with the trade REST found                                                | the broker confirmed the order and its trade matches the intent; the open `broker_trades` row is written in the same transaction. `socket.emit` or a local `ok` never counts |
| `rejected`                        | worker (executor said no, the intent expired, or the grant gate: a real intent while the worker's `REAL_TRADING_ENABLED` is not `true`, `real_trading_disabled`), publisher (delivery exhausted) | terminal; the token reserve is released in the same transaction                                                                                                              |
| `unknown`                         | worker (executor timeout, throw, a stale `submitting`, or an accepted trade that does not match the intent, `trade_mismatch`), sweeper                                                           | the order may have reached the broker; reserve kept; a `trading-reconciliation` outbox row is written for reconciliation (#89)                                               |
| `settled`                         | `settleIntent` from `accepted` (a `close_trade.success` or a REST closed snapshot through `settleClosedTrades`) or from `manual_review` (operator)                                               | terminal; the token is debited in the same transaction whatever the trade's profit; `broker_trades` closed                                                                   |
| `reconciling`, `manual_review`    | #89 / #90 (`unknown → reconciling → accepted \| rejected \| manual_review`); operator (`manual_review → settled \| rejected`: the ops exist, the tool is a later issue)                          | the outcome is being established; the reserve is kept and the account stays blocked                                                                                          |

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

| Guarantee                                                                                | Where                                                                                                                                               |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| only the edges of the graph, each bumping `version` by exactly one                       | trigger `trade_intents_transition_guard` (migration 0014); an UPDATE that keeps the status passes, the CAS predicate stays in each writer's `WHERE` |
| a live intent holds its token, a `rejected`/`settled` one holds none                     | CHECK `trade_intents_terminal_reserve_check` (0013)                                                                                                 |
| one live intent per account (`reconciling`/`manual_review` included)                     | `trade_intents_active_account_idx`                                                                                                                  |
| a broker trade links to one intent, an intent to one trade, of the same account and mode | `broker_trades_account_trade_key`, `broker_trades_intent_id_key`, `broker_trades_intent_account_fk`                                                 |
| one terminal ledger row (`release` or `settle`) per intent                               | `token_ledger_terminal_intent_idx`                                                                                                                  |

The trigger's pairs are a copy of the shared table; the transition grid in
`packages/db/src/schema.db.test.ts` tries every ordered pair and fails when the two disagree. A
graph change is a new migration that replaces the function.

**Transport state is not trade state.** The trade state is `trade_intents.status`; the socket's
state (`BrokerSocketState`, #99) is never stored on the intent. A disconnect can produce only
`unknown`, through the executor; the trigger refuses `submitting → settled` and
`unknown → rejected`, so no transport event ends an intent without the broker's answer or a
reconciliation.

**Acceptance carries proof.** `SubmitResult.accepted` is `{ transport, trade: OpenTrade }`, both
required. `markIntentAccepted` runs the CAS, checks the trade against the intent (`isDemo` against
`mode`, `assetId`, `action`, `amount` compared as decimals) and inserts the open `broker_trades`
row; a mismatch, or a trade already linked, throws `TradeIntentMismatchError` and the transaction
rolls back. The processor then marks the intent `unknown` (`trade_mismatch`) with a
reconciliation row and logs the intent id, the broker trade id and the reason code.
`broker_trades.raw` holds the parsed domain trade, not the broker's bytes: shared's parsers strip
unknown keys, and no token is in a trade.

**Settlement.** `settleIntent` (from `accepted` or `manual_review`, with a `ClosedTrade`) locks
`users → trade_intents → broker_trades`, checks the trade against the linked row (same broker
id) and against the intent (the four fields above), then moves the intent, writes the `settle`
row and closes the `broker_trades` row — or inserts it closed for a `manual_review` intent never
linked. `settleClosedTrades(db, { brokerAccountId, trades })` is the one applier of a
`close_trade.success` payload and of a REST closed snapshot: one transaction per trade, an
outcome per trade —

| Outcome               | Meaning                                                                            | Caller's action                             |
| --------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------- |
| `settled`             | settled now                                                                        | done                                        |
| `already_settled`     | an earlier pass settled it                                                         | nothing                                     |
| `not_ours`            | no intent behind this trade (a platform trade, or an acceptance not persisted yet) | ignore; a later snapshot links it           |
| `intent_not_accepted` | the intent is `reconciling`/`manual_review`                                        | leave to #89/#90/the operator; never settle |
| `mismatch`            | the closed trade contradicts the intent; nothing written                           | log; reconciliation                         |

A database error propagates; the trades before it stay applied, and a replay is safe.
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
| `accepted`                                             | `close_trade.success` → `settleClosedTrades`; the REST catch-up `listOverdueAcceptedIntents` + `listTrades(closed)` + `settleClosedTrades`; the REST pass at session start | #101 (socket, session start), #90 (catch-up) |
| `accepted`, closed before the acceptance was persisted | `settleClosedTrades` answered `not_ours`; the catch-up applies the closed snapshot once the intent is overdue                                                              | #90, #101                                    |
| `unknown`                                              | the `trading-reconciliation` consumer → `reconciling`                                                                                                                      | #89                                          |
| `reconciling`                                          | #89's pickup at worker start → `accepted` / `rejected` / `manual_review`                                                                                                   | #89                                          |
| `manual_review`                                        | the operator: `settleIntent` or `rejectIntent` (`manual_rejected`)                                                                                                         | a later issue (the tool)                     |

Until #101 and #90 ship their loops, an `accepted` intent is not self-resolving; no executor
accepts before then (`notConfiguredExecutor` rejects every intent).

## Delivery, ACK and timeout semantics

| Stage                                                                                                                                             | Retry policy                                                                                                                                           | Timeout                                                                                                                                                   | On failure                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Publisher `queue.add`, topic `trading-intents`                                                                                                    | outbox `attempts` with backoff 1 s, 2 s, 4 s, 8 s (cap 16 s), max 5                                                                                    | 5 s per add (`Promise.race`; a late success is harmless, the job id dedupes)                                                                              | 5th failure: outbox `failed` **and**, in the same transaction, a still-`queued` intent → `rejected` (`publish_failed`) with token release                                                                                                                                |
| Publisher `queue.add`, topic `trading-reconciliation`                                                                                             | same backoff, **no cap** — the row stays `pending` for as long as it takes; `attempts` keeps counting and every attempt from the 5th on logs a warning | 5 s per add                                                                                                                                               | never `failed`: giving up would strand an `unknown` intent with its reserve and no reconciliation                                                                                                                                                                        |
| Lost job (published row, job absent after 30 s while the intent is still `queued` for `trading-intents` / `unknown` for `trading-reconciliation`) | counted as a failed delivery under the topic's policy                                                                                                  | sweep every 15 s                                                                                                                                          | row back to `pending`, republished                                                                                                                                                                                                                                       |
| BullMQ job                                                                                                                                        | `attempts: 1` — the trade command is never retried by the queue                                                                                        | `lockDuration` 60 s, `stalledInterval` 30 s, `maxStalledCount` 1                                                                                          | a job that throws is dead-lettered; a stalled job is redelivered once                                                                                                                                                                                                    |
| Worker shutdown                                                                                                                                   | —                                                                                                                                                      | phase 1 budget 35 s (`SHUTDOWN_PHASE1_BUDGET_MS`) > longest ack timeout 30 s, phase 2 4 s; compose `stop_grace_period` 40 s                               | a job in flight finishes and its dead-letter write is awaited before any connection closes; an overrun exits 1 and the sweeper resolves the intent after the restart                                                                                                     |
| Backend shutdown                                                                                                                                  | —                                                                                                                                                      | phase 1 budget 10 s (`SHUTDOWN_PHASE1_BUDGET_MS`, `apps/backend/src/timing.ts`) > publish/has deadline 5 s, phase 2 4 s; compose `stop_grace_period` 20 s | `publisher.stop()` finishes the row in flight and leaves the rest of the batch `pending`; an overrun (a database timing out every statement, a request that hangs) exits 1 with the transaction rolled back and the outbox row replayed                                  |
| `takeIntent`                                                                                                                                      | —                                                                                                                                                      | `INTENT_MAX_AGE_MS` (60 s) in the CAS predicate, database clock                                                                                           | too old → `rejected` (`expired`), executor never called                                                                                                                                                                                                                  |
| `executor.submit`                                                                                                                                 | none                                                                                                                                                   | `SUBMIT_ACK_TIMEOUT_MS` (10 s), enforced by the processor with `Promise.race`; the executor also receives an `AbortSignal`                                | `realTradingGate` first: a real intent with the flag off → `rejected` (`real_trading_disabled`), the inner executor never called. Then timeout → `unknown` (`executor_timeout`); throw → `unknown` (`executor_error`)                                                    |
| Outcome write                                                                                                                                     | none                                                                                                                                                   | —                                                                                                                                                         | `accepted` writes the open `broker_trades` row in the same transaction; a trade that does not match the intent → `unknown` (`trade_mismatch`) + reconciliation row. A database failure here fails the job (dead letter); the intent stays `submitting` until the sweeper |
| Stale `submitting` (redelivery or sweeper, every 15 s)                                                                                            | —                                                                                                                                                      | `STALE_SUBMITTING_MS` 60 s ≥ `lockDuration` > max ack timeout                                                                                             | → `unknown` (`stale_submitting`) + reconciliation row                                                                                                                                                                                                                    |

Invariants these numbers encode (asserted at import in `apps/trading-worker/src/intents/config.ts`
and `apps/backend/src/timing.ts`, and held against `compose.yaml` by tests): worker
`SUBMIT_ACK_TIMEOUT_MS ≤ 30 s < phase 1 35 s`, `35 s + phase 2 4 s < stop_grace_period 40 s <
lockDuration 60 s ≤ STALE_SUBMITTING_MS 60 s`; backend `publish deadline 5 s < phase 1 10 s`,
`10 s + 4 s < stop_grace_period 20 s`. No live worker can still be inside its ack deadline when a
redelivery or the sweeper calls its intent unknown; a routine deploy never kills a submit or a
publish mid-flight; and the broker command is never sent twice — a redelivered job only checks
state. The budgets cover the bounded operations plus ordinary database latency, not a database
that times out every statement: that is the exit(1) path, and it loses nothing.

The sweeper can win a race against a slow executor: the late `accepted` is then dropped (the CAS
sees `unknown`, not `submitting`) and reconciliation recovers the real result.

## Dead-letter queue

`trading-intents-dead-letter` receives one entry per failed job: `{ intentId | null, reason,
failedAt }` with `reason` from the allowlist (`invalid_job` for a malformed payload or a missing
intent, `processing_failed` otherwise). No exception text is stored — it can carry connection
details — the log line next to it has the error. A failure to write the entry is logged as
`dlq_publish_failed`; the worker keeps running. Writes started by jobs that fail during a
shutdown drain are awaited before the queue connection closes. Nothing consumes the queue
automatically; inspect it with the BullMQ tooling of your choice.

## Persisted reasons and secrets

`trade_intents.last_error`, `outbox_events.last_error` and dead-letter entries only ever hold
`TradeIntentFailureReason` codes — a database CHECK on both columns refuses anything else. The
executor may return a free-text `detail`; it is truncated to 200 characters and logged, never
stored. An executor that throws is logged by the error's name and code only: a client library's
message can embed a header or a response body, and key-based redaction cannot scrub a string.
`trade_mismatch` (the accepted trade does not match the intent) and `manual_rejected` (the
operator's rejection from `manual_review`) are two of those codes (#17). Queue payloads carry the
intent id only. Neither the publisher nor the worker loads broker
tokens. Both loggers are built from `logOptions` in `packages/shared`: they redact `authorization`
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

Worker (optional, code defaults in `apps/trading-worker/src/env.ts`):

| Variable                | Default | Bounds                                                                                     |
| ----------------------- | ------- | ------------------------------------------------------------------------------------------ |
| `INTENT_MAX_AGE_MS`     | 60000   | 1000–600000                                                                                |
| `SUBMIT_ACK_TIMEOUT_MS` | 10000   | 500–30000 (`MAX_SUBMIT_ACK_TIMEOUT_MS`, below the shutdown budget and the stale threshold) |
| `WORKER_CONCURRENCY`    | 5       | 1–100                                                                                      |

Fixed constants and why they relate the way they do: `apps/trading-worker/src/intents/config.ts`.

Backend and worker: `REAL_TRADING_ENABLED` — the Binodex trading grant (#134). Default `false`;
exactly `true` or `false`, any other value (empty included) stops the process at start. Compose
passes the one `.env` value to both services (`REAL_TRADING_ENABLED:` under each, forwarded
only when set); each process reads its own environment when it starts, so a change takes a
restart of both. With `false`, the backend refuses to create real intents (409
`real_trading_disabled`) and the worker rejects any real intent that still reaches it, releasing
its reserve. The name, the default and the parsing live in `parseRealTradingEnabledEnv`
(`packages/shared/src/env.ts`). Demo is not affected.

## Boundaries

- **ARCH-01 (#40)** implements `TradeExecutor` (`apps/trading-worker/src/intents/executor.ts`)
  with the broker socket client. Until then `notConfiguredExecutor` rejects every intent with
  `executor_not_configured`, so the whole path can be exercised without a broker.
- **#89** consumes `trading-reconciliation` jobs: `unknown → reconciling` (a new op),
  `reconciling → accepted` through `markIntentAccepted({ from: 'reconciling', trade })`,
  `reconciling → rejected` through `rejectIntent` with its own reason, `reconciling →
manual_review` (the reserve stays), and the pickup of `reconciling` intents at worker start. The
  edges already exist in the graph and the trigger. The publisher already publishes the topic; jobs
  wait in the queue until the consumer exists.
- **#90** matches REST snapshots to `unknown`/`reconciling` intents, halts the account on
  `manual_review`, and runs the REST catch-up loop over `listOverdueAcceptedIntents` +
  `settleClosedTrades` in the backend (the only process with a path to a broker token today).
- **#101** feeds `close_trade.success` into `settleClosedTrades` and runs the REST closed pass at
  session start; **#100** implements the executor that returns `{ outcome: 'accepted', transport,
trade }`. The operator tool for `manual_review` is a later issue.
- Real-mode eligibility: **#134** the grant gate
  (this document); **#135** what a revoked grant does to running sessions; **#21/#121** starting
  real mode from the bot; **#144** the kill switch, a separate operational flag. Country
  restrictions are deferred: there is no data source (`GET /v1/broker/user` has no country, the
  Partner API reports `country` as `unknown`, #14). There are no per-account real-mode flags;
  the account predicates `status = active` and `trading_halted = false` apply as before. #15 is
  split into #136 (the token balance, [trading-access.md](trading-access.md)), #137 (the broker
  balance snapshot, [broker-balance.md](broker-balance.md)) and #138 (the pair catalog).
- **#25 / #29**: the bot tracks and notifies by `intent.id`. `GET /trading/intents/:id` is the
  status source; a notification dedupe key should be derived from the intent id and status.
  The internal API is fully trusted: the read is not scoped to a user, because the only caller
  is the bot holding the shared secret and ids are `gen_random_uuid()`. Once #25 forwards ids
  that came from an end user, the read must take `telegramUserId` and add it to the `where`.
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
# then GET /trading/intents/<id> shows rejected / executor_not_configured within a second
```
