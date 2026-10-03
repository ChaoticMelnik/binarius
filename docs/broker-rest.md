# Broker REST client (issue #98)

`packages/broker-rest/src/rest.ts` (`@binarius/broker-rest`) is the client for the Binodex Broker
REST API: five calls, one error class, and no state. It has no logger, no counters and no
retries. The caller passes the access token on every authorized call and decides what to retry
and what to log. It moved out of `apps/trading-worker` in #138 so the backend and the worker
share one client. Its first caller is the backend's pairs catalog (docs/pairs-catalog.md).
Nothing in the worker calls it yet: wiring it into the worker (the base URL in its `env.ts`,
compose) is #100/#101.

```bash
pnpm test --project unit packages/broker-rest   # needs no database or Redis
```

## Use

```ts
const client = createBrokerRestClient({ baseUrl: 'https://api.binodex.app' });
const user = await client.getUser({ accessToken }, { signal });
```

`timeoutMs` is optional and defaults to `BROKER_REST_TIMEOUT_MS` (see Timeouts). `options` on every
call is `{ signal?: AbortSignal }`.

| Method | HTTP | Bearer | Sends | Returns |
|---|---|---|---|---|
| `getUser(auth)` | `GET /v1/broker/user` | yes | — | `BrokerUser` |
| `listPairs()` | `GET /v1/broker/pairs/binary` | no | — | `BinaryPair[]` |
| `listTrades(auth, filter?)` | `GET /v1/broker/user/trades` | yes | query `status`, `is_demo`, `limit`, `offset`, only the ones given | `BrokerTrade[]` |
| `openTrade(auth, request)` | `POST /v1/broker/user/trades` | yes | JSON `toOpenTradeRequestWire(request)` | `OpenTrade` |
| `getChart(request)` | `GET /v1/broker/chart` | no | query `asset_id`, `interval`, `limit`, `start_time` | `Candle[]` |

`BROKER_REST_ENDPOINTS` holds the method, the path and the bearer rule of each row, and every call
goes through it. Its keys are the mock broker's `MockRestEndpoint`; a type-level test checks that
the two match. `TradeListStatus` (`open`, `closed`) is spelled as the broker spells it.

Every response is validated by the shared zod schema of its endpoint and mapped by the shared
mapper, so money reaches the caller as `DecimalString` and ids as strings. Requests are typed and
not re-validated: an interval or a duration the broker does not accept comes back as its 400.
`listTrades` gives open and closed trades in one list. `isClosedTrade` tells them apart.

## Errors

Every failure is a `BrokerRestError` with `name` `'BrokerRestError'`, `message` equal to `code`,
and own fields `code`, `status?`, `retryAfterSec?` and `detail?`. A field that does not apply is
not set at all. The code comes from the HTTP status or from how the transport failed. The body
text never decides it.

| `code` | From | What it means | For `openTrade` | For a GET |
|---|---|---|---|---|
| `unauthorized` | 401 | the broker refused before acting | did not open | a new token (#101) |
| `rate_limited` | 429; `retryAfterSec` from an integer `Retry-After` | refused before acting | did not open | wait, the caller decides |
| `rejected` | any other 4xx | refused before acting; `detail` says why | did not open | fix the request |
| `unavailable` | 5xx; `fetch` failed (network, DNS, TLS); our own timeout; a 2xx body cut mid-flight | **outcome unknown** | may have opened: `unknown` | the caller may retry |
| `contract_violation` | a 2xx body that is not JSON, fails the schema or is over `MAX_SUCCESS_BODY_BYTES` (4 MiB); any 3xx | **outcome unknown** | may have opened: `unknown` | drift, retrying will not help |
| `aborted` | the caller's `signal` fired first | the caller's own limit | the caller has already decided | — |

#100 decides `rejected` or `unknown` for a REST open from the "What it means" column, not from
the name of the code. There is no catch-all row: every status lands in exactly one row.

- **3xx is not followed** (`redirect: 'manual'`). The API host has never been seen to redirect.
  Following would make `fetch` replay a POST to the target, and whether the origin acted on the
  request cannot be known.
- **`aborted` versus `unavailable`.** The caller's signal and our timeout are combined with
  `AbortSignal.any`. The abort reason shows which one fired first, so our own timeout stays
  `unavailable` even when the caller aborts a moment later. A signal that is already aborted
  sends nothing.
- **A body cut mid-flight** makes the body read reject with `TypeError: terminated`. The read and
  `JSON.parse` are separate steps, so it is `unavailable` and not `contract_violation`. An empty
  2xx body fails `JSON.parse`, so it is `contract_violation`.
- **`Retry-After` as an HTTP date** leaves `retryAfterSec` unset. The `x-ratelimit-*` headers the
  live broker sends on every response are not exposed.

## `detail`

`detail` is the broker's `error.message` from the envelope `{ "error": { "message", "details" } }`,
cut to `MAX_DETAIL_LENGTH` (200, `rest.ts`; the worker's processor cuts the executor's `detail` with
the same constant). It is read only from a 4xx/5xx body whose `content-type` starts with
`application/json` and which is at most `MAX_ERROR_BODY_BYTES` (16 384) bytes. In any other
case, and on any failure while reading, it is not set, and the status still decides the code.
`details` is never copied: it is `unknown` and may echo the request. A 2xx body is read for its
data only and never lands on an error.

The policy is the one #97 set for the socket's `auth_error.message` and `open_trade_fail[].message`:
the text is logged, truncated, and never persisted. The texts observed live (401, the chart's 400s)
carry no values. A broker text that echoes an amount would be a log-only exposure of at most 200
characters (accepted risk).

## Secrets and logging

The error carries no `cause`, URL, header or request body, and no response body beyond `detail`.
The client writes no log line. A caller logs a failure like this:

```ts
logger.warn(
  { ...errorLogFields(error), status: error.status, retryAfterSec: error.retryAfterSec, detail: error.detail },
  'broker rest call failed',
);
```

`rest.test.ts` checks one error of every code: `JSON.stringify(error)`, the message, the stack and
every own property contain neither the token nor the base URL. It then writes each error through
a real pino logger built with `logOptions('info')` and reads the line back. `err` is
`{ name, code }`, there is no `cause`, and the token is not in it.

## Timeouts

`BROKER_REST_TIMEOUT_MS = 5_000` (`rest.ts`) bounds one request, headers and body together. The
body is also capped in bytes as it arrives, whatever `content-length` says:
`MAX_SUCCESS_BODY_BYTES` for a 2xx, `MAX_ERROR_BODY_BYTES` for the error envelope. Each
process that waits on a call during shutdown orders it below its phase-1 budget, and the link is
checked where that process's chain lives:

- worker: `BROKER_REST_TIMEOUT_MS < SHUTDOWN_PHASE1_BUDGET_MS` (35 000) in
  `apps/trading-worker/src/intents/config.ts`. A job that makes a REST call without a deadline of
  its own still finishes inside the drain. `config.test.ts` asserts it.
- the pairs catalog: `BROKER_REST_TIMEOUT_MS < MIN_BROKER_PAIRS_TTL_MS` in
  `packages/broker-rest/src/pairs-catalog.ts` (docs/pairs-catalog.md).

Each `*_CHAIN_HOLDS` throws at import when its link breaks. The backend waits on no REST call
during shutdown: its one caller, the pairs catalog, is aborted by `stop()` in phase 1.

It is deliberately not ordered against `SUBMIT_ACK_TIMEOUT_MS` (500–30 000, env). The processor
passes its own signal, and a request ends at whichever comes first: the caller's signal or the
timeout. With a 30 s ack timeout, a REST open still gives up after 5 s, the same value the
backend uses for its broker client (`BROKER_HTTP_TIMEOUT_MS`).

## Money

The live broker sends money as JSON integers (`GET /v1/broker/user`, 2026-10-02: `min_trade_amount`,
`real`/`demo` `available`/`held`/`total`). Shared's `moneyWireSchema` (`packages/shared/src/money.ts`)
is the one place a JSON number becomes money. It accepts a decimal string or a safe integer and
converts the integer with `String()`, with no arithmetic. A fraction, an integer beyond
`2**53 - 1`, `NaN` and other types are refused, and that refusal is a `contract_violation`. The
schema covers every money field the broker sends: the balances, `min_trade_amount`, a trade's
`amount`, `potential_profit` and `profit`. What we send (`openTrade`'s `amount`) stays a positive
decimal string.

An integer has no fixed scale on the wire: `0` becomes `"0"`, not `"0.00"`. Money is compared as
decimals, never as strings.

## Observed live (2026-10-02)

- `GET /v1/broker/pairs/binary` without a token: 200 with a bare array (144 pairs).
- `GET /v1/broker/chart?asset_id=…&interval=1m&start_time=<ms>&limit=3`: 200 with three
  5-element tuples. `interval=60` gives 400 `Unsupported interval 60; …`. A missing
  `start_time` gives 400 `Validation failed: "start_time" (ms epoch) is required`.
- `GET /v1/broker/user` and `/user/trades` without a token: 401
  `Authentication failed: Missing bearer token`.
- With a stored account's token: `GET /v1/broker/user` gave 200 with money as integers.
  `GET /v1/broker/user/trades` gave 200 `{ "trades": [] }`.

## Open items

1. **The money unit is unknown** (whole units or minor units). `10000` is read as `"10000"`. To
   confirm, open one demo trade with a non-round stake (for example 1.5) in broker-web and read
   `GET /v1/broker/user` again. A fraction (`9998.5`) means whole units, and `moneyWireSchema`
   needs a fraction branch. `999850` means minor units, and `moneyWireSchema` needs a scale. Until
   then a fractional live value is a `contract_violation`: loud, not wrong.
2. **The body form of `POST /v1/broker/user/trades` is unconfirmed.** `amount` is sent as a decimal
   string, which the fixture accepts. If the live broker wants a number, the answer is a 400
   (`rejected`, with `detail`), caught on #100's first live demo trade. The fix would go into
   `toOpenTradeRequestWire` only.
3. **Trade money fields accept integers without a live trade** (the live list was empty). The
   same broker types them `number` in broker-web.
4. **4xx is read as "refused before acting"** for a REST open. No 4xx that follows a placed order
   is known for this API.

## Boundaries

- #85: the `err` whitelist serializer that `logOptions` installs. The client does not log.
- #97: the socket normalizer (docs/broker-socket.md). It shares the money schema and the `detail`
  policy, and imports nothing from here.
- #99: the Socket.IO client.
- #100: the trade executor and the REST fallback decision. #100/#101: the base URL in the
  worker's env and compose.
- #138: the pairs catalog (docs/pairs-catalog.md), the first caller, in the backend.
- #137: `getUser` for the broker balance snapshot (docs/broker-balance.md), in the backend, on
  the same client instance as the catalog.
- #101: the session manager and 401 handling (refresh and revocation). Retries on
  `rate_limited`/`unavailable` belong to the callers.
- #104: the Socket.IO side of `packages/mock-broker`. The fixture is used here as published and is
  not changed.
