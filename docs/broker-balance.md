# Broker balance snapshot

The backend keeps the last balance the broker reported for each broker account, and how old it
is. `POST /trading/access` shows it to the bot ([trading-access.md](trading-access.md) → Broker
balance). Issue #137, with its table and operations from #235.

Today the REST call is the only source: `GET /v1/broker/user`, through the REST client
([broker-rest.md](broker-rest.md)). It runs when the bot asks about an account and on a
background tick over the accounts in work. The socket events (`user.data`,
`user.<mode>.update_balance`) are a second source once #99/#101 exist; the contract for them is
below.

## Components

| Part | File | What it holds |
| --- | --- | --- |
| Table | `packages/db/src/schema/broker-balance-snapshots.ts`, migration 0011 | one row per broker account; `BalanceRefreshError` |
| Operations | `packages/db/src/balance-snapshot-ops.ts` | the only writers and readers of the table, `toBrokerBalanceView` |
| Contract | `packages/shared/src/broker-balance.ts` | `BROKER_BALANCE_SLA_SEC`, `TRADING_ACCESS_BUDGET_MS`, `BrokerBalanceUnavailableReason`, `brokerBalanceViewSchema` |
| Reconciler | `apps/backend/src/broker/balance-reconciler.ts` | `refresh()`, `tick()`, `start()`, `stop()` |
| Route | `apps/backend/src/trading/access.ts` | the `broker` section of `POST /trading/access` |
| Constants | `apps/backend/src/timing.ts` | the interval, the per-minute ceiling, the windows, the route budget, and the chain between them |

## The row

`broker_balance_snapshots`, primary key `broker_account_id` (FK
`broker_balance_snapshots_account_fk` to `broker_accounts`, ON DELETE RESTRICT):

| Columns | Meaning |
| --- | --- |
| `real_available`, `real_held`, `real_total`, `demo_*`, `min_trade_amount` | `numeric(20,8)`, `>= 0`, as the broker sent them. `total = available + held` is not checked: that is a rule of the mock's fixtures, not something observed live |
| `level_code`, `level_rank` | the broker's level; `level_rank` is `numeric(8,4)`, `>= 0` |
| `rest_observed_at` | database time of the last REST write |
| `real_event_at`, `demo_event_at` | database time of the last socket event per mode; NULL until #99/#101 write one |
| `last_requested_at` | database time the bot last asked about this account |
| `last_refresh_error`, `last_refresh_failed_at` | the last failure's code (`BalanceRefreshError`) and time, set together; a successful write clears both |

The row is never locked inside a transaction that holds `users`, `broker_accounts` or
`trade_intents`. Every operation takes `Db`, not a transaction, and runs one autocommit
statement. It outlives a revocation, as the account's last known state.

## Stored domain

`moneyWireSchema` has three branches: a decimal string of any length with an optional sign, a safe
JSON integer (up to 16 digits, `9007199254740991`), and a JSON fraction whose `String()` is a plain
decimal of at most 15 significant digits (#236). Each takes a sign, because `broker_trades` shares
the schema and a profit is signed. The columns here would round a ninth fraction digit silently, fail on a thirteenth integer
digit and refuse a sign. So `upsertBalanceSnapshot` checks every value first
(`balanceSnapshotOutOfDomain`) and runs no statement for one outside the domain. It returns
`{ written: false, field }` with the value's path (`'real.available'`, `'level.rank'`, …):

| Value | Accepted |
| --- | --- |
| each amount | unsigned, at most 12 integer and 8 fraction digits (`MONEY_INTEGER_DIGITS`, `MONEY_SCALE` in `columns.ts`, the same constants that size the columns) |
| `level.rank` | its decimal form: at most 4 integer and 4 fraction digits, no sign, no exponent. A range check on the number would let `9999.99995` round up to an overflow and `1e-7` round down to 0 |
| `level.code` | 1 to 64 code points (`LEVEL_CODE_MAX_LENGTH`), no control characters. The column has no CHECK: this check in the one writer is the only bound |

The reconciler records such an answer as `contract_violation`. Its log line names the field and
never the value.

## Ages and `fresh`

The ages are computed when the row is read, from the database clock, in whole seconds. A
timestamp in the future (a clock step) reads as 0, and a NULL time stays NULL:

- `restSnapshotAgeSec`: since `rest_observed_at`.
- `balanceEventAgeSec`: since the newer of `real_event_at` and `demo_event_at`; NULL until either
  is set.
- `fresh`: `min(restSnapshotAgeSec, balanceEventAgeSec ?? ∞) <= BROKER_BALANCE_SLA_SEC` (60).

`toBrokerBalanceView` builds the wire view key by key. Neither `last_refresh_error` nor the
account id reaches the bot.

## Refresh

`refresh(accountId, { signal?, requested?, mayRefresh? })`, one flight per account. A second
caller joins the flight in progress and gets its outcome, and its `requested: true` still reaches
the write. The starter's signal ends the GET for every caller joined to that flight. When the
route's 3 s `TRADING_ACCESS_REFRESH_BUDGET_MS` runs out, a joined tick gets `aborted` (not held
back, see the tick), and a joined second bot request falls back to the stored snapshot or
`broker_unavailable`. A joiner's own signal ends only its own wait, and an already aborted
signal starts no flight. The steps:

1. The access token: `ensureFreshAccessToken(…, { mayRefresh })`
   ([binodex-oauth.md](binodex-oauth.md) → Refresh). It reads the user's status in the statement
   that locks the account, and a blocked user gets no token.
2. The account's `broker_user_id`; a missing account spends no call.
3. `GET /v1/broker/user`, with the caller's signal and `stop()`'s.
4. The owner check: the answer's `id` must be the account's `broker_user_id`.
5. `upsertBalanceSnapshot`, and its domain check.

| Source | Outcome, `last_refresh_error` | Logged |
| --- | --- | --- |
| a snapshot written | `ok`, cleared | — |
| token `account_pending` / `account_revoked` / `key_unavailable` | the same code | token-service logs `key_unavailable` |
| token `refresh_needed` (the tick, `mayRefresh: false`) | `refresh_needed`, nothing written | — |
| token `user_blocked` | `user_blocked`, nothing written | — |
| token `account_not_found` | nothing written | — |
| `BrokerRestError` `unauthorized` / `rate_limited` / `rejected` / `unavailable` / `contract_violation` | the same code | `warn` `balance refresh failed`, with `status`, `retryAfterSec`, `detail` |
| `BrokerRestError` `aborted` (`stop()`, the route's budget) | `aborted`, nothing written | — |
| the answer is another broker user's | `account_mismatch`, snapshot not written | `warn` with `expected` and `received` |
| a value outside the stored domain | `contract_violation`, snapshot not written | `warn` with `field` |

A failure code is written only where a snapshot row already exists: `recordBalanceRefreshFailure`
creates no row. Any other throw (a database error, a bug) is not turned into a code. On the
route it reaches the opaque 500. In the tick it is logged as
`error({ accountId, ...errorLogFields(error) }, 'balance refresh threw')` and the tick goes on.
Only the error's name and code are logged: a drizzle error carries the whole statement and the
row's values.

401 with a token we believed valid is recorded as `unauthorized` and retried. A forced refresh or
a revocation on it is #101's.

## The background tick

Every `BALANCE_RECONCILE_INTERVAL_MS` (env, 10 000 to 60 000, default 60 000):

1. **Accounts in work** (`listBalanceRefreshCandidates`): an active account of an active user,
   with a non-terminal intent or one the bot asked about within `BALANCE_WATCH_WINDOW_MS`
   (10 min), whose access token outlives `now() + ACCESS_SKEW_MS` by the database clock. This
   filter is an optimisation: the user's status is read again under the account lock when the
   token is taken (`user_blocked`: nothing written, counted `skipped`, held back).
2. **Order.** Never-observed accounts come first. After them, the account that has gone longest
   since its last attempt (`greatest(rest_observed_at, last_refresh_failed_at)`), so a recorded
   failure moves an account to the back of the queue.
3. **Held back.** An attempt of the tick that left nothing in the row puts the account in the
   reconciler's in-memory `stalled` map for `BALANCE_STALLED_RETRY_MS` (5 min), and the next
   ticks pass it as `exclude`. That happens when there is no snapshot to mark the failure on,
   when the outcome was `refresh_needed`, `user_blocked` or `account_not_found`, and when the
   attempt threw. A successful refresh, from the tick or from the route, removes the account from
   the map. A restart forgets the map, and each such account is tried once more. `aborted` is not
   held back: in the tick it comes from `stop()`, or from joining a route's flight cut by its
   budget. The next tick's own GET is bounded by `BROKER_REST_TIMEOUT_MS`, and its failure is
   recorded.
4. **Limit.** `max(1, floor(BALANCE_POLL_MAX_PER_MINUTE × interval / 60 000))` accounts per tick
   (env, 1 to 500, default 200), four at a time. A `rate_limited` answer stops new calls for the
   rest of the tick. A tick still running when the next interval fires makes that one a no-op.
5. **Never a token exchange.** Each call passes `mayRefresh: false`. `ensureFreshAccessToken`
   decides under the row lock, with the same clock and comparison as the exchange. A token that
   would need one comes back as `refresh_needed`, with nothing exchanged or revoked, the 90-day
   rule included. A refresh failure revokes the account (Rule 12), and a timer must not do that
   to an account nobody is using.
6. **Summary**, one `info` line per tick:
   `{ candidates, refreshed, failed, skipped, watched, withoutSnapshot, oldestAgeSec, msg: 'balance tick' }`.
   `watched` covers every account in work whatever its token, so an account with an expired token
   shows up here and only here. A `warn` (`watched broker balances are stale`) follows when
   `oldestAgeSec > 2 × BROKER_BALANCE_SLA_SEC`.

During a key rollout, `key_unavailable` makes token-service write one `warn` per affected account
per tick, at most the tick limit.

## Constants and chain

`TIMING_CHAIN_HOLDS` in `apps/backend/src/timing.ts` throws at import if one of these breaks, and
`timing.test.ts` restates them:

- `BROKER_REST_TIMEOUT_MS` (5 000) `< MIN_BALANCE_RECONCILE_INTERVAL_MS` (10 000): a GET ends
  before the next tick.
- `MAX_BALANCE_RECONCILE_INTERVAL_MS` `<= BROKER_BALANCE_SLA_MS` (60 000): the interval cannot
  outgrow the SLA by configuration.
- `MAX_BALANCE_POLL_PER_MINUTE` (500) `< BROKER_RATE_LIMIT_PER_MINUTE` (600). This budgets the
  tick only. GETs triggered by the route (`POST /trading/access` with a stale snapshot, at most
  one in flight per account) come on top and are not capped. Until the probe in Observed live
  shows whether authorized calls share the per-IP window, the headroom of 100 a minute is shared
  by OAuth, token exchanges, the pairs catalog and these route GETs.
- `MAX_BALANCE_RECONCILE_INTERVAL_MS < BALANCE_STALLED_RETRY_MS < BALANCE_WATCH_WINDOW_MS`: a
  held-back account skips at least one tick and is retried inside its watch window.
- `MAX_BALANCE_RECONCILE_INTERVAL_MS < BALANCE_WATCH_WINDOW_MS`: an account the bot asked about
  survives at least one tick.
- `TRADING_ACCESS_REFRESH_BUDGET_MS` (3 000) `< TRADING_ACCESS_BUDGET_MS` (4 000, shared)
  `< SHUTDOWN_PHASE1_BUDGET_MS` (10 000). The bot's link
  `TRADING_ACCESS_BUDGET_MS <= BACKEND_REQUEST_TIMEOUT_MS` is #24's.

Both env variables are forwarded by `compose.yaml` without a value, so the code's defaults apply
unless the host sets them.

## Start and shutdown

The reconciler is created after the app, because it logs through `app.log`. `start()` runs after
`listen()`, inside the second `if (!shuttingDown)` in `index.ts`, and a `start()` after `stop()`
does nothing. Phase 1 calls `stop()`, which aborts the GETs in flight and waits for the tick and
the flights to finish. A token exchange in progress (a route refresh) is not abortable, and is
covered by `BROKER_HTTP_TIMEOUT_MS < SHUTDOWN_PHASE1_BUDGET_MS`. A `refresh()` after `stop()`
answers `aborted` without a call.

## Contract for the socket writers (#99/#101, #100, #92)

The writers land in #101, on top of #99's socket client (docs/broker-socket.md → Client), which
delivers `user_data` and `balance_update` events and writes nothing itself.

- **`user.data`**: `upsertBalanceSnapshot(db, { brokerAccountId, user, requested: false, eventAt: [modes] })`.
  It writes the whole snapshot and moves `rest_observed_at` and each listed `<mode>_event_at` to
  `now()`.
- **`user.<mode>.update_balance`**: `applyBalanceEvent(db, { brokerAccountId, mode, balance })`,
  not implemented yet because nothing calls it. It moves the three amounts of that mode and
  `<mode>_event_at` on an existing row, and inserts nothing, because the event carries neither
  the other mode nor `min_trade_amount`. So a session takes a REST snapshot (`refresh()`) before
  it subscribes.
- Every writer checks the answer's user id against `broker_user_id` before writing, and goes
  through the domain check.
- A snapshot after a trade is accepted or settled (#100 after `accepted`, #92 after a reconciliation) calls `refresh(accountId)`.

## Observed live

- 2026-10-03, without a token: `x-ratelimit-limit: 600` per 60 s, and `x-ratelimit-remaining`
  dropped across requests from one IP (599 → 598 → 597, one `reset`).
- **Not verified:** whether authorized calls count against the same per-IP window or a per-token
  one. A 429 on `GET /v1/broker/user` under 500 calls a minute from one IP would mean the window is
  shared or smaller, and the ceiling should come down. The check, run on the pilot by the owner
  with one active account's id (the token is decrypted inside the container and never printed):

  ```bash
  docker compose exec -T -e ACCOUNT_ID=<broker_accounts.id> backend \
    pnpm --filter @binarius/backend rate-limit-probe
  ```

  `apps/backend/src/cli/rate-limit-probe.ts` makes two authorized `GET /v1/broker/user` calls and
  prints each one's status and `x-ratelimit-*` headers, nothing else. It takes the token through
  `ensureFreshAccessToken` with `mayRefresh: false`. So it refuses an account that is not active,
  of a blocked user, or whose access token needs an exchange, and it never exchanges one. The
  result goes here.

## Accepted risks

- The `stalled` map lives in memory. One backend container runs (`compose.yaml`). A second
  instance, or more than 1 000 accounts in work without a snapshot, would call for recording the
  failure in the database.
- An account whose failure is recorded is rotated through the queue, not held back. With more
  accounts in work than the tick limit, each one gets a GET every `N / limit` ticks.
- An account in work with an expired access token gets a snapshot only when its user acts; its
  age shows in the tick summary.
- `rest_observed_at` is the time of the write, milliseconds after the broker answered.
- The token is handed out inside a transaction, and the GET goes out after its COMMIT. A block
  committed in those milliseconds does not stop a request already sent. Nothing sets a block
  today. Future code that needs a hard guarantee revokes the user's accounts in the same
  transaction, in the order `users → broker_accounts`.

## Boundaries

- #99/#101: the socket writers and the 401 handling. #100: refresh after `accepted`; #92: after a reconciliation (the worker has no `refresh()`; it is the backend balance reconciler).
- #24: the bot's display, `BackendClient.readTradingAccess`, and the link
  `TRADING_ACCESS_BUDGET_MS <= BACKEND_REQUEST_TIMEOUT_MS`.
- The money unit is whole currency units (live 2026-10-03, [broker-rest.md](broker-rest.md) →
  Money). The snapshot stores the string as received and does no arithmetic.
- `/health` does not reflect the snapshots. There is no metrics stack: the tick's log line is the
  monitoring surface.
