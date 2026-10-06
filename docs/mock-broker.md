# Mock broker: the REST and Socket.IO fixture (issues #103, #104)

`packages/mock-broker` (`@binarius/mock-broker`) is a test-only stand-in for the Binodex Broker
API. A test starts it on `127.0.0.1` with a random port and points its client at it. The fixture
answers the four REST endpoints of #103: the user, the binary pairs, the user's trades (list and
open), and the chart. A test can also script a failure for the next request on any of them: a
429, a 5xx, a delay, or a request that never answers. The same server and the same store also
speak the broker's Socket.IO protocol (#104, [Socket.IO](#socketio)). It is a library only.
Nothing in the repo starts it as a process or a compose service; that is #105.

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
| `url` | `http://127.0.0.1:<port>`, without the `/v1/broker` prefix; also the Socket.IO URL |
| `state` | the store behind the routes and the socket (`createBrokerState()`); it announces `state.onChange` events (`trade_opened`, `trade_closed`, `pair_updated`, `token_revoked`) |
| `users.register(seed)` | a user with a bearer token; defaults: level `standard`/1, `min_trade_amount` `1.00`, demo `10000.00` (#8), real `0.00`; the defaults are decimal-string seeds, on the wire they go out as JSON numbers (`1`, `10000`, `0`) |
| `users.revokeToken(token)` | the token is answered `Invalid token` from then on, and every socket of its user gets `user.disconnect_token_expired` and is dropped |
| `users.get(id)` | the `GET /user` body |
| `pairs.list()` / `pairs.update(id, { payout?, scheduled_until? })` | the catalogue, `DEFAULT_PAIRS` unless `options.pairs` is given |
| `trades.list(userId)` | every trade of the user, newest first |
| `trades.settle(tradeId, { outcome, closePrice?, closeTimestamp? })` | closes an open trade; a second call throws |
| `rest.failNext(endpoint, script)` | queues a script for the next request on `user`, `pairs`, `tradesList`, `openTrade` or `chart` |
| `rest.journal` / `rest.clearJournal()` | every request, without the token or any body value |
| `rest.pendingHangs` | how many `hang` requests are still waiting for `close()`; one whose client aborted is dropped |
| `socket` | the Socket.IO side: scripts, journal, connected sockets, price pushes ([Socket.IO](#socketio)) |
| `priceAt(assetId, atMs)` | the one price curve that produces chart candles, `open_price`, the default `close_price` and `price.update` |
| `close()` | answers every hanging request with 503, drops every socket, then stops the server; rejects with an `AggregateError` if an `onChange` listener threw and the errors were not cleared ([Listeners](#listeners)) |

There are no timers and no fake clock. A trade stays open until a test settles it. Times come
from `Date.now()`, so tests check relations between values (`close_timestamp = open_timestamp +
duration * 1000`), not absolute times.

## Listeners

`state.onChange(listener)` is called after every change is committed: a trade opened or
closed, a pair updated, a known token revoked (an unknown token changes nothing and announces
nothing). The socket layer is one such listener. A listener must not throw. If one does, the change stands, the other
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
apart. No candle starts after now, and the forming candle is included (observed live
2026-10-06, as is the rounding of `start_time` down to the step). `limit` defaults to 100, and
anything above 5000 is cut to 5000. A step below 5 s, or a `start_time` below `1e11` (seconds
rather than ms), answers `[]`. `M` is 30 days. A candle's close equals the next candle's open,
and `low <= min(open, close) <= max(open, close) <= high`. Every value is rounded to the pair's `digits`.

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

## Socket.IO

The Socket.IO server runs on the fixture's own HTTP server, so `broker.url` is both the REST
base URL and the socket URL. Namespace `/`, path `/socket.io`, as in broker-web. Only the
`websocket` transport is accepted: a client that keeps the default transports starts with
polling and gets `connect_error`. The live transports are not known, and #99 is websocket-only.

```ts
import { io } from 'socket.io-client';
import { startMockBroker } from '@binarius/mock-broker';

const broker = await startMockBroker({ socketPayload: 'bytes' }); // as the live broker sends
broker.users.register({ id: 1, accessToken: 'access-1' });
const socket = io(broker.url, { transports: ['websocket'], reconnection: false });
socket.emit('user.auth', { id: 1, token: 'access-1' });
// user.auth.success (null), user.data, common.assets_list, then six observed extras

broker.socket.failNext('openTrade', { disconnect: true, open: true });
// the next open_trade drops the socket and the trade opens anyway
```

The socket never changes balances or trades itself: it calls the store, and every event that
follows a change (`update_balance`, `close_trade.success`, `assets_update`,
`disconnect_token_expired`) comes from one `state.onChange` listener. A REST trade, a socket trade
and `settle()` therefore reach the sockets the same way. There are no timers: every event is
the answer to an incoming event, to a store change, or to a `broker.socket.*` call.

| `broker.socket` member | What it does |
| --- | --- |
| `failNext(endpoint, script)` | queues a script for the next `user.auth` (`'auth'`) or the next `open_trade` in either mode (`'openTrade'`) |
| `journal` / `clearJournal()` | every incoming event, without the token or any payload value |
| `sockets()` | the connected sockets in connection order: `{ id, userId?, subscriptions }`, subscriptions sorted |
| `disconnect({ userId } \| { socketId })` | the server drops each matching socket (`io server disconnect` at the client); returns how many |
| `cutTransport({ userId } \| { socketId })` | closes each matching socket's transport without a DISCONNECT packet: the client sees `transport close` and its own reconnection runs, the shape of the live drop of 2026-10-02 ([Observed vs fixture rule](#observed-vs-fixture-rule-1)); returns how many |
| `emitRaw({ userId } \| { socketId }, event, ...args)` | emits exactly these arguments to each matching socket, outside the payload form and the journal: a malformed payload, extra arguments or an unknown event name; returns how many |
| `pushPrice(assetId, atMs = Date.now())` | one `price.update` to each socket subscribed to the asset; returns how many. An asset without a pair throws `RangeError` |
| `pushPrices(atMs = Date.now())` | one `price.update` per subscription of every socket, ids without a pair skipped; returns how many were sent |
| `pendingDelays` | `openTrade` scripts still waiting on their `delayMs` |

### Client → server

Every incoming event is a journal record first. An event name the fixture does not know is
recorded as `unknown` and ignored. A trailing ack function is counted in `argc` and never called
(broker-web uses no acks, and none was seen live).

| Event | Checks, in order | Answer |
| --- | --- | --- |
| `user.auth { id, token }` | an `auth` script; shared's `userAuthWireSchema` (`invalid`: `user.auth.error` with `Validation failed: "<field>" is required` / `is invalid`); the token belongs to `id`, compared as strings so `'1'` matches `1` (`auth_failed`: `Authentication failed: Invalid token`) | `user.auth.success` with one argument, `null`, then `user.data`, `common.assets_list` and the six observed extras below, in this order. A repeated `user.auth` is handled like the first: the burst comes again, a different user moves the socket to that user's events, and the subscriptions stay |
| `price.subscribe { assets }` | authenticated (else nothing); shared's `priceSubscribeWireSchema`, 1..40 integers (else nothing, `invalid`) | the ids are added to the socket's subscriptions; `price.subscribed { assets }` echoes the request. An id without a pair is kept, and `pushPrices` skips it |
| `user.{demo,real}.open_trade { asset_id, amount, action, duration }` | authenticated (else nothing, and a queued `openTrade` script stays queued); an `openTrade` script; shared's `socketOpenTradeRequestWireSchema` (`.fail [{ message, field }]`, same texts as the REST body); the store's checks, in the REST order (`.fail [{ message }]`, same texts as REST) | the trade opens in the event's mode. `user.<mode>.update_balance` goes to every socket of the user first, then `user.<mode>.open_trade.success` (the REST trade body, with `close_timestamp` and `symbol`) to the sender only |

A failed `user.auth` leaves the socket as it was: a socket that never authenticated stays
unauthenticated, and one that had authenticated keeps its user. Nothing before `user.auth`
reaches a socket.

### Server → client

Every payload except `null` goes through the fixture's payload form ([Payload forms](#payload-forms)).

| Event | When | To |
| --- | --- | --- |
| `user.auth.success` (`null`), `user.auth.error { message }` | `user.auth` | the sender |
| `user.data`, `common.assets_list` | a successful `user.auth` | the sender |
| `user.real.close_trade.recent { trades: [] }`, `user.demo.close_trade.recent { trades: [] }`, `user.real.futures.positions { positions: [], orders: [] }`, `user.real.futures.closed.recent { orders: [] }`, `user.demo.futures.positions { … }`, `user.demo.futures.closed.recent { … }` | a successful `user.auth`, after `common.assets_list`, in this order; always empty | the sender |
| `price.subscribed { assets }` | `price.subscribe` | the sender |
| `price.update [assetId, price, atMs]` | `pushPrice` / `pushPrices`; `price` is `priceAt(assetId, atMs)` | subscribed sockets |
| `user.<mode>.open_trade.success` / `.fail` | `open_trade` | the sender |
| `user.<mode>.update_balance { available, held, total }` | a trade opened or settled in that mode, over REST or the socket | every socket of the user |
| `user.<mode>.close_trade.success { trades: [closed] }` | `trades.settle()`, before that mode's `update_balance` | every socket of the user |
| `common.assets_update { asset_id, payout, scheduled_until }` | `pairs.update()`, even with an empty patch | every authenticated socket |
| `user.disconnect_token_expired` (`null`), then the server drops the socket | `users.revokeToken()` of a known token | every socket of the user |

Money is JSON numbers, as on REST and as the live broker sends it (Drift 1 and 6). All 15 server→client events of shared's
`BrokerServerToClientEvents` are emitted. The last test of `socket.test.ts` triggers each one in a
single test and fails on a missing one; a type check in the same file fails to compile if
the contract gains an event that the list does not name.

### Observed vs fixture rule

Observed on 2026-10-02 against the live broker (tech-lead's probe, socket.io-client 4.8.4,
without trades; docs/broker-socket.md → Observed live):

| Fact | Source |
| --- | --- |
| auth by the `user.auth { id, token }` event, not by handshake options | observed |
| `user.auth.success` as one argument, `null` | observed |
| the burst after auth: `user.data`, `common.assets_list`, then the six extras in the order of the table above | observed |
| the six extras' payloads always empty | observed empty; the fixture never fills them |
| `price.subscribed { assets }` after `price.subscribe` | observed with one id; the echo and the additive subscriptions are fixture rules |
| `price.update` as one array `[assetId, price, third]` | observed; the third element is `atMs` here, its live unit is not known |
| every payload a Node `Buffer` | observed: the `bytes` form |
| `is_otc` on every pair of `common.assets_list` | observed; every `DEFAULT_PAIRS` entry carries it |
| `user.auth.error`, `user.disconnect_token_expired`, `open_trade.success/.fail`, `update_balance`, `close_trade.success`, `common.assets_update` | not observed: from shared and broker-web (#8). The texts are the REST texts; a client classifies by the event, never by the text |
| `update_balance` before `open_trade.success`, `close_trade.success` before `update_balance` | fixture rules (the store announces a change before the socket answers) |
| ack callbacks never called, websocket only, no idle drop | fixture rules |
| an `open_trade` accepted before a token revocation still opens after a `delayMs` | fixture rule: the command was accepted under a valid session, and the store does not check tokens. For a client this is the "outcome unknown" case: it hears `disconnect_token_expired`, and the order may still have opened |

The live server closed the probe's connection after about 16.7 s (`transport close`). The fixture
never drops a socket on its own. A test drops one with `socket.disconnect(...)` or a script.

### Socket scripts

Each endpoint has its own one-shot FIFO queue, like `rest.failNext`. One `openTrade` queue serves
both modes. An `auth` script is consumed before validation. An `openTrade` script is consumed
after the auth check and before validation: an unauthenticated `open_trade` is recorded
`unauthenticated`, gets no answer and leaves the script queued for the next authenticated one.
REST scripts come before the bearer check instead: they model the edge, and a request carries its
own credential.

| Endpoint | Script | Effect |
| --- | --- | --- |
| `auth` | `{ error: { message } }` | `user.auth.error` with this text |
| `auth` | `{ silent: true }` | no answer |
| `auth` | `{ disconnect: true }` | the server drops the socket, no answer |
| `openTrade` | `{ fail: [{ message, field? }] }` | `user.<mode>.open_trade.fail` with this array; nothing opens |
| `openTrade` | `{ silent: true, open? }` | no answer. With `open: true` the command runs as without a script (schema, then the store), so the trade opens if the store accepts it and the sender still gets `update_balance`: a balance is not a confirmation |
| `openTrade` | `{ disconnect: true, open? }` | the server drops the socket first. With `open: true` the command then runs, so the trade opens and `update_balance` reaches only the user's other sockets |
| `openTrade` | `{ delayMs }` | waits. The user is the one the socket was authenticated as when the event arrived; the schema and the store are read after the delay. The trade opens for that user even if the socket disconnected, the token was revoked or the socket re-authenticated as someone else meanwhile. The answer goes only to a socket still authenticated as that user. Only `close()` cancels the command. REST `{ delayMs }` differs: it reads the bearer after the delay |

`open: true` is "the order opened, the answer was lost". A client learns the outcome only by
reading `GET /v1/broker/user/trades`, which shows the trade, or `broker.trades.list(userId)` in a
test. `failNext` throws on a script it cannot play as written: a `TypeError` for an unknown
endpoint, no shape or mixed shapes, `silent`/`disconnect` other than `true`, `open` other than a
boolean or on `fail`/`delayMs`/`auth`, an `error` without a string `message` or a `fail` that is
not shared's `openTradeFailWireSchema`; a `RangeError` for a negative or fractional `delayMs`.
The type says the same.

### Socket journal

`broker.socket.journal` holds one record per incoming event, in arrival order: `{ socketId,
event, argc, userId?, outcome }`. `userId` is the socket's user after the event was handled.
`outcome` is a `MockSocketOutcome`: `handled`, `scripted`, `unauthenticated`, `invalid`,
`auth_failed` or `unknown`. No token, payload value or asset id is stored; the subscriptions are
visible through `sockets()`. `connect` and `disconnect` are not events and are not recorded.

### Payload forms

`startMockBroker({ socketPayload })` picks how every server→client payload is delivered; one form
per fixture:

| `socketPayload` | A Node client receives |
| --- | --- |
| `'object'` (default) | the object |
| `'json'` | a JSON string |
| `'bytes'` | a `Buffer` of the UTF-8 JSON (the live form) |
| `'envelope'` | `{ data: [...bytes] }` |

`null` (`user.auth.success`, `user.disconnect_token_expired`) is sent as `null` in every form, as
seen live. An `ArrayBuffer` or a typed array reaches a Node client as the same `Buffer`, so they
are one form here. Shared's `decodeSocketPayload` turns each form back into the same object. The
default is `object`, but the live broker sends `bytes`, so #99 runs its main suite under
`'bytes'` and repeats it over all four. Any other value throws `RangeError` before the server
listens.

### Close

`close()` answers REST hangs and cuts REST delays as before. Then it cancels the socket scripts'
delays (nothing more runs for them), drops every socket (`io server disconnect` at the client) and
stops the engine, and only then closes the HTTP server. The order matters: Fastify's
`app.close()` does not return while a WebSocket client is connected, and socket.io's
`io.close()` waits for an HTTP connection that `close()` has cut but not yet dropped. Both were
checked against socket.io 4.8.4 and Fastify 5.12.5. A second `close()` resolves.

## Drift

The fixture follows the shared contract wherever the contract has an answer. Each response is
checked in the fixture's own tests by shared's `safeParse*` functions. In the places below,
shared and the live broker (or `binodex/broker-web`) disagreed or shared was silent; items 1–3
and 6 are resolved, 4–5 and 9 remain, and 7–8 are handled on the consumer's side:

1. **Money form. Resolved 2026-10-06 (#236).** The live broker counts whole currency units and
   answers a whole amount as a JSON integer and a fractional one as a JSON fraction, both in one
   object (2026-10-03, after a 1.5 demo stake). Shared accepts a decimal
   string, a safe JSON integer or a plain JSON fraction of at most 15 significant digits
   (`moneyWireSchema`) and maps each to `DecimalString`. The fixture keeps bigint cents and sends
   every money field as a JSON number through `wireMoney` (`money.ts`): `10000`, `9998.5`, never
   `"10000.00"`. `wireMoney` throws on 10^15 cents or more, so the fixture never sends a number
   shared refuses.
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
6. **Money on the socket. Resolved 2026-10-06 (#236).** The socket sends the same JSON numbers as
   REST (`user.data`, `update_balance`, `open_trade.success`, `close_trade.success`), because
   `balanceWire`, `openWire` and `closedWire` in `state.ts` are the one place money reaches either
   wire. The trade shapes are assumed, not recorded live (docs/broker-rest.md → Open items 3).
7. **`user.auth.success` carries one argument, `null`**, where shared's event map says
   `() => void`. The normalizer's `extraArgs` rule does not count that `null`
   (docs/broker-socket.md → `extraArgs`).
8. **Seven events outside shared's map**: `price.subscribed` and the six post-auth extras. The
   normalizer answers them `unknown_event` by design (docs/broker-socket.md → Observed live), and
   #99 drops them without treating them as errors. The fixture names them in one constant,
   `OBSERVED_EXTRA_EVENTS` in `socket.ts`.
9. **Open for #99:** the unit of `price.update`'s third element (the fixture sends ms), and why
   the live server closed the probe's connection after about 16.7 s (keepalive, a session limit or
   something else). The fixture models neither.

## Accepted risks

- The texts for refusing to open a trade are the fixture's own (#37 is open), and the client
  classifies by status. `Unknown asset` on trades is borrowed from the chart.
- `scheduled_until` is read as "not tradable until". This rests on a single non-zero live value,
  not confirmed by a trade.
- The trade list order (newest first) and its default limit of 20 are fixture rules. broker-web
  always passes `limit` and sorts on the client.
- The chart cap of 5000. **Closed 2026-10-03** by the owner's probe (issue #133): `limit=6000`
  over 10 days gave 4 982 rows across exactly 4 999 minutes, so the cap is by `limit`, not the
  data window. The live history has gaps inside it; the fixture has none.
- The status for opening a trade (200) was not observed.
- Socket: the default payload form `object` is not the live `bytes` (owner decision, #104). A
  consumer's suite that never sets `socketPayload` runs on the less faithful form.
- Socket: the order of `update_balance` and `open_trade.success`, and of `close_trade.success`
  and `update_balance`, was not observed. Neither was the echo of `price.subscribed` with more
  than one id, nor what the live broker does with more than 40 ids.
- Socket: the six post-auth extras are always empty, even when the store holds closed trades. A
  non-empty live form has not been seen; when #99 sees one, the fixture follows.

## Boundaries

- The `BrokerRestClient` and its tests landed in #98 (docs/broker-rest.md). The issue's
  criterion "used by the `BrokerRestClient` tests" is closed there.
- Socket.IO on the same server and store landed in #104. The `BrokerSocketClient` and its
  subscriptions are #99, the trade executor #100, the session manager and the end-to-end scenario
  #101.
- The OAuth endpoints, moving `apps/backend/src/broker/testing/oauth-stub.ts` here, and a `bin`
  or compose service: #105.
- Changes to `packages/shared`: money, chart and `{trades}` landed in #98; the fraction branch of
  `moneyWireSchema` and the number form of the fixture — #236; `symbol` and `close_timestamp`
  (Drift 4) remain. #104 changes nothing in shared (Drift 6-9).
