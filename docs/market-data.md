# The market data source (#404)

The backend keeps a candle ring for every pair of the catalog on the `15s` and `5s` intervals, built
from the broker's `price.update` ticks on a data socket of its own. That socket runs on a service
account ([service-accounts.md](service-accounts.md), #391). A REST backfill (#590, [Backfill](#backfill-590))
closes the gaps of a cold start and of a hole on the signal pacer's overflow. The signal feed and
the scanners read it (#405, [signal.md](signal.md#feed-and-journal-133)).

```bash
pnpm test --project unit apps/backend/src/market-data   # mock broker and fake clients, no database
```

## Components

| Piece | Where | What it does |
|---|---|---|
| `createCandleRing` | `apps/backend/src/market-data/ring.ts` | one #392 builder (`createCandleBuilder`, `packages/signal/src/ticks.ts`) per (pair, interval), the closing rule, holes, `read`/`fill`/`missing` |
| `createMarketDataManager` | `apps/backend/src/market-data/manager.ts` | the two socket clients on service accounts, failover, token refusals, hold-back, subscriptions, the log line |
| `createCandleSource`, `createPendingRequests` | `apps/backend/src/market-data/source.ts` | the adapter over the ring and the request set that implements the feed's port `SignalCandleSource` (`packages/signal/src/source.ts`, #405): a window only while the manager's `streaming()` is true and only for `SIGNAL_SCAN_INTERVALS`, `request` only for those; and the bounded request set the backfill drains (`pending()`) |
| `createCandleBackfill` | `apps/backend/src/market-data/backfill.ts` | the REST backfill: due elements, the queue, one native GET per (pair, interval), `fill` (#590) |
| `createTickStore` | `apps/backend/src/market-data/ticks.ts` | the newest tick per pair with its receipt time (#666): the manager pushes the active's ticks next to the ring (the ring's `tickProblem` rule, an older tick does not replace a newer one); `POST /trading/signal` answers it in a session's decision record ([trade-log.md](trade-log.md#the-last-tick)). The tick is kept until a newer one, never cleared on a socket drop, a failover or a quiet pair: a reader bounds its age itself (`taken_at_ms - last_tick.receivedAtMs` in the trade log). Since #668 it also keeps a window per pair, the last `TRADE_TICKS_BUFFER_MS` behind the pair's watermark (at most `TRADE_TICKS_MAX_PER_PAIR`), answered by `between(assetId, from, until)` with its coverage; the manager calls its `onDrop()` wherever it calls the ring's, and a tick ahead of its receipt moves the watermark only to the receipt + `TRADE_TICKS_AHEAD_MS`. The trade log keeper reads it ([trade-log.md → The ticks around a decision](trade-log.md#the-ticks-around-a-decision)) |
| `createSecondSeries` | `apps/backend/src/market-data/seconds.ts` | the 1s closes of every pair for the H1 shadow (#669): the manager pushes the active's ticks into it next to the ring and the tick store, and calls its `onDrop()` wherever it calls the ring's. Its own closing rule is below; the series, the shadow that reads it and its counters are [h1.md](h1.md) |
| `BrokerSocketClient` | `packages/broker-socket` | the worker's socket client, unchanged ([broker-socket.md](broker-socket.md)) |

The source is created only when `BROKER_WS_URL` is set. It reads the same variable as the worker's
sessions (`https:` or `wss:`; an empty value fails the start). `apps/backend/src/index.ts` builds the
ring and the request set (`candleStore`) before the signal feed, which reads them through
`createCandleSource` (its `streaming` asks the manager, built below, only after `listen()`), then
the backfill and the manager in one function (`createMarketData`), starts the manager and then the
backfill after `listen()` with the other loops, and stops the backfill and then the manager in
shutdown phase 1. The start line
`market data source { enabled }` says whether it runs. The second series is built with the ring,
and the H1 shadow on it with the backfill and the manager, unless `H1_SHADOW=off`; it starts after
them and stops before them ([h1.md](h1.md#start-stop-and-the-switch)).

## The state machine

At most two clients per process, both on in-service service accounts (`listServiceBrokerAccounts`:
marked, the account `active`, its user `active`, ordered by `service_since asc, id asc`, read again
on every tick). A token that merely expired does not take an account out of the list: the start
exchanges it (owner's decision, 2026-10-17).

- **active:** subscribed to every pair of the fresh catalog. Only its ticks reach the ring.
- **reserve:** a separate client on another account, authenticated and subscribed to nothing (a
  client's registry survives `stop()` and goes out with every auth, so only a new client is empty).

Each slot is `empty`, `starting` (waiting on `accessToken`) or `running`. A slot out of `ready` has
`since`: the job's start, kept by its client, or the moment the client left `ready`. Every start is
a new client, started once. An answer opens a client only in the slot that still holds its job.

Every handler changes only its own slot and ends in `reconcile()`, which applies, in order:

1. **R1** a slot whose account is not in the list: vacated, without a hold-back.
2. **R2** a reserve out of `ready` for `MARKET_DATA_RESERVE_READY_MS`, when another account could
   take its place: vacated with a hold-back.
3. **R3** a `ready` reserve, when the active is empty, or out of `ready` (any state, `starting`
   too) for `MARKET_DATA_FAILOVER_GRACE_MS`: the active is vacated (`not_ready`, no hold-back), and
   the reserve becomes the active.
4. **R4**, **R5** an empty slot starts on the first candidate (listed, not held back, not in the
   other slot); no active and no candidate nor reserve: `market data: no working service account`.
5. **R6** the active subscribes the fresh catalog's ids it lacks; **R7** one timer, at the nearest
   deadline of R2 or R3.

| Event on a slot | What happens |
|---|---|
| `accessToken` `ok`, the slot still holds the job | a new client; the active subscribes the catalog before `start()` |
| any other answer, or a throw of the client's start | the slot empties, the account is held back ([Tokens and hold-back](#tokens-and-hold-back)) |
| an answer to a slot that no longer holds the job | dropped, no client |
| `connecting`, `authenticating`, `reconnecting` | the slot waits; R3 bounds the active, R2 the reserve, by `since` |
| `ready` / leaving `ready` | `since` cleared / set; the active leaving `ready` marks the drop in the ring |
| `disconnected_by_server`, a foreign `user.data`, `token_expired`, `auth_failed` | the slot empties (hold-back: the table below) |
| `stop()` | both clients stopped, the timer cleared, the starts in flight awaited, nothing opened after |

**A refused token.** The `hashToken` of the client's token goes, as `refusedToken`, to the next start
on that account, exactly once. The first refusal of an account within `MARKET_DATA_ACCOUNT_RETRY_MS`
vacates without a hold-back, a second one with it: at most two exchanges per account in that window.
With a ready reserve, R3 promotes it at once and R5 starts the next reserve on the old account;
without one, R4 starts the active on the first free account, usually the same one.

Guarantees (`manager.test.ts`): S1, S2 at most two live clients, exactly those in the slots, no
account in both (`expectSafe` ends every fake-client case); S3 an account that left the list keeps
a slot for at most a tick plus the read, after a database error until the next good read (M19); S4
only the active is subscribed (M1, M7c, M7d, M20); S5 every promise has a handler, and
`market data work failed` is a backstop no case reaches; S6 every failure holds its account back,
except the first token refusal in the window, R1 and R3 (M7e); S7 a refusal is reported once (M7c).
Liveness: with an account that the broker accepts listed from `t0`, the active is `ready` by
`t0 + ACCOUNT_RETRY + TICK + (n + 1) × RESERVE_READY + GRACE` for `n` accounts (407 s for two);
every state out of `ready` is bounded by R2 or R3 through `since` (M21, M23).

## Closing a candle and holes

A bucket `b` of interval `I` is **closed** when either rule says so:

- `W ≥ b + I`, where `W` is the watermark: the newest tick time on the active socket, any pair;
- `now ≥ b + I + MARKET_DATA_SKEW_MARGIN_MS`, on the process clock. This rule is for a quiet stream
  (closed markets): the tick delay's p95 on the pilot was 268 ms.

Both offsets count from the bucket's end, `b + I`. `read()` returns the closed candles of the window
(`chartWindow(nowMs, I, 300)`, the same window as the feed's fetch), the latest unclosed bucket
apart as `forming` (the current bucket, or the one before it until a rule closes it; the feed uses
it only when it is the current one, [signal.md](signal.md)), and the empty closed buckets as `gaps`.

**Holes are per pair, in broker time.** When the active leaves `ready`, every pair keeps its own
watermark. Its first tick past that watermark, from whichever socket is active by then, marks
`[watermark, tick]` a hole on both of its builders (`markHole`, closed at both ends). The candles it
reaches are dropped, and no candle is built for the buckets it reaches. The rest of the rule:

- a pair first heard after a drop loses its first bucket;
- two drops before the pair's next tick make one hole;
- a repeated tick not past the pair's watermark leaves the hole open.

`fill(assetId, interval, rows, nowMs)` is the backfill's entry. It puts REST rows only into closed buckets
of the window that have no tick candle and no earlier fill. A tick candle is never replaced, because
the tick series is continuous (each open is the previous close). It judges closedness at `nowMs` by
the watermark it has now, so the caller passes only rows of buckets that were closed when its
request was built: a bucket the broker answered as forming may be closed by the time the answer
arrives. `missing()` counts the empty closed
buckets.

**The seconds of the H1 shadow have a rule of their own** ([h1.md](h1.md#the-second-series)): a
second is closed by its own pair's first tick past it, not by the watermark of every pair, or by
the clock `H1_SECOND_CLOSE_MARGIN_MS` (500 ms) after its end, inside `MARKET_DATA_SKEW_MARGIN_MS`.
A drop makes the pair's seconds NaN until its next tick. The REST backfill does not touch them.

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

Every token comes from `accessToken(id, { mayRefresh: true, serviceOnly: true, refusedToken? })`:
an exchange happens here only if the keeper missed it, or after a refusal, which the token service
marks expired first (#281); once marked, any later call exchanges anyway, so it is reported once.

| Outcome | Hold-back (`MARKET_DATA_ACCOUNT_RETRY_MS`) | Log |
|---|---|---|
| `ok` | no | `info` `market data socket started { role, accountId }` |
| `refresh_rate_limited` | yes, this account only: the next one usually reads a live token without an exchange | `warn` `market data token refused` |
| `account_revoked` | yes | `warn` `market data token refused` with `revokedReason` |
| `not_service`, `user_blocked`, `account_pending`, `account_not_found` | yes | `info` `market data token refused` |
| `key_unavailable`, `refresh_needed` | yes | `warn` `market data token refused` |
| `accessToken` threw | yes | `error` `market data token threw` (name and code) |
| `start()` or `openClient` threw | yes | `error` `market data socket start threw` (name and code) |
| the client's token refused (`token_expired`, `auth_failed`) | the first in the window no, a second yes | `warn` `market data failover` / `info` `market data reserve stopped` |
| `disconnected_by_server` | yes | `warn` `market data socket disconnected by server` |
| foreign `user.data` | yes | `warn` `market data foreign user` (the other user's id is not logged) |
| R1: the account left the list | no | `reason: 'not_working'` |
| R2: the reserve out of `ready` past its budget | yes | `reason: 'not_ready'` |
| R3: the active out of `ready` past the grace | no | `reason: 'not_ready'` |

Hold-backs are kept in process memory and lapse by time. The account list is read on every tick, so
a mark or unmark in the admin pages, a blocked user or a revoked account takes effect, for a start
and for a running socket alike, within `MARKET_DATA_TICK_MS` plus the list's read (R1), and a mark
plus any hold-back.

## Backfill (#590)

`createCandleBackfill` (`apps/backend/src/market-data/backfill.ts`) closes the empty buckets of the
ring by REST. An **element** is a (pair, interval).

**Which elements.**

- **Proactive set:** the pairs of the last fresh catalog with valid `digits` that the scanner would
  take (`eligiblePairs`: open by the schedule, accepting the interval's duration, at any payout
  since #631), on both intervals. It applies only while `MarketDataManager.streaming()` is true
  (the active socket is `ready`). A closed pair is warmed only on request (B14; a pair paying less
  than 80 % without one, B14b). The set grew with #631 by the pairs below 80 %: the warm-up after a
  start takes longer at the same budget, one spare token a refill.
- **Requests:** `pending()` is drained on every scan, whatever the socket. A request for an id outside
  the last fresh catalog, or with `digits` that fail `assertDigits`, is dropped: the ring holds no
  pair outside the subscription. Before the first fresh catalog the requests wait in their set.

**When an element is due.** Its hold-back (`MARKET_DATA_BACKFILL_RETRY_MS` after its last finished
attempt) is over, and its window has a closed empty bucket the last GET did not leave unfilled. A
request makes any closed empty bucket enough. So a hole, a cold start, a quiet bucket and a new
catalog id all become due by themselves. A bucket the broker did not fill is not asked for again
until a new bucket goes missing or a request comes. The unfilled buckets are forgotten once they
leave the window.

**Order** (rebuilt every `MARKET_DATA_BACKFILL_SCAN_MS`, and once at `start()`):

1. the requests, in `pending()` order;
2. the elements never attempted, by the pair's payout (`comparePairsByPayout`);
3. the rest, by the age of their last attempt.

Within a level `15s` comes before `5s` on an equal key. A cold pair is warmed before any repeat, and
the repeats rotate by age, so no element starves.

**The GET.** Every `MARKET_DATA_BACKFILL_POLL_MS`, while a worker is free
(`MARKET_DATA_BACKFILL_CONCURRENCY`), the head is checked again and takes a spare token. With
`w = chartWindow(now, I, MARKET_DATA_RING_CANDLES)` the request is
`{ startTime: w.startTime − I, limit: w.limit + 1 }`, and the first row of the answer is dropped: it
opens on the first tick of its bucket, not on the close before it (the #392 spike's `dropFirstRow`).
A GET may cross a candle boundary. Of the rest, only the rows of buckets closed when the GET was
built go to `ring.fill`: those that ended before its boundary and that the ring called closed at
that moment, `timestamp < min(floor(at, I), ring.closedUntil(I, at))`. The bucket forming at `at`
comes as a partial row and is never filled by that GET; a bucket that closed later is an empty
bucket for the next one. `ring.fill` then puts the rows only into closed buckets of the window that
have no tick candle and no earlier fill. No GET starts in the first `SIGNAL_SCAN_SLACK_MS` of a `5s` candle,
because the broker publishes a just-closed candle about 150 ms after the boundary. Every GET runs
under `MARKET_DATA_BACKFILL_BUDGET_MS` and the `stop()` signal.

**Tokens.** Only the overflow of the signal pacer (`ScanPacer.tryTakeSpare`,
[signal.md → The budget](signal.md#the-budget)): what `refill` discards above the bucket's capacity,
held to one token. While the source is live nothing but the on-demand GETs of intervals the ring
does not build (`1m` and longer - never from the bot, #313) takes the pacer's tokens, so the
backfill gets nearly the whole share; without the source the feed's GETs by demand take the bucket
first. A 429 or a 2xx
answer goes to the same pacer (#405).

| Outcome of an attempt | Counters | The element |
|---|---|---|
| 2xx, any rows (`[]` on a closed market too) | `fetched`, `filled +n` | held back; the window's empty buckets that were closed when the GET was built become `unfilled`; failures reset; the request it served is dropped, one that came in flight stays |
| 429 | `rateLimited` | the pacer paused (`onRateLimited`); the element goes back to the head, its hold-back and failures untouched; the request stays |
| `unavailable`, `contract_violation`, `rejected`, `unauthorized`, `aborted` by the budget | `failed` | held back, failures +1, the request stays; at `MARKET_DATA_BACKFILL_ATTEMPTS` `warn` `market data backfill gave up`, the empty buckets closed when the GET was built become `unfilled`, failures reset, the request it served is dropped (one that came in flight stays) |
| a throw that is not a `BrokerRestError` | `failed`, `warn` `market data backfill threw` | as a failure |
| aborted by `stop()` | none | the loop is over |
| no longer due at dispatch | none | off the queue |

State lives only in memory: at most two elements per catalog pair, dropped with the pair. A restart
warms cold again.

## The log

| Message | Level | When |
|---|---|---|
| `market data` | info | every `MARKET_DATA_LOG_MS`, the line below |
| `market data socket started` | info | a client opened for a role |
| `market data failover` | warn | `{ from, reason, heldBack }`: the active vacated |
| `market data reserve stopped` | info | `{ accountId, reason, heldBack }`: the reserve vacated |
| `market data reserve promoted` | info | `{ to }`: R3, a ready reserve took an empty active slot, or one out of `ready` past the grace |
| `market data socket disconnected by server` | warn | `{ role, accountId, reason }` |
| `market data foreign user` | warn | `{ role, accountId }` |
| `market data token refused` | info / warn | the table above |
| `market data token threw` | error | `{ role, accountId, err }` |
| `market data socket start threw` | error | `{ role, accountId, err }` |
| `market data work failed` | error | `{ err }`: the backstop of `track()` and of the timer; no case reaches it |
| `market data catalog not fresh` | warn | once per streak of stale catalog reads |
| `market data: no working service account` | warn | once per streak without an active |
| `market data tick failed` | error | the tick threw (the account list's query) |
| `market data backfill gave up` | warn | `{ assetId, interval, code, attempts }`: `MARKET_DATA_BACKFILL_ATTEMPTS` failed GETs in a row on one element |
| `market data backfill threw` | warn | `{ assetId, interval, err }`: a GET threw something other than a `BrokerRestError` (name and code) |
| `market data backfill tick failed` | error | `{ err }`: the backstop of the backfill's timers and of a GET's promise; no case reaches it |

The `market data` line, with counters for the period since the previous line:
`{ accounts, held, active: { accountId, socketState, connection, subscriptions } | null, reserve: { accountId, socketState } | null, ticks, ticksPerSec, late, invalid, skewed, holed, unknownAsset, skippedDigits, holes, lateClose: { watermark, clock }, failovers, watermarkLagMs, closed: { '15s', '5s' }, pairs, pending, backfill: { queued, fetched, filled, failed, rateLimited, spare }, seconds: { pairs, ahead, late, closedByTick, closedByClock, holeSeconds, resets }, buffer: { pairs, held, ahead, dropped, holes } }`.
`lateClose` counts ticks that changed a candle the ring already called closed, split by the rule
that closed it. `closed` counts tick candles whose bucket closed in the period. In `backfill`,
`queued` is the queue's length now and the rest count the period: answered GETs, rows put into the
ring, failed attempts, 429s, and spare tokens taken (one per GET started). In `seconds`, `pairs` is
the series' pairs now and the rest count the period: ticks more than the series' close margin past
their receipt (dropped for the series only), ticks at or before their pair's last closed second, seconds closed by a tick and by the clock, seconds closed as NaN after a drop, and pairs
emptied by a jump past the series' capacity ([h1.md](h1.md#the-second-series)). In `buffer`
(#668), `pairs` and `held` are the tick window's pairs and ticks now, and the rest count the
period: ticks whose watermark was clamped to their receipt + `TRADE_TICKS_AHEAD_MS`, ticks dropped
below a pair's floor or by its cap, and holes closed after a drop
([trade-log.md](trade-log.md#the-ticks-around-a-decision)). The client's state is
`socketState`, because the logger redacts every key named `state` (the OAuth state). No line carries a
token, the socket URL or a payload (`manager.test.ts` M11).

## Constants

`apps/backend/src/timing.ts`, checked at import with the backend chain:

| Constant | Value | Bounds |
|---|---|---|
| `MARKET_DATA_TICK_MS` | 30 000 | the tick: accounts, roles, new pairs |
| `MARKET_DATA_LOG_MS` | 60 000 | the `market data` line |
| `MARKET_DATA_FAILOVER_GRACE_MS` | 2 000 | the active out of `ready` (start, connection, reconnection) while a ready reserve waits |
| `MARKET_DATA_RESERVE_READY_MS` | 25 000 | the reserve out of `ready` before it gives way to the next account |
| `MARKET_DATA_SKEW_MARGIN_MS` | 2 000 | the clock rule of closing |
| `MARKET_DATA_ACCOUNT_RETRY_MS` | 300 000 | an account's hold-back |
| `MARKET_DATA_RING_CANDLES` | `SIGNAL_FETCH_LIMIT` (300) | candles per (pair, interval) |
| `MARKET_DATA_PENDING_MAX` | 288 | `request()`s waiting for the backfill (144 pairs × 2) |
| `MARKET_DATA_BACKFILL_BUDGET_MS` | 3 000 | one backfill GET, by the call's own signal |
| `MARKET_DATA_BACKFILL_ATTEMPTS` | 3 | failed attempts in a row on one element before `gave up` |
| `MARKET_DATA_BACKFILL_RETRY_MS` | 15 000 (`SIGNAL_CHART_INTERVAL_MS['15s']`) | an element's hold-back after any finished attempt |
| `MARKET_DATA_BACKFILL_SCAN_MS` | 5 000 (`SIGNAL_CHART_INTERVAL_MS['5s']`) | the queue's rebuild |
| `MARKET_DATA_BACKFILL_POLL_MS` | 250 | a spare token asked for while the queue is not empty |
| `MARKET_DATA_BACKFILL_CONCURRENCY` | 2 | backfill GETs in flight |

The backfill's slack is `SIGNAL_SCAN_SLACK_MS` (500) and its GET's limit `MARKET_DATA_RING_CANDLES + 1`.
The second series and the H1 shadow have four constants of their own in the same file
(`H1_SECOND_CLOSE_MARGIN_MS`, `H1_SHADOW_TICK_MS`, `H1_SHADOW_LOG_MS`, `H1_SERIES_CAPACITY_SEC`),
with their links: [h1.md → Constants](h1.md#constants). The tick window has `TRADE_TICKS_BUFFER_MS`
(240 000), `TRADE_TICKS_MAX_PER_PAIR` (10 000) and `TRADE_TICKS_AHEAD_MS` (500), chained with the
keeper's constants in the same file ([trade-log.md → The ticks around a decision](trade-log.md#the-ticks-around-a-decision)).

The links:

- `BROKER_SOCKET_RECONNECT_DELAY_MS × (1 + JITTER) < GRACE`: the client's first reconnection attempt,
  at its longest jitter, starts inside the grace. Its handshake (connect, then `user.auth`) is not
  bounded here: a slower one ends in the switch.
- `GRACE < 5 s`: the switch happens within one `5s` candle.
- `BROKER_HTTP_TIMEOUT_MS + SOCKET_CONNECT + SOCKET_AUTH < RESERVE_READY` (20 s < 25 s): a start ends first.
- `SKEW_MARGIN < 5 s` and `< TICK_MAX_SKEW_MS`.
- `TICK ≤ LOG`.
- `SERVICE_ACCOUNTS_TICK_MS < ACCOUNT_RETRY`: the keeper gets a tick to repair an account before it
  is retried.
- `stop()` waits for the `accessToken` calls in flight (at most two, at once), which
  `BROKER_HTTP_TIMEOUT_MS < SHUTDOWN_PHASE1_BUDGET_MS` already bounds.
- The backfill: `BACKFILL_BUDGET < BROKER_REST_TIMEOUT_MS` (the budget, not the client, ends a slow
  GET) and `< SHUTDOWN_PHASE1_BUDGET_MS` (its `stop()` aborts and waits for at most one GET a worker,
  at once); `BACKFILL_POLL × MAX_SIGNAL_SCAN_PER_MINUTE ≤ 60 000` (no overflow
  token is lost between two polls); `BACKFILL_SCAN ≤ 5 s`.

## Tests

- `ring.test.ts` R1-R9, R12, with R3b/R3c (`lateClose`).
- `source.test.ts` S1-S3; S4-S6 the adapter `createCandleSource` (#405).
- `backfill.test.ts` B1-B17, with B2b-B2d, B3c-B3e and B5b, on a fake `getChart`, the real ring and the real pacer under an injected
  clock.
- `manager.test.ts`:
  - M1-M6, M8-M14 on `packages/mock-broker`, with two users;
  - M7-M7e, M10b, M15, M16, M19-M25 and M27 on fake clients, because the mock has one token per user
    and cannot authorise an exchanged one, its clients never throw, and its states cannot be held;
  - M26 on the mock broker with the real backfill and REST client: a failover's hole refilled;
  - M28 on fake clients: the tick store keeps the active's ticks only (#666);
  - M11 reads the log itself. It reads the lines of every case before it, so alone or shuffled it
    fails falsely; `vitest.config.ts` pins the order.
- `ticks.test.ts` T1-T4: the tick store (#666); T5-T15 the window: bounds and order, the prune
  floor, the cap, holes after a drop, the first-tick coverage, the clamp of a tick ahead of its
  receipt (#668). `manager.test.ts` M32, M32b: both `onDrop` sites reach the window, the `buffer`
  line.
- The timing pins are in `timing.test.ts`.

## Accepted risks

1. **Unmeasured: does the broker send `price.update` to every socket of a user?** If it does, a
   worker session on a trading service account receives about 555 ticks a second. The worker has
   no handler for them, so the cost is the worker's CPU (the spike measured 3.7 % of one vCPU for
   the full stream). Falsifiable: the `events` count in the worker's `broker socket disconnected`
   line for such a session runs to thousands.
2. **One service account on the pilot.** On the active, any of these leaves the stream without a
   socket for `MARKET_DATA_ACCOUNT_RETRY_MS` (5 min): `disconnected_by_server`, a foreign
   `user.data`, a refused exchange, or a second token refusal within 5 min. The first token refusal
   costs one start.
3. **Closing may come before a bucket's last ticks.** The clock rule can close early when the
   process clock runs ahead of the broker's by more than the margin during a quiet stream. The
   watermark rule can close early because ticks of different pairs arrive out of timestamp order.
   Falsifiable: `lateClose.clock` or `lateClose.watermark` > 0 in the line.
4. **A quiet pair's boundary candle may still be open at the scan** (#405). The scanner fires
   `SIGNAL_SCAN_SLACK_MS` after the boundary, before the clock rule's margin; a pair with no tick
   past the boundary yet is decided on the candle before, which is not served. The scanner counts
   these as `unclosed` ([signal.md → The scanner](signal.md#the-scanner-343)). Falsifiable:
   `unclosed / decided` above 5 % in trading hours.
5. **The subscription limit of one socket is unmeasured** (#555). 144 ids worked on one socket for
   30 minutes.
6. **A pair that left the catalog stays subscribed** until a restart.
7. **Memory:** 144 × 2 × 300 candles, about 5 MB plus the builders.
8. **One backend process.** Two replicas would open two active sockets. There is no lease (#93).
9. **A change of a pair's `digits`** applies after a restart.
10. **An active out of `ready` with no ready reserve is not vacated:** the stream waits for its own
    reconnection (≤ 15 s apart), or for a reserve R2 finds by rotation. Falsifiable: a `market data`
    line with `active.socketState` not `ready` two periods in a row and `reserve: null`.
11. **A fresh active slower than the grace gives way to a ready reserve.** The answer of the dropped
    start, perhaps with an exchange, is not lost: the token stays in the row, and the old account
    starts as the reserve. The cost is one more `accessToken` and perhaps a socket. Falsifiable: more
    than a few `market data failover { reason: 'not_ready' }` an hour with a healthy broker.
12. **The list stops a socket on the next tick, not at once** (an unmark, a blocked user, a revoked
    account; after a database error, on the next good read); a new start of a blocked user does not
    pass the token service. Falsifiable: a `market data` line with an account unmarked > 60 s ago.
13. **A 429 on an exchange holds only its account**, and each other account that hits it. Falsifiable:
    more than `n` lines `market data token refused { reason: 'refresh_rate_limited' }` in 5 min.
14. **A bucket the watermark closed just before a backfill GET may come partial.** A bucket closed
    less than about 150 ms (the broker's publication delay, #392 spike) before the request, while the
    process clock runs behind the broker's by more than `SIGNAL_SCAN_SLACK_MS` minus 150 ms, can be
    answered before the broker has published it: the same assumption as the scanner's slack
    ([signal.md](signal.md)).
15. **A bucket the ring had not closed when a GET was built waits for the hold-back** (≤ 15 s, one
    more GET), as in a quiet stream within the first `MARKET_DATA_SKEW_MARGIN_MS` of a candle.
    Falsifiable: `backfill.fetched` grows faster than the number of elements per period while
    `filled` stays near 0.

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
4. The backfill (#590), after the first night:
   `docker compose logs --since 12h backend | grep -E '"market data"' | tail -3`. In `backfill`,
   `fetched > 0` and `filled > 0`, and `queued` has fallen to 0; `spare` grows with `queued`, and the
   `signal scanner` lines show `source: "live"`.
5. After any `market data failover`, `queued` rises and is back to 0 within minutes, in the day too.

## Boundaries

- The feed and the scanner reading the source, one pacer instead of two, and the end of the budget
  split of #382 shipped in #405 ([signal.md → The budget](signal.md#the-budget)).
- No trade command is sent on a data socket: the manager never calls `openTrade`, and the backfill
  calls only `getChart`.
- The tick window keeps the last 240 s of ticks per pair in memory only; what is kept of it is the
  trade log's `decision_ticks` ([trade-log.md](trade-log.md#the-ticks-around-a-decision)).
- The second series keeps one close per second, not the ticks; the H1 shadow on it is #669
  ([h1.md](h1.md)).
