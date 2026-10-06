# Broker Socket.IO events: the normalizer (issue #97)

`apps/trading-worker/src/broker/events.ts` turns one raw Socket.IO event from the Binodex broker
into either a typed domain event or a problem a caller can log as it is. It is a pure function:
no network, no logger, no counters. The Socket.IO client that feeds it (`socket.onAny`), the
handshake, reconnects and the logging of problems are #99.

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

### Log policy for #99

- `logger.warn({ problem, extraArgs }, …)` is safe as it is: the problem is plain data, which
  matters because the logging ESLint rule does not look inside nested objects and the redact
  paths do not scrub strings.
- Broker free text that reaches a domain event, `auth_error.message` and
  `open_trade_fail[].message`, is treated like the executor's `detail`. It is logged truncated to
  `MAX_DETAIL_LENGTH` and never persisted. This is a rule for #99's call sites; the normalizer
  does not enforce it.
- Client-library errors from the socket are not problems. They go through
  `errorIdentity`/`errorLogFields`, with the `err` serializer from #85 as the second line.

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

Probe on 2026-10-02 against `broker-ws.binodex.app`, socket.io-client 4.8.4, Node 22. #99 extends
this section with what it sees.

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
- **The `price.update` timestamp unit** (seconds or milliseconds) is still unconfirmed. The value
  is passed through as received, and the consumers normalize it (#17/#19). #99 records the unit.

## Boundaries

- `packages/shared` (decoder, schemas, event maps, `modeEvent`) is used as it is and not changed
  here.
- #85: the `err` whitelist serializer. Nothing on this module's path depends on it.
- #98: the REST client (docs/broker-rest.md) and the integer-money fix above, in shared.
- #99: the Socket.IO client, `onAny` wiring, auth handshake, subscriptions, reconnect, the
  logging and counting of problems, the ack callbacks.
- #100: the trade command executor and the client→server payloads
  (`toSocketOpenTradeRequestWire`).
- #101: the session manager and the end-to-end mock scenario.
- #104: the Socket.IO side of `packages/mock-broker`. These tests use literal wire fixtures, not
  that package.
