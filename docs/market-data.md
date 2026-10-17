# The market data source (#404)

The backend keeps a candle ring for every pair of the catalog on the `15s` and `5s` intervals, built
from the broker's `price.update` ticks on a data socket of its own. That socket runs on a service
account ([service-accounts.md](service-accounts.md), #391). This part has no consumer yet. The REST
refill of gaps and cold starts is #590, and the feed and scanner move onto the source in #405.

```bash
pnpm test --project unit apps/backend/src/market-data   # mock broker and fake clients, no database
```

## Components

| Piece | Where | What it does |
|---|---|---|
| `createCandleRing` | `apps/backend/src/market-data/ring.ts` | one #392 builder (`createCandleBuilder`, `packages/signal/src/ticks.ts`) per (pair, interval), the closing rule, holes, `read`/`fill`/`missing` |
| `createMarketDataManager` | `apps/backend/src/market-data/manager.ts` | the two socket clients on service accounts, failover, token refusals, hold-back, subscriptions, the log line |
| `CandleSource`, `createPendingRequests` | `apps/backend/src/market-data/source.ts` | the interface #405 reads (`read`, `request`) and the bounded request set #590 drains (`pending()`) |
| `BrokerSocketClient` | `packages/broker-socket` | the worker's socket client, unchanged ([broker-socket.md](broker-socket.md)) |

The source is created only when `BROKER_WS_URL` is set. It reads the same variable as the worker's
sessions (`https:` or `wss:`; an empty value fails the start). `apps/backend/src/index.ts` starts it
after `listen()` with the other loops and stops it in shutdown phase 1. The start line
`market data source { enabled }` says whether it runs.

## Roles and failover

At most two clients per process, both on working service accounts (`listServiceBrokerAccounts`,
ordered by `service_since asc, id asc`, read again on every tick):

- **active:** subscribed to every pair of the fresh catalog. Only its ticks reach the ring.
- **reserve:** a separate client on another account, authenticated and subscribed to nothing. A
  client that was never asked to `subscribe()` is the only kind that stays without subscriptions:
  `stop()` keeps the registry, and every auth sends all of it again.

The active hands over in these cases:

| The active | What happens |
|---|---|
| `disconnected_by_server`, or a `user.data` of another user | its account is held back; a ready reserve gets `subscribe(<the active's registry>)` and becomes the active, and the old client is stopped and forgotten |
| `reconnecting` | after `MARKET_DATA_FAILOVER_GRACE_MS` without coming back to `ready`, the same switch, without a hold-back: a transport drop is not the account's fault, so the account is the first candidate for the next reserve |
| `token_expired` / `auth_failed` with the reserve `ready` | the same switch at once (decision 7a). The next reserve starts on the old account with `refusedToken` (below) |
| `token_expired` / `auth_failed` without a ready reserve | the token is exchanged in place: the same client `start()`s with the new token, and its registry goes out with the next auth |

A reserve that is not `ready` at the switch keeps its slot, and the active starts at once on the
next free account (the reserve's account is not free). Whichever comes first takes the active role:
a start that opens a client becomes the active, and the reserve stays the reserve. The ready reserve
is promoted into an empty active slot on three entries (`promote()`):

1. the switch itself, when the reserve is `ready` at that moment;
2. the end of an active start that found no client (every account refused, or the broker's rate
   limit ended the run);
3. the reserve reaching `ready` while the active slot is empty.

A promotion sends `subscribe()` with every id of the fresh catalog (the switch sends the old
active's registry), and logs `market data reserve promoted` on entries 2 and 3. After a promotion
and after a switch with no ready reserve, an empty reserve slot starts at once on the next free
account. The one exception is a promotion after the rate limit: that run is not continued, and the
reserve starts on the next tick. While the active is `starting` or `refreshing`, a reserve that
turns `ready` waits for the outcome of that start (risk 11).

The reserve's own events: its prices are ignored. `disconnected_by_server` or a foreign `user.data`
stops it and holds its account back, and a new reserve starts on the next tick. A token refusal is
exchanged in place, with no subscription and no switch.

Each slot is `empty`, `starting` or `refreshing` (both waiting on `accessToken`), or `running`. The
tick fills only an empty slot, so there are never more than two clients. `stop()` stops both clients
at once, then waits for an `accessToken` in flight, and opens nothing after its answer. The
invariants:

- I1: no handler ends with the active slot empty and the reserve `running` and `ready` (the three
  entries above).
- I2: every start and exchange ends by writing its own slot (`running`, `empty`, or a failover), or
  leaves on `stop()`.
- I3: a throw of the client (`start()` on invalid credentials or a second start) is the account's
  failure: the client is detached and stopped, the account is held back, and the start goes on to
  the next candidate; after an exchange the account fails over as on a refused exchange.
- I4: every work nobody awaits has a rejection handler (`market data work failed`), a backstop that
  by I3 no case reaches.

## Closing a candle and holes

A bucket `b` of interval `I` is **closed** when either rule says so:

- `W ≥ b + I`, where `W` is the watermark: the newest tick time on the active socket, any pair;
- `now ≥ b + I + MARKET_DATA_SKEW_MARGIN_MS`, on the process clock. This rule is for a quiet stream
  (closed markets): the tick delay's p95 on the pilot was 268 ms.

Both offsets count from the bucket's end, `b + I`. `read()` returns the closed candles of the window
(`chartWindow(nowMs, I, 300)`, the same window as the feed's fetch), the forming one apart, and the
empty closed buckets as `gaps`.

**Holes are per pair, in broker time.** When the active leaves `ready`, every pair keeps its own
watermark. Its first tick past that watermark, from whichever socket is active by then, marks
`[watermark, tick]` a hole on both of its builders (`markHole`, closed at both ends). The candles it
reaches are dropped, and no candle is built for the buckets it reaches. The rest of the rule:

- a pair first heard after a drop loses its first bucket;
- two drops before the pair's next tick make one hole;
- a repeated tick not past the pair's watermark leaves the hole open.

`fill(assetId, interval, rows, nowMs)` is #590's entry. It puts REST rows only into closed buckets
of the window that have no tick candle and no earlier fill. A tick candle is never replaced, because
the tick series is continuous (each open is the previous close). `missing()` counts the empty closed
buckets.

## Subscriptions

The ids come from the fresh REST catalog (`pairsCatalog.read()`, `fresh`), so the source uses the
same list and `digits` as the scanner and the bot. The socket's `common.assets_list` is not read.

- A stale catalog: the active authenticates without subscribing, `market data catalog not fresh` is
  logged once per streak, and the first fresh tick subscribes.
- New catalog ids are subscribed on the tick. There is no `price.unsubscribe`, so a pair that left
  the catalog stays subscribed until a restart.
- A pair whose `digits` fail `assertDigits` is not subscribed (`skippedDigits`).
- A price of an id outside the catalog is dropped (`unknownAsset`).
- A pair keeps the `digits` of its first tick until a restart.

## Tokens and hold-back

Every token comes from `accessToken(id, { mayRefresh: true, serviceOnly: true, refusedToken? })`. An
exchange happens here only if the keeper missed it (the keeper renews a day ahead). After a broker
refusal, the token service sees `refusedToken` (the `hashToken` of the refused token), marks the
stored one expired and exchanges it (#281). The refusal is reported only by the call that holds the
old token, because once the token is marked, any later call exchanges anyway.

| Outcome | Hold-back (`MARKET_DATA_ACCOUNT_RETRY_MS`) | Log |
|---|---|---|
| `ok` | no | `info` `market data socket started { role, accountId }` |
| `refresh_rate_limited` | yes; the run over the accounts stops (the limit is per IP) | `warn` `market data token refused` |
| `account_revoked` | yes | `warn` `market data token refused` with `revokedReason` |
| `not_service`, `user_blocked`, `account_pending`, `account_not_found` | yes | `info` `market data token refused` |
| `key_unavailable`, `refresh_needed` | yes | `warn` `market data token refused` |
| `accessToken` threw | yes | `error` `market data token threw` (name and code) |
| `start()` threw (a new client or an exchange in place) | yes | `error` `market data socket start threw` (name and code) |
| exchange in place `ok` | no | `info` `market data token refreshed` |
| `disconnected_by_server` | yes | `warn` `market data socket disconnected by server` |
| foreign `user.data` | yes | `warn` `market data foreign user` (the other user's id is not logged) |
| `reconnecting` past the grace | no | `warn` `market data failover` |

Hold-backs are kept in process memory and lapse by time. The account list is read on every tick, so
a mark or unmark in the admin pages, or a repair by the keeper, takes effect within
`MARKET_DATA_TICK_MS` plus any hold-back.

## The log

| Message | Level | When |
|---|---|---|
| `market data` | info | every `MARKET_DATA_LOG_MS`, the line below |
| `market data socket started` | info | a client opened for a role |
| `market data failover` | warn | `{ from, to, reason }`; `to: null` when no ready reserve took over |
| `market data socket disconnected by server` | warn | `{ role, accountId, reason }` |
| `market data foreign user` | warn | `{ role, accountId }` |
| `market data token refused` | info / warn | the table above |
| `market data token threw` | error | `{ role, accountId, err }` |
| `market data token refreshed` | info | an in-place exchange succeeded |
| `market data reserve promoted` | info | `{ to }`: the reserve reached `ready` while the active slot was empty, or took it when the active's start found no client |
| `market data socket start threw` | error | `{ role, accountId, err }` |
| `market data work failed` | error | `{ err }`: a backstop for a throw outside the client's tries; no case reaches it |
| `market data catalog not fresh` | warn | once per streak of stale catalog reads |
| `market data: no working service account` | warn | once per streak without an active |
| `market data tick failed` | error | the tick threw (the account list's query) |

The `market data` line, with counters for the period since the previous line:
`{ accounts, held, active: { accountId, socketState, connection, subscriptions } | null, reserve: { accountId, socketState } | null, ticks, ticksPerSec, late, invalid, skewed, holed, unknownAsset, skippedDigits, holes, lateClose: { watermark, clock }, failovers, watermarkLagMs, closed: { '15s', '5s' }, pairs, pending }`.
`lateClose` counts ticks that changed a candle the ring already called closed, split by the rule
that closed it. `closed` counts tick candles whose bucket closed in the period. The client's state is
`socketState`, because the logger redacts every key named `state` (the OAuth state). No line carries a
token, the socket URL or a payload (`manager.test.ts` M11).

## Constants

`apps/backend/src/timing.ts`, checked at import with the backend chain:

| Constant | Value | Bounds |
|---|---|---|
| `MARKET_DATA_TICK_MS` | 30 000 | the tick: accounts, roles, new pairs |
| `MARKET_DATA_LOG_MS` | 60 000 | the `market data` line |
| `MARKET_DATA_FAILOVER_GRACE_MS` | 2 000 | the active's own reconnection before the switch |
| `MARKET_DATA_SKEW_MARGIN_MS` | 2 000 | the clock rule of closing |
| `MARKET_DATA_ACCOUNT_RETRY_MS` | 300 000 | an account's hold-back |
| `MARKET_DATA_RING_CANDLES` | `SIGNAL_FETCH_LIMIT` (300) | candles per (pair, interval) |
| `MARKET_DATA_PENDING_MAX` | 288 | `request()`s waiting for #590 (144 pairs × 2) |

The links:

- `BROKER_SOCKET_RECONNECT_DELAY_MS × (1 + JITTER) < GRACE`: the client's first reconnection attempt,
  at its longest jitter, starts inside the grace. Its handshake (connect, then `user.auth`) is not
  bounded here: a slower one ends in the switch.
- `GRACE < 5 s`: the switch happens within one `5s` candle.
- `SKEW_MARGIN < 5 s` and `< TICK_MAX_SKEW_MS`.
- `TICK ≤ LOG`.
- `SERVICE_ACCOUNTS_TICK_MS < ACCOUNT_RETRY`: the keeper gets a tick to repair an account before it
  is retried.
- `stop()` waits for at most one `accessToken`, which `BROKER_HTTP_TIMEOUT_MS < SHUTDOWN_PHASE1_BUDGET_MS`
  already bounds.

## Tests

- `ring.test.ts` R1-R9, R12, with R3b/R3c (`lateClose`).
- `source.test.ts` S1-S3.
- `manager.test.ts`:
  - M1-M6, M8-M14 on `packages/mock-broker`, with two users;
  - M7-M7d, M15, M16, the in-flight case of M10, M17a-M17e (the promotion and the reserve after a
    switch) and M18a-M18c (a throwing `start()`) on fake clients, because the mock has one token
    per user and cannot authorise an exchanged one, and its clients never throw;
  - M11 reads the log itself. It reads the lines of every case before it, so alone or shuffled it
    fails falsely; `vitest.config.ts` pins the order.
- The timing pins are in `timing.test.ts`.

## Accepted risks

1. **Unmeasured: does the broker send `price.update` to every socket of a user?** If it does, a
   worker session on a trading service account receives about 555 ticks a second. The worker has
   no handler for them, so the cost is the worker's CPU (the spike measured 3.7 % of one vCPU for
   the full stream). Falsifiable: the `events` count in the worker's `broker socket disconnected`
   line for such a session runs to thousands.
2. **One service account on the pilot.** On the active, any of these leaves the stream without a
   socket for `MARKET_DATA_ACCOUNT_RETRY_MS` (5 min): `disconnected_by_server`, a foreign
   `user.data`, or a refused token exchange. A token the broker refuses while the exchange works
   costs only the exchange (≤ `BROKER_HTTP_TIMEOUT_MS`).
3. **Closing may come before a bucket's last ticks.** The clock rule can close early when the
   process clock runs ahead of the broker's by more than the margin during a quiet stream. The
   watermark rule can close early because ticks of different pairs arrive out of timestamp order.
   No consumer exists in this part. Falsifiable: `lateClose.clock` or `lateClose.watermark` > 0 in
   the line.
4. **No refill until #590.** A hole or a cold start leaves the window short.
5. **The subscription limit of one socket is unmeasured** (#555). 144 ids worked on one socket for
   30 minutes.
6. **A pair that left the catalog stays subscribed** until a restart.
7. **Memory:** 144 × 2 × 300 candles, about 5 MB plus the builders.
8. **One backend process.** Two replicas would open two active sockets. There is no lease (#93).
9. **A change of a pair's `digits`** applies after a restart.
10. **A refused token while an exchange is in flight:** if the reserve turns `ready` during an
    in-place exchange of the active, the switch no longer happens. The window is
    ≤ `BROKER_HTTP_TIMEOUT_MS`.
11. **A reserve that turns `ready` while the active is `starting` waits for that start.** The window
    is the `accessToken` answer (usually a database read; up to `BROKER_HTTP_TIMEOUT_MS`, 5 000,
    with an exchange) plus the new active's connection. Promoting in the middle of a start would mean
    redirecting the start in flight to another slot. Falsifiable: `market data failover { to: null }`,
    then `market data socket started { role: 'active' }` more than 5 s after the reserve's `ready`
    in the same period.
12. **A reserve that reconnects without end keeps its account.** The client retries forever
    (`reconnectionAttempts: Infinity`) and the reserve has no grace, so with two accounts and a
    failed active the stream waits for that reconnection. Falsifiable: a `market data` line with
    `reserve.socketState: 'reconnecting'` in two periods in a row.

## Owner's steps after the merge (pilot)

1. Deploy the backend: `docker compose up -d backend`. After 60-90 s,
   `docker compose logs --since 3m backend | grep -E 'market data'` should show:
   - `active` with `subscriptions` equal to the catalog's size;
   - `ticksPerSec` > 0 during trading hours;
   - `reserve: null`.

   Note the backend's CPU from `docker stats --no-stream`.
2. Check risk 1: run a demo session on the service account while the source runs. Afterwards, look
   at the session's `events` in
   `docker compose logs --since 30m trading-worker | grep 'broker socket disconnected'`.
   - About the number of trades: there is no fan-out.
   - Thousands: there is fan-out, and that needs a task.
3. Later, mark a second service account in the admin pages. The next `market data` line shows
   `reserve: { accountId, socketState: 'ready' }`.

## Boundaries

- The REST refill (`fill`, `pending()`, the native `5s`/`15s` GETs) is #590.
- The feed and the scanner reading the source, and the budget split of #382, are #405.
- No trade command is sent on a data socket: the manager never calls `openTrade`.
