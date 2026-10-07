# Pairs catalog (issue #138)

The backend keeps the broker's binary pairs (`GET /v1/broker/pairs/binary`) in an in-process
cache and serves it on `GET /trading/pairs`. The cache is refreshed by a timer every
`BROKER_PAIRS_TTL_MS`, warmed once before the HTTP server listens, and never fetched on the
request path. The broker's pairs need no token.

```bash
pnpm test --project unit packages/broker-rest packages/shared/src/catalog.test.ts apps/backend/src/trading/pairs-routes.test.ts   # needs no database or Redis
```

## Components

- `packages/broker-rest/src/pairs-catalog.ts` — `createPairsCatalog`, its constants and
  `PAIRS_CATALOG_CHAIN_HOLDS`. It lives beside the REST client (docs/broker-rest.md) so the
  worker can build the same module later rather than a copy.
- `packages/shared/src/catalog.ts` — the contract: `TRADING_PAIRS_PATH`, `PairsCatalogErrorCode`,
  `pairViewSchema` and `pairsCatalogResponseSchema`, the structural `PairsCatalogView` the cache
  hands out, and the allowlisted mapping `toPairView`/`toPairsCatalogResponse`.
- `apps/backend/src/trading/pairs-routes.ts` — the route, an encapsulated plugin behind
  `internalBearerAuth` (the bot's bearer), like the other internal routes.
- `apps/backend/src/index.ts` — the wiring: the client on `BROKER_API_BASE_URL`, the warm-up,
  the timer, the stop in shutdown phase 1.

## The module

```ts
const catalog = createPairsCatalog({ client, ttlMs, logger, now });
catalog.read();     // PairsCatalogView | undefined
catalog.refresh();  // Promise<boolean>
catalog.start();
catalog.stop();
```

- `refresh()` makes one `listPairs()` call and replaces the snapshot on success. It resolves
  `true` when the snapshot was replaced and `false` otherwise; it never rejects. While a call is
  in flight, every `refresh()` returns that same promise, the timer's tick included, so there is
  never more than one request.
- `fetchedAt` is `now()` taken after the answer was parsed: the age measures the data, not the
  attempt. `read()` gives `ageMs = max(0, now() - fetchedAt)`, both on the process clock. A clock
  that went back reads as age 0; one that jumped forward makes the snapshot look older until the
  next tick.
- `read()` is `undefined` before the first success and once the snapshot is older than
  `BROKER_PAIRS_MAX_STALE_MS`. An empty array from the broker is a valid snapshot, not a failure.
- `read()` also gives `fresh = ageMs <= ttlMs + BROKER_REST_TIMEOUT_MS`: the oldest a snapshot
  gets while every tick succeeds. Older means at least one refresh has failed, and the snapshot
  is still served (up to `BROKER_PAIRS_MAX_STALE_MS`) but no longer called fresh. The module owns
  the TTL, so the verdict is its own: neither the route nor the bot compares ages.
- A failed `refresh()` leaves the snapshot as it was and writes one `warn` line (see Logging).
  The next attempt is the next tick; there is no backoff, on 429 included.
- `start()` arms `setInterval(refresh, ttlMs)`. A second `start()` does nothing, and neither does
  a `start()` after `stop()`.
- `stop()` clears the timer and aborts the request in flight. That request resolves `false`
  without a log line, and every later `refresh()` resolves `false` without a request.

## Constants

In `packages/broker-rest/src/pairs-catalog.ts`:

| Constant | Value | What it bounds |
|---|---|---|
| `MIN_BROKER_PAIRS_TTL_MS` | 30 000 | lowest accepted `BROKER_PAIRS_TTL_MS` |
| `DEFAULT_BROKER_PAIRS_TTL_MS` | 30 000 | the timer's period when the env does not set one |
| `MAX_BROKER_PAIRS_TTL_MS` | 60 000 | highest accepted `BROKER_PAIRS_TTL_MS`; plus one request, the oldest age `read()` still calls fresh |
| `BROKER_PAIRS_MAX_STALE_MS` | 300 000 | how long the last snapshot is still served while every refresh fails |

`PAIRS_CATALOG_CHAIN_HOLDS` throws at import unless
`BROKER_REST_TIMEOUT_MS < MIN_BROKER_PAIRS_TTL_MS ≤ DEFAULT ≤ MAX < BROKER_PAIRS_MAX_STALE_MS` and
`MAX_BROKER_PAIRS_TTL_MS + BROKER_REST_TIMEOUT_MS < BROKER_PAIRS_MAX_STALE_MS` (65 000 < 300 000),
so a snapshot is served for longer than it is fresh.
Shutdown phase 1 does not wait for the catalog's GET: `stop()` aborts it (see Start and
shutdown), so the backend's chain (`apps/backend/src/timing.ts`) has no link for it.

`BROKER_PAIRS_TTL_MS` is parsed in `apps/backend/src/env.ts` as an integer between the MIN and the
MAX, default `DEFAULT_BROKER_PAIRS_TTL_MS`; an empty value is refused like every other variable.
compose forwards it to `backend` without a value, so it reaches the container only when the host
or `.env` sets it. The module itself takes any positive `ttlMs`.

## GET /trading/pairs

`Authorization: Bearer <INTERNAL_API_TOKEN>`, no body.

| Code | Body | When | What the bot does |
|---|---|---|---|
| `200` | `{ pairs: PairView[], fetchedAt, ageMs, fresh }` | the cache has a snapshot no older than `BROKER_PAIRS_MAX_STALE_MS`; `fresh` is the module's verdict above | `fresh: true` — draws the screen from it; `fresh: false` — shows none of it, says the catalog is updating and offers «🔄 Повторить» (docs/bot-demo.md). `fresh` is required: a body without it is a contract violation, so an older backend never reads as fresh |
| `503` | `{ error: 'catalog_unavailable' }` | no snapshot yet, or the broker has been failing for longer than the ceiling; a read, nothing happened | says the catalog is unavailable and offers «🔄 Повторить»; told by the reason, not the status; not an unknown outcome |
| `401` | `{ error: 'unauthorized' }` | the bearer did not match | configuration, not a user scenario |
| other | `{ error: 'internal' }` | the app's error handler | like any 500 |

`PairView` names `BinaryPair`'s fields one by one: `id`, `symbol`, `isOtc` (absent when the broker
omits it), `type`, `digits`, `payout`, `maxPayout`, `minTimeframe`, `maxTimeframe`,
`scheduledUntil`. A field the broker adds later reaches the bot only once it is added to
`pairViewSchema` and `toPairView`. The catalog is global and unfiltered: no filter by
`scheduledUntil` or by duration.

## Start and shutdown

- The catalog is created before the app, warmed with one `refresh()` after the signal handlers
  are registered and before `app.listen()`, then its timer is started and
  `pairs catalog started` is logged with `warmed`. The warm-up waits at most
  `BROKER_REST_TIMEOUT_MS` (5 s), inside the backend healthcheck's `start_period` (20 s).
- A broker that is down at start does not stop the process: the warm-up logs its `warn`,
  `warmed` is `false`, and the route answers 503 until a tick succeeds.
- Shutdown phase 1 calls `stop()` beside `app.close()`. A SIGTERM during the warm-up aborts it,
  and the start-up after it (`start()`, `listen()`, the publisher, the balance reconciler and the
  staff bot) is skipped because `shutdown()` has already set `shuttingDown`. The start-ups after
  `listen()` re-check `shuttingDown`, so a SIGTERM during `listen()` skips them too.

## Logging

One line per failed refresh, at `warn`:

```json
{ "err": { "name": "BrokerRestError", "code": "rate_limited" }, "status": 429, "retryAfterSec": 7, "msg": "pairs catalog refresh failed" }
```

`status`, `retryAfterSec` and `detail` (the broker's message, at most 200 characters) appear only
when the error has them. The line holds neither the base URL nor any of the response body beyond
`detail`.
`pairs-catalog.test.ts` reads these lines back through a pino logger built with `logOptions`.

## Boundaries

- Not taken by #99/#101 and still open: the socket's `common.assets_list`/`common.assets_update`
  as a source of updates, the catalog instance in the worker, and the `refresh()` call on
  reconnect. `BROKER_API_BASE_URL` is in the worker's env since #90.
- The bot's client for `GET /trading/pairs` and the asset picker: docs/bot-demo.md (#125).
- #136/#137: `POST /trading/access` and its broker section.
- Not done anywhere yet: the catalog in `/health`, `GET /trading/pairs/:id`, backoff on 429/5xx.
