# Signal v2 (issues #132, #133, #258, #343, #379)

`packages/signal` (`@binarius/signal`) turns a series of candles and the pair's quote precision
(`digits`) into a trade direction (`up` or `down`) or into a reason why there is none. It lived in `apps/trading-worker/src/signal/` until
#258 moved it to a package, so the backend and the worker share one module. It does not use an
LLM. The decider is a pure function: it reads no clock, no environment and no network, and writes
no log. The same candles, `intervalMs`, `nowMs`, `digits` and parameters always give the same
decision. The
signal feed (`feed.ts`, #133, [Feed and journal](#feed-and-journal-133)) fetches the candles,
calls the decider and writes one journal line per decision. Its callers are the backend's
`POST /trading/signal` (#258, [below](#post-tradingsignal-258)) and the backend's background
scanner behind `GET /trading/signals` (#343, [The scanner](#the-scanner-343)), both through one
cache. The worker never calls the feed itself: the session orchestrator (#287,
[trading-session.md](trading-session.md)) asks `POST /trading/signal`.

Nobody has shown that this algorithm makes money. It is a technical baseline: the defaults are not
tuned and no backtest was run.

**v2 (#379)** adds two rule gates to v1's, from the owner's seven demo sessions of 2026-10-07…08
(8 wins in 30): an ATR floor in quote steps (`minAtrTicks`, session `2e25e081`: every move one
step of 0.00001) and the RSI extremes (`rsiExtremeBand`, session `d9c92776`: three `up` at RSI
66.9–69.1 right after a rush). `SIGNAL_ALGORITHM_VERSION` is `'v2'`. v1's decider stays in the
package, unchanged, for its journal lines only ([Replay per version](#replay-per-version-379)).

```bash
pnpm test --project unit packages/signal   # needs no database or Redis
```

## Use

```ts
const decider = createSignalDecider(); // DEFAULT_SIGNAL_PARAMS
const decision = decider.decide({ candles, intervalMs: 60_000, nowMs: Date.now(), digits: 5 });
```

`createSignalDecider(params?)` checks the parameters once and keeps a frozen copy in
`decider.params`. That copy is the only place the numbers live. A decision carries `version`
(`SIGNAL_ALGORITHM_VERSION`, `'v2'`) but not the parameters, so a journal stores
`decider.params` next to each decision. `createSignalDeciderV1(params?)` is v1's decider, for the
replay of v1 lines; no runtime caller uses it.

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
| `digits` (v2) | number | an integer from 0 to `MAX_PAIR_DIGITS` (10, `packages/shared/src/broker.ts`, #379): the pair's `digits` from the catalog, one quote step = 10^-digits |

`volume` is never read: the live chart sends 5-element tuples without it (docs/broker-rest.md).
A wrong `intervalMs`, `nowMs` or `digits` throws a `RangeError`; `digits` above
`MAX_PAIR_DIGITS` too (D25): the catalog's live range is 2–7, and at 10 `atr × 10^digits` stays
finite and exact, where `10^309` would be `Infinity`, pass the tick floor and print `null` in the
journal. The wire schema of a pair does not bound it — that would drop the whole catalog for one
pair — so such a pair is refused per pair: the scanner's `signal scan failed`, the route's 500,
the worker's `backend_status` hold. So do wrong parameters, at `createSignalDecider`. A bad candle
never throws.

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
- `atrTicks = atr × 10^digits` (v2): the ATR in the pair's quote steps, a float.

The gates run in this order, and the first one that holds is the reason (v1 has gates 1, 2 and
4–6 in the same order and no other):

| Gate | Condition | `reason` |
|---|---|---|
| 1 | `atrPct < minAtrPct` | `volatility_too_low` |
| 2 | `atrPct > maxAtrPct` | `volatility_too_high` |
| 3 (v2) | `atrTicks < minAtrTicks` | `volatility_below_tick_floor` |
| 4 | `trend === flat` | `trend_flat` |
| 5 | `momentum === neutral` | `rsi_neutral` |
| 6 | `trend !== momentum` | `trend_momentum_disagree` |
| 7 (v2) | `trend === up` and `rsi >= 50 + rsiExtremeBand` | `rsi_overbought` |
| 8 (v2) | `trend === down` and `rsi <= 50 − rsiExtremeBand` | `rsi_oversold` |
| — | none of the above | `{ kind: 'signal', action: trend }` |

The tick floor is a volatility gate and sits with them. The RSI extremes come last, so a refusal
names the extreme only when trend and momentum already agreed: at RSI 70 with the trend down the
answer is `trend_momentum_disagree`, as in v1. At the defaults a signal needs RSI in [55, 65) for
`up` and (35, 45] for `down` (`decide.test.ts` D16–D18). The floor compares with `<`: an ATR of
exactly `minAtrTicks` steps passes (D21, on integer closes at `digits` 0, where the product is
exact); elsewhere a value within float noise of the floor may fall either side (stated).

The caller does not trade on that candle after any rule refusal. `trend_flat` covers a trend with
no direction at all: the two EMAs are equal, or the slope's sign contradicts their order. Splitting
it out of "disagree" means the screen never says that two indicators disagree when one of them
says nothing (owner's decision 2026-10-03).

## Output

```ts
| { kind: 'signal'; version: 'v2'; action: 'up' | 'down'; features }
| { kind: 'no_signal'; version: 'v2'; reason: <rule reason>; features }
| { kind: 'no_signal'; version: 'v2'; reason: <data reason>; detail }
```

`features` is `{ emaFast, emaSlow, emaSlowSlope, rsi, atr, atrPct, lastClose,
lastCandleTimestamp, closedCandles, trend, momentum, atrTicks }`; v1's has no `atrTicks`. Every
number in it is finite, and no key is ever set to `undefined`. A decision survives
`JSON.parse(JSON.stringify(decision))` unchanged, so the feed logs it as it is. All codes come from `as const` constants in
`packages/shared/src/signal.ts`: `SignalKind`, `NoSignalReason` (split into
`DATA_REFUSAL_REASONS` and `RULE_REFUSAL_REASONS`), `CandleProblem`, `TrendDirection` and
`MomentumDirection`. The direction is shared's `TradeAction`. The same file holds the decision's
wire schema, `signalDecisionSchema` (v2: eight rule reasons, `atrTicks`), and `SignalDecision` is
its inferred type, the one type `decide.ts` returns. `decide.test.ts` (D15) parses every decision
shape the decider produces back through it. v1's shapes stay beside it for the replay:
`signalDecisionV1Schema` (`RULE_REFUSAL_REASONS_V1`, five), `signalFeaturesV1Schema`,
`signalParamsV1Schema`; each version's decision parses through its own schema only (D23, S8).

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
| `rsiExtremeBand` (v2) | 15 | finite, `rsiBand < band <= 50` | no `up` at RSI ≥ 65, no `down` at RSI ≤ 35 |
| `minAtrTicks` (v2) | 5 | integer `>= 1` | below it the price moves by a few quote steps only |

`minClosedCandlesFloor = max(emaSlow + slopeLookback, rsiPeriod + 1, atrPeriod + 1)`. The defaults
are checked when `config.ts` is imported, so a default edited out of its rules fails at import.
`DEFAULT_SIGNAL_PARAMS_V1` and `assertSignalParamsV1` are v1's ten fields and rules; v2's assert
runs v1's and adds the two rows above (`config.test.ts` K11–K15). The two v2 values are expert
ones (owner, 2026-10-09); the backtest stand (#381) tunes them. `minAtrTicks` 5 may refuse quiet
5 s candles on majors (EUR/USD at 5 digits: a step is 0.1 pip) — the owner's choice with that
consequence named; the journal shows the rate.

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
const result = await feed.evaluate({ assetId, interval: '1m', digits: pair.digits }, { signal });
```

The intervals are a closed table, `SIGNAL_CHART_INTERVAL_MS` in `packages/shared/src/signal.ts`:
`5s`, `15s`, `1m`, `5m`, `15m`, `30m` and `1h`. The live broker accepted each of them (owner's
probe 2026-10-03: every interval from `1s` to `1d`). `5s` and `15s` (#313) analyse the demo's 5
and 15 s trades; no separate probe was made for them (owner, 2026-10-07): the first live analysis
after the deploy checks them, through [the post-deploy check](#the-post-deploy-check-313).
The parameters are the same on them: every window counts candles, so 60 candles × 5 s is
a 5-minute window and `maxStaleIntervals` 2 lets the last closed `5s` candle be 10 s old. An
interval outside the table is a `RangeError` before any fetch.

### The window

`evaluate` reads the clock once (`nowMs`, `Date.now` unless `now` is passed) and checks it with
`assertSignalClock`, and `digits` with `assertDigits` (0 to `MAX_PAIR_DIGITS`), before any broker
call (`feed.test.ts` F11). It then requests
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
| `digits` (v2) | the pair's quote precision the caller passed |
| `fetch` | `{ startTime, limit, rows, durationMs }` |
| `version` | `SIGNAL_ALGORITHM_VERSION` |
| `params` | `decider.params`, the frozen parameters |
| `series` | the candles as received, as tuples `[timestamp, open, high, low, close]` (`volume` is never written) |
| `decision` | the decision as `decide` returned it |

No key of the entry is a redacted key or an error key of `logOptions`, so the line holds the entry
unchanged. The line carries everything the decision was computed from, so
`replaySignalJournalEntry(JSON.parse(line).signal)` computes the same decision again.
`feed.test.ts` does this on a line read back from a `logOptions` logger (F2, F10 with `digits`).
`journal.test.ts` does it for a signal, each of the four data refusals and both volatility
refusals, one of them from a decider with non-default parameters. A non-finite price (impossible on the live chart, which is
JSON) is `null` on the line, and replays as `non_finite` at the same index.

#### Replay per version (#379)

`replaySignalJournalEntry` dispatches on the line's `version`, never on the current decider: `v1`
→ v1's decider on `{ candles, intervalMs, nowMs }` with the line's v1 `params`; `v2` → v2's on the
same plus the line's `digits`; anything else → `RangeError('signal journal: entry version v0 is
not one of v1, v2')` (J3). So a v1 line logged before the deploy replays to its recorded
decision: `packages/signal/src/fixtures/v1-signal-line.json` is one such line, produced by main's
feed before any v2 change, and J4 replays it (a `signal up` at RSI 74.3 that v2 would answer
`rsi_overbought`; J5 shows the two versions on one series). A v2 line without `digits` throws
`RangeError` rather than deciding. A later version is one more entry in the same dispatch.

A line is about 5 KB (5 231 bytes live, below). With every price at 17 significant digits, the
longest a double prints, it is 6 332 bytes. `feed.test.ts` (F9) keeps it under 16 KiB, the line
size Docker's log copier reads in one piece.

### Probe

`signal-probe` reads the public pairs list once (`listPairs`) for the asset's `digits`, then runs
one evaluation and exits. The journal line goes to stdout and a one-line summary to stderr. It
exits 0 on `decided` (a refusal included) and 1 on `fetch_failed` (`pairs fetch_failed <code>` when
the list itself fails) or on an id the list does not hold (`unknown asset id`, before any chart
GET). It reads no token and opens no trade.

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

After the #379 deploy, the v2 reasons by interval — `rsi_overbought`/`rsi_oversold` and
`volatility_below_tick_floor` are the new filters' rates, and every line now carries `version`
`v2` and `digits` (the owner's step; the filter ran here over the feed's lines on the mock broker
only):

```bash
docker compose logs --no-log-prefix --since 1h backend | grep -F '"msg":"signal decision"' \
  | jq -c '[.signal.version, .signal.interval, (.signal.decision.reason // "signal")]' | sort | uniq -c
```

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
chart is public and a decision is per pair. After the shape, the route looks the pair up in the
backend's pairs cache (the one `GET /trading/pairs` serves) for its `digits` (#379), before any
chart GET; neither refusal below is journalled, no decision was made. Whether the pair is open or
accepts a duration stays the caller's check: an analysis of a closed pair is allowed.

| Evaluation | Status | Body (`tradingSignalResponseSchema`) |
|---|---|---|
| `decided` | 200 | `{ outcome: 'decided', params, decision }`: the decider's parameters, so the screen names `EMA9`/`EMA21` from them, and the decision |
| `fetch_failed` | 200 | `{ outcome: 'fetch_failed', code, retryAfterSec? }`; `status` and the request facts stay in the feed's `warn` line |
| a body that fails the schema | 400 | `{ error: 'validation', issues }` |
| no catalog snapshot, or not `fresh` | 503 | `{ error: 'catalog_unavailable' }` (`TradingSignalErrorCode.CatalogUnavailable`, the pairs route's string); the feed is not called (`signal-routes.test.ts` R7) |
| the id not in the catalog | 409 | `{ error: 'pair_unknown' }` (`TradingSignalErrorCode.PairUnknown`); the feed is not called (R8) |
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
| 400, 401, 409, 500, 503, a timeout, a broken body | the bot shows the analysis as unavailable and logs `warn` `signal not evaluated` with the error; the worker's session holds back `TRADING_SESSION_RETRY_MS` (`backend_status`), and its next attempt's pairs read stops `pair_unavailable` if the pair is gone. Both read a fresh catalog before asking, so the 503 and the 409 are races |

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
feed, keyed by `${assetId}:${interval}`. `digits` is the pair's, not the request's, and is not in
the key: two requests for one key in one candle share one fetch and the first caller's `digits`
(C14); they can differ only if the catalog changed the pair's precision inside that candle
(stated).

| Inner result | Held? | Until |
|---|---|---|
| `decided` (a signal or any refusal) | yes | `min(end of the candle containing entry.nowMs, entry.nowMs + maxTtlMs)` |
| `fetch_failed` `rate_limited` with `retryAfterSec` | yes | `now() + min(retryAfterSec s, maxTtlMs)`; a hit answers what is left, `ceil((until − now()) / 1000)` |
| any other `fetch_failed`, `rate_limited` without `retryAfterSec` | no | the next call fetches |
| a throw | no | every waiter of that fetch rejects with it |

- Concurrent calls for one key in one candle (by the cache's clock at the call) share one inner
  `evaluate`; the entry is set before the inner call can settle and removed once it does, whatever
  the outcome. A call in the next candle never joins the previous candle's fetch (#343: the
  scanner at the boundary would otherwise get the previous candle's decision; C12, S5b).
- A result is held only if it lasts longer than the hold already there: a late result of an older
  fetch never replaces a newer hold (C13).
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
a minute per key while users ask for it. The manual GETs are demand-driven and outside every
budgeted share; the scanner's are inside its own ([The budget](#the-budget)). The first fetch in a
candle is that candle's answer for every user, for at most 30 s.

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

## The scanner (#343)

The backend decides the signal of the top pairs in the background, so a later screen (#320) can
offer only pairs that have one now. It lives in `apps/backend/src/signal/scanner.ts` and goes
through the same cached feed as `POST /trading/signal`. A manual analysis of a scanned pair in the
same candle is a cache hit with no second GET (`scanner.test.ts` S5). Every decision is the feed's
own `signal decision` line, so the journal replays it like any other. A cache hit writes no line.

**Which pairs.** Only the `15s` interval (`SIGNAL_SCAN_INTERVAL`); `5s` trades keep the on-demand
analysis. The broker's per-IP budget does not fit both: 122 pairs on every `5s` and `15s` candle
would be about 1 950 GETs a minute against 600 ([The budget](#the-budget)).
- Each candle reads the pairs catalog. A missing or stale catalog (`fresh: false`) scans nothing,
  with one `warn` `signal scan skipped: no fresh catalog` per stale streak.
- Eligible pairs are those open by `scheduled_until` (`isPairOpen`), accepting a 15 s trade
  (`pairAcceptsDuration`) and paying at least the cycle floor (`pairPayoutAccepted`,
  `MIN_CYCLE_PAYOUT_PCT` 80, #379: no cycle starts below it, [trading-session.md](trading-session.md#the-payout-floor-379)).
  A `min_timeframe` 60 pair and a pair paying 79 % are never scanned nor served (S18). Each
  evaluation carries the pair's `digits` from the catalog it was chosen from (S19). On the live
  catalog of 2026-10-09, 50 of the 122 pairs accepting 15 s paid ≥ 80, the top 25 ≥ 86.
- The scan set is the top `floor(SIGNAL_SCAN_MAX_PER_MINUTE / 4)` eligible pairs by `payout` desc,
  then `id` asc. That is 25 by default, each decided once a candle.
- The set is recomputed every candle, so it follows the catalog's refresh. A pair that left the set
  leaves the snapshot at that candle.

**When.** One scan a candle, `SIGNAL_SCAN_SLACK_MS` (500 ms) after its boundary. The live broker
returned the just-closed `15s` candle 150 ms after the boundary (2026-10-08); the rest of the slack
covers clock skew. After a start, nothing is served until the first scan, at most 15.5 s later.
- The timer aims at a remembered target, `nextAt`, the next boundary plus the slack. It is moved
  forward by one candle at each fire, never recomputed from the clock at that moment. So a timer
  that fires a few ms early cannot run a second scan for the same candle (S12).
- A scan's boundary comes from its target. A second run for a boundary already scanned returns at
  once.
- A target whose candle has already ended (a stall, a forward clock jump) is not scanned. The
  timer then aims at the candle in progress at once, while it still runs (S15). After the clock
  moved back by a candle or more it aims at the upcoming moment, so the scanner is never silent
  for longer than one candle (S16).
- A scan takes no new pair once its candle has ended: the rest counts as `skipped` (S13).
  Otherwise, on a slow broker, it would spend the next candle's tokens on stale work and could call
  inside the next slack, before that candle's close is published.

**Each call**, at most `SIGNAL_SCAN_CONCURRENCY` (4) at once:

| Step or outcome | What the scanner does |
|---|---|
| before the call | the candle has ended, or no pacer token (a pause, an empty bucket): this pair and the rest of the candle are dropped (`skipped`) |
| `decided` | stores `{ kind, action or reason, lastCandleTimestamp, decidedAtMs }` for the pair; resets the 429 backoff |
| `fetch_failed` `rate_limited` | pauses the pacer for `retryAfterSec` held to 15–120 s (`SIGNAL_SCAN_BACKOFF_MIN_MS`/`_MAX_MS`), or without it for 15 s doubling to 120 s; a 429 without Retry-After while a pause runs is the same burst and neither doubles nor extends it (`pacer.test.ts` P3b, P7, P8) |
| any other `fetch_failed` | counted by code; the pair's previous entry stays and goes stale with the candle |
| a throw | counted as `threw`, `warn` `signal scan failed` with the error's name and code and `assetId` (Rule 8) |

One pair's failure never stops the others or the next candle (S7). A cache hit also costs a token:
at most one candle's batch is wasted when the bot already asked for every scanned pair (stated).

**The pacer** (`pacer.ts`) is a token bucket refilled at `SIGNAL_SCAN_MAX_PER_MINUTE / 60 s`, with
room for one candle's batch. A batch goes out right after the boundary, and any 60 s window carries
at most the ceiling plus one batch (`pacer.test.ts` P2). Only the scanner takes tokens:
`POST /trading/signal` never waits for it, and a 429 the bot gets is the route's own answer.

**Stop.** `stop()` runs in shutdown phase 1. It clears the timers and waits for the calls in flight.
Each call is bounded by the cache's `SIGNAL_FETCH_BUDGET_MS` (3 s), already in the phase-1 chain.
The calls still queued are dropped (S8). `start()` runs after `listen()` with the other loops
(`index.ts`), so a SIGTERM during the warm-up never starts it.

**The log line**, every `SIGNAL_SCAN_LOG_MS` (60 s): `info` `signal scanner` with:

| Field | What it counts |
|---|---|
| `eligible` | eligible pairs at the last scan (open, 15 s, at or above the payout floor); 0 while the catalog is stale |
| `scanned` | the size of the scan set |
| `signals` | fresh signals now (the route's rule) |
| `noSignal` | `no_signal` decisions over the minute |
| `skipped` | calls dropped: no pacer token, or the candle had ended |
| `failed` | failed calls by code, with `threw` for a throw |
| `rateLimited` | 429 answers |
| `pausedMs` | time added to pauses |
| `lagMsP95` | the 95th percentile of the time from the candle's boundary to a decision, slack included |

### GET /trading/signals

Behind the internal bearer (`internalBearerAuth`); no query parameters; the answer is built from
named fields (`tradingSignalsResponseSchema` in `packages/shared/src/signal.ts`):

```json
{ "asOf": 1760000012000, "interval": "15s", "scanned": 25,
  "signals": [{ "assetId": 101, "action": "up", "lastCandleTimestamp": 1759999995000,
                "decidedAt": 1760000010500, "ageMs": 2000 }] }
```

A pair is served only when all three hold (`freshSignals` in `scanner.ts`; `signals-routes.test.ts`
R2–R5 and the `freshSignals` cases in `scanner.test.ts`):
- its decision is a `signal`;
- the decision is on the candle that closed most recently (`lastCandleTimestamp ===
  floor(now / 15 000) × 15 000 − 15 000`);
- the pair is in the current scan set.

A signal whose candle changed without a recompute is not served: a 429, a stale catalog, or a clock
skew past the slack costs coverage, never a stale answer. This is stricter than the decider's own
`maxStaleIntervals`. A `no_signal`, a failed call and a pair outside the set never appear.
`ageMs` is the time since that candle closed. Without the bearer the answer is 401
`{ error: 'unauthorized' }`.

The one consumer is the bot's signals screen (#320, `readSignals` in
`apps/bot/src/backend-client.ts`). It keeps a pair only if the catalog read at the same press lists
it, open, accepting 15 s and paying at least the cycle floor (`checkDemoCycle`, #379), and takes the
symbol and payout from there; it never re-reads the
signal at a press, since the session asks for one before every trade
([bot-demo.md](bot-demo.md#the-signals-screen-320)).

The check after a deploy is the owner's step on the pilot: the agent has no SSH to production, and
these commands were not run before the merge. Give it a minute after the start, so the first
`signal scanner` line is out:

```bash
docker compose exec -T backend sh -c \
  'wget -qO- --header "Authorization: Bearer $INTERNAL_API_TOKEN" http://127.0.0.1:3000/trading/signals'
docker compose logs --since 2m backend | grep '"msg":"signal scanner"' | tail -1
```

### The budget

The broker counts every request from one IP against one window of 600 a minute
(`x-ratelimit-limit`, also on the public `GET /v1/broker/chart`, 2026-10-08). Three loops share it,
each bounded on its own. The table lives in `packages/shared/src/broker-budget.ts`:

| Constant | Value | Whose |
|---|---|---|
| `BROKER_RATE_LIMIT_PER_MINUTE` | 600 | the broker's per-IP window |
| `WORKER_BROKER_GETS_PER_MINUTE` | 400 | the trading worker's passes, worst case (`apps/trading-worker/src/intents/config.ts`) |
| `DEFAULT_BALANCE_POLL_PER_MINUTE` | 100 | the backend's balance refresh (`BALANCE_POLL_MAX_PER_MINUTE`, 1–500) |
| `DEFAULT_SIGNAL_SCAN_PER_MINUTE` | 100 | the scanner (`SIGNAL_SCAN_MAX_PER_MINUTE`, 4–200) |

- `BROKER_BUDGET_HOLDS` throws at import if the defaults sum over the limit (`broker-budget.test.ts`
  B1).
- Ceilings set in env above their defaults may sum over it. That is an operator's choice: the
  backend writes one `warn` `broker budget over the per-IP limit` at start, and the scanner's pause
  on a 429 is the backstop.
- Nothing counts the three processes together at run time (stated).
- A worker deploy runs two workers for its overlap, the readiness wait (≤ `READY_TIMEOUT_S`, 120 s)
  plus the drain (≤ 40 s), longer after an interrupted run until an operator resolves it
  ([worker-deploy.md](worker-deploy.md), #95):
  for that window the worker's share can double (accepted there, risk 1).
- Manual analysis, OAuth, token exchanges and the pairs catalog are outside every share.

The backend's `TIMING_CHAIN_HOLDS` adds the scanner's links, checked at import and in
`timing.test.ts`:
- `SIGNAL_SCAN_SLACK_MS < 15 000` and `SIGNAL_FETCH_BUDGET_MS + SIGNAL_SCAN_SLACK_MS < 15 000`: a
  scan starts inside its candle, and a call made at the scan moment ends inside it. A whole scan is
  bounded by the candle's end check, not by this chain;
- `SIGNAL_SCAN_BACKOFF_MIN_MS ≤ SIGNAL_SCAN_BACKOFF_MAX_MS`;
- the env bounds around the default, at least one pair, and below the window.

## What it is not

- It gives no probability and no confidence score. The decision is the direction or the reason,
  plus the features (owner's decision 2026-10-03).
- It does no tuning or backtesting and makes no profitability claim.
- The decider makes no network calls, writes no logs and contains no user-facing text (the feed
  does the fetching and the logging). The Russian wording of a reason belongs to the bot (#126).
- It does not read volume or price ticks. It works from the chart and the pair's `digits` only.

## Boundaries

- #287 (shipped): session orchestration, which asks `POST /trading/signal` inside a session
  (docs/trading-session.md). #90: the broker base URL in the worker's env and compose.
- #320 (shipped): the bot's «Сигналы сейчас» screen reads `GET /trading/signals` and joins it
  with the pairs catalog for the symbol and payout ([bot-demo.md](bot-demo.md#the-signals-screen-320)).
  The scanner keeps no history in the database.
- #126: the analysis screen and its texts in the bot, on `POST /trading/signal`
  ([bot-demo.md](bot-demo.md#the-analysis)). #127: the stake button's press and the intent status. Stake size: docs/stake.md.
- The decision's wire shape and codes are in `packages/shared/src/signal.ts` (#258).
  `packages/db` is not changed.
