# Broker sessions: the session manager (ARCH-01, #101)

The worker keeps one Socket.IO session with the broker for each broker account in work, sends
that account's orders over it (the trade command executor, [trade-executor.md](trade-executor.md))
and writes what the session hears: the balance ([broker-balance.md](broker-balance.md) → The
socket writers) and the closed trades (`settleClosedTrades`). It opens no trade of its own and
reconciles nothing. Off unless `BROKER_WS_URL` is set.

```bash
# the unit suite and the end-to-end scenario on the mock broker
pnpm vitest run apps/trading-worker/src/broker/session-manager.test.ts
TEST_DATABASE_URL=postgres://binarius@127.0.0.1:5434/binarius \
  pnpm vitest run apps/trading-worker/src/broker/session-manager.db.test.ts
```

## Components

| Part | Where | What |
|---|---|---|
| `createBrokerSessionManager(deps)` | `apps/trading-worker/src/broker/session-manager.ts` | the manager; implements `TradeSessionSource` (`sessionFor`), plus `start()`, `tick()`, `stop()`, `clientFor()`, `size` |
| Constants | `apps/trading-worker/src/broker/session-config.ts` | the table under [Constants](#constants) and `SESSION_CHAIN_HOLDS` |
| Candidates | `listSessionCandidates` in `packages/db/src/balance-snapshot-ops.ts` | the accounts in work, `{ id, brokerUserId }` |
| Writers | `upsertBalanceSnapshot`, `applyBalanceEvent` (same file), `settleClosedTrades` (`trade-intent-ops.ts`) | what a session hears, written once its connection proved whose it is |
| Client | `BrokerSocketClient` ([broker-socket.md](broker-socket.md)) | one per session; the taint after an aborted command |
| Token | `AccessTokenSource` (`broker/access-token.ts`) | `POST /trading/accounts/:id/access-token` on the backend, always `mayRefresh: false` |
| Composition | `apps/trading-worker/src/index.ts` | built only when `env.brokerWsUrl` is set; otherwise `noTradeSessions` |
| Probe | `apps/trading-worker/src/cli/socket-probe.ts`, `socket-probe-verdict.ts` | the two-socket check the rollout waits for; exit 0 only on its safe verdict ([broker-socket.md → Observed live](broker-socket.md#observed-live)) |

## The candidates

`listSessionCandidates(db, { watchWindowMs, exclude })` is the backend balance tick's "in work":
an active account of an active user with a non-terminal intent, or one the bot asked about within
`BALANCE_WATCH_WINDOW_MS` (10 min, `packages/shared/src/broker-balance.ts`, one value for both).
`POST /trading/access` sets `last_requested_at`, so opening the trade screen puts the account in
work before its first intent. Ordered by `broker_accounts.id`, with no limit: the manager has to
see every account in work to tell a running session's account from an idle one, and applies its
cap in memory. No token-expiry filter: the token is asked for with `mayRefresh: false` and an
account whose token needs an exchange is held back. `exclude` is the manager's held-back set.

## The lifecycle

The manager holds, per account, at most one of: an entry `starting` (its token fetch in flight),
an entry `running` (a started client), or a hold-back until a time. All of it is in memory: one
worker container runs (accepted risk 5).

**The tick** (`SESSION_TICK_MS`, single-flight, the first at `start()`):

1. Hold-backs whose time passed are forgotten.
2. One query: the candidates, without the held-back accounts. A throw (the database down) logs
   `broker session tick failed` and keeps every session.
3. An entry whose account is no longer a candidate: a `starting` one is dropped at once (its
   fetch finds it gone and starts nothing); a `running` one is closed once it has been missing for
   `SESSION_IDLE_GRACE_MS` (`broker session closed`, `reason: idle`). One that is back loses its
   idle mark.
4. The start queue is replaced: the candidates without an entry, in candidate order, cut to
   `MAX_SESSIONS_PER_WORKER − size` (`size` counts `starting` too). More candidates than the cap →
   one `broker sessions capped` per tick; the rest trade over REST.

The tick never waits for a start, so a revoked or blocked account's session closes within
`SESSION_TICK_MS + SESSION_IDLE_GRACE_MS` (65 s) whatever the backend's speed.

**The start pool**: `SESSION_START_CONCURRENCY` workers take accounts from the queue. For each:
the entry is `starting`, the token is fetched; on `ok` a client is created with
`logger.child({ accountId })`, its listeners attached, `start({ brokerUserId, accessToken })`
called, and the entry is `running`. A non-`ok` answer drops the entry with the hold-back of
[The token](#the-token). A throw out of the fetch or `start()` (a bug by contract) logs `broker
session start failed` and holds the account back `SESSION_RETRY_MS`.

**Client states** (`onState`):

| State | Manager |
|---|---|
| `connecting`, `reconnecting`, `authenticating` | the connection is new: it is unverified until its `user.data` ([The identity gate](#the-identity-gate)) |
| `ready`, `idle` | nothing |
| `token_expired`, `auth_failed` | one token fetch (single-flight per entry: a second terminal state during it is ignored). A token different from the session's → `start()` on the same client at once. The same token → `broker session token unchanged` (`accountId`, `sessionState`), dropped, held back `SESSION_RETRY_MS`. A non-`ok` answer → [The token](#the-token) |
| `disconnected_by_server` | `broker session closed` (`reason: disconnected_by_server`), dropped, held back `SESSION_RETRY_MS` |

"Dropped" means `client.stop()` and the entry deleted: the account is a plain candidate again
once its hold-back is over, and nothing terminal stays in the map.

`sessionFor(accountId)` is the client of a `running` entry, `undefined` otherwise (starting, held
back, unknown). The client itself answers `not_sent`/`not_ready` in any state but `ready` and on
a tainted connection, which the executor sends over REST.

## The token

Every fetch passes `mayRefresh: false` (Rule 12: a timer never exchanges a token; the exchange
happens on the user's trade over the REST fallback, where the executor passes the default
`true`), and the manager's stop signal.

| Answer | Manager |
|---|---|
| `ok` | start the client, or restart it with a new token after a terminal state |
| `refresh_needed` | drop, hold back `SESSION_RETRY_MS`; `info` `broker session waits for a token exchange` |
| `backend_unreachable`, `backend_status`, `contract_violation`, `not_configured` | drop, hold back `SESSION_RETRY_MS`; `warn` `broker session token unavailable` (`reason`, `status`). `not_configured` cannot happen: `index.ts` builds the manager only with the backend source |
| `backend_unreachable` while stopping | drop, nothing logged |
| `account_not_found`, `account_pending`, `account_revoked`, `user_blocked`, `key_unavailable` | drop, hold back `SESSION_REFUSAL_RETRY_MS`; `warn` `broker session token refused` (`refusal`) |

The `switch` over the answer is exhaustive: a new code in the source's union is a `tsc` error
here.

## The identity gate

`update_balance` and `close_trade.success` carry no user id, and a connection is `ready` on
`user.auth.success`, before `user.data`. So a connection is unverified until its `user.data`
arrives:

- `user.data` with the account's `broker_user_id` → verified; its snapshot is queued.
- `user.data` with another id → `error` `broker session user mismatch` (`accountId`, `expected`,
  `received`; broker user ids are not secrets), the client is stopped inside the handler — the
  client then delivers nothing more of that session — the entry dropped, the account held back
  `SESSION_REFUSAL_RETRY_MS`. Nothing of that connection is written.
- `update_balance` or `close_trade.success` before the connection's `user.data` → not written; one
  `warn` `broker session event before user.data` (`type`) per connection. The next `user.data` is
  a full snapshot, and the catch-up (#90) settles a close the session did not apply.

Every new connection (a reconnect included) starts unverified.

## The writers

Per account, one serial queue: the writes land in the order the events came, and a later session
of the same account queues behind what an earlier one left.

| Event | Write | Logs |
|---|---|---|
| `user.data` | `upsertBalanceSnapshot(db, { brokerAccountId, user, requested: false, eventAt: [demo, real] })` | `{ written: false }` → `warn` `balance snapshot not written` (`source: user_data`, `reason: out_of_domain`, `field`), once per connection |
| `user.<mode>.update_balance` | `applyBalanceEvent(db, { brokerAccountId, mode, balance })` | `no_snapshot` or `out_of_domain` → the same warn with `source: update_balance`, once per connection |
| `user.<mode>.close_trade.success` | `settleClosedTrades(db, { brokerAccountId, trades })` | `settled` → `info` `intent settled from close_trade.success` (`intentId`, `brokerTradeId`); `not_ours`, `already_settled`, `intent_not_accepted` → `debug` `closed trade not applied` (`brokerTradeId`, `result`) |

A writer's throw → `error` `broker session write failed` (`source`, `errorLogFields`); the queue
goes on with the next write. No REST GET at session start (`user.data` is the snapshot) and none
after `accepted` (the `update_balance` before `open_trade.success` is it). `price.update`,
`common.*` and the command answers are not the manager's: the answers are the executor's through
`openTrade`.

## The command and the taint

The executor sends a command over `sessionFor(accountId)`. A command that ends without its answer
while its connection is alive taints that connection: the client drops it and answers
`not_sent`/`not_ready` until the next `ready`, and a `success` answers only with the command's
asset, action and amount ([broker-socket.md → The trade command](broker-socket.md#the-trade-command-100)).
The manager does nothing for it: the reconnect is socket.io's, and the new connection passes the
identity gate like any other.

## Start and shutdown

`index.ts` builds the manager only when `BROKER_WS_URL` is set and passes it to the trade command
executor in place of `noTradeSessions`; `sessions?.start()` runs after the reconciliation pass and
the catch-up, and `trading-worker started` carries `sessions: true|false`.

Shutdown phase 1: the intents consumer's step is `worker.close()` → `drainDeadLetters()` →
`sessions.stop()`, so the sockets close after the jobs in flight finished and our own shutdown
never cuts a submit waiting on its socket. `stop()`: the timer cleared, the token fetches aborted
(the pool exits), every client stopped (a command still waiting settles `unknown`/`state_changed`,
and no event is delivered after it), the writes queued behind the one in flight dropped with one
`warn` `broker session writes dropped at stop` (`dropped`), then the write in flight per account
and the scan in flight awaited within `SESSION_STOP_BUDGET_MS`; past it `warn` `broker session
stop budget exceeded` (`pending`) and it returns (the statement finishes under phase 2's
`pool.end()`). Dropping is safe: a snapshot is replaced by the next `user.data` or the backend
tick, and a dropped close is settled by the catch-up within `CATCHUP_GRACE_MS` of the trade's
expected close.

## Constants

`apps/trading-worker/src/broker/session-config.ts`:

| Constant | Value | Bounds |
|---|---|---|
| `SESSION_TICK_MS` | 5 000 | the candidate scan interval (one query and the bookkeeping) |
| `SESSION_IDLE_GRACE_MS` | 60 000 | how long a session outlives its account's last appearance among the candidates |
| `SESSION_RETRY_MS` | 60 000 | the hold-back after a transient failure |
| `SESSION_REFUSAL_RETRY_MS` | 300 000 | the hold-back after a durable refusal or a `user.data` id mismatch |
| `SESSION_START_CONCURRENCY` | 4 | token fetches in flight in the start pool |
| `SESSION_STOP_BUDGET_MS` | 2 000 | how long `stop()` waits for the writes in flight |
| `MAX_SESSIONS_PER_WORKER` | 500 | sessions (running + starting) one process holds; a safety cap, not a measured limit (#94) |

`SESSION_CHAIN_HOLDS`, thrown at import and restated in `session-config.test.ts`:
`SESSION_TICK_MS < SESSION_IDLE_GRACE_MS` (an account missing from one scan is not closed),
`SESSION_TICK_MS < SESSION_RETRY_MS <= SESSION_REFUSAL_RETRY_MS` (a held-back account skips at
least one tick), `SESSION_IDLE_GRACE_MS < BALANCE_WATCH_WINDOW_MS` (an account the bot asked
about keeps its session for the whole window), every `*_MS` an integer in `[1, MAX_TIMER_MS]`.

The worker's chain (`intents/config.ts`, `TIMING_CHAIN_HOLDS`, restated in `config.test.ts`):
`MAX_SUBMIT_ACK_TIMEOUT_MS + SESSION_STOP_BUDGET_MS < SHUTDOWN_PHASE1_BUDGET_MS` (32 s < 35 s: the
drain's longest wait plus the manager's stop after it; the slack for the outcome write after a
full-length ack wait goes from 5 s to 3 s), `BROKER_SOCKET_CONNECT_TIMEOUT_MS <
SHUTDOWN_PHASE1_BUDGET_MS` and `ACCESS_TOKEN_ROUTE_BUDGET_MS < SHUTDOWN_PHASE1_BUDGET_MS` (the worst
case of a connect or a token fetch `stop()` could not cut), `SESSION_TICK_MS <
SHUTDOWN_PHASE1_BUDGET_MS`.

`BROKER_WS_URL` (worker env, optional, no default): `https://` or `wss://`, no IPv6 literal;
absent → no manager; empty → the worker does not start (Rule 14). `compose.yaml` forwards it
valueless through `x-broker-environment`, only when the host sets it (`config.test.ts`).

## Logs

The worker's pino (`logOptions`); each client logs through `logger.child({ accountId })`. No
token, no amount, no URL, no payload. The socket state is logged as `sessionState` (`state` is a
redacted key).

| `msg` | Level | Fields |
|---|---|---|
| `broker session tick` | debug | `candidates`, `sessions`, `starting`, `queued`, `closed`, `heldBack` |
| `broker session tick failed` | error | `err` |
| `broker sessions capped` | warn, once per tick | `candidates`, `cap` |
| `broker session closed` | info | `accountId`, `reason` (`idle`, `disconnected_by_server`) |
| `broker session start failed` | error | `accountId`, `err` |
| `broker session waits for a token exchange` | info | `accountId` |
| `broker session token unavailable` | warn | `accountId`, `reason`, `status` |
| `broker session token refused` | warn | `accountId`, `refusal` |
| `broker session token unchanged` | warn | `accountId`, `sessionState` |
| `broker session user mismatch` | error | `accountId`, `expected`, `received` |
| `broker session event before user.data` | warn, once per connection | `accountId`, `type` |
| `balance snapshot not written` | warn, once per connection and source | `accountId`, `source`, `reason`, `field` |
| `intent settled from close_trade.success` | info | `accountId`, `intentId`, `brokerTradeId` |
| `closed trade not applied` | debug | `accountId`, `brokerTradeId`, `result` |
| `broker session write failed` | error | `accountId`, `source`, `err` |
| `broker session writes dropped at stop` | warn | `dropped` |
| `broker session stop budget exceeded` | warn | `pending` |

`session-manager.test.ts` U14 reads every line its cases wrote through a `logOptions('debug')`
sink: no `SECRET-` sentinel, no amount the fixture spells, no broker host, and every `msg` above
but `broker session start failed` (a bug path) present.

## Tests

- `session-manager.test.ts` (unit, the mock broker in `bytes`; stubbed candidates, tokens and
  writers; the `openClient` seam for the token cycle and an `openSocket` wrapper that holds
  chosen events back): U1 one client per candidate; U2 the idle grace; U3/U3b the cap, a starting
  session counted; U4/U5 the token answers and their hold-backs; U6/U6b/U7 `token_expired` and
  `auth_failed` with the same and with a new token; U8 `disconnected_by_server`; U9/U9b/U9c the
  identity gate (a burst with a foreign `user.data`, a reconnect); U10 a throwing writer; U11
  `sessionFor`; U12/U12b `stop()` and its budget; U13 single-flight and a failing scan; U15 a tick
  returns while its starts are pending; U16 a candidate gone while starting; U14 the log scan.
- `session-manager.db.test.ts` (integration, `TEST_DATABASE_URL`): the end-to-end scenario on
  the mock broker with the production composition — `listSessionCandidates`, the production
  writers, `buildExecutor(parseEnv(…), createTradeCommandExecutor({ sessions: manager, … }))`,
  `processIntentJob`. E1 connect → auth (the snapshot from `user.data`), E2 subscribe → price, E3
  open success (accepted over the socket, `update_balance` moves the demo amounts), E4 close →
  balance (`close_trade.success` settles the intent), E5 open fail (below the minimum), E6 a late
  answer after the deadline (a new connection, the next intent answered by its own event), E8
  idle, E7 token expiry with the same token, E9 `stop()`. Every oracle is the persisted state,
  waited for on its exact condition.

## Running it locally

The manager needs a Socket.IO server that speaks the broker's protocol; locally that is
`packages/mock-broker` inside the tests above. `BROKER_WS_URL` refuses `http://` and `ws://`, so
the compose stack runs without sessions unless it points at the broker itself.

## Rollout

`BROKER_WS_URL` stays unset on the pilot until a run of the two-socket probe
([broker-socket.md → Observed live](broker-socket.md#observed-live)) prints
`verdict: answers go to the sender; BROKER_WS_URL may be set` and exits 0. A `broadcast` or an
`inconclusive` verdict (exit 1) keeps it unset; an account whose `min_trade_amount` is 0.01 or
less is always `inconclusive` (the below-minimum command cannot be sent), so the probe runs on an
account with a higher minimum. Then:

```bash
# BROKER_WS_URL=https://broker-ws.binodex.app in .env, then
docker compose up -d trading-worker
docker compose logs -f trading-worker | grep -E 'broker socket ready|broker session|trade command'
```

## Accepted risks

1. **Never exercised live** (#100 risk 1 stands). Falsifiable: with `BROKER_WS_URL` set,
   `broker socket ready` lines appear and the first demo intent is recorded with
   `transport: socket`; if every intent instead shows `trade command outcome unknown` with
   `transport: socket`, the fix is the shared schema or this manager, and `BROKER_WS_URL` is unset
   until then.
2. **A token the broker refuses before its stored expiry does not converge** (#281). The backend
   returns the stored token while it outlives `now() + 60 s`, before it reads `mayRefresh`; a REST
   401 exchanges nothing. After a live `token_expired`/`auth_failed` for such a token the manager
   holds the account back every `SESSION_RETRY_MS` with `broker session token unchanged`, and the
   user's REST trades are refused until the stored expiry (≤ 7 days) or a re-login. Falsifiable:
   that line repeating for one account for longer than `SESSION_RETRY_MS`.
3. **A late `success` with the command's own terms on an untainted connection** is accepted for
   the wrong intent only when the earlier trade was never linked. The only way to the same
   connection is an abort, which taints it; reconciliation links the earlier trade first in every
   path in `main`.
4. **A cross-socket answer**: if the live broker sends `open_trade.*` to every socket of the user,
   a `fail` for a manual broker-web order would reject our intent while our order may be open, and
   a `success` with equal terms would link the manual trade. Not closable without an answer field;
   the probe decides, and a positive result keeps `BROKER_WS_URL` unset.
5. **One worker container**: two would open two sessions per account. `compose.yaml` runs one;
   #93's lease is the fix.
6. **A revocation or a block reaches the session only through the candidates**, within 65 s; until
   then the session writes that account's balance events — rows of an account that cannot trade.
7. **Writes queued at `stop()` are dropped**; the snapshot is rewritten by the next `user.data` or
   the backend tick, a close is settled by the catch-up.
8. **`rest_observed_at` moves with every `user.data`**: `restSnapshotAgeSec` is the age of the last
   full snapshot, REST or socket.
9. **Accounts beyond the cap trade over REST**, in `broker_accounts.id` order; the pilot's load
   exceeds 500 (#94's sharding). Falsifiable: `broker sessions capped`. The scan has no limit,
   assuming fewer than ~10 000 accounts in work at once.
10. **Whether the WebSocket handshake counts against the broker's 600/min per-IP limit is
    unknown.** Falsifiable: `connect_error`s with a 429 during a reconnect storm.
11. **`mayRefresh: false` costs one REST-fallback trade per weekly token expiry** per account when
    the broker's refusal and the stored expiry coincide; when they do not, risk 2 applies.
12. **A slow backend delays the starts, not the tick**: 500 token fetches at the 7 s budget, 4 in
    flight, take ~15 minutes. Falsifiable: `broker session tick` lines with `queued > 0` across
    many ticks.

## Boundaries

- ARCH-02: #93 the lease, #94 the measured per-process limit and sharding, #95 handoff and
  single-flight refresh across processes, #96 the emergency stop.
- ARCH-05: #87 the load stand, #88 degradation.
- #92 (a balance check after a reconciliation, DLQ), #274 (`not_found`), #275 (429 on refresh),
  #130 (the demo session on `trading_sessions`), #278, #279, #281 (risk 2).
- `price.update` has no consumer in production: the signal feed reads the REST chart; E2 proves
  the subscription pipe only.
