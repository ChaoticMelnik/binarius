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
| Router         | `apps/trading-worker/src/intents/router.ts`                       | hands a shared job of an account another live worker process owns to that process's own queue, before the take (#347, [Routing to the owner](#routing-to-the-owner-347)) |
| Reconciliation | `apps/trading-worker/src/intents/reconciliation.ts`               | `trading-reconciliation` jobs hand `unknown` intents to the pass, which asks the `IntentReconciler` port (#89) |
| REST reconciler | `apps/trading-worker/src/intents/rest-reconciler.ts`             | the port's implementation: the broker's open and closed lists matched against the intent (#90)                 |
| Catch-up       | `apps/trading-worker/src/intents/settlement-catchup.ts`           | settles `accepted` intents past their expected close from the closed list (#90)                                |
| Session manager | `apps/trading-worker/src/broker/session-manager.ts`              | one broker socket session per account in work when `BROKER_WS_URL` is set; `close_trade.success` → `settleClosedTrades` (#101, [broker-session.md](broker-session.md)) |
| Token route    | `apps/backend/src/trading/routes.ts` → `POST /trading/accounts/:id/access-token` | the worker's only way to a broker access token (#90); the worker holds no broker credentials   |
| Trading switch | `packages/db` → `createInTransaction`, `takeIntent`; worker → `rejectPausedIntent` | the `trading_switch` row (#144, [kill-switch.md](kill-switch.md)): no intent, demo or real, is created or taken while it is closed |

## Sequence

```
bot ──POST /trading/intents──▶ backend ──tx──▶ trade_intents (queued) + outbox_events (pending)
                                   │  201 { intent }                     │
                                   ◀─────────────────────────────────────┘
                              publisher: pending row ──add(jobId = intent id)──▶ BullMQ trading-intents
                              worker: re-read ──(another live process owns the account: add to trading-intents-<owner>, done; #347)
                                      ──CAS queued→submitting──▶ executor.submit ──▶ CAS submitting→accepted|rejected|unknown
unknown ──outbox──▶ BullMQ trading-reconciliation ──CAS unknown→reconciling──▶ pass (woken, #872): claim
        ──token (backend route) + GETs only──▶ CAS reconciling→accepted(→settled) | manual_review(+halt) | rejected (demo, proven absence)
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
   2a. **DEMO_ONLY (#396).** A `real` intent from a caller that passes `{ demoOnly: true }`
   (`POST /trading/intents` and `createSessionIntent` pass the process's flag) → 409 `demo_only`,
   before the switch, the account and the reserve; an in-memory check, nothing is read
   ([kill-switch.md](kill-switch.md) → DEMO_ONLY).
   2b. **The trading switch (#144).** `trading_switch` closed, or its row missing → 409
   `trading_paused`, any mode, before any read of the account and before the reserve. A plain
   read, no lock. The replay above runs first, so a retry still finds an intent created while
   trading was open ([kill-switch.md](kill-switch.md)).
3. Resolve the broker account: the given `brokerAccountId` must belong to the user (404
   `broker_account_not_found`), or the user's single active account (0 → 404, more than one →
   409 `ambiguous_broker_account`).
3a. **The stake bounds (#297, #326)**, for an intent of either mode, only when the caller passes
   `{ checkStake: true }` — today `POST /trading/intents` alone (stated; the driver's
   session intents rely on the sizer, Rule 23). One plain `select` of the resolved account's
   `broker_balance_snapshots` row, no lock, any age: none → 409 `balance_unavailable`; otherwise
   `checkStake(amount, { minTradeAmount, available })` with `available` = `real_available` for a
   `real` intent and `demo_available` for a `demo` one → 409 `stake_precision`,
   `stake_below_minimum` or `insufficient_balance`. After the replay, so a retry after a
   committed trade that spent the balance gets its intent back; after 2a, so a `real` intent on a
   `DEMO_ONLY` process answers `demo_only` whatever its amount; before the reserve, so a refusal
   writes nothing.
4. Reserve one token with a guarded update on `users` (`status = active`,
   `token_balance - token_reserved >= 1`); zero rows → 409 `user_blocked` or `insufficient_tokens`.
5. Lock the account with `FOR NO KEY UPDATE` and the predicates `status = active`,
   `trading_halted = false`; zero rows → 409 `account_revoked`, `account_not_confirmed` (linked but not confirmed in the bot, see docs/binodex-oauth.md) or `account_halted`.
5a. **A session intent only** (`createSessionIntent`, #130): lock the session row `FOR NO KEY
   UPDATE` with `broker_account_id` = the account, `mode` = the intent's and `status = active`; zero rows →
   `TradingSessionNotActiveError` (no wire code: the route never names a session), the reserve
   rolls back. The insert below carries `trading_session_id`; the request key is
   `session:<session id>:<step>`, so a repeated step is a replay
   ([trading-session.md](trading-session.md)). An H1 session's intent (#670) may carry
   `submit_deadline_at` too (`IntentSession.submitDeadlineAt`, the backend's clock): the last
   moment the worker may take it, and `submit_not_before_at` (`IntentSession.submitNotBeforeAt`,
   #836): the first such moment, the entry's hold. Only this path writes them; the route's request
   schema has no such field, so a bot intent's are NULL ([h1.md → The entry](h1.md#the-entry-836)).
6. Insert the intent (`planned`, `tokens_reserved = 1`), the ledger `reserve` row, move it to
   `reserved`, insert the outbox row, move it to `queued`, commit.
7. After the commit the publisher is woken; a failed wake only logs (the poll picks the row up).

A unique violation on `trade_intents_user_request_idx` or `trade_intents_active_account_idx`
(two identical or two competing requests) rolls back and re-runs step 2: found → replay or
conflict, not found → 409 `active_intent_exists`. That 409 is a snapshot — the competing intent
may already be terminal when the bot reads it; retrying with the same `clientRequestId` is the
intended reaction.

`409 trading_paused` comes from the trading switch, before any side effect: no row, no reserve,
no wake. The bot answers «Торговля временно приостановлена, попробуйте позже»; retrying helps
only once an operator opens trading (`kill-switch off`).

**Lock order is `users` → `broker_accounts` → `trading_sessions` → `trade_intents`, for every
writer.** Creation takes the user row (reserve `UPDATE`), then the account (`FOR NO KEY UPDATE`),
then — a session intent only — the session row (`FOR NO KEY UPDATE`), then inserts the intent; a rejection takes the user row (`FOR NO KEY UPDATE`) before it locks the intent it
releases. The intent-first order deadlocked against a creation whose `INSERT` was waiting on
the active-intent index while holding the user row. OAuth linking, revocation and ARCH-04 must
keep the same order.

Unexpected errors (a database failure, a bug) are answered with `500 { "error": "internal" }`
and a log line; the response never carries the error message, because a query error's message
contains the SQL text and its parameters.

### GET /trading/intents/:id (#127)

The bot reads an intent by the id it carries in the «🔄 Обновить» button's callback data
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
| `rejected`                        | worker (executor said no, the intent expired, the trading switch was closed when the job came, `trading_paused`, or a real intent met a `DEMO_ONLY` worker before the take, `demo_only`, or an H1 session's intent was past its `submit_deadline_at` at the take, `entry_window_missed`, #670), publisher (delivery exhausted), the reconciliation pass on an absence proven twice in demo (`reconciliation_not_found`, #274) | terminal; the token reserve is released in the same transaction                                                                                                              |
| `unknown`                         | worker (executor timeout, throw, a stale `submitting`, an order sent with no answer, `broker_unavailable`, or an accepted trade that does not match the intent, `trade_mismatch`), sweeper                                                                                     | the order may have reached the broker; reserve kept; a `trading-reconciliation` outbox row is written for reconciliation (#89)                                               |
| `settled`                         | `settleIntent` from `accepted` (a `close_trade.success` or a REST closed snapshot through `settleClosedTrades`) or from `manual_review` (operator)                                                                                                                              | terminal; the token is debited in the same transaction whatever the trade's profit; `broker_trades` closed                                                                   |
| `reconciling`                     | worker, `trading-reconciliation` job: `startReconciling` CAS from `unknown`; the pass claims it (`reconcile_claimed_at`, database clock) and asks the `IntentReconciler`                                                                                                        | the outcome is being established; the reserve is kept and the account stays blocked; `unavailable` leaves it here and the pass retries after `RECONCILE_RETRY_MS`            |
| `manual_review`                   | the reconciliation pass: the reconciler answered `ambiguous` (`reconciliation_ambiguous`), found nothing once the window closed (`reconciliation_not_found`, absence not proven: a real intent or no first-page proof, #274) or offered a trade that does not match (`trade_mismatch`); operator (`manual_review → settled \| rejected`: the ops exist, the tool is a later issue)                                 | the reserve is kept; the same transaction halts the account (`trading_halted`, `halted_reason`) and an `error` line alerts after the commit (#90) |

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

**The row's domain (#675).** A broker value the column cannot hold does not refuse the accepted
trade: `payout` (`numeric(8,4)`, nullable since 0077) is written through `payoutInColumn` — NULL
outside `[0, 9999.9999]` — and `potential_profit` through `moneyInColumn` — NULL outside the money
shape (no sign, at most 12 integer and 8 fraction digits; its CHECK is `>= 0`, a 0-payout trade
has 0); `raw` keeps the broker's value. The price CHECKs admit any finite double (the sign and 0
included): no decision rests on a price — the messages and the export print it, the bot's session
card and promo scale it into a chart, which takes any finite value. Still refused, by
design: a timestamp of 0 (`open_timestamp_ms`/`close_timestamp_ms` `> 0`, the wire's
`unixMsSchema` admits 0) and a `profit` of 13 or more integer digits — both enter behaviour (the
catch-up's overdue predicate, the reconciliation and tick windows, the Martingale sums), and the
write's failure shows as `reconciliation attempt failed` / `settlement catch-up attempt failed`.
The wire schemas are not narrowed: a refusal there would drop the account's whole trades list.

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
| `reconciling`                                          | the reconciliation pass: first tick at worker start, then every 15 s; a claim is a 60 s lease → `accepted` / `settled` / `manual_review` / `rejected` (demo, absence proven twice, #274)  | #89 (the pass), #90 (the reconciler)         |
| `manual_review`                                        | the operator: `settleIntent` (with the closed trade from that account's own closed list) or `rejectIntent` (`manual_rejected`)                                             | a later issue (the tool)                     |

With `BROKER_WS_URL` set, `close_trade.success` on the account's session (#101) is the main path
and the catch-up (#90) resolves from the closed list what the session missed, once the intent is
overdue. Without it there is no session: every intent reaches the broker over REST
(`rest_fallback`, the trade command executor, [trade-executor.md](trade-executor.md)) and the
catch-up settles every one. Every write of the worker that ends an intent or halts its account (a
settle over the socket, by the catch-up or by the pass; a rejection by the processor or the pass; a
halt) wakes the session orchestrator after its commit (#696,
[trading-session.md](trading-session.md#the-orchestrator)), not after a partial settle that throws
(the tick finds it, trading-session.md → The wake); the backend's own terminal writes wait for its
tick.

The intents of a demo session take the same rows; what the session does meanwhile is
[trading-session.md](trading-session.md) → [Recovery after a restart](trading-session.md#recovery-after-a-restart-131).

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
is released on it alone (Proof of absence below). The trades are merged by `id`, the
closed form winning (a trade that closed between the two reads). The order was observed live
2026-10-23 (docs/broker-rest.md → Observed live (2026-10-23)).

**Proof of absence (#274).** A list's end is proven only on its first page (`offset=0`): the
reader stopped there (`pagesRead = 1`, covered), and the page is empty, or its ids are distinct,
its first trade is strictly newer than its last and it reached a trade older than the window;
every trade on it has the intent's mode. Newest first, a trade inside the window sorts before
every older one, so ours would be on that page. Nothing is read from a page's length or from a
later offset (A2 is not a premise); the page being the list's newest prefix (A7) is stated, not
checked. A proof of both lists counts only in demo and only twice: the first non-aborted attempt
records its claim in the reconciler's memory and answers `unavailable/absence_unconfirmed`; the
next attempt on a later claim answers `not_found`. Any other ending of a non-aborted attempt for
the intent (and a throw) forgets the first proof; an attempt the pass has given up on (deadline,
`stop()`) answers `timeout` and neither records nor forgets. The two reads are at least
`RECONCILE_RETRY_MS − RECONCILE_ATTEMPT_TIMEOUT_MS` (30 s) apart, which covers a trade between the
open and the closed list (A3). A restart forgets every first proof: it only delays a release.

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
| 0 exact, nothing near, real or a list without proof | any     | yes                                     | `unresolved` → `manual_review` (`reconciliation_not_found`) + halt |
| 0 exact, nothing near, demo, both proven, 1st time  | yes     | yes                                     | `unavailable/absence_unconfirmed`                               |
| 0 exact, nothing near, demo, both proven, 2nd time  | yes     | yes                                     | `not_found` → `rejected` (`reconciliation_not_found`), reserve released, no halt |

`not_found` is answered only by the last row (Proof of absence above): the pass releases the
reserve through `rejectIntent` (Rule 24), runs the balance check (#92) and wakes the session
orchestrator (#696), whose session goes on and counts the intent as any `rejected`. A real intent,
or one whose lists prove nothing (a full first page inside the window, one trade, repeated ids,
equal timestamps, a trade of the other mode), is parked as before. The token
route refusing (`token_unavailable`) or failing (`backend_unavailable`) and every broker error
(`rate_limited`, `unauthorized` → `token_unavailable`, `rejected`/`contract_violation` →
`broker_contract`, `unavailable`, `aborted` → `timeout`) answer `unavailable` with a `warn`;
anything else is thrown and the pass logs it by name. A 401 first reports the token's fingerprint
with `mayRefresh: true` (#281): the backend marks it expired and exchanges it, and the next
attempt by lease takes the new token; the token, a 401 on the first page and the report fit one
attempt (`2 × ACCESS_TOKEN_ROUTE_BUDGET_MS + BROKER_REST_TIMEOUT_MS`, `TIMING_CHAIN_HOLDS`). A
401 on a later page (the token refused mid-attempt) can outlast it — 34 s here, 24 s in the
catch-up: the report is cut by the attempt's signal, and the next attempt meets the 401 on its
first page and reports in time (stated).

**Halt and alert.** Every `manual_review` the pass writes — `ambiguous`, `unresolved`
(`reconciliation_not_found`) and a found trade that does not match (`trade_mismatch`) — goes through `haltAccountForManualReview`: `broker_accounts`
`FOR NO KEY UPDATE`, then the intent's CAS, then `trading_halted = true` with `halted_reason`
from `AccountHaltReason`, in one transaction. After the commit one line
`error { intentId, brokerAccountId, reason } account halted for manual review` is the alert (a
source for #69). A lost CAS writes and alerts nothing. Only an operator lifts the halt, writing
both columns (the pair CHECK).

**Balance check after an outcome (#92).** For every recorded `accepted`, `settled` and
`rejected` (from the reconciler's `not_found`, #274) the pass runs `createBalanceCheck`
(`intents/balance-check.ts`) for the intent's account after the tick's attempts (#872), in the
order of the outcomes, each behind a reservation of `BALANCE_CHECK_GETS` (1) GET and only while
the pass is not stopping; a refused reservation ends the tick's remaining checks. Each runs under
its own deadline, `BALANCE_CHECK_TIMEOUT_MS` (20 s: the token, the GET and, on a 401, the report of the
refused token, `2 × 7 + 5 < 20`). Not after `manual_review`: the account is already halted and
alerted, and the parked intent keeps its mode out of any compare. The check never changes the
outcome or the intent:

1. `readHeldExposure` (`packages/db`, one statement, no locks): per mode, our open
   `broker_trades`, the count of the mode's intents created within the last 10 minutes
   (`RECENT_INTENTS_WINDOW_MS`: bounded by the window, not by the account's history; the second
   read counts from the first read's bound, so its window contains the first's and an intent
   created between them always changes the count — B18), whether one is in flight (non-terminal and not
   `accepted` with an open linked trade), and whether an open trade is at or past its expected close
   by the database clock.
2. The token with `mayRefresh: false` (Rule 12), then one `GET /v1/broker/user`.
3. The id check against `broker_accounts.broker_user_id`, then `upsertBalanceSnapshot` with the
   answer (its domain check included) and `eventsAfter` = the first read's database clock: a mode
   whose socket event landed since keeps the newer amounts. Another user's id or a value out of the domain writes
   nothing and compares nothing.
4. `readHeldExposure` again, now with the broker's `held` per mode: `held > sum(open amount)`
   is compared in SQL `numeric` (Rule 2).
5. Per mode, compare only when nothing of ours moved around the GET:
   - an intent in flight at either read → `intent_unresolved`;
   - an open trade past its expected close (the broker may already have settled it) →
     `settlement_pending`;
   - the open trade ids or the recent intent count differ between the reads → `trades_changed`.
   A skip is `info` `balance check not compared` `{ brokerAccountId, mode, reason }`. Otherwise,
   when the broker holds more than our open trades, the alert is
   `error { brokerAccountId, mode, direction: 'broker_holds_more' } broker balance mismatch` —
   alert only, no halt (owner, 2026-10-07). Holding less is settlement lag on the broker's side,
   not an alert.

The two reads, not the trade durations, keep a moving trade out of the compare: a 5 s trade
(#313) that opens and settles inside one GET has an intent before the first read (in flight there,
or with its trade in the first read's ids) or creates one after it (the count changes)
(`balance-check.db.test.ts` B5b, B6, B6b). No amount reaches a log line. Failures are a `warn`
`balance check failed` with `reason` (`token`, `account_not_found`, `broker` with `code`,
`status`, `retryAfterSec`; the broker's `detail` is not logged); a 401 also reports the refused
token with `mayRefresh: false` (#281); a `rate_limited` GET ends the tick's remaining checks, and
an attempt's own 429 ends the tick before any of its checks; a throw is `error` `balance check threw` and a deadline `warn` `balance check timed out`. A
check whose signal the deadline or `stop()` aborted ends `aborted` at the next step: a cut token
fetch is not logged as a backend failure, and after the GET it writes and alerts nothing
(B14–B16). The tick summary counts `balanceCompared` and `balanceMismatch`.

**Settlement catch-up.** `listOverdueAcceptedIntents` (open time + duration + 10 s grace by the
database clock — sized in #313 for the demo's 5 and 15 s trades, which settle 10-15 s after their
close while no close event arrives; every 5 s, at most `CATCHUP_BATCH_SIZE` (16) accounts a tick,
one accepted intent per account, Rule 7), then per intent a reservation of
`CATCHUP_GETS_PER_ATTEMPT` (2) GETs (#872), the token with `mayRefresh: false`, the closed list (the same
page reader) until the trade or the list's end, and `settleClosedTrades` over every closed trade
read; a page that settled any trade wakes the session orchestrator (#696). Each ending:

| Ending                                                              | Account held back for 30 s  |
| ------------------------------------------------------------------- | --------------------------- |
| `settled`, `already_settled`, `intent_not_accepted` (left the queue) | no                          |
| trade not in the pages read (still open, or past the cap)           | yes                         |
| token refused or the backend failing                                | yes, one `warn` per attempt |
| broker error other than `rate_limited`, inconsistent pages; a 401 first reports its token with `mayRefresh: false` (#281) | yes                         |
| `rate_limited`                                                      | no; the tick ends           |
| the GET budget refuses the reservation (before the token, #872)     | no; the tick ends           |
| the attempt's deadline, a throw                                     | yes                         |
| `stop()` during the attempt, the token fetch included              | no                          |

**Budget and the wake (#872).** The broker allows 600 requests a minute per IP. The backend's
balance refresh and its signal REST (the scanner's share until #828) take up to 100 each by
default (the shares are in `packages/shared/src/broker-budget.ts`, docs/signal.md → The budget).
The worker holds its share, `WORKER_BROKER_GETS_PER_MINUTE` (400), at runtime: one budget per
process (`apps/trading-worker/src/broker/get-budget.ts`) counts every `listTrades` and `getUser`
of the reconciliation pass and the settlement catch-up when it is sent, and drops it 60 s later
(`BROKER_GET_WINDOW_MS`). Before an attempt's first GET its loop reserves the attempt's worst case
— `RECONCILE_GETS_PER_ATTEMPT` (4: two lists of `RECONCILE_MAX_TRADE_PAGES` pages),
`CATCHUP_GETS_PER_ATTEMPT` (2), `BALANCE_CHECK_GETS` (1) — and returns what it did not spend when
the attempt ends. A reservation that does not fit the window ends the tick there: a reconciliation
candidate is not claimed and keeps its place at the head of the order, a catch-up account is not
asked for a token and not held back, and the next tick takes them once the window frees; the
tick summary counts it as `budget`. So the GETs sent in any 60 s window stay at or under 400 while
an attempt keeps to its reservation (stated: the page caps of `readTradePages`, one GET a check);
a GET beyond it is still counted, and the next reservation waits for it. A new process cannot
see what the one before it sent in the last 60 s, so its budget starts with the window full
(`carriedOver`, the whole cap in production: `WorkerTuning.brokerGetsCarriedOver`, #909): the
first GET of its reconciliation pass, balance check and catch-up comes no sooner than 60 s after
its start, and a restart puts no more than the cap of the old process's GETs and the new one's
into any 60 s window. A wake inside that minute is refused before the claim and the intent waits
for the interval tick; the catch-up's overdue accounts wait for the window. The submits (POST) and
the sockets are not GETs of the two loops and stay outside the budget, and are not delayed. The
budget is per worker process: a deploy's
overlap runs two for the readiness wait (≤ 120 s) plus the drain (≤ 40 s), the new one sending
nothing for its first 60 s (#909), or until an operator
resolves an interrupted run ([worker-deploy.md](worker-deploy.md) → The overlap's length, #95), and
one process otherwise: `TRADING_WORKER_REPLICAS` stays 1 until #815 bounds the fleet
([worker-capacity.md](worker-capacity.md)). The reconciliation job wakes the pass after its
commit of `unknown → reconciling` (`wake()` from the consumer's wrapper in `worker.ts`): a tick at
once, or one right after the running one; wakes during a tick merge into that one tick, and a wake
after `stop()` starts nothing. The tick line counts them as `woken`. A tick's attempts run one
after another, so a wake that meets a running tick waits for it — up to 16 × (30 + 20) s in the
worst case, seconds normally; parallel attempts are #899. With the reconciliation quiet the
catch-up reaches up to 192 accounts a minute (16 a tick, 12 ticks; 384 GETs at two pages each). Neither loop has a floor of
its own: both draw on one window. A 429 ends a tick and the attempt is
retried on the lease or the next tick. A 429 on `/user-auth/refresh` during an exchange on the
backend is the refusal `refresh_rate_limited`: nothing is revoked, the caller asks again later
(#275). The worker's share keeps its own traffic from driving
the IP to 429; the sum with the backend's ceilings raised above their defaults is a `warn` at the
backend's start, not enforced.

## Routing to the owner (#347)

With several worker processes ([worker-capacity.md](worker-capacity.md)) the account's broker
socket is held by its owner, the process rendezvous names over the live set. BullMQ hands a job of
the shared queue `trading-intents` to any consumer, so `intents/router.ts` moves it to the owner:

- **Two queues per process.** Every process consumes the shared `trading-intents` and its own
  `trading-intents-<ownerId>` (a hyphen: BullMQ refuses `:` in a queue name), both at
  `WORKER_CONCURRENCY`. The job payload stays `{ intentId }`.
- **One hop, before the take.** The shared consumer's processor, for a `queued` intent, after the
  `DEMO_ONLY` refusal and before `takeIntent`, asks the registry for the account's owner
  (`registry.ownerOf`, fenced like `owns`: no answer before the first heartbeat, past the fence or
  after `stop()`). Another live process → the job goes to that process's own queue (job id = the
  intent id, the publisher's options), the shared job completes with the outcome `forwarded`, and
  the line `intent forwarded` (`intentId`, `accountId`, `owner`) is logged. Nothing was sent, the
  intent is untouched (Rule 15). The own queue's consumer has no forward: an intent hops once at
  most. A `submitting` or terminal intent never hops. The owner processes the job with the
  unchanged processor; its socket opens the trade when its session is ready, REST otherwise.
- **The insurance.** With the forward, the forwarder adds the same job, delayed
  `INTENT_RECOVERY_DELAY_MS` (20 s), to its own queue. When the owner processed the intent, the
  insurance finds it no longer `queued`: `intent job is a no-op`. When the owner died with the job
  in its queue, the forwarder takes the intent itself (REST without a socket of its own) 20 s
  after the forward: below `INTENT_MAX_AGE_MS`'s default (60 s) and below the backend's lost-job
  sweep (30 s), which stays the second net. An operator who sets `INTENT_MAX_AGE_MS` below about
  25 s makes every recovered intent `expired`.
- **The dead owner's timeline.** Owner X crashes at D: its row stays live up to D + 30 s
  (`WORKER_PROCESS_TTL_MS`), so forwards to it go on until the forwarders' next heartbeat after
  that (about D + 36 s); each such intent is taken by its forwarder at its forward + 20 s, the last
  one by about D + 56 s, aged about 20 s at the take. An H1 session intent past its
  `submit_deadline_at` ends `entry_window_missed` then.
- **The backend's sweep.** A forwarded job completes in the shared queue at once, so for an intent
  still `queued` 30 s after publication `has()` finds no job and the publisher republishes it
  (`attempts + 1`, the warning `outbox job missing from the queue, re-pending`). With the insurance
  at 20 s this happens only when the forwarder died too; the republished job is forwarded again or
  processed, and every copy converges on the take's CAS. The relation
  `INTENT_RECOVERY_DELAY_MS < staleQueuedMs` crosses processes: stated, pinned by literal in
  `intents/config.test.ts`.
- **A clean stop.** After both intent consumers closed, `router.stop({ deregistered, notAfter })`
  drains the own queue: every `INTENT_ROUTER_DRAIN_POLL_MS` (250 ms) a move pass adds each job of
  the own queue to the shared queue under the job name `intent-direct` and the id
  `<intentId>-direct`, then removes it from the own queue. The `-direct` id does not collide with
  the forwarder's shared job of the same intent, which is still active while it forwards. A moved
  job keeps what is left of its delay, so an insurance stays an insurance. The drain goes on until
  `INTENT_ROUTER_DRAIN_TAIL_MS` (9 s) after the deregister settled: a peer names the stopping
  process until its next heartbeat after the deregister (≤ 6 s + 2 s), so every forward it makes
  meanwhile reaches the shared queue within a poll, not at its insurance. A final pass, then the
  own queue is deleted (`obliterate`). The drain is cut at `notAfter`, the phase-1 start plus
  `SHUTDOWN_PHASE1_BUDGET_MS` less `2 × INTENT_ROUTER_STOP_BUDGET_MS` (31 s), with the warning
  `intent router drain cut by the shutdown budget`; that happens only for `SUBMIT_ACK_TIMEOUT_MS`
  above 16 s (after an entry's hold of up to 2 s, #836) with a submit that waits out nearly its deadline at the stop. The final pass and the
  close have `INTENT_ROUTER_STOP_BUDGET_MS` (2 s) after it; a timeout or a throw is logged, never
  fails the shutdown, and a failed final pass leaves the own queue in Redis rather than delete its
  jobs. A clean stop takes about 9 s longer than before #347. A job named `intent-direct` is
  processed where it lands, never forwarded: the survivors still see the stopping process in their
  view for up to a heartbeat and would hand it straight back.
- **The owner changed meanwhile.** The named owner processes the job anyway: without a ready
  socket of its own the order goes over REST. A view that says X at P and P at X: X processes. Two
  copies of one intent (a forward and a republish): one `takeIntent` wins, the other is `noop`.
- **A dirty stop or a crash** leaves the process's own queue in Redis with its unprocessed jobs
  (intent ids only); their forwarders' insurance takes them. The per-process queues are listed by
  `docker compose exec redis redis-cli --scan --pattern 'bull:trading-intents-*:meta'`; a queue
  whose id is not in `worker_processes` (`select owner_id from worker_processes`) is dead and may
  be deleted by hand.
- **One replica** forwards nothing: the live set is the process itself.

Tests: `router.redis.test.ts` R1–R11 (R8 the drain and its tail, R9 the cut at `notAfter`, R10
the remaining delay, R11 the `-direct` id beside the forwarder's job), `processor.db.test.ts`
P1–P4, `fleet/registry.test.ts` F7, `consumer.redis.test.ts` Q1, `worker.handoff.db.test.ts` H15
(two workers, every intent of the second one's accounts over its socket), H16 (a dead owner: the
insurance takes the intent over REST, one trade; an `intent-direct` job is not forwarded), H17 (the
requeue at a clean stop), H18 (forwards to a stopping process before and after its deregister are
taken within 3 s, not at the insurance, and its own queue is gone).

## Delivery, ACK and timeout semantics

| Stage                                                                                                                                             | Retry policy                                                                                                                                                              | Timeout                                                                                                                                                   | On failure                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Publisher `queue.add`, topic `trading-intents`                                                                                                    | outbox `attempts` with backoff 1 s, 2 s, 4 s, 8 s (cap 16 s), max 5                                                                                                       | 5 s per add (`Promise.race`; a late success is harmless, the job id dedupes)                                                                              | 5th failure: outbox `failed` **and**, in the same transaction, a still-`queued` intent → `rejected` (`publish_failed`) with token release                                                                                                                                |
| Publisher `queue.add`, topic `trading-reconciliation`                                                                                             | same backoff, **no cap** — the row stays `pending` for as long as it takes; `attempts` keeps counting and every attempt from the 5th on logs a warning                    | 5 s per add                                                                                                                                               | never `failed`: giving up would strand an `unknown` intent with its reserve and no reconciliation                                                                                                                                                                        |
| Lost job (published row, job absent after 30 s while the intent is still `queued` for `trading-intents` / `unknown` for `trading-reconciliation`) | counted as a failed delivery under the topic's policy                                                                                                                     | sweep every 15 s                                                                                                                                          | row back to `pending`, republished                                                                                                                                                                                                                                       |
| Forward to the owner (#347)                                                                                                                       | none: an `add` that fails processes the intent here (`intent forward failed, processing here`)                                                                           | —                                                                                                                                                         | a copy that landed in the owner's queue races the local take on the CAS; nothing is sent before the take                                                                                                                                                                |
| Recovery (the forwarder's own queue, #347)                                                                                                        | one insurance job per forward                                                                                                                                             | `INTENT_RECOVERY_DELAY_MS` 20 s after the forward                                                                                                         | still `queued` → taken by the forwarder; anything else → `noop`                                                                                                                                                                                                          |
| BullMQ job                                                                                                                                        | `attempts: 1` — the trade command is never retried by the queue                                                                                                           | `lockDuration` 60 s, `stalledInterval` 30 s, `maxStalledCount` 1                                                                                          | a job that throws is dead-lettered; a stalled job is redelivered once                                                                                                                                                                                                    |
| Worker shutdown                                                                                                                                   | —                                                                                                                                                                         | phase 1 budget 35 s (`SHUTDOWN_PHASE1_BUDGET_MS`) > the entry's hold 2 s + the longest ack timeout 28 s, phase 2 4 s; compose `stop_grace_period` 40 s                               | a job in flight finishes and its dead-letter write is awaited before any connection closes; an overrun exits 1 and the sweeper resolves the intent after the restart                                                                                                     |
| Backend shutdown                                                                                                                                  | —                                                                                                                                                                         | phase 1 budget 10 s (`SHUTDOWN_PHASE1_BUDGET_MS`, `apps/backend/src/timing.ts`) > publish/has deadline 5 s, phase 2 4 s; compose `stop_grace_period` 20 s | `publisher.stop()` finishes the row in flight and leaves the rest of the batch `pending`; an overrun (a database timing out every statement, a request that hangs) exits 1 with the transaction rolled back and the outbox row replayed                                  |
| The entry's hold (#836) | — | until `submit_not_before_at` on the worker's clock, at most `INTENT_HOLD_MAX_MS` (2 s); NULL never | an H1 session's intent waits its second + `entryDelaySec` after the forward to the owner and before `takeIntent`, which judges the age, the deadline and the switch after it; nothing is sent before the take ([h1.md → The entry](h1.md#the-entry-836)) |
| `takeIntent`                                                                                                                                      | —                                                                                                                                                                         | `INTENT_MAX_AGE_MS` (60 s) in the CAS predicate, database clock, after the entry's hold                                                                                           | before it, a real intent on a `DEMO_ONLY` worker → `rejected` (`demo_only`, #396), even when too old; too old → `rejected` (`expired`); past its `submit_deadline_at` on the database clock (`submit_deadline_at <= now()`, #670; NULL never) → `rejected` (`entry_window_missed`), after the age so an old intent keeps `expired`; trading switch closed → `rejected` (`trading_paused`); executor never called                                                                                                                                                                                                                  |
| `executor.submit`                                                                                                                                 | none                                                                                                                                                                      | `SUBMIT_ACK_TIMEOUT_MS` (10 s), enforced by the processor with `Promise.race`; the executor also receives an `AbortSignal`; the socket wait and the REST call carry their own 5 s timers below the deadline                                | The trade command executor (the trading switch is checked before, in `takeIntent`): socket when the account's session is ready, REST only when nothing was emitted; an order sent with no answer → `unknown` (`broker_unavailable`), a refusal → `rejected` (`broker_rejected`) ([trade-executor.md](trade-executor.md) → Outcomes). Timeout → `unknown` (`executor_timeout`); throw → `unknown` (`executor_error`) |
| Outcome write                                                                                                                                     | none                                                                                                                                                                      | —                                                                                                                                                         | `accepted` writes the open `broker_trades` row in the same transaction; a trade that does not match the intent → `unknown` (`trade_mismatch`) + reconciliation row. A database failure here fails the job (dead letter); the intent stays `submitting` until the sweeper; a payout/potential profit outside the column is stored NULL, prices any finite value (#675) |
| Stale `submitting` (redelivery or sweeper, every 15 s)                                                                                            | —                                                                                                                                                                         | `STALE_SUBMITTING_MS` 60 s ≥ `lockDuration` > max ack timeout                                                                                             | → `unknown` (`stale_submitting`) + reconciliation row                                                                                                                                                                                                                    |
| Reconciliation job, topic `trading-reconciliation`                                                                                                | `attempts: 1`, as above                                                                                                                                                   | the BullMQ job options above                                                                                                                              | `unknown → reconciling`; after the commit the consumer's wrapper wakes the pass, which claims it at once or right after the running tick (#872); the job never asks the broker. A throw dead-letters with `topic`, and the outbox re-pends the row after 30 s while the intent is still `unknown`                                                                              |
| Reconciliation attempt (the pass, every 15 s and on every reconciliation job's `wake()`, at most 16 candidates, one after another, each behind a reservation of 4 GETs, #872) | after the lease: the claim (`reconcile_claimed_at = now()`, `version + 1`) is the first write and keeps the intent from being a candidate for `RECONCILE_RETRY_MS` (60 s) | `RECONCILE_ATTEMPT_TIMEOUT_MS` (30 s) per `reconcile()` call (the token plus up to four GETs), enforced by the pass with `Promise.race`; the reconciler also receives an `AbortSignal`     | `unavailable`, a deadline or a throw write nothing beyond the claim; `rate_limited` ends the tick. Every outcome is a CAS on `status = reconciling` and the claim's `version`, so an attempt whose lease was re-claimed cannot write                                     |
| Settlement catch-up (every 5 s, at most 16 overdue accounts, one after another, each behind a reservation of 2 GETs, #872)                         | an attempt that does not take its intent out of `accepted` holds the account back for `CATCHUP_STALLED_RETRY_MS` (30 s), in memory                                      | `CATCHUP_ATTEMPT_TIMEOUT_MS` (20 s): the token (`mayRefresh: false`) and up to two closed pages                                                          | `rate_limited` ends the tick and holds nobody; a throw is logged with `errorLogFields` and holds the account. `settleClosedTrades` is idempotent, so a repeat is safe                                     |

Invariants these numbers encode (asserted at import in `apps/trading-worker/src/intents/config.ts`
and `apps/backend/src/timing.ts`, and held against `compose.yaml` by tests): worker
`5 s (socket command, REST) < 6 s ≤ SUBMIT_ACK_TIMEOUT_MS ≤ 28 s < phase 1 35 s`, `hold 2 s + ack cap 28 s < phase 1 35 s` (#836: the entry's hold runs in the same job), `35 s + phase 2 4 s < stop_grace_period 40 s <
lockDuration 60 s ≤ STALE_SUBMITTING_MS 60 s`; backend `publish deadline 5 s < phase 1 10 s`,
`10 s + 4 s < stop_grace_period 20 s`; reconciliation `BROKER_REST_TIMEOUT_MS 5 s < attempt 30 s <
lease 60 s`, `attempt 30 s < phase 1 35 s` (phase 1 also waits for `pass.stop()`: the attempt in
flight plus one outcome write), `tick 15 s ≤ lease 60 s`; #90 adds `token route 7 s + 4 × 5 s <
attempt 30 s`, `ack cap 28 s < window after 90 s`, `token 7 s + 2 × 5 s < catch-up attempt 20 s <
phase 1 35 s` (`catchup.stop()` runs alongside `pass.stop()`), `catch-up tick 5 s < hold 30 s`, `BROKER_REST_TIMEOUT_MS 5 s < catch-up grace 10 s`,
and on the backend `exchange 5 s < token route 7 s < phase 1 10 s`; #347 adds `hold 2 s + ack cap 28 s +
2 × router stop 2 s < phase 1 35 s` and states `recovery 20 s < the backend's stale-queued 30 s`. No live worker can still be inside its ack deadline when a
redelivery or the sweeper calls its intent unknown; a routine deploy never kills a submit or a
publish mid-flight; and the broker command is never sent twice — a redelivered job only checks
state. The budgets cover the bounded operations plus ordinary database latency, not a database
that times out every statement: that is the exit(1) path, and it loses nothing.

The sweeper can win a race against a slow executor: the late `accepted` is then dropped (the CAS
sees `unknown`, not `submitting`) and reconciliation recovers the real result.

## Dead-letter queue

`trading-intents-dead-letter` receives one entry per failed job of either topic: `{ source:
'intent_job', intentId | null, topic, reason, failedAt }` (a job of a process's own queue, #347,
carries `topic: 'trading-intents'`) with `reason` from the allowlist
(`invalid_job` for a malformed payload or a missing intent, `processing_failed` otherwise). A
broker session write that throws (#92, [broker-session.md](broker-session.md)) leaves
`{ source: 'user_data' | 'update_balance' | 'close_trade_success', accountId, mode, brokerTradeIds,
reason: 'processing_failed', failedAt }`: the event's mode and trade ids, never its amounts or
user object. Its job id is `session.<accountId>.<source>.<UTC hour>`: BullMQ adds nothing while
an entry with the id exists and nothing consumes the queue, so a writer failing on every event
leaves at most three entries per account an hour (the trade ids are the hour's first event's);
the log line marks every failure. The session manager awaits the write inside the account's
write queue, so `stop()` waits for it too, but never longer than `DEAD_LETTER_WRITE_TIMEOUT_MS`
(1 s, below `SESSION_STOP_BUDGET_MS`): the worker's Redis connection holds a command while
Redis is down instead of failing it, and the queue then goes on after an `error`
`dlq_publish_failed` with `reason: 'timeout'` (the entry lands once Redis is back, unless the
worker shuts down first: `redis.quit()` drops the queued command; a later failure of the same
write is not logged again). The log line `broker session write failed` carries the event's trade
ids, so the ids of the hour's later failures are not lost with their dead letters. The writes
`stop()` drops are not failures and leave nothing. No exception text is stored — it can carry connection
details — the log line next to it has the error. A failure to write the entry is logged as
`dlq_publish_failed`; the worker keeps running. Writes started by jobs that fail during a
shutdown drain are awaited before the queue connection closes. Nothing consumes the queue
automatically; inspect it with the BullMQ tooling of your choice. A `trading-reconciliation`
entry is a record, not a loss: the outbox re-publishes the row while the intent is `unknown`.

Redis keeps the queue across restarts (#92): `compose.yaml` runs it with `--appendonly yes` on the
named volume `redisdata`. AOF fsyncs every second, so a host crash can lose about a second of
queue writes. **Deploy note:** the first start on `redisdata` replaces the image's anonymous
`/data` volume, so Redis starts empty once — the dead-letter entries written before are gone,
and a BullMQ job not yet taken is re-published by the backend's stale-published re-publish
(`listStalePublished`).

## Persisted reasons and secrets

`trade_intents.last_error`, `outbox_events.last_error` and dead-letter entries only ever hold
`TradeIntentFailureReason` codes — a database CHECK on both columns refuses anything else. The
executor may return a free-text `detail`; it is truncated to 200 characters and logged, never
stored. An executor that throws is logged by the error's name and code only: a client library's
message can embed a header or a response body, and key-based redaction cannot scrub a string.
`trade_mismatch` (the accepted trade does not match the intent) and `manual_rejected` (the
operator's rejection from `manual_review`) are two of those codes (#17);
`reconciliation_not_found` (a parked intent, or a demo release on a proven absence, #274) and `reconciliation_ambiguous` are the reconciler's two (#89);
`broker_unavailable` is the trade command executor's "sent, no answer says whether it opened"
(#100), `demo_only` the worker's rejection of a queued real intent under `DEMO_ONLY` before the
take (#396; `outbox_events.last_error` never receives it, the CHECK carries it because one enum
drives both columns), `entry_window_missed` the worker's rejection of an H1 session's intent past
its `submit_deadline_at` at the take (#670; likewise never in `outbox_events.last_error`), and `executor_not_configured` stays in the list for rows written before it. Queue
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
`apps/backend/src/outbox/publisher.ts` (`DEFAULT_PUBLISHER_CONFIG`). Optional: `DEMO_ONLY`
(default `false`; `true` or `false`, anything else or empty stops the backend at start, #396), and
`BROKER_WS_URL` (the same rules as the worker's below; unset → no market data source, #404,
[market-data.md](market-data.md)).

Worker, required (#90): `BACKEND_URL` (compose: `http://backend:3000`), `INTERNAL_API_TOKEN` (the
backend's value), `BROKER_API_BASE_URL` (https, the backend's value through compose's
`x-broker-environment`).

Worker (optional, code defaults in `apps/trading-worker/src/env.ts`):

| Variable                | Default | Bounds                                                                                     |
| ----------------------- | ------- | ------------------------------------------------------------------------------------------ |
| `INTENT_MAX_AGE_MS`     | 60000   | 1000–600000; below about 25000 an intent recovered after a dead owner (20 s, #347) ends `expired` |
| `SUBMIT_ACK_TIMEOUT_MS` | 10000   | 6000–28000 (`MIN_SUBMIT_ACK_TIMEOUT_MS`: above the socket command's and the REST call's own timeouts, 5 s, #96; `MAX_SUBMIT_ACK_TIMEOUT_MS`: below the shutdown budget and the stale threshold) |
| `WORKER_CONCURRENCY`    | 5       | 1–100                                                                                      |
| `BROKER_WS_URL`         | none    | `https://` or `wss://`; unset → no broker sessions, every order over REST; empty → the worker does not start (#101, [broker-session.md](broker-session.md)) |
| `DEMO_ONLY`             | `false` | `true` or `false`; anything else or empty → the worker does not start (#396) |

Fixed constants and why they relate the way they do: `apps/trading-worker/src/intents/config.ts`
— among them the reconciliation pass's `RECONCILE_ATTEMPT_TIMEOUT_MS` (30 s),
`RECONCILE_RETRY_MS` (60 s, the lease), `RECONCILE_TICK_MS` (15 s), `RECONCILE_BATCH_SIZE`
(16) and the balance check's `BALANCE_CHECK_TIMEOUT_MS` (20 s), the GET reservations
`RECONCILE_GETS_PER_ATTEMPT` (4), `BALANCE_CHECK_GETS` (1) and `CATCHUP_GETS_PER_ATTEMPT` (2) and
the catch-up's `CATCHUP_BATCH_SIZE` (16, #872), the router's
`INTENT_RECOVERY_DELAY_MS` (20 s), `INTENT_ROUTER_STOP_BUDGET_MS` (2 s),
`INTENT_ROUTER_DRAIN_POLL_MS` (250 ms) and `INTENT_ROUTER_DRAIN_TAIL_MS` (9 s, #347), the matching window and pages (`RECONCILE_WINDOW_*`, `RECONCILE_TRADES_PAGE_SIZE`,
`RECONCILE_MAX_TRADE_PAGES`) and the catch-up's `CATCHUP_*`; none has an environment variable.

`REAL_TRADING_ENABLED` (#134) is gone: the one switch for demo and real is the `trading_switch`
row, toggled by the `kill-switch` CLI without a restart. `DEMO_ONLY` (#396) is the one environment
setting about trading: a property of a process (backend and worker, the same `false` default and
spellings) that refuses real intents and sessions in it, read at start
([kill-switch.md](kill-switch.md) → DEMO_ONLY).

## Boundaries

- **#100** implements `TradeExecutor` (`apps/trading-worker/src/intents/executor.ts`) with
  `createTradeCommandExecutor`, passed to the processor directly
  ([trade-executor.md](trade-executor.md)).
- **#89** (this pipeline's reconciliation half): the `trading-reconciliation` consumer, the
  pass, the `IntentReconciler` port (`apps/trading-worker/src/intents/reconciler.ts`) and the
  outcome writes. The port only reads: it never opens a trade.
- **#90** (shipped): the REST reconciler, the halt and alert on `manual_review`, the settlement
  catch-up and the backend's token route — Reconciliation matching above; it never releases a
  reserve on absence. **#274** (shipped): `not_found` and the release on an absence proven twice in demo (Proof of absence above). **#91**: no second open
  after `unknown` (the executor side is proven in #100, [trade-executor.md](trade-executor.md) →
  The two-cases rule). **#92** (shipped): the broker balance check after a reconciliation
  outcome and the session writers' dead letters (above).
- **#101** (shipped): the session manager feeds `close_trade.success` into `settleClosedTrades` and
  takes `noTradeSessions`' place when `BROKER_WS_URL` is set ([broker-session.md](broker-session.md)).
  The operator tool for `manual_review` is a later issue.
- **#347** (shipped): intent jobs routed to the account's owner (Routing to the owner above);
  **#815** partitions the loops and the GET budget across processes.
- **#872** (shipped): the worker's GET budget at runtime and the wake of the pass by the
  reconciliation job (Budget and the wake above); parallel reconciliation attempts are **#899**.
  **#909** (shipped): the window carried over a restart (Budget and the wake above).
- Real-mode eligibility: **#144** replaced #134's env flag with the global trading switch, one
  for demo and real ([kill-switch.md](kill-switch.md)); **#135** what a revoked grant does to
  running sessions; **#121** real mode from the bot: a real intent only for a user in real mode,
  409 `real_mode_off` from the reserve UPDATE ([trading-mode.md](trading-mode.md)). Country
  restrictions are deferred: there is no data source (`GET /v1/broker/user` has no country, the
  Partner API reports `country` as `unknown`, #14). There are no per-account real-mode flags;
  the account predicates `status = active` and `trading_halted = false` apply as before. #15 is
  split into #136 (the token balance, [trading-access.md](trading-access.md)), #137 (the broker
  balance snapshot, [broker-balance.md](broker-balance.md)) and #138 (the pair catalog).
- **#127 / #29**: the bot tracks by `intent.id` ([bot-demo-trade.md](bot-demo-trade.md)).
  `GET /trading/intents/:id` is the status source, scoped by the owner since #127 because the id
  travels in a button's callback data ([GET /trading/intents/:id](#get-tradingintentsid-127));
  a notification dedupe key (#29) should be derived from the intent id and status.
- `trading_session_id` is set only by `createSessionIntent` (#130, [trading-session.md](trading-session.md));
  the route's and the bot's single trades keep `NULL`, as they keep `submit_deadline_at` and
  `submit_not_before_at` (#670, #836). Its caller is the backend's H1 driver
  (`apps/backend/src/h1/driver.ts`, #707); the worker's orchestrator called it until #835.
  A session is started, read and stopped through `POST /trading/sessions`,
  `GET /trading/sessions/:id` and `POST /trading/sessions/:id/stop` (#283), all of a user's
  stopped at once through `POST /trading/sessions/stop` (#122), and its summary card claimed
  through `POST /trading/sessions/:id/summary` (#318,
  [trading-session.md → Routes](trading-session.md#routes)), behind the same internal bearer.

## Running it locally

```bash
# `up` runs the migrate service first; backend and trading-worker start after it
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
# submit timeout, or rejected / broker_rejected when the token source or the broker refused;
# 409 trading_paused when trading is closed (a fresh database starts open; docs/kill-switch.md:
# docker compose exec backend pnpm --filter @binarius/backend kill-switch status)
```
