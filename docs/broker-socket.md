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
  for `auth_error` ([Client → Logs](#logs)); the trade command executor does for
  `open_trade_fail` ([trade-executor.md](trade-executor.md)).
- Client-library errors from the socket are not problems. They go through `errorLogFields`, with
  the `err` serializer from #85 as the second line.

## Client (#99)

`createBrokerSocketClient({ url, logger, timing?, openSocket? })` in `socket.ts`. One client holds
one socket for one set of credentials at a time. The session manager
([broker-session.md](broker-session.md), #101) holds one per broker account in work.

| Member | What it does |
|---|---|
| `start({ brokerUserId, accessToken })` | opens a new socket (`forceNew`, `transports: ['websocket']`, socket.io's reconnection on). Throws unless the state is `idle` or terminal; throws `TypeError` for credentials `userAuthWireSchema` refuses, without quoting them |
| `stop()` | closes the socket and forgets the credentials; synchronous, a no-op when idle. The registry stays |
| `subscribe(assetIds)` | adds to the registry; the ids that are new go out at once when `ready`, otherwise with the next pass |
| `subscriptions()` | the registry, ascending |
| `openTrade(mode, request, signal)` | the trade command (#100, [below](#the-trade-command-100)): emits `user.<mode>.open_trade` only while `ready` on an untainted connection, and answers with the first `open_trade.fail` of that mode, or the first `open_trade.success` of that mode whose asset, action and amount are the command's, on the same connection |
| `state`, `connections` | the state below; successful auths since the last `start()` |
| `onEvent(listener)`, `onState(listener)` | every valid `BrokerEvent`; every state change `{ from, to, reason? }`. Each returns its unsubscribe |
| `isTerminalBrokerSocketState(state)` | whether `start()` may be called again without `stop()` |

The credentials are held by the session of the current `start()` for the re-auth after a
reconnect; `stop()` and the next `start()` drop them. They are never part of a state change, an
error or a log line.

### Listeners

State changes and events are delivered when the client's current unit of work (a socket.io
event, the auth timer, `start()`, `stop()`) has finished, through one queue in the order they
happened, each to every listener registered when its delivery begins, in registration order. A
listener may call `stop()`, `start()` or `subscribe()`: the effect is immediate, and the
notifications it causes follow the one being delivered, so every listener sees every change in
causal order and, once the deliveries are done, the last change it saw is the client's state. A `subscribe()` on `ready` sends
only the ids the pass did not. An event is delivered only while its session is current: when a
listener stops or restarts the client, the delivery of that session's event ends for the
remaining listeners, and an event whose session ended before its delivery began is not delivered
at all. `state` and `connections` are current values at read time, which a listener holding an
older change must expect.

### States

`BrokerSocketState`, an `as const` constant:

| State | Meaning | Left by |
|---|---|---|
| `idle` | created, or after `stop()` | `start()` |
| `connecting` | `start()` called, the first connection not up; `connect_error`s are logged here | `connect` → `authenticating`; a refused connection (`connect_error` with `active === false`) → `disconnected_by_server` |
| `authenticating` | `connect` fired, `user.auth` sent, the auth timer armed | `user.auth.success` → `ready`; the timer or a transport drop → `reconnecting`; `user.auth.error` → `auth_failed`; `user.disconnect_token_expired` → `token_expired`; a server DISCONNECT → `disconnected_by_server` |
| `ready` | authenticated; the registry pass for this connection sent | a transport drop → `reconnecting`; `user.auth.error` → `auth_failed`; `user.disconnect_token_expired` → `token_expired`; a server DISCONNECT → `disconnected_by_server` |
| `reconnecting` | the transport dropped (`transport close`, `ping timeout`, `transport error`, `forced close`); socket.io's backoff runs | `connect` → `authenticating`; a refused connection (`connect_error` with `active === false`) → `disconnected_by_server` |
| `auth_failed` | `user.auth.error`, during the handshake or after it | `start()` |
| `token_expired` | `user.disconnect_token_expired` | `start()` |
| `disconnected_by_server` | the server ended or refused the connection: a DISCONNECT (`io server disconnect`) or a CONNECT_ERROR from the namespace middleware (`connect_error`, `socket.active === false`); socket.io never reconnects after either. The state change's `reason` tells the two apart | `start()` |

The last three are terminal for the current credentials: the client closes the socket itself (so
the server's drop that follows `token_expired` arrives as `io client disconnect` and changes
nothing) and waits for `start()`. Each is reached from every live state its trigger can arrive
in, as the column lists; `stop()` leads to `idle` from any state.

### Handshake and the exactly-once pass

```text
connect ─ emit user.auth { id, token } ─ arm BROKER_SOCKET_AUTH_TIMEOUT_MS ─ authenticating
user.auth.success ─ disarm ─ emit price.subscribe per chunk of registry.all() ─ ready
subscribe(ids) while ready ─ emit price.subscribe per chunk of the ids the registry did not hold
```

`user.auth` is emitted only on `connect`; `price.subscribe` only after `user.auth.success` — the
pass right away, before the state is published as `ready`, and from `subscribe()` while `ready`.
Nothing is emitted in any other state: socket.io buffers an emit made while disconnected and flushes it ahead of the
next `user.auth`. Each chunk holds at most `MAX_PRICE_SUBSCRIPTION_ASSETS` (40) ids
(`chunkAssets`) and is parsed with `priceSubscribeWireSchema` before the emit. `price.subscribed`
is not awaited. The registry deduplicates, so on one connection an id goes out once, in the pass
or as a later add; after a reconnect the pass sends everything once more. The tests prove it per
socket id from the fixture's journal: one `user.auth`, then `ceil(n / 40)` `price.subscribe`, all
`handled`, and the socket's subscriptions equal to `subscriptions()`; and, through the
`openSocket` seam, that an id a `ready` listener subscribes goes out once, after the pass. A second
`user.auth.success` on one connection is logged at `debug` and starts no second pass.

### The trade command (#100)

`openTrade(mode, request, signal)` resolves with one of four outcomes (`SocketOpenTradeResult`):

| `outcome` | When | Emitted? |
|---|---|---|
| `success` (`trade`) | the first `user.<mode>.open_trade.success` on the connection the command went out on whose asset, action and amount are the command's | yes |
| `fail` (`failures`) | the first `user.<mode>.open_trade.fail` there | yes |
| `not_sent` (`reason: not_ready`, `state`) | the client is not `ready` (no session, or any other state), or the connection is tainted (below) | no |
| `not_sent` (`reason: aborted`, `state`) | the caller's signal was already aborted | no |
| `unknown` (`reason: state_changed`, `state`) | any state change while waiting: `ready → reconnecting` (a transport drop), a terminal state, `idle` (`stop()`) | yes |
| `unknown` (`reason: aborted`, `state`) | the caller's signal aborted while waiting | yes |

- The readiness check and the emit are one synchronous unit (no await between them), so the state
  the caller is answered by is the state the command went out in. The payload is parsed with
  `socketOpenTradeRequestWireSchema` first; a request it refuses throws before anything is sent,
  as a subscription chunk does. `user.<mode>.open_trade` is the client's third emit, after
  `user.auth` and `price.subscribe`, and the only one carrying a command.
- Correlation: the command carries no id the broker echoes, so the answer is the first
  `open_trade.fail` of the command's mode, or the first `open_trade.success` of that mode whose
  `assetId`, `action` and amount (compared by value, `normalizeDecimal`) are the command's, on the
  same connection after the emit. A success with other terms is not the answer: the command keeps
  waiting, the event is dispatched to the listeners as every event is, and the client writes
  `broker socket open_trade answer mismatch` with the first term that differs (`field`: `asset`,
  `action` or `amount`; no values). A `fail` carries nothing to check. At most one command waits
  per client — a second `openTrade()` while one waits throws (`broker socket open_trade already
  pending`); the active-intent index (one non-terminal intent per account) makes that unreachable
  in production. `update_balance` (the fixture sends it first), the other mode's answers,
  problems and ignored events are not an answer. The answering event is still dispatched to the
  listeners.
- The taint (#101, the m4 finding of the #100 review). A command that ends without its answer
  while its connection is alive — the caller's signal aborted while waiting, the processor's
  deadline included — leaves an answer that may still come on that connection, and a late
  `fail` cannot be told from the next command's own by content. So the abort marks the
  connection `tainted`, the client writes `broker socket connection tainted` (`connection`) and
  drops it with `socket.io.engine.close()`, the transport-loss mechanism of the auth timeout:
  `reconnecting` (`forced close`) → `authenticating` → `ready` on a new connection, whose answers
  a late answer of the old one can no longer reach. Until that `ready`, `openTrade()` answers
  `not_sent`/`not_ready` — the executor's REST case. engine.io closes at once when its write
  buffer is empty and after draining it otherwise; the flag covers the window before
  `disconnect` either way. `socket.test.ts` proves it twice: with the real drop (two connections,
  one `user.auth` each, the next command answered by its own event) and with `engine.close`
  replaced through the `openSocket` seam by a recorder that keeps the connection open, so the late
  `fail` arrives and is shown to answer nothing (without the flag it answers the next command —
  the money bug of m4).
- A state change ends the wait at once: the command is never emitted again on a new connection,
  and an answer on a new connection is never matched to it. An emit made after the transport died
  but before socket.io noticed is buffered and then dropped with the send buffer on `disconnect`
  (the subscription case above), so it never reaches the broker on the next connection either;
  the caller sees `unknown` for it, which is the safe reading.
- The client writes `broker socket open_trade sent` at `debug` (`mode`, `connection`), the two
  warns above, and nothing else about the answer; no amount, no broker text. The executor logs
  the outcome.

### Reconnection and timing

socket.io's own reconnection; the client reacts to `connect` (re-auth), `disconnect` (state) and
`reconnect_attempt` (the `attempt` field). A hung handshake is turned into a transport loss with
`socket.io.engine.close()`. socket.io's backoff grows only across consecutive failed attempts
(`connect_error`); every open and every close reset it, so a broker that accepts and then drops,
or accepts and never answers `user.auth`, is retried about every `BROKER_SOCKET_RECONNECT_DELAY_MS`
(plus the auth timeout for a hung handshake), never at the maximum. It is not escalated: nothing
of the kind has been observed.

| Constant (`socket-config.ts`) | Bounds | socket.io option |
|---|---|---|
| `BROKER_SOCKET_CONNECT_TIMEOUT_MS = 10_000` | the engine open of one attempt (the WebSocket upgrade and the engine.io handshake); the namespace CONNECT after it is not bounded | `timeout` |
| `BROKER_SOCKET_AUTH_TIMEOUT_MS = 5_000` | `user.auth` sent → `user.auth.success` (live ~50 ms) | the client's timer |
| `BROKER_SOCKET_RECONNECT_DELAY_MS = 1_000` | the first wait between attempts | `reconnectionDelay` |
| `BROKER_SOCKET_RECONNECT_DELAY_MAX_MS = 10_000` | the longest wait | `reconnectionDelayMax` |
| `BROKER_SOCKET_RECONNECT_JITTER = 0.5` | the randomisation of each wait | `randomizationFactor` |

The chain (every `*_MS` an integer in `[1, MAX_TIMER_MS]` — `2^31 - 1`, Node's `setTimeout`
limit, past which a delay fires after 1 ms — first wait ≤ longest wait, auth timeout ≤ connect
timeout, 0 ≤ jitter < 1, since at 1 a wait could shrink to 0) is checked at import for the
defaults and by `resolveBrokerSocketTiming` at construction for a `timing` override. Its link
to the worker's shutdown budget is in `intents/config.ts`: `BROKER_SOCKET_CONNECT_TIMEOUT_MS <
SHUTDOWN_PHASE1_BUDGET_MS` ([broker-session.md → Constants](broker-session.md#constants)).

Not bounded: a namespace CONNECT the server never answers. The client adds no timer for it (it
would race `Manager.open`'s own); it has not been seen live. It shows as a `start()` whose
`connect` never fires within `BROKER_SOCKET_CONNECT_TIMEOUT_MS` while no `connect error` is logged.

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
| `broker socket token expired` | warn | that terminal state | — |
| `broker socket disconnected by server` | warn | that terminal state | `reason` (`io server disconnect` or `connect_error`); `err` for `connect_error` (name and code only, never the server's text) |
| `broker event problem` | warn once per (event, kind) per connection, then counted | a problem for a name not in `IGNORED_BROKER_EVENTS` | `problem`, `extraArgs` |
| `broker event with extra arguments` | warn once per event name per connection | a valid event with `extraArgs > 0` | `event`, `extraArgs` |
| `broker event ignored` | debug | a name in `IGNORED_BROKER_EVENTS` (the live extras under Observed live) | `event` |
| `broker event listener threw` | warn once per event type per connection | an `onEvent` listener throws; the others still run | `type`, `err` |
| `broker socket state listener threw` | warn | an `onState` listener throws; the others still run | `to`, `err` |
| `broker socket state` | debug | every state change | `from`, `to`, `reason` |
| `broker socket open_trade sent` | debug | each command emitted | `mode`, `connection` |
| `broker socket connection tainted` | warn | a command aborted while waiting on a live connection; the client drops it | `connection` |
| `broker socket open_trade answer mismatch` | warn | a success of the command's mode whose terms are not the command's | `connection`, `mode`, `field` (`asset`, `action`, `amount`) |

`IGNORED_BROKER_EVENTS` holds the same names as the mock's `OBSERVED_EXTRA_EVENTS`; a test keeps
the two equal. `socket.test.ts` reads the log itself: a pino sink built from `logOptions('debug')`
across every path above, a trade command included, no line containing a `SECRET-` sentinel (the
token, payloads, a listener's error text), the command's amount or the URL, and every `msg` of
the table present.

### Tests

`socket.test.ts` runs against `packages/mock-broker` (`bytes` payloads, the handshake also under
`object`, `json` and `envelope`), with `cutTransport` for the live drop and `emitRaw` for
problems, and `failNext('connect', …)` for a refused connection. Re-entering listeners are
registered ahead of the recorders, so the order other listeners see is what is asserted.

`openSocket` is a seam for tests. Its contract: the returned socket is a socket.io-client
`Socket` or a wrapper that keeps its timing — `connect()` and `emit()` return before any event is
delivered, `disconnect()` raises `disconnect` synchronously, and `onAny`/`on`/`io.on` behave as
socket.io-client's. A wrapper that re-enters the client from inside these calls is refused (a
`start()` from inside `openSocket` throws `already started`) or ended (a `stop()` from inside an
`emit` ends the session without an orphan socket or a stray timer); that is all the client
promises for it. The client is `connecting` when it calls `connect()`, and re-checks its session
after every call into the socket. The seam's tests wrap `io()` to record the emits, to observe
the state at `connect()`, and to re-enter the client. The command at the top of this file runs
them.

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

- **Pending: the two-socket probe (#101).** Whether the live broker sends an `open_trade`
  answer to every socket of a user, or only to the sender, has not been observed. Until it is, a
  cross-socket answer is an accepted risk ([broker-session.md → Accepted risks](broker-session.md#accepted-risks)).
  The owner runs the probe on the pilot (`apps/trading-worker/src/cli/socket-probe.ts`; two
  sockets A and B on one account, two demo commands from A, event types per socket):

  ```bash
  docker compose exec -T -e ACCOUNT_ID=<broker_accounts.id> -e BROKER_WS_URL=https://broker-ws.binodex.app \
    trading-worker pnpm --filter @binarius/trading-worker socket-probe
  ```

  The rollout rule: `open_trade_success` and `open_trade_fail` on A only → the answers go to the
  sender, `BROKER_WS_URL` may be set. Any `open_trade_*` on B → the broker broadcasts answers;
  `BROKER_WS_URL` stays unset until a correlation the broadcast cannot defeat exists. When the
  account's `min_trade_amount` is 0.01 or less the probe skips the below-minimum command
  (`fail-проба пропущена: minTradeAmount <= 0.01`): that run verifies the success broadcast only,
  the `fail` broadcast stays unverified, and a probe on an account with a higher minimum is still
  needed before `BROKER_WS_URL` is set. `balance_update` on both sockets is expected either way.
  The result goes here.

## Boundaries

- `packages/shared` (decoder, schemas, event maps, `modeEvent`) is used as it is and not changed
  here.
- #85: the `err` whitelist serializer. Nothing on this module's path depends on it.
- #98: the REST client (docs/broker-rest.md) and the integer-money fix above, in shared.
- #99: the Socket.IO client above. It writes nothing to the database.
- #100: `openTrade()` on the client ([The trade command](#the-trade-command-100)) and the trade
  command executor on top of it ([trade-executor.md](trade-executor.md)).
- #101: the taint and the field check above, and the session manager on top of the client
  ([broker-session.md](broker-session.md)).
- #104: the Socket.IO side of `packages/mock-broker`. The normalizer's tests use literal wire
  fixtures; the client's run against that package.
