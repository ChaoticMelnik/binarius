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
  worker can build the same module later (#101) rather than a copy.
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
| `MAX_BROKER_PAIRS_TTL_MS` | 60 000 | highest accepted `BROKER_PAIRS_TTL_MS`; the oldest age a caller sees under a working broker, plus one request |
| `BROKER_PAIRS_MAX_STALE_MS` | 300 000 | how long the last snapshot is still served while every refresh fails |

`PAIRS_CATALOG_CHAIN_HOLDS` throws at import unless
`BROKER_REST_TIMEOUT_MS < MIN_BROKER_PAIRS_TTL_MS ≤ DEFAULT ≤ MAX < BROKER_PAIRS_MAX_STALE_MS`.
The backend's own chain (`apps/backend/src/timing.ts`) adds
`BROKER_REST_TIMEOUT_MS < SHUTDOWN_PHASE1_BUDGET_MS`: a warm-up or a tick in flight ends inside
phase 1 even when `stop()` did not cut it.

`BROKER_PAIRS_TTL_MS` is parsed in `apps/backend/src/env.ts` as an integer between the MIN and the
MAX, default `DEFAULT_BROKER_PAIRS_TTL_MS`; an empty value is refused like every other variable.
compose forwards it to `backend` without a value, so it reaches the container only when the host
or `.env` sets it. The module itself takes any positive `ttlMs`.

## GET /trading/pairs

`Authorization: Bearer <INTERNAL_API_TOKEN>`, no body.

| Code | Body | When | What the caller does (#125) |
|---|---|---|---|
| `200` | `{ pairs: PairView[], fetchedAt, ageMs }` | the cache has a snapshot no older than `BROKER_PAIRS_MAX_STALE_MS` | show it; how fresh is fresh enough is the caller's decision from `ageMs` against `MAX_BROKER_PAIRS_TTL_MS` |
| `503` | `{ error: 'catalog_unavailable' }` | no snapshot yet, or the broker has been failing for longer than the ceiling; a read, nothing happened | say the catalog is unavailable and offer to retry; not an unknown outcome |
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
  and the start-up after it (`start()`, `listen()`, the publisher and the staff bot) is skipped
  because `shutdown()` has already set `shuttingDown`. A SIGTERM during the `listen()` call
  itself is not covered; that window predates the catalog.

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

- #99/#101: the socket's `common.assets_list`/`common.assets_update` as a source of updates, the
  catalog instance in the worker, `BROKER_API_BASE_URL` in the worker's env, and the `refresh()`
  call on reconnect.
- #125: the bot's client for `GET /trading/pairs`, the asset picker and its use of `ageMs`.
- #136/#137: `POST /trading/access` and its broker section.
- Not done anywhere yet: the catalog in `/health`, `GET /trading/pairs/:id`, backoff on 429/5xx.
