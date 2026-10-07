# Signal v1 (issues #132, #133, #258)

`packages/signal` (`@binarius/signal`) turns a series of candles into a trade direction (`up` or
`down`) or into a reason why there is none. It lived in `apps/trading-worker/src/signal/` until
#258 moved it to a package, so the backend and the worker share one module. It does not use an
LLM. The decider is a pure function: it reads no clock, no environment and no network, and writes
no log. The same candles, `intervalMs`, `nowMs` and parameters always give the same decision. The
signal feed (`feed.ts`, #133, [Feed and journal](#feed-and-journal-133)) fetches the candles,
calls the decider and writes one journal line per decision. Its first caller is the backend's
`POST /trading/signal` (#258, [below](#post-tradingsignal-258)), through a cache. The worker never
calls the feed itself: the session orchestrator (#287, [trading-session.md](trading-session.md))
asks `POST /trading/signal`.

Nobody has shown that this algorithm makes money. It is a technical baseline: the defaults are not
tuned and no backtest was run.

```bash
pnpm test --project unit packages/signal   # needs no database or Redis
```

## Use

```ts
const decider = createSignalDecider(); // DEFAULT_SIGNAL_PARAMS
const decision = decider.decide({ candles, intervalMs: 60_000, nowMs: Date.now() });
```

`createSignalDecider(params?)` checks the parameters once and keeps a frozen copy in
`decider.params`. That copy is the only place the numbers live. A decision carries `version`
(`SIGNAL_ALGORITHM_VERSION`, `'v1'`) but not the parameters, so a journal stores
`decider.params` next to each decision.

## Pipeline

```
candles ──> prepareCandles ──> EMA / RSI / ATR ──> gates ──> decision
            (candles.ts)       (indicators.ts)    (decide.ts)
               │                                     │
               └─ data refusal                       └─ rule refusal (with features)
```

## Inputs

| Field | Type | Rule |
|---|---|---|
| `candles` | `readonly Candle[]` (`@binarius/shared`) | ascending by `timestamp`; never mutated |
| `intervalMs` | number | a positive integer, the candle step |
| `nowMs` | number | finite, `>= 0`; the caller's clock |

`volume` is never read: the live chart sends 5-element tuples without it (docs/broker-rest.md).
A wrong `intervalMs` or `nowMs` throws a `RangeError`. So do wrong parameters, at
`createSignalDecider`. A bad candle never throws.

## Data policy

`prepareCandles` runs these checks in this order, and the first failure is the answer:

1. For each candle in index order: every field finite (`non_finite`), the four prices `> 0`
   (`non_positive`, `-0` included), `low <= min(open, close)` and `max(open, close) <= high`
   (`ohlc_order`). Then, for `i > 0`, the step from the previous candle: `<= 0` is
   `not_ascending`, exactly `intervalMs` is fine, a whole number of intervals is `candle_gap`, and
   any other step is `step_mismatch`.
2. **Future:** the first candle that starts after `nowMs` (`timestamp > nowMs`) is
   `invalid_candle/in_future` at its index.
3. **Forming:** the last candle is dropped when it is still forming, that is when
   `timestamp <= nowMs < timestamp + intervalMs`. At most one candle is dropped. A candle with
   `timestamp + intervalMs === nowMs` is closed and is kept.
4. No closed candle left: `insufficient_candles` with `closedCandles: 0`.
5. **Stale:** `ageMs = nowMs - (last.timestamp + intervalMs)`. An age above
   `maxStaleIntervals × intervalMs` is `stale`. An age exactly equal to it is not stale.
6. **Count:** fewer than `minClosedCandles` closed candles is `insufficient_candles`.

| `reason` | `detail` | What the feed's caller (#287, #126) does |
|---|---|---|
| `invalid_candle` | `{ index, problem }`, `problem` one of `CandleProblem`: `non_finite`, `non_positive`, `ohlc_order`, `not_ascending`, `step_mismatch`, `in_future` | logs it as a feed contract problem and does not trade; retrying the same series gives the same answer |
| `candle_gap` | `{ index, expectedTimestamp, actualTimestamp }`, where `expectedTimestamp` is the first missing start | logs it and does not trade; a re-fetch may fill the gap |
| `stale` | `{ lastCandleTimestamp, ageMs, maxAgeMs }` | the feed is behind: logs it and does not re-run on the same series |
| `insufficient_candles` | `{ closedCandles, required }` | fetches more (`limit`) or waits for more candles |

The series is never sorted, and missing candles are never filled in. A non-ascending answer from
the broker is a refusal, never a wrong direction.

## Indicators

| Indicator | Definition | Seed | Output aligned to |
|---|---|---|---|
| `ema(values, p)` | `prev + 2 / (p + 1) × (value - prev)` | SMA of the first `p` values | `values[p - 1 + j]` |
| `rsi(closes, p)` | `100 - 100 / (1 + avgGain / avgLoss)`, Wilder smoothing `(prev × (p - 1) + current) / p` | mean of the first `p` gains and losses | `closes[p + j]` |
| `atr(candles, p)` | Wilder-smoothed true range, `max(high - low, abs(high - prevClose), abs(low - prevClose))` | mean of the first `p` true ranges | `candles[p + j]` |

If gains and losses are both zero, RSI is 50. A zero loss alone gives 100 and a zero gain alone
gives 0, both straight from the formula. A series shorter than its seed throws a `RangeError`.
This is a programmer error, because the count check runs first.

The tests pin three worked references: `ema([1, 2, 3, 4, 5], 3) = [2, 3, 4]`;
`rsi([1, 3, 2, 4, 3], 2) = [200/3, 600/7, 600/11]`; `atr` over true ranges `[2, 4, 6]` with
period 2 `= [3, 4.5]`.

Each indicator runs over the whole closed series the caller supplies, with no trailing window.
EMA and Wilder values depend on the series length, so a decision can be reproduced only from the
exact series. For decisions to be comparable, the feed fetches `SIGNAL_CHART_LIMIT` (60) candles
and records the series.

## Decision

From the closed series:

- `trend`: `up` when `emaFast > emaSlow` and `emaSlowSlope > 0`; `down` when `emaFast < emaSlow`
  and `emaSlowSlope < 0`; otherwise `flat`. `emaSlowSlope = slowEma[last] - slowEma[last -
  slopeLookback]`.
- `momentum`: `up` when `rsi >= 50 + rsiBand`; `down` when `rsi <= 50 - rsiBand`; otherwise
  `neutral`.
- `atrPct = atr / lastClose × 100`.

The gates run in this order, and the first one that holds is the reason:

| Gate | Condition | `reason` |
|---|---|---|
| 1 | `atrPct < minAtrPct` | `volatility_too_low` |
| 2 | `atrPct > maxAtrPct` | `volatility_too_high` |
| 3 | `trend === flat` | `trend_flat` |
| 4 | `momentum === neutral` | `rsi_neutral` |
| 5 | `trend !== momentum` | `trend_momentum_disagree` |
| — | none of the above | `{ kind: 'signal', action: trend }` |

The caller does not trade on that candle after any rule refusal. `trend_flat` covers a trend with
no direction at all: the two EMAs are equal, or the slope's sign contradicts their order. Splitting
it out of "disagree" means the screen never says that two indicators disagree when one of them
says nothing (owner's decision 2026-10-03).

## Output

```ts
| { kind: 'signal'; version: 'v1'; action: 'up' | 'down'; features }
| { kind: 'no_signal'; version: 'v1'; reason: <rule reason>; features }
| { kind: 'no_signal'; version: 'v1'; reason: <data reason>; detail }
```

`features` is `{ emaFast, emaSlow, emaSlowSlope, rsi, atr, atrPct, lastClose,
lastCandleTimestamp, closedCandles, trend, momentum }`. Every number in it is finite, and no key is
ever set to `undefined`. A decision survives `JSON.parse(JSON.stringify(decision))` unchanged, so
the feed logs it as it is. All codes come from `as const` constants in
`packages/shared/src/signal.ts`: `SignalKind`, `NoSignalReason` (split into
`DATA_REFUSAL_REASONS` and `RULE_REFUSAL_REASONS`), `CandleProblem`, `TrendDirection` and
`MomentumDirection`. The direction is shared's `TradeAction`. The same file holds the decision's
wire schema, `signalDecisionSchema`, and `SignalDecision` is its inferred type, the one type
`decide.ts` returns. `decide.test.ts` (D15) parses every decision shape the decider produces back
through it.

## Parameters

| Name | Default | Rule | What changing it does |
|---|---|---|---|
| `emaFast` | 9 | integer `>= 2`, `< emaSlow` | a faster EMA reacts sooner and flips more often |
| `emaSlow` | 21 | integer `>= 2` | the trend's baseline |
| `slopeLookback` | 3 | integer `>= 1` | how many candles back the slow EMA's slope is measured |
| `rsiPeriod` | 14 | integer `>= 2` | the RSI window |
| `rsiBand` | 5 | finite, `0 <= band < 50` | a wider band gives more `rsi_neutral` |
| `atrPeriod` | 14 | integer `>= 2` | the ATR window |
| `minAtrPct` | 0.001 | finite, `>= 0` | below it the market is treated as dead |
| `maxAtrPct` | 2 | finite, `> minAtrPct` | above it the market is treated as a shock |
| `minClosedCandles` | 50 | integer `>= minClosedCandlesFloor(params)` (24 for the defaults) | how much history a decision needs |
| `maxStaleIntervals` | 2 | integer `>= 1` | how old the last closed candle may be |

`minClosedCandlesFloor = max(emaSlow + slopeLookback, rsiPeriod + 1, atrPeriod + 1)`. The defaults
are checked when `config.ts` is imported, so a default edited out of its rules fails at import.

The ATR corridor is there to refuse a dead feed (ATR 0, an OTC weekend) and a shock. It is not
meant to be optimal. On the mock broker's curve (the architect's probe: 6 pairs, 1m and 5m, 480
decisions), ATR% ran from 0.077 to 0.136. If live 1m-5m
candles fall outside the corridor in ordinary hours, the number in `config.ts` changes, not the
rule.

## Feed and journal (#133)

`feed.ts` connects the decider to the broker's chart. It fetches through the REST client's
`getChart` (docs/broker-rest.md), opens no socket and parses no raw payload of its own.

```ts
const feed = createSignalFeed({ rest, logger }); // decider defaults to createSignalDecider()
const result = await feed.evaluate({ assetId, interval: '1m' }, { signal });
```

The intervals are a closed table, `SIGNAL_CHART_INTERVAL_MS` in `packages/shared/src/signal.ts`:
`5s`, `15s`, `1m`, `5m`, `15m`, `30m` and `1h`. The live broker accepted each of them (owner's
probe 2026-10-03: every interval from `1s` to `1d`). `5s` and `15s` (#313) analyse the demo's 5
and 15 s trades; no separate probe was made for them (owner, 2026-10-07): the first live analysis
after the deploy checks them, through [the post-deploy check](#the-post-deploy-check-313).
Signal v1's parameters are unchanged on them: every window counts candles, so 60 candles × 5 s is
a 5-minute window and `maxStaleIntervals` 2 lets the last closed `5s` candle be 10 s old. An
interval outside the table is a `RangeError` before any fetch.

### The window

`evaluate` reads the clock once (`nowMs`, `Date.now` unless `now` is passed) and checks it with
`assertSignalClock` before any broker call. It then requests
`chartWindow(nowMs, intervalMs, SIGNAL_CHART_LIMIT)`:
`startTime = floor(nowMs / intervalMs) × intervalMs − (limit − 1) × intervalMs`. That is `limit`
candle starts ending on the current interval boundary. The last of them is the forming candle,
which the decider drops. The decision uses the same `nowMs` the window was built from.

`SIGNAL_CHART_LIMIT` is 60 (owner's choice). The window has to leave `minClosedCandles` closed
candles even after the forming candle and `maxStaleIntervals` late candles are taken out:
`SIGNAL_CHART_LIMIT − 1 − maxStaleIntervals ≥ minClosedCandles`, which is 60 − 1 − 2 = 57 ≥ 50
for the defaults. `assertFeedLimit` checks this when `feed-config.ts` is imported (for
`DEFAULT_SIGNAL_PARAMS`) and again in `createSignalFeed` (for the decider it is given). A decider
that needs more candles than the window can give is refused at construction with a `RangeError`.
A gap anywhere in the window is a `candle_gap` refusal, whatever the count.

The feed has no retries, no sleeps and no re-fetch on a data refusal. A refusal is a decision and
is journaled as one. It holds no mutable state, so concurrent `evaluate` calls for different
assets are independent. The one REST call is bounded by the client's `BROKER_REST_TIMEOUT_MS`
(5 s). The caller may pass a shorter `signal`.

### Outcomes

`evaluate` resolves to one of `SignalFeedOutcome`:

- `{ outcome: 'decided', entry }`, with one `info` line `signal decision` (below);
- `{ outcome: 'fetch_failed', request, code, status?, retryAfterSec? }`, with one `warn` line
  `signal fetch failed`: `err: { name: 'BrokerRestError', code }`, `status`, `retryAfterSec`, the
  broker's `detail` (already cut by the client) and the request facts under `signal`. It carries
  no URL and no token: the chart endpoint takes none.

Any other error, such as a programmer error, is rethrown and logs nothing.

| `code` | Source (docs/broker-rest.md → Errors) | What the caller (#287) does |
|---|---|---|
| `unauthorized` | 401. The chart sends no bearer, so this is drift | stops and reports |
| `rate_limited` | 429, with `retryAfterSec` when `Retry-After` is an integer | waits `retryAfterSec` (or its own backoff), then evaluates again |
| `rejected` | any other 4xx (an interval or asset the broker refuses) | fixes the request and stops |
| `unavailable` | 5xx, a failed fetch, the client's 5 s timeout, a body cut mid-flight | may evaluate again later |
| `contract_violation` | a 2xx that is not JSON, fails `candlesWireSchema` or exceeds 4 MiB; any 3xx | treats it as drift and stops |
| `aborted` | the caller's own `signal` fired first (the backend's cache: `SIGNAL_FETCH_BUDGET_MS`) | nothing: it set the limit itself |

### The journal line

Each decision is one pino `info` line, `msg` `signal decision`, with the whole entry under the
key `signal`:

| Field | Content |
|---|---|
| `assetId`, `interval`, `intervalMs`, `nowMs` | the request and the clock reading the decision used |
| `fetch` | `{ startTime, limit, rows, durationMs }` |
| `version` | `SIGNAL_ALGORITHM_VERSION` |
| `params` | `decider.params`, the frozen parameters |
| `series` | the candles as received, as tuples `[timestamp, open, high, low, close]` (`volume` is never written) |
| `decision` | the decision as `decide` returned it |

No key of the entry is a redacted key or an error key of `logOptions`, so the line holds the entry
unchanged. The line carries everything the decision was computed from, so
`replaySignalJournalEntry(JSON.parse(line).signal)` computes the same decision again.
`feed.test.ts` does this on a line read back from a `logOptions` logger. `journal.test.ts` does it
for a signal, each of the four data refusals and both volatility refusals, one of them from a
decider with non-default parameters. An entry of another `version` is refused with a `RangeError`:
v1 code does not re-decide a v2 line. A non-finite price (impossible on the live chart, which is
JSON) is `null` on the line, and replays as `non_finite` at the same index.

A line is about 5 KB (5 231 bytes live, below). With every price at 17 significant digits, the
longest a double prints, it is 6 332 bytes. `feed.test.ts` (F9) keeps it under 16 KiB, the line
size Docker's log copier reads in one piece.

### Probe

`signal-probe` runs one evaluation and exits. The journal line goes to stdout and a one-line
summary to stderr. It exits 0 on `decided` (a refusal included) and 1 on `fetch_failed`. It reads
no token and opens no trade.

```bash
BROKER_API_BASE_URL=https://api.binodex.app ASSET_ID=237831086 pnpm --filter @binarius/trading-worker signal-probe
```

| Variable | Rule |
|---|---|
| `BROKER_API_BASE_URL` | required; https, or http on `127.0.0.1`/`localhost` (a local mock) |
| `ASSET_ID` | required; an integer from 1 |
| `INTERVAL` | one of the table's keys (`5s` and `15s` included); default `1m` |
| `LOG_LEVEL` | default `info` |

### The post-deploy check (#313)

Each `POST /trading/signal` on a `5s`/`15s` key writes one `signal decision` line through the
backend's logger; `signal.interval`, `signal.decision.kind` and `signal.decision.reason` give the
rate of each outcome. After the deploy, on the pilot (before it was written here, the filter after
`docker compose logs` ran over the feed's lines on the mock broker, `5s`/`15s`/`1m` on pairs
101/202/303: the six sub-minute lines counted, the three `1m` lines left out):

```bash
docker compose logs --no-log-prefix --since 1h backend | grep -F '"msg":"signal decision"' \
  | jq -c 'select(.signal.interval | IN("5s","15s")) | [.signal.interval, .signal.decision.kind, (.signal.decision.reason // "signal")]' \
  | sort | uniq -c
```

- `stale` on every pair: the broker publishes sub-minute candles late (the last closed candle
  older than `maxStaleIntervals` × interval = 10 s / 30 s).
- `candle_gap`: holes in the series, as the 1m history has ([Observed live](#observed-live-2026-10-06)).
- `volatility_too_low`: ATR% under `minAtrPct` 0.001 %.

Any of them is a question on the #132 parameters for the owner — never a minute candle: a 5 or
15 s trade is analysed on its own candle only.

### Observed live (2026-10-06)

- The architect made three public chart GETs (asset 237831086, NZD/USD OTC, `1m`). The rows are
  5-tuples, strictly ascending and one step apart in all three answers. `start_time` is rounded
  down to the step. The answer is the rows from that start, capped by `limit`. The forming candle
  is included. The mock does the same.
- One `signal-probe` run against the live broker (10:19 UTC, the command above): exit 0,
  `fetch.rows` 60, 60 tuples of 5 elements, the first starting at `fetch.startTime` and the last on
  the current minute boundary, 59 closed candles in the decision, a 5 231-byte line. Prices were
  not recorded.
- The owner's probe of 2026-10-03: every interval from `1s` to `1d` was accepted, and `limit=6000`
  over 10 days gave 4 982 rows across exactly 4 999 minutes. The cap is 5 000 rows by `limit`, and
  the series has gaps (18 missing candles in 5 000). On 1m candles some evaluations will be
  `candle_gap` refusals. The journal measures how many. A tolerance for gaps would be a change to
  the #132 parameters.

## POST /trading/signal (#258)

The backend computes the signal for the bot's analysis screen (#126). The route sits behind the
internal bearer (`internalBearerAuth`, as `GET /trading/pairs`) and touches no database: one
public chart GET through the cached feed, on the process's one REST client.

Request: `{ assetId, interval }` (`tradingSignalRequestSchema`): `assetId` a positive int4, the
same spelling as `POST /trading/intents`; `interval` a key of the table. There is no user id: the
chart is public and a decision is per pair. Whether the asset is in the fresh catalog is the bot's
check (#126); the route checks only the shape.

| Evaluation | Status | Body (`tradingSignalResponseSchema`) |
|---|---|---|
| `decided` | 200 | `{ outcome: 'decided', params, decision }`: the decider's parameters, so the screen names `EMA9`/`EMA21` from them, and the decision |
| `fetch_failed` | 200 | `{ outcome: 'fetch_failed', code, retryAfterSec? }`; `status` and the request facts stay in the feed's `warn` line |
| a body that fails the schema | 400 | `{ error: 'validation', issues }` |
| a wrong bearer | 401 | `{ error: 'unauthorized' }` |
| a throw (a broken clock: a programmer error) | 500 | `{ error: 'internal' }`, logged by name and code |

A broker failure is a 200 with an outcome, not an HTTP error: the bot's client keeps only `error`
from a non-2xx body, and `retryAfterSec` has to reach the user. The body is built from named
fields; the journal series never leaves the backend's log.

| Outcome | What the caller (#126, [bot-demo.md](bot-demo.md#the-analysis)) does |
|---|---|
| `decided` | shows the decision: the direction and the stake button on a signal, the reason in words on a refusal; the feature lines from `features`, the periods from `params` |
| `fetch_failed` `rate_limited` | «попробуй через N с» with `retryAfterSec`; without it, the analysis as unavailable; no log line |
| any other `fetch_failed` code | shows the analysis as unavailable and logs `warn` `signal not evaluated` with `signalCode` |
| 400, 401, 500, a timeout, a broken body | shows the analysis as unavailable and logs `warn` `signal not evaluated` with the error |

`intervalForDuration(durationSec)` (shared) picks the interval for a trade's duration: the longest
table interval not above it, the shortest (`5s`) below it. A 5 s trade gets `5s` and a 15 s trade
`15s`, never `1m` (#313; `signal.test.ts` S3 fails otherwise). `durationSec` must be a positive
integer; anything else is a `RangeError`.

The backend writes the feed's lines through its own logger: one `signal decision` line per fetch,
one `signal fetch failed` line per failed fetch, nothing on a cache hit. The route adds no line of
its own. `signal-routes.test.ts` (R6) reads the backend's log sink: two requests in one candle make
one chart GET and one journal line, which replays to the answered decision.

### The cache

`createCachedSignalFeed(inner, { fetchBudgetMs, maxTtlMs, maxEntries, now })` (`cache.ts`) wraps a
feed, keyed by `${assetId}:${interval}`:

| Inner result | Held? | Until |
|---|---|---|
| `decided` (a signal or any refusal) | yes | `min(end of the candle containing entry.nowMs, entry.nowMs + maxTtlMs)` |
| `fetch_failed` `rate_limited` with `retryAfterSec` | yes | `now() + min(retryAfterSec s, maxTtlMs)`; a hit answers what is left, `ceil((until − now()) / 1000)` |
| any other `fetch_failed`, `rate_limited` without `retryAfterSec` | no | the next call fetches |
| a throw | no | every waiter of that fetch rejects with it |

- Concurrent calls for one key share one inner `evaluate`; the entry is set before the inner call
  can settle and removed once it does, whatever the outcome.
- Every inner call carries the cache's own deadline, `AbortSignal.timeout(fetchBudgetMs)`. The
  cache takes no caller signal, so a joiner never inherits another caller's abort and nobody waits
  longer than the budget from the fetch it joined.
- The hold is computed from the entry's `nowMs`, the clock reading taken before the fetch: a fetch
  that crossed a boundary is not held into the next candle. Every request in one candle gets the
  same closed candles anyway; the forming one is dropped.
- At most `maxEntries` (`SIGNAL_CACHE_MAX_ENTRIES`, 1 024; the live catalog is 144 pairs × 7
  intervals = 1 008) keys are held; an insert beyond it drops the oldest. Expired entries go on read.
  Failures are never held, so an unknown asset id costs a GET and no entry.
- The clock is the process clock (`now`, `Date.now` by default). A backward jump extends a hold by
  the jump, a forward one shortens it. No timer: nothing to stop at shutdown.

`cache.test.ts` (C1–C11) pins the table's rows, the shared fetch, the deadline, the bound and a
backward clock jump.

So the broker sees at most two chart GETs per `1m`-or-longer key per minute (one per hold of up to
30 s) and one per 429 window. On `5s` and `15s` the candle's end binds first: up to 12 and 4 GETs
a minute per key while users ask for it. Chart GETs are demand-driven and outside the worker's
budgeted share, as before. The first fetch in a candle is that candle's answer for every user, for
at most 30 s.

### Budgets

| Constant | Value | Where | Bounds |
|---|---|---|---|
| `SIGNAL_FETCH_BUDGET_MS` | 3 000 | `apps/backend/src/timing.ts` | the one chart GET (the cache's `fetchBudgetMs`); below `BROKER_REST_TIMEOUT_MS` (5 000), so it is this budget that ends a slow chart |
| `TRADING_SIGNAL_BUDGET_MS` | 4 000 | `packages/shared/src/signal.ts` | the whole answer; the bot waits at least this long (`TRADING_SIGNAL_BUDGET_MS <= BACKEND_REQUEST_TIMEOUT_MS` in `apps/bot/src/timing.ts`, #126) |
| `SIGNAL_CACHE_MAX_TTL_MS` | 30 000 | `apps/backend/src/timing.ts` | the longest hold; below the 1m interval, or it would never bind there (on `5s`/`15s` the candle's end binds) |

The backend's `TIMING_CHAIN_HOLDS` checks at import that `SIGNAL_FETCH_BUDGET_MS <
BROKER_REST_TIMEOUT_MS`, `SIGNAL_FETCH_BUDGET_MS < TRADING_SIGNAL_BUDGET_MS`,
`TRADING_SIGNAL_BUDGET_MS < SHUTDOWN_PHASE1_BUDGET_MS` (phase 1's `app.close()` waits for a
request in flight) and `SIGNAL_CACHE_MAX_TTL_MS < 60 000`; `timing.test.ts` asserts the same four.

## What it is not

- It gives no probability and no confidence score. The decision is the direction or the reason,
  plus the features (owner's decision 2026-10-03).
- It does no tuning or backtesting and makes no profitability claim.
- The decider makes no network calls, writes no logs and contains no user-facing text (the feed
  does the fetching and the logging). The Russian wording of a reason belongs to the bot (#126).
- It does not read volume or price ticks. v1 works from the chart only.

## Boundaries

- #287 (shipped): session orchestration, which asks `POST /trading/signal` inside a session
  (docs/trading-session.md). #90: the broker base URL in the worker's env and compose.
- #126: the analysis screen and its texts in the bot, on `POST /trading/signal`
  ([bot-demo.md](bot-demo.md#the-analysis)). #127: the stake button's press and the intent status. Stake size: docs/stake.md.
- The decision's wire shape and codes are in `packages/shared/src/signal.ts` (#258).
  `packages/db` is not changed.
