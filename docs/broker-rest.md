# Broker REST client (issue #98)

`packages/broker-rest/src/rest.ts` (`@binarius/broker-rest`) is the client for the Binodex Broker
REST API: five calls, one error class, and no state. It has no counters and no retries, and logs
only a call abandoned past its deadline, to an optional `logger` (see Timeouts). The caller passes the access token on every authorized call and decides what to retry
and what to log. It moved out of `apps/trading-worker` in #138 so the backend and the worker
share one client. Its first caller is the backend's pairs catalog (docs/pairs-catalog.md). The
signal feed (`packages/signal`, docs/signal.md → Feed and journal) calls `getChart` on a client its
caller builds: the backend's `POST /trading/signal` (#258; the worker's session orchestrator called it through the route from #287 to #835). The worker's
base URL is `BROKER_API_BASE_URL` (its `env.ts`, compose's `x-broker-environment`, #90); the REST
reconciler and the settlement catch-up call `listTrades`; the trade command executor
(docs/trade-executor.md) calls `openTrade`.

```bash
pnpm test --project unit packages/broker-rest   # needs no database or Redis
```

## Use

```ts
const client = createBrokerRestClient({ baseUrl: 'https://api.binodex.app' });
const user = await client.getUser({ accessToken }, { signal });
```

`timeoutMs` is optional and defaults to `BROKER_REST_TIMEOUT_MS` (see Timeouts); so is `logger`
(`{ error, warn }`, the backend and the worker pass their app logger). `options` on every
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
text never decides it. The codes are the constant `BrokerRestErrorCode` in
`packages/shared/src/broker.ts`, there since #258 because `POST /trading/signal` carries one to the
bot; the class and `MAX_DETAIL_LENGTH` stay here.

| `code` | From | What it means | For `openTrade` | For a GET |
|---|---|---|---|---|
| `unauthorized` | 401 | the broker refused before acting | did not open | the caller reports the token's fingerprint to the backend, which marks it expired (#281); the user's next action or a reconciliation exchanges it (Rule 12) |
| `rate_limited` | 429; `retryAfterSec` from an integer `Retry-After` | refused before acting | did not open | wait, the caller decides |
| `rejected` | any other 4xx | refused before acting; `detail` says why | did not open | fix the request |
| `unavailable` | 5xx; `fetch` failed (network, DNS, TLS); our own timeout; a 2xx body cut mid-flight | **outcome unknown** | may have opened: `unknown` | the caller may retry |
| `contract_violation` | a 2xx body that is not JSON, fails the schema or is over `MAX_SUCCESS_BODY_BYTES` (4 MiB); any 3xx | **outcome unknown** | may have opened: `unknown` | drift, retrying will not help |
| `aborted` | the caller's `signal` fired first | the caller's own limit | the caller has already decided | — |

The trade command executor (#100, docs/trade-executor.md → Outcomes) decides `rejected` or
`unknown` for a REST open from the "What it means" column, not from the name of the code:
`unauthorized`, `rate_limited` and `rejected` are `rejected`/`broker_rejected`; `unavailable`,
`contract_violation` and `aborted` are `unknown`/`broker_unavailable`. There is no catch-all row:
every status lands in exactly one row.

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
The client writes no log line for a failure; the two lines of an abandoned call are under
Timeouts. A caller logs a failure like this:

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
`MAX_SUCCESS_BODY_BYTES` for a 2xx, `MAX_ERROR_BODY_BYTES` for the error envelope.
The reader is `readBody` in `packages/shared/src/http-body.ts`, shared with the OAuth client, the
bot's, web's and the worker's backend clients (Architecture Rule 26). Each
process that waits on a call during shutdown orders it below its phase-1 budget, and the link is
checked where that process's chain lives:

- worker: `BROKER_REST_TIMEOUT_MS < SHUTDOWN_PHASE1_BUDGET_MS` (35 000) in
  `apps/trading-worker/src/intents/config.ts`. A job that makes a REST call without a deadline of
  its own still finishes inside the drain. `config.test.ts` asserts it.
- the pairs catalog: `BROKER_REST_TIMEOUT_MS < MIN_BROKER_PAIRS_TTL_MS` in
  `packages/broker-rest/src/pairs-catalog.ts` (docs/pairs-catalog.md).

**The deadline does not rely on `fetch` honouring its abort (#481).** On the pilot a `listPairs`
stayed pending for minutes with no error, and no probe reproduced a `fetch` that outlives its
`AbortSignal.timeout`. So the whole call (headers, the error body, the body, the parse) runs inside
`withinDeadline` (`packages/shared/src/fetch-deadline.ts`), whose own timer replaces
`AbortSignal.timeout` and aborts the call's signal at `BROKER_REST_TIMEOUT_MS`:

- A call that settles before the cut, or within one timer tick after it, passes its own outcome
  through, so every code above is unchanged (`unavailable` for our timeout, `aborted` for the
  caller's signal, a status whose error body the abort cut).
- A call still pending after that tick is **abandoned**: the caller gets `unavailable` (our timer)
  or `aborted` (the caller's signal) at once, and the client's `logger`, when given, writes
  `error` `{ endpoint, timeoutMs, err }` `broker request abandoned`. If it settles later, the
  result is dropped and `warn` `{ endpoint, lateMs, outcome: 'ok' | 'error', err? }`
  `broker request settled late` is written; `lateMs` counts from the abandonment.
- `abandonedFetches()` counts the process's calls still abandoned. Same timeout, no new constant,
  so no chain below changes.

Each `*_CHAIN_HOLDS` throws at import when its link breaks. The backend waits on no REST call
during shutdown: its one caller, the pairs catalog, is aborted by `stop()` in phase 1.

Ordered below the deadline's env floor: `BROKER_REST_TIMEOUT_MS < MIN_SUBMIT_ACK_TIMEOUT_MS`
(6 000) in `apps/trading-worker/src/intents/config.ts` (#96): a POST the broker leaves unanswered
ends as `unavailable` (the client's own timeout) before the processor's deadline can cut it as
`aborted`, so the circuit breaker counts it. A request still ends at whichever comes first, the
caller's signal or the timeout: with a 30 s ack timeout a REST open gives up after 5 s, the same
value the backend uses for its broker client (`BROKER_HTTP_TIMEOUT_MS`).

## Money

The live broker counts whole currency units. A whole amount comes as a JSON integer and a
fractional one as a JSON fraction, both in one object (`GET /v1/broker/user`, 2026-10-03: after a
1.5 demo stake `available` and `held` came as fractions and `total` as an integer). Shared's `moneyWireSchema`
(`packages/shared/src/money.ts`) is the one place a JSON number becomes money. It accepts a
decimal string, a safe integer, or a fraction whose `String()` is a plain decimal (no exponent) of
at most `MAX_WIRE_SIGNIFICANT_DIGITS` (15) significant digits, and converts the number with
`String()`, with no arithmetic and no rounding. A float artifact (`0.30000000000000004`, 17
digits), a fraction of 16 or more significant digits, an exponent (`1e-7`, `1e+21`), an integer
beyond `2**53 - 1`, `NaN`, `±Infinity` and other types are refused, and that refusal is a
`contract_violation`. The schema covers every money field the broker sends: the balances,
`min_trade_amount`, a trade's `amount`, `potential_profit` and `profit`; the Partner API's trader
`balance` (`partnerTraderStatsWireSchema`, `packages/shared/src/partner.ts`) shares it, unchecked
live (#14). What we send (`openTrade`'s
`amount`) stays a positive decimal string.

The guarantee is exact only for a JSON text of at most 15 significant digits. A longer text may
be rounded by `JSON.parse` to a shorter double before the schema sees it, and is then accepted as
that double: `99999999999.999999` arrives as `100000000000`, `1.5000000000000001` as `1.5`. The
error is at most half a unit in the last place of the double (6.2e-5 at 10^12, under 1e-9 below
10^7). Every amount the broker has shown has at most 2 fraction digits and 12 integer digits, so
at most 14 significant digits. Telling a rounded text apart needs the raw JSON source, which this
client does not read.

An integer has no fixed scale on the wire, nor has a fraction: `0` becomes `"0"`, not `"0.00"`,
and `9998.5` becomes `"9998.5"`, not `"9998.50"`. Money is compared as decimals, never as
strings.

## Observed live (2026-10-02)

- `GET /v1/broker/pairs/binary` without a token: 200 with a bare array (144 pairs).
- `GET /v1/broker/chart?asset_id=…&interval=1m&start_time=<ms>&limit=3`: 200 with three
  5-element tuples. `interval=60` gives 400 `Unsupported interval 60; …`. A missing
  `start_time` gives 400 `Validation failed: "start_time" (ms epoch) is required`.
- `GET /v1/broker/user` and `/user/trades` without a token: 401
  `Authentication failed: Missing bearer token`.
- With a stored account's token: `GET /v1/broker/user` gave 200 with money as integers.
  `GET /v1/broker/user/trades` gave 200 `{ "trades": [] }`.

## Observed live (2026-10-03)

- One demo trade opened with the stake sent as the decimal string `"1.5"` was accepted.
- `GET /v1/broker/user` after the open: `demo.available` 1.5 lower and `demo.held` 1.5 higher,
  both JSON fractions, `demo.total` unchanged and a JSON integer, in one object; after the loss
  `demo.held` back and `demo.total` 1.5 lower. The amounts moved by exactly 1.5: the unit is whole
  currency units. Only the shapes and these differences were recorded, not the balances.
- The response shapes of the trade open and of the settled trade were not recorded.

## Observed live (2026-10-06)

- Three public `GET /v1/broker/chart` calls without a token (`interval=1m`): the rows are
  5-element tuples, strictly ascending. `start_time` is rounded down to the step, and the answer is
  the rows from that start, capped by `limit`. The forming candle is included: a 5-minute window
  fetched 40 s into a minute gave 6 rows, the last starting on the current minute boundary.
- The owner's probe of 2026-10-03 (issue #133): `limit=6000` over 10 days gave 4 982 rows across
  exactly 4 999 minutes. The cap is 5 000 rows by `limit`, and the history has gaps.

## Observed live (2026-10-23)

The owner's read-only probe of the trades list for #274 (issue #274, the plan's "Owner step 1"),
on the pilot, on a **demo** account. P1 reads first pages; P2 watches one new trade from open to
closed, here a **5-second** trade. The output, verbatim:

```
P1 ?status=closed&is_demo=true&limit=50&offset=0: HTTP 200 count=50 descending=true strict=true distinct_ids=true ms=true is_demo=[true] older_than_150s=49
P1 ?status=open&is_demo=true&limit=50&offset=0: HTTP 200 count=0 descending=true strict=false distinct_ids=true ms=true is_demo=[] older_than_150s=0
P1 ?status=closed&is_demo=false&limit=50&offset=0: HTTP 200 count=0 descending=true strict=false distinct_ids=true ms=true is_demo=[] older_than_150s=0
P1 ?status=open&is_demo=false&limit=50&offset=0: HTTP 200 count=0 descending=true strict=false distinct_ids=true ms=true is_demo=[] older_than_150s=0
P1 ?status=closed&limit=50&offset=0: HTTP 200 count=50 descending=true strict=true distinct_ids=true ms=true is_demo=[true] older_than_150s=49
P1 ?status=closed&is_demo=true&limit=1&offset=0: HTTP 200 count=1 descending=true strict=false distinct_ids=true ms=true is_demo=[true] older_than_150s=0
P1 ?status=closed&is_demo=true&limit=50: HTTP 200 count=50 descending=true strict=true distinct_ids=true ms=true is_demo=[true] older_than_150s=49
P1 prefix: the same first closed trade at limit=50, limit=1 and without offset=true
P2: new trade first seen in open at index 0, 604 ms after its open_timestamp by the broker's Date header (1 s resolution)
P2: states in order, each run's span between first and last poll: open 3.3s, closed 5.5s
```

- **A1** confirmed: newest first, strictly, with distinct ids, on every page of two or more trades.
- **A7** confirmed: `offset=0` is the newest prefix (the same first trade at `limit=50`, `limit=1`
  and without `offset`), and the new trade was first seen at index 0.
- **A3** confirmed on the 5-second trade: open, then closed, with no poll that saw it on neither
  list. The visibility lag was 604 ms.
- **A4** observed on demo trades only: `is_demo=true` gave `[true]`, and `is_demo=false` gave no
  rows while the unfiltered list held 50 demo rows, so the filter is neither ignored nor inverted.
  `[false]` was never seen: the account has no real trades.
- **A5** confirmed: milliseconds.
- **A2** and **A6** were not observed (not premises of #274).

## Trades list: assumptions (#90)

The reconciler and the catch-up (docs/trade-intent-transport.md → Reconciliation matching) rest on
these, taken from the fixture and broker-web; A1, A3, A4, A5 and A7 were then observed live
(→ Observed live (2026-10-23)):

- **A1 order:** `status=closed` and `status=open` come newest first by `open_timestamp`. The code
  checks every page and the seam between pages; a violation answers `broker_contract`. Since #274
  it is a premise of the release: a first page proves the list's end only when it is empty, or its
  ids are distinct and its first trade is strictly newer than its last (the reader refuses only
  growth, so one trade, repeated ids or equal timestamps show no direction).
- **A2 `limit`/`offset`:** honoured, with disjoint pages. Not a safety condition: the release reads
  only the first page (#274), never a page's length or a later offset. Not observed.
  `readTradePages` (`apps/trading-worker/src/intents/trade-pages.ts`) takes only an empty first
  page, an empty page after a one-trade page, or a trade older than the window as the list's end;
  every other page must start with a trade already read. What the code gets from a broken A2: a
  capped or ignored `limit` shortens the reach (`window_not_covered` while the window is open, then
  manual review); a cap of 1, an ignored, skewed or page-numbered `offset` and a list that shrinks
  between pages answer `broker_contract` and are retried on the lease.
- **A3 `status`:** filters open from closed, and a trade is on one of the two lists at every
  moment (it leaves `open` no earlier than it appears in `closed`). If the filter is wrong, the
  merge by `id` stays correct; if the move is not atomic, a trade closing during the read is on
  neither list. The release covers that gap with two proven attempts whose reads are at least
  `RECONCILE_RETRY_MS − RECONCILE_ATTEMPT_TIMEOUT_MS` (30 s) apart (#274).
- **A4 `is_demo`:** filters by mode. The local mode check stays either way, and a first page with
  a trade of the other mode proves nothing (#274). Only demo intents are released.
- **A5 `open_timestamp`** is Unix milliseconds (the shapes of 2026-10-03 show it).
- **A6** the default page size (the fixture's 20) is not used: every call passes `limit`. Not
  observed, not a safety condition.
- **A7 `offset=0`** returns the newest prefix of the list: a first page never skips a newer trade.
  No page can show this; it rests on the probe, and a broker that broke it could release an intent
  whose trade exists (#274).

## Open items

1. **The money unit. Closed 2026-10-03:** whole currency units (Observed live 2026-10-03); the
   fraction branch of `moneyWireSchema` landed in #236.
2. **The body form of `POST /v1/broker/user/trades`. Closed 2026-10-03:** decimal string accepted
   live 2026-10-03 (`"1.5"`). `toOpenTradeRequestWire` is unchanged.
3. **Trade money fields: the parser takes integers and fractions; the open/closed trade response
   shapes of 2026-10-03 were not recorded**, so the fixtures assume `amount`/`potential_profit`/
   `profit` as JSON numbers, fractional when fractional, `profit` negative on a loss (assumed, not
   recorded). The same broker types them `number` in broker-web.
4. **4xx is read as "refused before acting"** for a REST open. No 4xx that follows a placed order
   is known for this API.

## Boundaries

- #85: the `err` whitelist serializer that `logOptions` installs. The client does not log.
- #97: the socket normalizer (docs/broker-socket.md). It shares the money schema and the `detail`
  policy, and imports nothing from here.
- #99: the Socket.IO client.
- #100: the trade command executor and its REST fallback (docs/trade-executor.md). #90: the base
  URL in the worker's env and compose, and the worker's first `listTrades` callers.
- #138: the pairs catalog (docs/pairs-catalog.md), the first caller, in the backend.
- #133, #258: the signal feed (`packages/signal`, docs/signal.md); the backend's
  `POST /trading/signal` is its first caller of `getChart`.
- #137: `getUser` for the broker balance snapshot (docs/broker-balance.md), in the backend, on
  the same client instance as the catalog.
- #101: the session manager (docs/broker-session.md); on a REST 401 the worker only reports the
  token (#281).
  Retries on `rate_limited`/`unavailable` belong to the callers.
- #104: the Socket.IO side of `packages/mock-broker`. #104/#236: the fixture, which sends money as
  JSON numbers since #236, is used here as published.
