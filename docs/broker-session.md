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
| `createBrokerSessionManager(deps)` | `apps/trading-worker/src/broker/session-manager.ts` | the manager; implements `TradeSessionSource` (`sessionFor`), plus `start()`, `tick()`, `renewLeases()`, `stop()`, `clientFor()`, `size` |
| Constants | `apps/trading-worker/src/broker/session-config.ts` | the table under [Constants](#constants) and `SESSION_CHAIN_HOLDS` |
| Candidates | `listSessionCandidates` in `packages/db/src/balance-snapshot-ops.ts` | the accounts in work, `{ id, brokerUserId }` |
| Lease | `broker_session_leases` (migration 0031), `packages/db/src/session-lease-ops.ts` (#93) | which process may hold an account's socket: acquire, renew, release ([The lease](#the-lease-93)) |
| Writers | `upsertBalanceSnapshot`, `applyBalanceEvent` (same file), `settleClosedTrades` (`trade-intent-ops.ts`) | what a session hears, written once its connection proved whose it is |
| Client | `BrokerSocketClient` ([broker-socket.md](broker-socket.md)) | one per session; the taint after an aborted command |
| Token | `AccessTokenSource` (`broker/access-token.ts`) | `POST /trading/accounts/:id/access-token` on the backend, always `mayRefresh: false`; after `token_expired`/`auth_failed` with the refused token's fingerprint (#281) |
| Composition | `apps/trading-worker/src/index.ts` | built only when `env.brokerWsUrl` is set; otherwise `noTradeSessions` |
| Probe | `apps/trading-worker/src/cli/socket-probe.ts`, `socket-probe-run.ts`, `socket-probe-verdict.ts` (#285) | the two-socket check the rollout waits for; exit 0 only on its safe verdict ([broker-socket.md → Observed live](broker-socket.md#observed-live)) |

## The candidates

`listSessionCandidates(db, { watchWindowMs, exclude })` is the backend balance tick's "in work":
an active account of an active user with a non-terminal intent, or one the bot asked about within
`BALANCE_WATCH_WINDOW_MS` (10 min, `packages/shared/src/broker-balance.ts`, one value for both).
`POST /trading/access` sets `last_requested_at`, so opening the trade screen puts the account in
work before its first intent. Ordered by `broker_accounts.id`, with no limit: the manager has to
see every account in work to tell a running session's account from an idle one, and applies its
cap in memory. No token-expiry filter: the token is asked for with `mayRefresh: false` and an
account whose token needs an exchange is held back. `exclude` is the manager's held-back set.
`ownerId` (#93) leaves out an account whose live lease belongs to another process: an
optimisation for several processes, not the guarantee — the acquire is.

## The lifecycle

The manager holds, per account, at most one of: an entry `starting` (its token fetch in flight),
an entry `running` (a started client), or a hold-back until a time. All of it is in memory; which
process may hold an account's socket at all is the lease's ([The lease](#the-lease-93)).

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
| `idle` | unverified: a stopped client has no connection. An external `client.stop()` (outside the manager) is not supported: the entry stays, without a session, until its account leaves the candidates and the idle grace closes it |
| `ready` | nothing |
| `token_expired`, `auth_failed` | unverified at once (the client closed its socket), then one token fetch carrying the refused token's fingerprint (#281; single-flight per entry: a second terminal state during it is ignored). A token different from the session's → `start()` on the same client at once. The same token → `broker session token unchanged` (`accountId`, `sessionState`), dropped, held back `SESSION_RETRY_MS`. A non-`ok` answer → [The token](#the-token) |
| `disconnected_by_server` | `broker session closed` (`reason: disconnected_by_server`), dropped, held back `SESSION_RETRY_MS` |

"Dropped" means `client.stop()` and the entry deleted: the account is a plain candidate again
once its hold-back is over, and nothing terminal stays in the map.

`sessionFor(accountId)` is the client of a `running` entry whose current connection is verified
([The identity gate](#the-identity-gate)), `undefined` otherwise (starting, held back, unknown, or
a connection whose `user.data` has not matched yet — the executor then sends the order over REST).
`clientFor()` returns the running client verified or not, for tests. The client itself answers `not_sent`/`not_ready` in any state but `ready` and on
a tainted connection, which the executor sends over REST.

## The token

Every fetch passes `mayRefresh: false` (Rule 12: a timer never exchanges a token; the exchange
happens on the user's trade over the REST fallback, where the executor passes the default
`true`), and the manager's stop signal. The fetch after `token_expired`/`auth_failed` also passes
`refusedToken`, the sha256 of the session's token: the backend marks that token expired and
answers `refresh_needed`, or hands out the pair someone already rotated
([binodex-oauth.md → A refused token](binodex-oauth.md#a-refused-token-is-an-expired-token-281)).

| Answer | Manager |
|---|---|
| `ok` | start the client, or restart it with a new token after a terminal state |
| `refresh_needed` | the token expired, or the one the broker just refused was marked expired (#281): drop, hold back `SESSION_RETRY_MS`; `info` `broker session waits for a token exchange` |
| `backend_unreachable`, `backend_status`, `contract_violation`, `not_configured`, `refresh_rate_limited` | drop, hold back `SESSION_RETRY_MS`; `warn` `broker session token unavailable` (`reason`, `status`). `not_configured` cannot happen: `index.ts` builds the manager only with the backend source; `refresh_rate_limited` cannot either with `mayRefresh: false` (#275) |
| `backend_unreachable` while stopping | drop, nothing logged |
| `account_not_found`, `account_pending`, `account_revoked`, `user_blocked`, `key_unavailable` | drop, hold back `SESSION_REFUSAL_RETRY_MS`; `warn` `broker session token refused` (`refusal`) |

The `switch` over the answer is exhaustive: a new code in the source's union is a `tsc` error
here.

## The identity gate

`update_balance` and `close_trade.success` carry no user id, and a connection is `ready` on
`user.auth.success`, before `user.data`. So a connection is unverified until its `user.data`
arrives, and nothing uses an unverified connection: `sessionFor()` returns `undefined` for it (the
order goes over REST) and its id-less events are not written:

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

A writer's throw → `error` `broker session write failed` (`source`, `brokerTradeIds` for a
`close_trade_success`, `errorLogFields`), then a
dead letter `{ source, accountId, mode, brokerTradeIds }` in the consumers' queue (#92,
[trade-intent-transport.md → Dead-letter queue](trade-intent-transport.md#dead-letter-queue)),
awaited inside the account's queue so `stop()` waits for it, for at most
`DEAD_LETTER_WRITE_TIMEOUT_MS` (1 s, `session-config.ts`, below `SESSION_STOP_BUDGET_MS`), one
entry per account, source and hour; the queue goes on with the next write. No REST GET at session start (`user.data` is the snapshot) and none
after `accepted` (the `update_balance` before `open_trade.success` is it). `price.update`,
`common.*` and the command answers are not the manager's: the answers are the executor's through
`openTrade`.

## The command and the taint

The executor sends a command over `sessionFor(accountId)`. A command that ends without its answer
while its connection is alive taints that connection: the client drops it and answers
`not_sent`/`not_ready` until the next `ready`, and a `success` answers only with the command's
asset, action and amount ([broker-socket.md → The trade command](broker-socket.md#the-trade-command-100)).
The manager does nothing for it: the reconnect is socket.io's, and the new connection proves its
identity again before anything uses it — `sessionFor()` hands the client to the executor, and the
writers accept events, only after that connection's `user.data` matched the account; until then
the executor's command goes over REST.

## The lease (#93)

One row per account in `broker_session_leases`: `owner_id` (a fresh `randomUUID()` per worker
start, logged in `trading-worker started` as `sessionOwnerId`; never a hostname, so a restarted
container inherits nothing), `acquired_at`, `expires_at` (CHECK `expires_at > acquired_at`, FK to
`broker_accounts`). Each operation is one autocommit statement on the pool, outside the lock chain
(Rule 5), with the database's clock:

| Operation | Statement | Answer |
|---|---|---|
| `acquireSessionLease` | `insert … on conflict (broker_account_id) do update … where expires_at <= now() or owner_id = excluded.owner_id` | `true` for a free or lapsed lease, or our own; two concurrent acquires serialize on the row and the second re-checks the predicate against the first's commit, so one wins (`session-lease-ops.db.test.ts` A5) |
| `renewSessionLeases` | `update … set expires_at = now() + ttl where owner_id = $me and id = any($ids) and expires_at > now()` | the ids still held; a lapsed lease is not renewed even when nobody took it — lapsed means lost |
| `releaseSessionLeases` | `delete … where owner_id = $me` | at a graceful stop only |

**The manager.**
- `startOne` acquires before the token fetch. Refused → `debug` `broker session lease busy`, held
  back `SESSION_RETRY_MS`, no token fetch. A throw → `broker session start failed`.
- Every `SESSION_LEASE_RENEW_MS` one renewal for every entry whose acquire has answered (an
  acquire still in flight may not have committed yet, and a renewal missing its id would drop a
  lease about to be ours). The answer applies to the same entry objects it was sent for: a
  returned id moves the fence, a missing one drops the entry at once (`warn` `broker session lease
  lost`, held back `SESSION_RETRY_MS`). A renewal that throws is logged (`broker session lease
  renewal failed`) and changes nothing: the fence decides.
- **The fence.** The database sets `expires_at = now() + TTL` with `now()` not earlier than the
  moment the statement was sent, so a lease sent at monotonic time `t0` holds until at least
  `t0 + SESSION_LEASE_TTL_MS`. The process trusts it until `t0 + SESSION_LEASE_FENCE_MS`
  (`performance.now()`, not the wall clock): a timer closes every socket past its fence (`warn`
  `broker session lease fenced`, `lateMs`), and `sessionFor` refuses a client past it even before
  that timer ran, so no command goes over a socket whose lease may have lapsed.
- `stop()` closes every client, then releases our leases inside the same `SESSION_STOP_BUDGET_MS`:
  a successor that takes an account after the delete never overlaps our socket. A release that
  throws (`error` `broker session lease release failed`) or overruns leaves the leases to lapse.
- An account dropped for another reason (idle, a refusal, `disconnected_by_server`) keeps its row
  until it lapses: the same process re-acquires it, another one after the TTL. A per-drop delete
  could race a later re-acquire by the same owner.

A dead owner's account is picked up by another process within about TTL + one hold-back + one tick
(~95 s; owner, 2026-10-09): until then it trades over REST. Falsifiable: `broker session lease
busy` for one account longer than 95 s after its owner's last line. `compose.yaml` still runs one
worker: more replicas, sharding and routing intent jobs to the owner are #94.

## Start and shutdown

`index.ts` builds the manager only when `BROKER_WS_URL` is set and passes it to the trade command
executor in place of `noTradeSessions`; `sessions?.start()` runs after the reconciliation pass and
the catch-up, and `trading-worker started` carries `sessions: true|false`.

Shutdown phase 1: the intents consumer's step is `worker.close()` → `drainDeadLetters()` →
`sessions.stop()`, so the sockets close after the jobs in flight finished and our own shutdown
never cuts a submit waiting on its socket. `stop()`: the timers cleared (the scan, the lease
renewal, the fence), the token fetches aborted
(the pool exits), every client stopped (a command still waiting settles `unknown`/`state_changed`,
and no event is delivered after it), the writes queued behind the one in flight dropped with one
`warn` `broker session writes dropped at stop` (`dropped`), then the write in flight per account
the scan in flight and the release of our leases (#93) awaited within `SESSION_STOP_BUDGET_MS`; past it `warn` `broker session
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
| `SESSION_LEASE_TTL_MS` | 30 000 | how long a lease outlives its last acquire or renewal in the database (#93) |
| `SESSION_LEASE_RENEW_MS` | 10 000 | the renewal interval |
| `SESSION_LEASE_FENCE_MS` | 25 000 | how long after sending an acquire or a renewal the process trusts it; past it the socket is closed |

`SESSION_CHAIN_HOLDS`, thrown at import and restated in `session-config.test.ts`:
`SESSION_TICK_MS < SESSION_IDLE_GRACE_MS` (an account missing from one scan is not closed),
`SESSION_TICK_MS < SESSION_RETRY_MS <= SESSION_REFUSAL_RETRY_MS` (a held-back account skips at
least one tick), `SESSION_IDLE_GRACE_MS < BALANCE_WATCH_WINDOW_MS` (an account the bot asked
about keeps its session for the whole window), `2 × SESSION_LEASE_RENEW_MS <
SESSION_LEASE_FENCE_MS < SESSION_LEASE_TTL_MS` (one failed renewal does not fence; the fence closes
the socket 5 s before the database lets anyone else in), `SESSION_LEASE_TTL_MS < SESSION_RETRY_MS`
(a busy account is asked again only once its lease could have lapsed),
`DEAD_LETTER_WRITE_TIMEOUT_MS < SESSION_STOP_BUDGET_MS`, every `*_MS` an integer in
`[1, MAX_TIMER_MS]`.

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
| `broker session token unchanged` | warn | `accountId`, `sessionState`; the backend did not mark the refusal (#281) — not expected; restarting with the same token at once would loop `user.auth` against the per-IP limit |
| `broker session user mismatch` | error | `accountId`, `expected`, `received` |
| `broker session event before user.data` | warn, once per connection | `accountId`, `type` |
| `balance snapshot not written` | warn, once per connection and source | `accountId`, `source`, `reason`, `field` |
| `intent settled from close_trade.success` | info | `accountId`, `intentId`, `brokerTradeId` |
| `closed trade not applied` | debug | `accountId`, `brokerTradeId`, `result` |
| `broker session write failed` | error | `accountId`, `source`, `err` |
| `broker session writes dropped at stop` | warn | `dropped` |
| `broker session stop budget exceeded` | warn | `pending` |
| `broker session lease busy` | debug | `accountId` — another process holds it (#93) |
| `broker session lease lost` | warn | `accountId` — a renewal did not return it |
| `broker session lease fenced` | warn | `accountId`, `lateMs` — its fence passed without a confirmed renewal |
| `broker session lease renewal failed` | error | `err` |
| `broker session lease release failed` | error | `err` |

`session-manager.test.ts` U14 reads every line its cases wrote through a `logOptions('debug')`
sink: no `SECRET-` sentinel (U17a's thrown error carries one in its message, which
`errorLogFields` leaves out), no amount the fixture spells, no broker host, and every `msg` above
present.

## Tests

- `session-manager.test.ts` (unit, the mock broker in `bytes`; stubbed candidates, tokens and
  writers; the `openClient` seam for the token cycle and an `openSocket` wrapper that holds
  chosen events back): U1 one client per candidate; U2 the idle grace; U3/U3b the cap, a starting
  session counted; U4/U5 the token answers and their hold-backs; U6/U6b/U7 `token_expired` and
  `auth_failed` with the same and with a new token, the fetch carrying the refused token's
  fingerprint; U6c a backend that marks it: the session waits and restarts with the exchanged one; U8 `disconnected_by_server`; U9/U9b/U9c the
  identity gate (a burst with a foreign `user.data`, a reconnect); U10/U10b/U10c a throwing writer and its dead letter, ids only, held for its timeout at most; U11
  `sessionFor` (U11b: only for a verified connection, again after a reconnect; U11c: none during
  the refresh after `token_expired`/`auth_failed`; U11d: none on `idle`, for a listener that
  re-enters during the stop); U12/U12b/U12c `stop()` and its budget, a dead-letter write in flight included; U13 single-flight and a failing scan; U15 a tick
  returns while its starts are pending; U16 a candidate gone while starting; U17a/U17b
  `broker session start failed` from a throwing token source and from a client whose `start()`
  throws on the refresh path; U14 the log scan; L1–L11 and L8b the lease (#93): a busy account
  costs no token fetch, an acquire that throws, the lease before the token, a renewal without the
  account, `sessionFor` past the fence before its timer, the fence closing a socket whose renewal
  never answers, one failed renewal fencing nothing, the release after every client and within the
  budget, a release that throws, an entry started or re-created around a renewal, an acquire in
  flight not renewed.
- `session-lease.db.test.ts` (integration, real leases, the mock broker): M1 two managers whose
  scans both list the account open one socket — the acquire alone keeps the second out; M2 an
  owner that never renews is fenced before its lease lapses, and only then does another process
  open the account's socket.
- `packages/db/src/session-lease-ops.db.test.ts`: A1–A5 the acquire (A4 the `<=` boundary inside
  one transaction, A5 two connections), R1–R4 the renewal, D1 the release; the candidates' lease
  filter in `balance-snapshot-ops.db.test.ts`; the table's CHECK, FK and key in
  `schema.db.test.ts`.
- `session-manager.db.test.ts` (integration, `TEST_DATABASE_URL`): the end-to-end scenario on
  the mock broker with the production composition — `listSessionCandidates`, the production
  writers, `createTradeCommandExecutor({ sessions: manager, … })`,
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

`BROKER_WS_URL` stays unset on the pilot until the two-socket probe of #285
(`pnpm --filter @binarius/trading-worker socket-probe`) has printed on the pilot its safe line,
`verdict: no cross-socket answer within the window; BROKER_WS_URL may be set`, with exit 0. A
`broadcast` or `inconclusive` verdict (exit 1) keeps it unset. The command, the preconditions and
the conditions of the safe verdict are in
[broker-socket.md → Observed live](broker-socket.md#observed-live); the result there is pending
the owner's run. Then:

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
2. **A token the broker refuses before its stored expiry waits for an exchange.** Closed by #281:
   the fetch after `token_expired`/`auth_failed` reports the token, the backend marks it expired.
   The residual is Rule 12's — the account trades over REST until the user's next action or a
   reconciliation exchanges the token, and the balance tick skips it meanwhile. Falsifiable:
   `broker session waits for a token exchange` repeating for an account whose user is active.
3. **A late `success` with the command's own terms on an untainted connection** is accepted for
   the wrong intent only when the earlier trade was never linked. The only way to the same
   connection is an abort, which taints it; reconciliation links the earlier trade first in every
   path in `main`.
4. **A cross-socket answer**: if the live broker sends `open_trade.*` to every socket of the user,
   a `fail` for a manual broker-web order would reject our intent while our order may be open, and
   a `success` with equal terms would link the manual trade. Not closable without an answer field;
   the probe of #285 decides, and until it has run `BROKER_WS_URL` stays unset.
5. **No fencing at the broker** (#93). The lease is enforced on our side only: a process frozen
   longer than `SESSION_LEASE_FENCE_MS` (an event-loop stall, a VM pause) keeps its TCP socket
   until it resumes, while another process may open a second one after the TTL. On resume
   `sessionFor` refuses commands before any timer runs; an event that arrives first can still be
   written (the writers are idempotent). Lapsed means lost: a database stall longer than 25 s closes
   every socket of the process, trading goes on over REST and the sessions restart on the next
   ticks; a command in flight when the fence fires ends `unknown` and goes to reconciliation. An
   acquire answered after `stop()` released leaves one row of the dead owner until it lapses.
   Falsifiable: `broker session lease fenced` with `lateMs` above 5 000. One worker container still
   runs; more is #94.
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
    the broker's refusal and the stored expiry coincide; when the refusal comes first, #281 marks
    the token expired and the same single REST trade exchanges it.
12. **A slow backend delays the starts, not the tick**: 500 token fetches at the 7 s budget, 4 in
    flight, take ~15 minutes. Falsifiable: `broker session tick` lines with `queued > 0` across
    many ticks.

## Boundaries

- ARCH-02: #93 the lease (shipped, above), #94 the measured per-process limit, sharding and the
  orchestrator and catch-up under several processes, #95 handoff and
  single-flight refresh across processes, #96 the emergency stop.
- ARCH-05: #87 the load stand, #88 degradation.
- #92 shipped: the writers' dead letters above, and the balance check after a reconciliation
  (docs/trade-intent-transport.md). #274 (`not_found`), #278, #279; #281 shipped (risk 2). The session orchestrator (#287, shipped, docs/trading-session.md)
  keeps its account in work between trades through `touchBalanceRequested`, so its socket stays open.
- `price.update` has no consumer in production: the signal feed reads the REST chart; E2 proves
  the subscription pipe only.
