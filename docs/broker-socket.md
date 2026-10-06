# Broker Socket.IO: the event normalizer (#97) and the client (#99)

`apps/trading-worker/src/broker/events.ts` turns one raw Socket.IO event from the Binodex broker
into either a typed domain event or a problem a caller can log as it is. It is a pure function:
no network, no logger, no counters. `apps/trading-worker/src/broker/socket.ts` is the Socket.IO
client that feeds it: the handshake, subscriptions, reconnection and the logging of problems
([Client](#client-99)).

```bash
pnpm test --project unit apps/trading-worker/src/broker   # needs no database or Redis
```

## Pipeline

```text
socket.onAny(event, ...args)
  └─ normalizeBrokerEvent(event, args)
       ├─ the event name → its handler (unknown name → unknown_event)
       ├─ args[0] → safeDecodeSocketPayload        (shared, packages/shared/src/socket.ts)
       ├─ decoded → the event's safeParse*         (shared zod schema)
       └─ wire → the event's to* mapper            (shared) → BrokerEvent
```

The result is `{ ok: true, event, extraArgs }` or `{ ok: false, problem, extraArgs }`. Only
`args[0]` is read. A trailing ack function is counted in `extraArgs` and is never called.

Every field of a domain event comes from a shared mapper, so money stays `DecimalString` and ids
stay strings. The one mapping written here is `auth_error`: the wire object is loose, and the
event keeps `message` only, so extra keys the broker sends never reach a caller's log.

## Events

The handler table is checked against shared's `BrokerServerToClientEvents` with `satisfies`: a
server→client event added to the contract fails `tsc` in `events.ts` until it has a handler, and a
name that is not in the map (for example the client→server `user.demo.open_trade`) cannot be one.

| Wire name | `type` | Fields |
|---|---|---|
| `user.auth.success` | `auth_success` | none |
| `user.auth.error` | `auth_error` | `message` |
| `user.disconnect_token_expired` | `token_expired` | none |
| `price.update` | `price_update` | `update: PriceUpdate` (timestamp as received) |
| `common.assets_list` | `assets_list` | `pairs: BinaryPair[]` |
| `common.assets_update` | `assets_update` | `update: AssetsUpdate` |
| `user.data` | `user_data` | `user: BrokerUser` |
| `user.{demo,real}.open_trade.success` | `open_trade_success` | `mode`, `trade: OpenTrade` |
| `user.{demo,real}.open_trade.fail` | `open_trade_fail` | `mode`, `failures: OpenTradeFailure[]` |
| `user.{demo,real}.close_trade.success` | `close_trade_success` | `mode`, `trades: ClosedTrade[]` |
| `user.{demo,real}.update_balance` | `balance_update` | `mode`, `balance: BrokerBalance` |

`mode` comes from the event name. `type` and a problem's `kind` are `as const` constants
(`BrokerEventType`, `BrokerEventProblemKind`). Outside `events.ts` and tests, compare against
the constant, not a bare string; `local/no-status-literal` catches part of the bare literals.

## `extraArgs`

- An unknown event: `args.length`.
- `user.auth.success`, `user.disconnect_token_expired`: a `null` or `undefined` first argument
  means "no payload" and is not counted, so `extraArgs` is `args.length - 1`. Any other first
  argument, `{}` included, is an ignored payload and is counted, so `extraArgs` is `args.length`.
  The live broker sends `user.auth.success` as `[null]` (see Observed live). Counting that `null`
  would make the counter fire on every auth.
- A payload event: `args.length - 1`, never below 0.

## Problems

A problem is plain data: `kind`, `event` (the name as received, cut to `MAX_EVENT_NAME_LENGTH`,
100 characters) and, for `schema` only, `issues` and `issueCount`. It holds no `Error`, no error
text and no payload value. Node's `JSON.parse` error quotes its input, and that error is the cause
of shared's `SocketPayloadDecodeError`. So a `decode` problem carries neither the error nor its
message. The tests feed `SECRET-…` sentinels through every kind and check the problem object and a
real pino log line for them.

| `kind` | When | What the caller does |
|---|---|---|
| `unknown_event` | the name is not a server→client event in shared's map, including prototype names (`constructor`, `__proto__`), the empty name and the client→server names | drop; log/count (#99) |
| `missing_payload` | a payload event with no arguments or an `undefined` first argument | drop; log/count |
| `decode` | the first argument is a string, bytes or a byte envelope that is not valid UTF-8 JSON; JSON and UTF-8 failures are not told apart (shared's error has no code) | drop; log/count |
| `schema` | the decoded value does not match the event's schema. `issues` are zod codes and paths (`trades.0.amount`), at most `MAX_REPORTED_ISSUES` (10), with the full count in `issueCount` | drop; log/count |

All four are refusals before any side effect. Nothing has been sent to the broker, and none of
them ends a session by itself.

`null`, a function, an array where an object is expected, and objects such as `{ data: [] }`,
`{ data: 'x' }` or `{ data: [300] }` are not byte envelopes in shared's decoder. They pass through
undecoded and fail as `schema`. Binary nested inside an object (`{ trades: <Buffer> }`) is not a
supported form. Shared decodes the top level only, so it fails as `schema` too.

### Logging a problem

- `logger.warn({ problem, extraArgs }, …)` is safe as it is: the problem is plain data, which
  matters because the logging ESLint rule does not look inside nested objects and the redact
  paths do not scrub strings. The event name in it is the broker's, as received (cut to 100
  characters); only payloads are treated as secret.
- Broker free text that reaches a domain event, `auth_error.message` and
  `open_trade_fail[].message`, is treated like the executor's `detail`. It is logged truncated to
  `MAX_DETAIL_LENGTH` and never persisted. The normalizer does not enforce it; the client does
  for `auth_error` ([Client → Logs](#logs)), #100 for `open_trade_fail`.
- Client-library errors from the socket are not problems. They go through `errorLogFields`, with
  the `err` serializer from #85 as the second line.

## Client (#99)

`createBrokerSocketClient({ url, logger, timing?, openSocket? })` in `socket.ts`. One client holds
one socket for one set of credentials at a time; one client per broker account, the token
refresh and the place in `index.ts` are #101's.

| Member | What it does |
|---|---|
| `start({ brokerUserId, accessToken })` | opens a new socket (`forceNew`, `transports: ['websocket']`, socket.io's reconnection on). Throws unless the state is `idle` or terminal; throws `TypeError` for credentials `userAuthWireSchema` refuses, without quoting them |
| `stop()` | closes the socket and forgets the credentials; synchronous, a no-op when idle. The registry stays |
| `subscribe(assetIds)` | adds to the registry; the ids that are new go out at once when `ready`, otherwise with the next pass |
| `subscriptions()` | the registry, ascending |
| `state`, `connections` | the state below; successful auths since the last `start()` |
| `onEvent(listener)`, `onState(listener)` | every valid `BrokerEvent`; every state change `{ from, to, reason? }`. Each returns its unsubscribe |

The token lives only in the closure of the current `start()`: it is not a field, never part of a
state change, an error or a log line.

### States

`BrokerSocketState`, an `as const` constant:

| State | Meaning | Left by |
|---|---|---|
| `idle` | created, or after `stop()` | `start()` |
| `connecting` | `start()` called, the first connection not up; `connect_error`s are logged here | `connect` → `authenticating` |
| `authenticating` | `connect` fired, `user.auth` sent, the auth timer armed | `user.auth.success` → `ready`; the timer → `reconnecting` (`forced close`) |
| `ready` | authenticated; the registry pass for this connection sent | a transport drop → `reconnecting` |
| `reconnecting` | the transport dropped (`transport close`, `ping timeout`, `transport error`, `forced close`); socket.io's backoff runs | `connect` → `authenticating` |
| `auth_failed` | `user.auth.error`, during the handshake or after it | `start()` |
| `token_expired` | `user.disconnect_token_expired` | `start()` |
| `disconnected_by_server` | a server DISCONNECT (`io server disconnect`), which socket.io never reconnects after | `start()` |

The last three are terminal for the current credentials: the client closes the socket itself (so
the server's drop that follows `token_expired` arrives as `io client disconnect` and changes
nothing) and waits for `start()`. `stop()` leads to `idle` from any state.

### Handshake and the exactly-once pass

```text
connect ─ emit user.auth { id, token } ─ arm BROKER_SOCKET_AUTH_TIMEOUT_MS
user.auth.success ─ disarm ─ ready ─ emit price.subscribe per chunk of registry.all()
subscribe(ids) while ready ─ emit price.subscribe per chunk of the ids the registry did not hold
```

`user.auth` is emitted only on `connect`, `price.subscribe` only in `ready`. Nothing is emitted in
any other state: socket.io buffers an emit made while disconnected and flushes it ahead of the
next `user.auth`. Each chunk holds at most `MAX_PRICE_SUBSCRIPTION_ASSETS` (40) ids
(`chunkAssets`) and is parsed with `priceSubscribeWireSchema` before the emit. `price.subscribed`
is not awaited. The registry deduplicates, so on one connection an id goes out once, in the pass
or as a later add; after a reconnect the pass sends everything once more. The tests prove it per
socket id from the fixture's journal: one `user.auth`, then `ceil(n / 40)` `price.subscribe`, all
`handled`, and the socket's subscriptions equal to `subscriptions()`. A second
`user.auth.success` on one connection is logged at `debug` and starts no second pass.

### Reconnection and timing

socket.io's own reconnection; the client reacts to `connect` (re-auth), `disconnect` (state) and
`reconnect_attempt` (the `attempt` field). A hung handshake is turned into a transport loss with
`socket.io.engine.close()`, so the backoff decides when the next attempt runs.

| Constant (`socket-config.ts`) | Bounds | socket.io option |
|---|---|---|
| `BROKER_SOCKET_CONNECT_TIMEOUT_MS = 10_000` | one connection attempt | `timeout` |
| `BROKER_SOCKET_AUTH_TIMEOUT_MS = 5_000` | `user.auth` sent → `user.auth.success` (live ~50 ms) | the client's timer |
| `BROKER_SOCKET_RECONNECT_DELAY_MS = 1_000` | the first wait between attempts | `reconnectionDelay` |
| `BROKER_SOCKET_RECONNECT_DELAY_MAX_MS = 10_000` | the longest wait | `reconnectionDelayMax` |
| `BROKER_SOCKET_RECONNECT_JITTER = 0.5` | the randomisation of each wait | `randomizationFactor` |

The chain (first wait ≤ longest wait, auth timeout ≤ connect timeout, 0 ≤ jitter ≤ 1) is checked
at import for the defaults and by `resolveBrokerSocketTiming` at construction for a `timing`
override. Its link to the worker's shutdown budget comes with the client's place in `index.ts`
(#101).

### Logs

The worker's pino from `logOptions`. No line carries a payload value, the URL or the token;
client-library errors go through `errorLogFields` only. Counters and the warn-once keys are per
connection and reset on `connect`.

| `msg` | Level | When | Fields |
|---|---|---|---|
| `broker socket ready` | info | each auth success | `connection`, `attempt` (socket.io's reconnect attempt, 0 for the first), `subscriptions`, `authMs` |
| `broker socket disconnected` | info | each `disconnect` of a connection | `reason`, `connection`, `durationMs`, `events`, `ignored`, `extraArgs`, `authTimeouts`, `problems` (per kind) |
| `broker socket connect error` | warn once per outage, then debug | `connect_error` | `attempt`, `err` |
| `broker socket auth timeout` | warn | the auth timer fires | `connection` |
| `broker socket auth failed` | warn | `user.auth.error` | `detail`: the broker's text cut to `MAX_DETAIL_LENGTH` |
| `broker socket token expired`, `broker socket disconnected by server` | warn | those terminal states | — |
| `broker event problem` | warn once per (event, kind) per connection, then counted | a problem for a name not in `IGNORED_BROKER_EVENTS` | `problem`, `extraArgs` |
| `broker event with extra arguments` | warn once per event name per connection | a valid event with `extraArgs > 0` | `event`, `extraArgs` |
| `broker event ignored` | debug | a name in `IGNORED_BROKER_EVENTS` (the live extras under Observed live) | `event` |
| `broker event listener threw` | warn once per event type per connection | an `onEvent` listener throws; the others still run | `type`, `err` |
| `broker socket state` | debug | every state change | `from`, `to`, `reason` |

`IGNORED_BROKER_EVENTS` holds the same names as the mock's `OBSERVED_EXTRA_EVENTS`; a test keeps
the two equal. `socket.test.ts` reads the log itself: a pino sink built from `logOptions('debug')`
across every path above, no line containing a `SECRET-` sentinel (the token, payloads, a
listener's error text) or the URL, and every `msg` of the table present.

### Tests

`socket.test.ts` runs against `packages/mock-broker` (`bytes` payloads, the handshake also under
`object`, `json` and `envelope`), with `cutTransport` for the live drop and `emitRaw` for
problems. `openSocket` is a seam: one test wraps `io()` to record what the client emits. The
command at the top of this file runs them.

## Payload forms

Shared's decoder accepts five forms, read from `binodex/broker-web` (`src/lib/decode.ts`, #8 п.2):

| Form | Example |
|---|---|
| JSON string | `'{"available":"1.00",…}'` |
| `ArrayBuffer` | the UTF-8 bytes of that JSON |
| any `ArrayBufferView` (a Node `Buffer` is a `Uint8Array`) | decoded over its own byte range, so a view with an offset into a pooled buffer is read correctly |
| byte envelope | `{ data: [123, 34, …] }`, a non-empty array of integers 0-255 |
| already decoded | an object or array, passed through |

The tests drive every server→client payload event through each form, with Node `Buffer` as a
separate column, and expect the same domain event.

## Observed live

Probes on 2026-10-02 and 2026-10-03 against `broker-ws.binodex.app`, socket.io-client 4.8.4,
Node 22 (the 2026-10-03 one is recorded in #99).

- **Every server payload arrived as a Node `Buffer`**, the typed-array form.
- **`user.auth.success` arrived as one argument, `null`.** That is the reason for the `extraArgs`
  rule above.
- **Unsolicited events that are not in shared's map** arrived after auth: `price.subscribed`,
  `user.real.close_trade.recent`, `user.demo.close_trade.recent`, `user.real.futures.positions`,
  `user.demo.futures.positions`, `user.real.futures.closed.recent`,
  `user.demo.futures.closed.recent`. They are `unknown_event` by design: `packages/shared` is not
  changed for them. A test pins each name to `unknown_event`, so adding one to shared turns that
  test red on purpose.
- **Money fields in `user.data` are JSON integers**, not decimal strings. Since #98 shared's
  `moneyWireSchema` accepts a decimal string or a safe JSON integer and maps either to a
  `DecimalString`, so the all-integer shape seen live parses.
- **2026-10-03 (a 1.5 demo stake, recorded in #137):** `user.demo.update_balance` and
  `user.real.update_balance` arrive together, in the same millisecond, though only the demo
  balance changed, as `{ available, held, total }` with money as JSON numbers: an integer when
  whole, a fraction when fractional, both kinds in one object. Since #236 the fraction branch of
  `moneyWireSchema` parses them (docs/broker-rest.md → Money); a float artifact or a fraction of
  16 or more significant digits is a `schema` problem with the field's path. The tests here run
  both the decimal-string fixtures and the live number form (`liveNumberCases`) through every
  payload form, and the fixture (`packages/mock-broker`) sends money as JSON numbers.
- **2026-10-03, the handshake:** `user.auth.success` (`[null]`) ~50 ms after `user.auth`, then
  `user.data`, `common.assets_list` (144 pairs) and the six `.recent`/`.futures` extras.
  `price.subscribe { assets: [id] }` is echoed by `price.subscribed { assets: [id] }` ~100 ms
  later.
- **The `price.update` timestamp is in milliseconds** (2026-10-03: 13 digits, matching the
  server's clock), about four updates a second for an OTC pair. The value is still passed through
  as received.
- **The 2026-10-02 drop after ~16.7 s (`transport close`) did not recur** on 2026-10-03: two runs
  lived 28 s and 93 s until the probe closed them, with a price subscription active. Its cause is
  unknown; the client reconnects after it and resends its subscriptions.

## Boundaries

- `packages/shared` (decoder, schemas, event maps, `modeEvent`) is used as it is and not changed
  here.
- #85: the `err` whitelist serializer. Nothing on this module's path depends on it.
- #98: the REST client (docs/broker-rest.md) and the integer-money fix above, in shared.
- #99: the Socket.IO client above. It sends no trade command and writes nothing to the database.
- #100: the trade command executor and the client→server payloads
  (`toSocketOpenTradeRequestWire`).
- #101: the session manager on top of the client: one client per account, the token refresh after
  `token_expired`/`auth_failed`, the balance writers from `user.data`/`update_balance`,
  `BROKER_WS_URL`, the place in `index.ts` and the shutdown order, and the end-to-end mock
  scenario.
- #104: the Socket.IO side of `packages/mock-broker`. The normalizer's tests use literal wire
  fixtures; the client's run against that package.
