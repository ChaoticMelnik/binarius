# Mock broker: the REST fixture (issue #103)

`packages/mock-broker` (`@binarius/mock-broker`) is a test-only stand-in for the Binodex Broker
API. A test starts it on `127.0.0.1` with a random port and points its client at it. The fixture
answers the four REST endpoints of #103: the user, the binary pairs, the user's trades (list and
open), and the chart. A test can also script a failure for the next request on any of them: a
429, a 5xx, a delay, or a request that never answers. It is a library only. Nothing in the repo
starts it as a process or a compose service; that is #105.

```bash
pnpm test packages/mock-broker   # the fixture's own tests; they need no database
```

## Use

```ts
import { startMockBroker } from '@binarius/mock-broker';

const broker = await startMockBroker();
broker.users.register({ id: 1, accessToken: 'access-1' }); // demo 10000.00, real 0.00
const client = new SomeClient({ baseUrl: broker.url }); // the client adds /v1/broker/...

broker.rest.failNext('openTrade', { status: 429, retryAfterSec: 2 });
// the next POST /v1/broker/user/trades answers 429 with Retry-After: 2, the one after is normal

const [trade] = broker.trades.list(1);
broker.trades.settle(Number(trade.id), { outcome: 'win' });
await broker.close();
```

| Member | What it does |
| --- | --- |
| `url` | `http://127.0.0.1:<port>`, without the `/v1/broker` prefix |
| `state` | the store behind the routes (`createBrokerState()`); #104 attaches Socket.IO to the same store and announces `state.onChange` events (`trade_opened`, `trade_closed`, `pair_updated`) |
| `users.register(seed)` | a user with a bearer token; defaults: level `standard`/1, `min_trade_amount` `1.00`, demo `10000.00` (#8), real `0.00` |
| `users.revokeToken(token)` | the token is answered `Invalid token` from then on |
| `users.get(id)` | the `GET /user` body |
| `pairs.list()` / `pairs.update(id, { payout?, scheduled_until? })` | the catalogue, `DEFAULT_PAIRS` unless `options.pairs` is given |
| `trades.list(userId)` | every trade of the user, newest first |
| `trades.settle(tradeId, { outcome, closePrice?, closeTimestamp? })` | closes an open trade; a second call throws |
| `rest.failNext(endpoint, script)` | queues a script for the next request on `user`, `pairs`, `tradesList`, `openTrade` or `chart` |
| `rest.journal` / `rest.clearJournal()` | every request, without the token or any body value |
| `rest.pendingHangs` | how many `hang` requests are still waiting for `close()`; one whose client aborted is dropped |
| `priceAt(assetId, atMs)` | the one price curve that produces chart candles, `open_price` and the default `close_price` |
| `close()` | answers every hanging request with 503, then stops the server; rejects with an `AggregateError` if an `onChange` listener threw and the errors were not cleared ([Listeners](#listeners)) |

There are no timers and no fake clock. A trade stays open until a test settles it. Times come
from `Date.now()`, so tests check relations between values (`close_timestamp = open_timestamp +
duration * 1000`), not absolute times.

## Listeners

`state.onChange(listener)` is called after every change is committed: a trade opened or
closed, a pair updated. A listener must not throw. If one does, the change stands, the other
listeners still run, the HTTP client gets its normal answer, and the error is kept in
`state.listenerErrors`. `close()` then rejects with an `AggregateError` of those errors, so a
test that did not expect them fails at teardown. A test that throws on purpose reads the errors
and calls `state.clearListenerErrors()` before `close()`. This is fixture behaviour, not the
broker's.

## Endpoints

All routes are under `/v1/broker`. Without the `/v1` prefix the live broker answers 404, and so
does the fixture.

| Route | Auth | Answer |
| --- | --- | --- |
| `GET /v1/broker/user` | bearer | `{ id, level, min_trade_amount, real, demo }`, where `real` and `demo` are `{ available, held, total }` and `total = available + held` |
| `GET /v1/broker/pairs/binary` | none | `BinaryPair[]`; `scheduled_until` is ms epoch, `0` means no restriction |
| `GET /v1/broker/user/trades` | bearer | `{ trades: [...] }`, open and closed trades together, newest first by `open_timestamp`; query `status=open\|closed`, `is_demo=true\|false`, `limit` (default 20), `offset` (default 0) |
| `POST /v1/broker/user/trades` | bearer | body `{ asset_id, amount, action, duration, is_demo }`, validated by shared's `openTradeRequestWireSchema`; answers 200 with the open trade |
| `GET /v1/broker/chart` | none | `[ts_ms, open, high, low, close][]`; query `asset_id`, `interval`, `start_time`, `limit` |

Opening a trade moves the stake from `available` to `held` in the trade's mode.
`potential_profit = floor(amount * payout / 100)`, in cents. `settle` releases the stake from
`held`. A win credits `available` with the stake plus `potential_profit` and records `profit =
potential_profit`. A loss records `profit = -amount`. Without `closePrice`, the close price
agrees with the outcome: it lies on the side of `open_price` the outcome needs, at least one tick
away. An explicit `closePrice` is used as given, even when it contradicts the outcome.

The checks on opening a trade run in this order: the amount has at most 2 decimals, the asset
exists, the asset is not scheduled (`scheduled_until > now`), the duration is within
`[min_timeframe, max_timeframe]`, the amount is at least `min_trade_amount`, the amount is at
most `available`. The bounds are inclusive.

Chart rules: the candles start at `start_time` rounded down to the step and are spaced one step
apart. No candle starts after now. `limit` defaults to 100, and anything above 5000 is cut to
5000. A step below 5 s, or a `start_time` below `1e11` (seconds rather than ms), answers `[]`.
`M` is 30 days. A candle's close equals the next candle's open, and `low <= min(open, close) <=
max(open, close) <= high`. Every value is rounded to the pair's `digits`.

Every response carries `x-ratelimit-limit` (`options.rateLimit`, default 600),
`x-ratelimit-remaining` (counted in a fixed 60-second window, never below 0) and
`x-ratelimit-reset` (the window's end, in unix seconds). The fixture never sends a 429 on its
own; only a script does.

## Observed vs fixture rule

The texts live in `packages/mock-broker/src/messages.ts`. `LIVE_MESSAGES` holds texts seen in
read-only, unauthenticated probes of `api.binodex.app` on 2026-10-02. `FIXTURE_MESSAGES` holds
texts the fixture chose because the live answer needs credentials, a real trade or a real rate
limit. A client classifies by status, never by text. All 4xx and 5xx responses use the envelope
`{"error":{"message","details":{}}}`, except the 404 for an unknown path.

| Case | Status | Text | Source |
| --- | --- | --- | --- |
| no `Authorization`, not `Bearer <token>`, or an empty token | 401 | `Authentication failed: Missing bearer token` | observed (the case-sensitive scheme is a fixture rule) |
| unknown or revoked token | 401 | `Authentication failed: Invalid token` | observed |
| auth before the body is read | 401 | (as above) | observed |
| unknown path | 404 | `{"code":404,"message":"Sorry, the <host><path> HTTP method <METHOD> resource you are looking for was not found."}` | observed |
| chart `interval` not `^\d+(ms\|s\|m\|h\|d\|w\|M)$` | 400 | `Unsupported interval <raw>; expected "250ms" / "5s" / "1m" / "1h" / "1d" / "1w" / "1M" forms` | observed |
| chart unknown, missing or non-numeric `asset_id` | 400 | `Unknown asset` | observed (missing: fixture rule) |
| chart missing or non-numeric `start_time` | 400 | `Validation failed: "start_time" (ms epoch) is required` | observed (non-numeric: fixture rule) |
| chart missing `interval` | 400 | `Validation failed: "interval" is required` | fixture rule |
| chart order: interval, then asset, then start_time | | | observed |
| chart step below 5 s, `start_time` in seconds | 200 | `[]` | observed (the 5 s threshold is an approximation) |
| trade body field missing | 400 | `Validation failed: "<field>" is required` | fixture rule, in the observed `"code" is required` form |
| trade body field present but wrong (a JSON-number `amount`, `"0.00"`, `"1."`, an unknown `action`, …) | 400 | `Validation failed: "<field>" is invalid` | fixture rule |
| trade amount with more than 2 decimals | 400 | `Validation failed: "amount" must have at most 2 decimal places` | fixture rule |
| trade on an unknown asset | 400 | `Unknown asset` | fixture rule (text borrowed from the chart) |
| trade on a scheduled asset | 400 | `Asset is not available` | fixture rule |
| duration out of range | 400 | `Unsupported duration` | fixture rule |
| amount below `min_trade_amount` | 400 | `Amount is below the minimum` | fixture rule |
| amount above `available` | 400 | `Insufficient balance` | fixture rule |
| trades query `status` / `is_demo` invalid | 400 | `Validation failed: "<field>" must be one of [...]` | fixture rule |
| trades query `limit` / `offset` invalid | 400 | `Validation failed: "limit" must be a positive integer` / `"offset" must be a non-negative integer` | fixture rule |
| body not JSON, empty JSON body, non-JSON content type | 400 | `Validation failed: body is not valid JSON` | fixture rule |
| body over 1 MiB (Fastify's `bodyLimit`), or any other client error Fastify raises | 413 (or Fastify's 4xx) | `Request failed` | fixture rule |
| anything the fixture throws | 500 | `Internal error` | fixture rule |
| `x-ratelimit-*` on every response | | | observed |

## Scripts: `failNext`

Each endpoint has its own FIFO queue, and each script is used once. `failNext` throws on a script the fixture cannot play as written: a `RangeError` for a status outside 200..599 or a negative or fractional `delayMs`/`retryAfterSec`, a `TypeError` for an object of no known shape or one that mixes shapes. The three shapes exclude each other: exactly one of `status`, `delayMs`, `hang: true`, and `delayMs`/`hang` take no other field. The type says the same, so `{ status: 429, delayMs: 50 }` does not compile. A script is applied before
auth and validation, like a failure in front of the broker, so a script on `user` also fires for
a request without a token.

| Script | Effect |
| --- | --- |
| `{ status, body?, headers?, retryAfterSec? }` | answers `status`. Without `body`, a status of 400 or more gets the envelope with a default text: 429 `Too many requests`, 502/503/504 `Service unavailable`, other 5xx `Internal error`, other 4xx `Request failed`. `Retry-After` is sent only when `retryAfterSec` is given. `{ status: 200, body }` serves a contract-violating body as is |
| `{ delayMs }` | waits, then handles the request as if it arrived only then: the rate-limit headers, the token check and the store are all read after the delay, so a token revoked during it is refused and a user registered during it is accepted. If the client aborts first, the late answer goes nowhere and the fixture keeps serving |
| `{ hang: true }` | no answer until `close()`, which answers 503 `Connection closed by fixture` (with the rate-limit headers of that moment) and returns at once. A client that aborts first leaves the queue (`rest.pendingHangs`) |

`close()` during a `{ delayMs }` cuts the request off: the delay is cancelled, the client's
connection is dropped without an answer, and nothing more runs for that request.

The 429 body text and `Retry-After` were never observed: a real 429 would mean hammering the API.

## Journal

`rest.journal` holds one record per request, in arrival order: `{ method, path, endpoint?,
query, bearer, bodyKeys?, scripted }`. A test can prove what its client sent, and no token
value or body value is stored, so the journal never collects secrets. The fixture runs with
`logger: false`.

`bearer` is `'none'`, `'known'` or `'unknown'`: the `Authorization` header checked against the
token table. It is read once per request, together with the request's user and the
`x-ratelimit-*` headers, at the moment the fixture answers the request or starts handling it.
Until then it is `'pending'`, which a test can see while a request waits on a delay or a hang.
No record is left `'pending'` after `close()`.

| Branch | Observed | Headers / rate window |
| --- | --- | --- |
| no script (a route or a 404) | on arrival | yes |
| `{ status … }` | on arrival, before the scripted answer | yes |
| `{ delayMs }` | after the delay, so a token revoked or registered during it counts | yes |
| `{ delayMs }` cut by `close()` | in `close()` | none: no answer, not counted |
| `{ hang }` answered by `close()` | in `close()`, before the 503 | yes |
| `{ hang }` aborted by the client | at the abort | none: no answer, not counted |

`bodyKeys` is present only where the body is read: without a script, or after a `{ delayMs }`.
A request answered by a script or a hang never has its body parsed.

## Drift

The fixture follows the shared contract wherever the contract has an answer. Each response is
checked in the fixture's own tests by shared's `safeParse*` functions. In the places below,
shared and the live broker (or `binodex/broker-web`) disagreed or shared was silent; items 1–3
are resolved, 4–5 remain:

1. **Money form. Resolved 2026-10-02.** The live `GET /v1/broker/user` answers every money field
   as a JSON integer. Since #98 shared accepts a decimal string or a safe JSON integer
   (`moneyWireSchema`) and maps both to `DecimalString`. The fixture still sends strings
   (`"10000.00"`) and does not mirror the live form, because the unit (whole currency units or
   minor units) is not known yet. Switching the fixture is a follow-up once the unit is
   confirmed (docs/broker-rest.md → Open items).
2. **Chart request. Resolved in #98.** Shared now takes `interval` only in the string form
   (`CHART_INTERVAL_PATTERN`) and requires `start_time`, as the live broker and the fixture do.
3. **`{ trades }` envelope. Resolved in #98:** `tradesListWireSchema`.
4. **`close_timestamp` and `symbol`.** An open trade carries `close_timestamp` (its expiry), and
   both open and closed trades carry `symbol`, as broker-web reads them. Shared's
   `openTradeWireSchema` knows neither field, and `closedTradeWireSchema` has no `symbol`. Zod
   drops unknown keys, so a parse of a fixture response does not see either field. The fixture's
   tests check both fields on the raw body, and one test fails once shared's parse keeps them,
   as a signal to drop the duplicate check.
5. **`is_demo`** is optional in broker-web and always present in shared and in the fixture. The
   live trade list was empty on 2026-10-02, so this waits for a live trade.

## Accepted risks

- The texts for refusing to open a trade are the fixture's own (#37 is open), and the client
  classifies by status. `Unknown asset` on trades is borrowed from the chart.
- `scheduled_until` is read as "not tradable until". This rests on a single non-zero live value,
  not confirmed by a trade.
- The trade list order (newest first) and its default limit of 20 are fixture rules. broker-web
  always passes `limit` and sorts on the client.
- The chart cap of 5000: the live broker answered `limit=5000` with 4999 rows. Whether that is a
  cap or the data window is not known.
- The status for opening a trade (200) was not observed.

## Boundaries

- The `BrokerRestClient` and its tests landed in #98 (docs/broker-rest.md). The issue's
  criterion "used by the `BrokerRestClient` tests" is closed there.
- Socket.IO on the same server and store: #104.
- The OAuth endpoints, moving `apps/backend/src/broker/testing/oauth-stub.ts` here, and a `bin`
  or compose service: #105.
- Changes to `packages/shared`: money, chart and `{trades}` landed in #98; `symbol` and
  `close_timestamp` (Drift 4) remain.
