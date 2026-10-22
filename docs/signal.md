# Signal v2 (issues #132, #133, #258, #343, #379)

`packages/signal` (`@binarius/signal`) turns a series of candles and the pair's quote precision
(`digits`) into a trade direction (`up` or `down`) or into a reason why there is none. It lived in `apps/trading-worker/src/signal/` until
#258 moved it to a package, so the backend and the worker share one module. It does not use an
LLM. The decider is a pure function: it reads no clock, no environment and no network, and writes
no log. The same candles, `intervalMs`, `nowMs`, `digits` and parameters always give the same
decision. The
signal feed (`feed.ts`, #133, [Feed and journal](#feed-and-journal-133)) reads the candles - the
data socket's window or the REST chart (#405) - calls the decider and writes the decision's
journal line. Its callers are the backend's
`POST /trading/signal` (#258, [below](#post-tradingsignal-258)), the backend's background
scanner behind `GET /trading/signals` (#343, [The scanner](#the-scanner-343)) and, since #509, the
session start `POST /trading/sessions` (step 4c, [trading-session.md](trading-session.md#post-tradingsessions):
no session on a pair whose current candle says `no_signal`), all through one cache: a start right
after the analysis of the same pair in the same candle asks the broker nothing. The worker never calls the feed itself: the session orchestrator (#287,
[trading-session.md](trading-session.md)) asks `POST /trading/signal`.

Nobody has shown that this algorithm makes money. It is a technical baseline: the defaults are not
tuned; the stand (#381, [signal-stand.md](signal-stand.md)) backtests it on the broker's candle
history, and its report goes to the issue.

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
| `sma(values, p)` (#482) | mean of the last `p` values | none | `values[p - 1 + j]` |
| `macd(closes, f, s, g)` (#482) | line `ema(f) − ema(s)` over the closes both cover, signal `ema(line, g)`, histogram `line − signal` | the two `ema` seeds | `closes[s + g − 2 + j]` (all three) |

If gains and losses are both zero, RSI is 50. A zero loss alone gives 100 and a zero gain alone
gives 0, both straight from the formula. A series shorter than its seed throws a `RangeError`.
This is a programmer error, because the count check runs first.

The tests pin five worked references: `ema([1, 2, 3, 4, 5], 3) = [2, 3, 4]`;
`rsi([1, 3, 2, 4, 3], 2) = [200/3, 600/7, 600/11]`; `atr` over true ranges `[2, 4, 6]` with
period 2 `= [3, 4.5]`; `sma([1, 2, 4, 8, 16], 3) = [7/3, 14/3, 28/3]`;
`macd([1, 2, 4, 8, 16, 32], 2, 3, 2)` = line `[11/9, 239/108, 2791/648]`, signal
`[37/36, 589/324, 845/243]` (`indicators.test.ts` I9, I10). `macd` with `f ≥ s` throws.

### Display indicators (#482)

`displayIndicators(candles, intervalMs, nowMs, params)` (`display.ts`) computes what the analysis
card shows beside the decision; the decision never reads it. #483's backtest found no MACD or MA
gate that beats v2 on history, so neither joins it
([MACD and MA on history](#macd-and-ma-on-history-483)). The periods are `DISPLAY_INDICATOR_PARAMS` (shared): MACD 12, 26, 9, MA50, MA200.
It runs over the unbroken tail of the response: the rows after its last break, a step other than
`intervalMs` or a candle that fails the per-candle checks (`invalid_candle`). The tail passes the
same `prepareCandles` with a floor of one closed candle (the forming candle, a candle in the
future, `stale`); a tail that does not pass, or has no closed candle, gives no indicators, and the
route's answer has no `indicators` key. A gap 150 rows before the end leaves 149 closed candles:
MA200 is `{ ok: false, closedCandles: 149, required: 200 }`, MA50 and MACD have values
(`display.test.ts` D9, `feed.test.ts` F14). Each indicator is either a value or
`{ ok: false, closedCandles, required }` on the tail's count:

| Indicator | Needs closed candles | Value |
|---|---|---|
| `macd` | 35 (`MACD_REQUIRED_CANDLES` = `macdSlow + macdSignal`: two signal-line points) | `{ macd, signal, histogram, cross }`; `cross` is `up` when the histogram goes from below 0 to above 0 between the last two closed candles, `down` the other way, otherwise `none` (a zero on either point is `none`) |
| `ma50`, `ma200` | 50, 200 | `{ value, lastClose }`: the SMA and the last closed candle's close, the same candle as `features.lastClose` |

`display.test.ts` D1–D9 pin the counts, the cross and the refusals against closed forms and an
EMA written in the test, not against `indicators.ts`.

The consumer is the bot's analysis card ([bot-demo.md → The analysis](bot-demo.md#the-analysis)):
a word and the number per indicator, «данных мало (N из M)» for `ok: false`, and the same for all
three, at 0 of `MACD_REQUIRED_CANDLES` (shared, beside `DISPLAY_INDICATOR_PARAMS`) and of the two
periods, when the answer has no `indicators` key. The bot does not depend on `packages/signal`, so
the count it prints for a missing field comes from shared, the one source both read.

Each indicator runs over the whole closed series the caller supplies, with no trailing window.
EMA and Wilder values depend on the series length, so a decision can be reproduced only from the
exact series. For decisions to be comparable, the decision reads the rows a fetch of
`SIGNAL_CHART_LIMIT` (60) would return and the journal records them.

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
ones (owner, 2026-10-09); the backtest stand (#381, [signal-stand.md](signal-stand.md)) tunes them. `minAtrTicks` 5 may refuse quiet
5 s candles on majors (EUR/USD at 5 digits: a step is 0.1 pip) — the owner's choice with that
consequence named; the journal shows the rate.

The ATR corridor is there to refuse a dead feed (ATR 0, an OTC weekend) and a shock. It is not
meant to be optimal. On the mock broker's curve (the architect's probe: 6 pairs, 1m and 5m, 480
decisions), ATR% ran from 0.077 to 0.136. If live 1m-5m
candles fall outside the corridor in ordinary hours, the number in `config.ts` changes, not the
rule.

## Feed and journal (#133)

`feed.ts` connects the decider to its candles. They come from one of two places, and one code
(`decideRows`) decides both, so the decision, its journal series and the display indicators read
the same rows (`feed.test.ts` F15):

- **The candle source (#405)**: the data socket's ring ([market-data.md](market-data.md)) through
  the port `SignalCandleSource` (`packages/signal/src/source.ts`): `read(assetId, interval, nowMs)`
  returns the window or `undefined`, `request(assetId, interval)` asks for a refill. The backend's
  adapter `createCandleSource` (`apps/backend/src/market-data/source.ts`) gives a window only while
  the manager's `streaming()` is true and only for the ring's intervals (`SIGNAL_SCAN_INTERVALS`).
- **The REST chart**: the client's `getChart` (docs/broker-rest.md), when the source gives no
  window: no `BROKER_WS_URL`, no ready socket, or an interval the ring does not build (`1m` and
  longer). Every GET first takes a token of the signal pacer ([The budget](#the-budget)).

```ts
const feed = createSignalFeed({ rest, source, pacer, logger }); // source and pacer are optional
const result = await feed.evaluate({ assetId, interval: '5s', digits: pair.digits }, { signal });
const scanned = feed.fromSource({ assetId, interval: '5s', digits: pair.digits }); // or undefined
```

`fromSource` is synchronous: the source's window only, no REST, no journal line, `undefined`
without a window. `evaluate` tries the window first and falls back to REST. Without `source` the
feed is REST only (the CLI probe, the e2e harness); without `pacer` its GETs are not gated (F25).

The intervals are a closed table, `SIGNAL_CHART_INTERVAL_MS` in `packages/shared/src/signal.ts`:
`5s`, `15s`, `1m`, `5m`, `15m`, `30m` and `1h`. The live broker accepted each of them (owner's
probe 2026-10-03: every interval from `1s` to `1d`). `5s` analyses the demo's 5 s trades (#313,
#685; `15s` the 15 s trades from #313 to #685, and still a 15 s session started before the deploy or
by the CLI); no separate probe was made for them (owner, 2026-10-07): the first live analysis
after the deploy checks them, through [the post-deploy check](#the-post-deploy-check-313).
The parameters are the same on them: every window counts candles, so 60 candles × 5 s is
a 5-minute window and `maxStaleIntervals` 2 lets the last closed `5s` candle be 10 s old. An
interval outside the table is a `RangeError` before any fetch.

### The window

`evaluate` and `fromSource` read the clock once (`nowMs`, `Date.now` unless `now` is passed) and checks it with
`assertSignalClock`, and `digits` with `assertDigits` (0 to `MAX_PAIR_DIGITS`), before any broker
call (`feed.test.ts` F11). It then requests
`chartWindow(nowMs, intervalMs, SIGNAL_FETCH_LIMIT)`:
`startTime = floor(nowMs / intervalMs) × intervalMs − (limit − 1) × intervalMs`. That is `limit`
candle starts ending on the current interval boundary. The last of them is the forming candle,
which the decider drops. The decision uses the same `nowMs` the window was built from.

The source's window is the ring's for the same `nowMs`: the closed candles of the 300 buckets
ending on the boundary, from the same `startTime`, and the latest bucket the ring has not closed
(`forming`) when the pair has a candle in it. The feed appends `forming` only when it is the
current bucket of `nowMs`, as a REST answer carries its forming row, and the decider drops it
(F21). Until the watermark or the clock margin closes the bucket before the boundary, `forming` is
that bucket (`ring.test.ts` R3): the feed leaves it out, and the decision is on the candle before
it - `unclosed`, not served by `GET /trading/signals` (F26, S34). Either way the rows are decided as
a REST answer. A closed bucket without a candle is a gap of the window
(`gaps`); any gap in the window, inside the decision's 60 or before it, calls `request()` once for
the key, and the decision is what the decider makes of the rows as they are: a gap inside the
decision window is `candle_gap`, too few closed candles `insufficient_candles` (an empty window:
`closedCandles: 0`), a last closed candle too old `stale` (F16, F17). The feed never waits for the
refill; the cache holds that refusal to the end of the candle, as any decision, and the backfill
([market-data.md → Backfill](market-data.md#backfill-590)) closes the gap for a later candle. A window
without gaps asks for nothing (F18).

`SIGNAL_FETCH_LIMIT` is 300 (#482): MA200 needs 200 closed candles. The decision reads only the
rows a fetch of 60 with the same right edge returns, cut by time, not by count:
`decisionRows(candles, nowMs, intervalMs)` keeps the rows with
`chartWindow(nowMs, intervalMs, 60).startTime ≤ timestamp ≤ floor(nowMs / intervalMs) × intervalMs`,
the bounds the #381 stand's `seriesAt` cuts its cache with. Without a forming candle that is 59
rows, with one or two late closed candles 58 or 57, and a gap before that start is not a
`candle_gap`; so the decision, the journal series and the stand do not change (`feed.test.ts` F12
a–d, `window.test.ts` W4). Rows outside the window, a future one included, do not reach the
decision. The display indicators read the unbroken tail of the whole answer. `assertFetchLimit`
checks `SIGNAL_FETCH_LIMIT ≥ SIGNAL_CHART_LIMIT` and `SIGNAL_FETCH_LIMIT − 1 − maxStaleIntervals ≥
200` at import for the defaults (300 − 1 − 2 = 297, `feed-config.test.ts` K4); a feed's own
decider needs no check, since `assertFeedLimit` already bounds its `maxStaleIntervals` to at most
58. Each REST answer is about 5 times longer than a 60-row one.

`SIGNAL_CHART_LIMIT` is 60 (owner's choice). The decision window has to leave `minClosedCandles` closed
candles even after the forming candle and `maxStaleIntervals` late candles are taken out:
`SIGNAL_CHART_LIMIT − 1 − maxStaleIntervals ≥ minClosedCandles`, which is 60 − 1 − 2 = 57 ≥ 50
for the defaults. `assertFeedLimit` checks this when `feed-config.ts` is imported (for
`DEFAULT_SIGNAL_PARAMS`) and again in `createSignalFeed` (for the decider it is given). A decider
that needs more candles than the window can give is refused at construction with a `RangeError`.
A gap anywhere in the window is a `candle_gap` refusal, whatever the count.

The feed has no retries, no sleeps and no re-fetch on a data refusal. A refusal is a decision and
is journaled as one when its line is written (below). It holds no mutable state, so concurrent `evaluate` calls for different
assets are independent. The one REST call is bounded by the client's `BROKER_REST_TIMEOUT_MS`
(5 s). The caller may pass a shorter `signal`.

### Outcomes

`evaluate` resolves to one of `SignalFeedOutcome`:

- `{ outcome: 'decided', entry }`, with one `info` line `signal decision` (below) unless the
  caller passed `journal: false` (the cache does);
- `{ outcome: 'fetch_failed', request, code, status?, retryAfterSec? }`, with one `warn` line
  `signal fetch failed`: `err: { name: 'BrokerRestError', code }`, `status`, `retryAfterSec`, the
  broker's `detail` (already cut by the client) and the request facts under `signal`. It carries
  no URL and no token: the chart endpoint takes none.
- `{ outcome: 'fetch_failed', request, code: 'rate_limited', retryAfterSec }` when the signal
  pacer has no token for the GET (#405), with one `warn` line `signal fetch refused: no token`
  (`retryAfterSec` and the request facts under `signal`) and no GET sent. `retryAfterSec` is what
  is left of the pacer's pause after a 429, or `SIGNAL_PACER_RETRY_SEC` (1 s) when the bucket is
  only empty (F24). The code is the broker's `rate_limited`, so the bot answers "try again in N s"
  and a session step waits as on any `fetch_failed`; the wire schemas do not change. It is
  expected only without the source, when the steps of many sessions read REST at one boundary.

Any other error, such as a programmer error, is rethrown and logs nothing.

| `code` | Source (docs/broker-rest.md → Errors) | What the caller (#287) does |
|---|---|---|
| `unauthorized` | 401. The chart sends no bearer, so this is drift | stops and reports |
| `rate_limited` | 429, with `retryAfterSec` when `Retry-After` is an integer; or the signal pacer's refusal (above). A 429 also pauses the pacer | waits `retryAfterSec` (or its own backoff), then evaluates again |
| `rejected` | any other 4xx (an interval or asset the broker refuses) | fixes the request and stops |
| `unavailable` | 5xx, a failed fetch, the client's 5 s timeout, a body cut mid-flight | may evaluate again later |
| `contract_violation` | a 2xx that is not JSON, fails `candlesWireSchema` or exceeds 4 MiB; any 3xx | treats it as drift and stops |
| `aborted` | the caller's own `signal` fired first (the backend's cache: `SIGNAL_FETCH_BUDGET_MS`) | nothing: it set the limit itself |

### The journal line

A decision is one pino `info` line, `msg` `signal decision`, with the whole entry under the
key `signal`. In the backend the cache writes it lazily (#405, [The cache](#the-cache)): only for a
decision a route answers, once per decision.

| Field | Content |
|---|---|
| `assetId`, `interval`, `intervalMs`, `nowMs` | the request and the clock reading the decision used |
| `digits` (v2) | the pair's quote precision the caller passed |
| `source` (v2, #405) | where the series came from: `{ kind: 'rest', startTime, limit, rows, durationMs }`, the actual request (`limit` 300) and the rows it returned; or `{ kind: 'socket', startTime, closedUntil, gaps }`, the ring's window, the end of its closed buckets and the number of its closed buckets without a candle. A v2 line written before #405, and every v1 line, carries `fetch: { startTime, limit, rows, durationMs }` instead; the stand parses both (`journal-line.test.ts` JL) |
| `version` | `SIGNAL_ALGORITHM_VERSION` |
| `params` | `decider.params`, the frozen parameters |
| `series` | the rows inside the 60-row window (`decisionRows`) of the REST answer or of the source's window, the ones the decision read, as tuples `[timestamp, open, high, low, close]` (`volume` is never written) |
| `decision` | the decision as `decide` returned it |

No key of the entry is a redacted key or an error key of `logOptions`, so the line holds the entry
unchanged. The line carries everything the decision was computed from, so
`replaySignalJournalEntry(JSON.parse(line).signal)` computes the same decision again.
`feed.test.ts` does this on a line read back from a `logOptions` logger (F2, F10 with `digits`).
`journal.test.ts` does it for a signal, each of the four data refusals and both volatility
refusals, one of them from a decider with non-default parameters. The entry's wire shape is
`signalJournalEntrySchema` in `packages/shared/src/signal.ts` (with `storedSignalJournalEntrySchema`
for the v1 and pre-#405 v2 lines); `journal.test.ts` J8 pins it to this module's types both ways.
The same entry is stored for every decision a session acted on (#666,
[trade-log.md](trade-log.md)): the log line is unchanged, and the trade log keeps it past a
redeploy. A non-finite price (impossible on the live chart, which is
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

Each decision `POST /trading/signal` answers on a `5s`/`15s` key writes one `signal decision` line
through the backend's logger (once per decision, #405); `signal.interval`, `signal.decision.kind` and `signal.decision.reason` give the
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

- The architect made three public chart GETs (asset 237831086, NZD/USD with `is_otc`, `1m`). The rows are
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
internal bearer (`internalBearerAuth`, as `GET /trading/pairs`): one `evaluate` of the cached feed
with `journal: true` (#405) - the data socket's window while it streams, otherwise one public
chart GET on the process's one REST client and the signal pacer - and, only for a request with
`analysis` (#484), one write of the user's `users.last_analysis_*` after the decision.

Request: `{ assetId, interval, analysis? }` (`tradingSignalRequestSchema`): `assetId` a positive
int4, the same spelling as `POST /trading/intents`; `interval` a key of the table. The decision
is per pair: the chart is public. `analysis: { telegramUserId, durationSec }` is sent only by the
bot's analysis card (#484, [mailing.md](mailing.md) → The analysis reminder): with a `decided`
evaluation the route calls `setLastAnalysis` — a signal records the pair and `durationSec`, no
signal records none — and answers as without the field; `fetch_failed` and the refusals below
record nothing. The record is best-effort: its failure is a `warn` `last analysis not recorded`
(name and code) and the decision is answered; an unknown `telegramUserId` writes nothing and is
no error (`signal-routes.test.ts` R10–R17). The cycle's doors and the session start read the feed
without it. `record: true` is sent only by a trading session's worker (#666,
[trade-log.md](trade-log.md#the-record-of-post-tradingsignal)): a `decided` answer then carries
`record: { entry, lastTick }` — the whole journal entry the decision was computed from and the
pair's newest data-socket tick when the route answered (`null` without `BROKER_WS_URL` or before
the pair's first tick); without the flag the body is exactly as before (`signal-routes.test.ts`
R19–R21). The worker reads `record` apart from the answer: a record that fails its schema or is not
the answer's decision, pair and interval is dropped with a `warn` and the answer still trades
(`backend.test.ts` B7). Any other value of `record` is a 400. Unknown keys are dropped (`z.object`), so an older bot's or backend's body passes
(R3). After the shape, the route looks the pair up in the
backend's pairs cache (the one `GET /trading/pairs` serves) for its `digits` (#379), before any
chart GET; neither refusal below is journalled, no decision was made. Whether the pair is open or
accepts a duration stays the caller's check: an analysis of a closed pair is allowed.

| Evaluation | Status | Body (`tradingSignalResponseSchema`) |
|---|---|---|
| `decided` | 200 | `{ outcome: 'decided', params, decision, indicators?, record? }` (`record` only for `record: true`, #666): the decider's parameters, so the screen names `EMA9`/`EMA21` from them, the decision, and the [display indicators](#display-indicators-482), absent when the unbroken tail of the response did not pass the candle checks (`signal-routes.test.ts` R3b, R6) |
| `fetch_failed` | 200 | `{ outcome: 'fetch_failed', code, retryAfterSec? }`; `status` and the request facts stay in the feed's `warn` line |
| a body that fails the schema | 400 | `{ error: 'validation', issues }` |
| no catalog snapshot, or not `fresh` | 503 | `{ error: 'catalog_unavailable' }` (`TradingSignalErrorCode.CatalogUnavailable`, the pairs route's string); the feed is not called (`signal-routes.test.ts` R7) |
| the id not in the catalog | 409 | `{ error: 'pair_unknown' }` (`TradingSignalErrorCode.PairUnknown`); the feed is not called (R8) |
| a wrong bearer | 401 | `{ error: 'unauthorized' }` |
| a throw (a broken clock: a programmer error) | 500 | `{ error: 'internal' }`, logged by name and code |

A broker failure is a 200 with an outcome, not an HTTP error: the bot's client keeps only `error`
from a non-2xx body, and `retryAfterSec` has to reach the user. The body is built from named
fields; the journal series leaves the backend only in a session's `record` (#666), which the
worker stores in `signal_decisions`.

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

The backend writes the feed's lines through its own logger. The route and the session start
(#509) call `evaluate(…, { journal: true })`; the cache writes one `signal decision` line for each
decision they answer, the first time one of them answers it - a hit on a decision the scanner
made, a join of a fetch in flight or its own fetch - and never again for that decision (#405,
owner's answer 2 of #392). One `signal fetch failed` line per failed fetch; the route adds no line
of its own. `signal-routes.test.ts` reads the backend's log sink: two requests in one candle make
one chart GET and one journal line, which replays to the answered decision (R6); a decision the
scanner made writes its line when the route answers it, once (R16); without the source and with an
empty pacer the route answers `rate_limited` in 1 s and sends no GET (R18).
`session-routes.db.test.ts` R30b: a session start writes one line for the decision it checked.

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

`fromSource(request)` (#405, the scanner's) answers a held decision of the key, otherwise the inner
feed's `fromSource` and holds its decision by the same rule; without a window it holds nothing
(C15, C16). A decision of the source replaces a refusal held from REST on both entries: `fromSource` (C21) and
`evaluate`, which asks the source before it answers a held refusal (C22), so a source that
came back is not hidden behind a `rate_limited` hold. A decision it holds is the hit of an
`evaluate` in the same candle, the same object (C20).

The journal is the cache's (#405): the inner `evaluate` always runs with `journal: false`, and the
cache calls the inner `journal(entry)` for a decided result the first time an `evaluate` with
`journal: true` gets it - a hit, a join or its own fetch - remembered per decision object
(`WeakSet`), so a later call writes nothing (C17, C18). `journal` defaults to `false`; `fromSource`
and `fetch_failed` write no line (C18b, C19).

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
backward clock jump; C15–C22 `fromSource` and the lazy journal.

So the broker sees at most two chart GETs per `1m`-or-longer key per minute (one per hold of up to
30 s) and one per 429 window. On `5s` and `15s` the candle's end binds first: up to 12 and 4 GETs
a minute per key while users ask for it, and only when the source has no window for the key; each
takes a token of the signal pacer ([The budget](#the-budget)). The first decision in a candle is
that candle's answer for every user, for at most 30 s.

### Budgets

| Constant | Value | Where | Bounds |
|---|---|---|---|
| `SIGNAL_FETCH_BUDGET_MS` | 3 000 | `apps/backend/src/timing.ts` | the one chart GET (the cache's `fetchBudgetMs`); below `BROKER_REST_TIMEOUT_MS` (5 000), so it is this budget that ends a slow chart |
| `TRADING_SIGNAL_BUDGET_MS` | 4 000 | `packages/shared/src/signal.ts` | the whole answer; the bot waits at least this long (`TRADING_SIGNAL_BUDGET_MS <= BACKEND_REQUEST_TIMEOUT_MS` in `apps/bot/src/timing.ts`, #126) |
| `SIGNAL_CACHE_MAX_TTL_MS` | 30 000 | `apps/backend/src/timing.ts` | the longest hold; below the 1m interval, or it would never bind there (on `5s`/`15s` the candle's end binds) |
| `SIGNAL_PACER_RETRY_SEC` | 1 | `packages/signal/src/feed-config.ts` | `retryAfterSec` of a pacer refusal without a pause (#405): a token comes within `60 / perMinute` s, at most 2.4 s at the lowest ceiling; the cache holds the refusal as long, so `× 1000 ≤ SIGNAL_CACHE_MAX_TTL_MS` |

The backend's `TIMING_CHAIN_HOLDS` checks at import that `SIGNAL_FETCH_BUDGET_MS <
BROKER_REST_TIMEOUT_MS`, `SIGNAL_FETCH_BUDGET_MS < TRADING_SIGNAL_BUDGET_MS`,
`TRADING_SIGNAL_BUDGET_MS < SHUTDOWN_PHASE1_BUDGET_MS` (phase 1's `app.close()` waits for a
request in flight), `SIGNAL_CACHE_MAX_TTL_MS < 60 000` and `SIGNAL_PACER_RETRY_SEC × 1000 ≤
SIGNAL_CACHE_MAX_TTL_MS`; `timing.test.ts` asserts the same five.

## The scanner (#343)

The backend decides the signal of every eligible pair in the background, so the signals screen
(#320) can offer only pairs that have one now. It lives in `apps/backend/src/signal/scanner.ts`,
one instance per interval of `SIGNAL_SCAN_INTERVALS` (`['5s']`, #685; `['15s', '5s']` from #382), and decides from the
data socket's window through the cached feed's `fromSource` ([Feed and journal](#feed-and-journal-133)):
synchronously, with no broker call and no pacer (#405). A manual analysis of a scanned pair in the
same candle is a cache hit with no GET (`scanner.test.ts` S5). The scanner's decisions write no
journal line (owner's answer 2 of #392: about 122 pairs × 16 decisions a minute × 5 KB would be
14 GB a day); a decision a route answers writes its line then ([The cache](#the-cache)).

**Which pairs.** Every eligible pair of the fresh catalog, on the scanned interval, every
candle (S26). Before #405 the scanner read REST and the broker's per-IP budget allowed 13 pairs on
`15s` and 4 on `5s` (#382, #460); a decision from the ring costs no request, so the shares, the
pair counts and the choice by type are gone.
- Each candle reads the pairs catalog. A missing or stale catalog (`fresh: false`) scans nothing,
  with one `warn` `signal scan skipped: no fresh catalog` per stale streak, carrying `interval`.
- Eligible pairs are those open by `scheduled_until` (`isPairOpen`), accepting a trade of the
  candle's length, 5 s (`pairAcceptsDuration`; `eligiblePairs(view, nowMs, durationSec)`),
  whatever they pay (#631; #379 left a pair below `MIN_CYCLE_PAYOUT_PCT` 80 out: the bot's list
  now fills up with such pairs, [trading-session.md](trading-session.md#the-payout-order-key-379-631)).
  A `min_timeframe` 15 or 60 pair is never scanned since #685; a pair paying 79 % is scanned and
  served (S19'). Each decision carries the pair's `digits` from the catalog it was read from (S20).
- The set is recomputed every candle, so it follows the catalog's refresh. A pair that left the set
  leaves the snapshot at that candle (S9).

A 15 s session started before #685 (or by the CLI) asks `POST /trading/signal` on `15s`: the ring
builds no `15s` window, so its decision is a REST GET through the signal pacer, cached for the
candle; such sessions end within `SESSION_MAX_DURATION_MS` (1 h) of the deploy.

**The source.** The scanner gets the manager's `streaming()` as a dep. While it is false - no
`BROKER_WS_URL`, or the active socket not `ready` ([market-data.md](market-data.md)) - a scan
clears the snapshot (no entry, `scanned` empty), counts `sourceDown`, and writes one `warn`
`signal scan skipped: source not streaming` per streak (S27): `GET /trading/signals` then serves
empty lists, never decisions of the time before. It never falls back to REST for its pairs. When
the source comes back, the first scan after it fills the snapshot afresh; until then nothing is
served (S32). Right after a start or a gap the windows are short: those decisions are
`insufficient_candles`, `candle_gap` or `stale`, each with a refill request, and signals appear as
the backfill closes the windows.

**When.** One scan a candle of the instance's interval, `CANDLE_CLOSE_SLACK_MS` (500 ms, shared with
the worker's candle hold and the stand since #697) after its boundary (S1). After a start, nothing is served until the first scan, at most 5.5 s later.
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
- **`unclosed`.** The ring closes a bucket by its watermark (a tick stamped at or after the
  bucket's end) or by the clock `MARKET_DATA_SKEW_MARGIN_MS` (2 s) after it
  ([market-data.md → Closing a candle](market-data.md#closing-a-candle-and-holes)). At ~440 ticks a second
  the watermark crosses the boundary within milliseconds; on a quiet pair it may not have by the
  scan moment, and the decision is then on the candle before, which the route's freshness rule
  does not serve. Such a decision (the window's `closedUntil` below the boundary of the decision's
  own `nowMs`; the feed leaves the unclosed candle out, F26) is counted as `unclosed` (S29, S34); the slack is not raised (2 s would be 40 % of a `5s` candle).
  Measured on the pilot 2026-10-22 (2 h, #697): 1.07 % of the decisions `unclosed`, in 17 events,
  15 of them a whole scan at once (all 122 pairs: the watermark of the whole stream had not passed
  the boundary at `+ 500`); the watermark lag p50 212 / p95 364 / max 602 ms. Since #697 a
  session's next ask after `no_signal` or the pause comes at the same moment and reads the same
  cache, so it trades such a decision as the scanner made it (docs/trading-session.md → The candle
  wake); the bot's list does not serve it, as before.

**Each pair.** The scan is one synchronous loop over the eligible pairs, `fromSource` for each:

| Outcome | What the scanner does |
|---|---|
| a decision (`signal` or a refusal) | stores `{ kind, action or reason, lastCandleTimestamp, decidedAtMs }` for the pair |
| `undefined` (the source left during the scan) | this pair and the rest are `skipped`; their entries stay and go stale with the candle (S28) |
| a throw (digits outside `assertDigits`) | counted as `threw`, `warn` `signal scan failed` with the error's name and code and `assetId` (Rule 8); the others are decided (S7, S31) |

A decision from memory costs microseconds; 122 pairs on one interval block the event loop for an
estimated 20 ms at most every 5 s (40 ms on two intervals until #685) (accepted; `lagMsP95` above 600 with `unclosed` at 0 falsifies
it).

**Stop.** Each instance's `stop()` runs in shutdown phase 1 and clears the timers; a scan is
synchronous, so nothing is in flight (S8). `start()` runs after `listen()` with the other loops
(`index.ts`), so a SIGTERM during the warm-up never starts it.

**The log line**, every `SIGNAL_SCAN_LOG_MS` (60 s), one per instance: `info` `signal scanner`
with:

| Field | What it counts |
|---|---|
| `interval` | the instance's interval, `5s` |
| `source` | `live` or `down`: `streaming()` when the line is written |
| `eligible` | eligible pairs at the last scan (open, taking the interval's duration, at any payout since #631); 0 while the catalog is stale or the source is down |
| `scanned` | the size of the scan set (= `eligible` while live) |
| `signals` | fresh signals now (the route's rule) |
| `decided` | decisions over the minute |
| `noSignal` | `no_signal` decisions over the minute by reason, `{ candle_gap, insufficient_candles, stale, volatility_too_low, … }` |
| `unclosed` | decisions whose window had not closed the boundary's candle |
| `sourceDown` | scans not made because the source was down |
| `skipped` | pairs dropped: the source left during the scan, or the candle had ended |
| `threw` | pairs whose decision threw |
| `lagMsP95` | the 95th percentile of the time from the candle's boundary to a decision, slack included |

### GET /trading/signals

Behind the internal bearer (`internalBearerAuth`); no query parameters; the answer is built from
named fields (`tradingSignalsResponseSchema` in `packages/shared/src/signal.ts`):

```json
{ "asOf": 1760000012000,
  "lists": [
    { "interval": "5s", "scanned": 122,
      "signals": [{ "assetId": 101, "action": "up", "lastCandleTimestamp": 1760000005000,
                    "decidedAt": 1760000010500, "ageMs": 2000 }] } ] }
```

One list per scanner, in `SIGNAL_SCAN_INTERVALS` order whatever order the scanners are wired in
(#382); one list, `5s`, since #685. A list's `interval` is any `SignalInterval` in the schema,
wider than the scanner (#685): a backend and a bot of different versions parse each other's
answer, and the bot reads only the list of its own duration. In each list a pair is served only when all three hold (`freshSignals` in `scanner.ts`;
`signals-routes.test.ts` R2–R5 and the `freshSignals` cases in `scanner.test.ts`, S33 on 122
pairs):
- its decision is a `signal`;
- the decision is on that interval's candle that closed most recently (`lastCandleTimestamp ===
  floor(now / L) × L − L`, with `L` the list's candle, 5 000 ms);
- the pair is in that interval's current scan set.

A signal whose candle changed without a recompute is not served: the source gone during a scan, a
stale catalog, or a clock skew past the slack costs coverage, never a stale answer. This is
stricter than the decider's own `maxStaleIntervals`. A `no_signal` and a pair outside the set never
appear. While the source is down the lists are empty. `ageMs` is the time since that candle
closed; `scanned` is the size of that interval's scan set, every eligible pair. The signals come in
the catalog's order; the bot chooses and orders its own list from them. Without the bearer the
answer is 401 `{ error: 'unauthorized' }`.

The consumers are the bot's signals screen (#320, `readSignals` in
`apps/bot/src/backend-client.ts`), its cycle doors (#664: a pair in the list has a signal now) and
its wait for a signal (#664, `apps/bot/src/signal-wait.ts`): one poll per 5 s candle while any
user waits, whatever their number; `scanned: 0` and empty lists read as nothing to serve yet. It takes the list of the demo's duration
(`intervalForDuration(5)`, #685), keeps a pair only if the catalog read at the same press lists it,
open and accepting that duration (`checkDemoTrade`), keeps up to 12 of those paying at least 80 %
by type (`signalsShown`, #460) and, with fewer than five of them, fills the list up to five with
the pairs paying less (#631), and takes the symbol and payout from there; a door reads the list
again at its press, and the session asks for a signal before every trade
([bot-demo.md](bot-demo.md#the-signals-screen-320)). A body without that duration's list is a
deploy mismatch, not «no signals»: the bot answers it as unavailable.

The check after a deploy is the owner's step on the pilot: the agent has no SSH to production, and
the `docker compose` commands were not run before the merge; each pipeline below was run on the
mock broker against a backend started with its `BROKER_WS_URL` (#405). Give it a minute after the
start, so the first `signal scanner` line is out:

```bash
# the scanner line (one interval, 5s, since #685): source live, scanned = eligible, signals > 0 over ten minutes, unclosed near 0
docker compose logs --no-log-prefix --since 2m backend | grep -F '"msg":"signal scanner"' | tail -1
# every eligible pair is in the lists
docker compose exec -T backend sh -c 'wget -qO- --header "Authorization: Bearer $INTERNAL_API_TOKEN" http://127.0.0.1:3000/trading/signals' | jq '.lists[] | {interval, scanned, signals: (.signals | length)}'
# chart GETs outside the warm-up: backfill only, besides a request for 1m or longer (never from the bot) (fetched ~ 0 once queued is 0), no "signal fetch" lines
docker compose logs --no-log-prefix --since 10m backend | grep -F '"msg":"market data"' | tail -1 | jq .backfill
docker compose logs --no-log-prefix --since 10m backend | grep -cF '"msg":"signal fetch'
# the journal: lines only from POST /trading/signal and session starts, with source.kind socket
docker compose logs --no-log-prefix --since 10m backend | grep -F '"msg":"signal decision"' | jq -c '[.signal.source.kind, .signal.interval, (.signal.decision.reason // "signal")]' | sort | uniq -c
```

Expected: the `signal scanner` line shows `interval: "5s"`, `source: "live"`, `scanned` equal to `eligible`,
`signals` above 0 at least once over ten minutes and `unclosed` near 0; the lists' `scanned` are
the eligible counts; `backfill.queued` falls to 0 within minutes of the start and `fetched` stays
near 0 after it; no `signal fetch` line while the source is live; the journal's lines are
`socket` ones. **Without the source**: unmark the service accounts in the admin pages; within
`MARKET_DATA_TICK_MS` the scanner lines show `source: "down"`, `scanned: 0`, the lists are empty,
and an analysis in the bot still answers (its journal line is `rest`).

### The budget

The broker counts every request from one IP against one window of 600 a minute
(`x-ratelimit-limit`, also on the public `GET /v1/broker/chart`, 2026-10-08). Three loops share it,
each bounded on its own. The table lives in `packages/shared/src/broker-budget.ts`. The backtest
stand (#381) is not one of them: it runs from another IP under its own cap
([signal-stand.md → The budget](signal-stand.md#the-budget)).

| Constant | Value | Whose |
|---|---|---|
| `BROKER_RATE_LIMIT_PER_MINUTE` | 600 | the broker's per-IP window |
| `WORKER_BROKER_GETS_PER_MINUTE` | 400 | the trading worker's passes, worst case (`apps/trading-worker/src/intents/config.ts`) |
| `DEFAULT_BALANCE_POLL_PER_MINUTE` | 100 | the backend's balance refresh (`BALANCE_POLL_MAX_PER_MINUTE`, 1–500) |
| `DEFAULT_SIGNAL_SCAN_PER_MINUTE` | 100 | the signal REST: the on-demand GETs without the source and the backfill's overflow, on one pacer (`SIGNAL_SCAN_MAX_PER_MINUTE`, 25–200; the name stays for compose) |

- `BROKER_BUDGET_HOLDS` throws at import if the defaults sum over the limit (`broker-budget.test.ts`
  B1).
- Ceilings set in env above their defaults may sum over it. That is an operator's choice: the
  backend writes one `warn` `broker budget over the per-IP limit` at start, and the signal pacer's
  pause on a 429 is the backstop.
- Nothing counts the three processes together at run time (stated). The signal pacer's worst 60 s
  window above its share is its bucket plus one overflow token (11 at the default, 19 at the
  maximum), bounded at import at the maximum only.
- A worker deploy runs two workers for its overlap, the readiness wait (≤ `READY_TIMEOUT_S`, 120 s)
  plus the drain (≤ 40 s), longer after an interrupted run until an operator resolves it
  ([worker-deploy.md](worker-deploy.md), #95):
  for that window the worker's share can double (accepted there, risk 1).
- OAuth, token exchanges and the pairs catalog are outside every share.

**The pacer** (`pacer.ts`, #405) is the one token bucket of every signal chart GET, refilled at
`SIGNAL_SCAN_MAX_PER_MINUTE / 60 s`, with room for `signalRestCapacity(ceiling)` =
`ceil(ceiling × 5 000 / 60 000) + 1` tokens (10 at the default 100, 18 at 200, 4 at 25): the
on-demand GETs of one `5s` candle - the steps of every session on `5s` decide at one boundary -
plus a spare token, so a burst a few ms earlier relative to its boundary than the one before does
not find the bucket a fraction of a token short (#382 review M1; `pacer.test.ts` P9).
- `tryTake` is the feed's GET by demand: `POST /trading/signal`, a session step and the session
  start, whenever the source has no window. No token is the `rate_limited` refusal of
  [Outcomes](#outcomes).
- `tryTakeSpare` is the candle backfill's ([market-data.md → Backfill](market-data.md#backfill-590),
  #590): only the overflow, what a refill discards above the capacity, held to one token, which
  `tryTake` never sees on a clock that does not go back (`pacer.test.ts` P10, P12). While the
  source is live only an interval the ring does not build calls `tryTake` (`1m` and longer - never
  from the bot, #313), so the bucket stays nearly full and the backfill gets nearly the whole share
  (P10; the scanner takes no token, S26). Without the source the GETs by demand take the bucket
  first.
- Together they carry at most `perMinute + capacity + 1` in any 60 s window (P11): 219 at the
  maximum.
- A 429 of either pauses both - one object, one per-IP window: for `Retry-After` held to 15–120 s
  (`SIGNAL_SCAN_BACKOFF_MIN_MS`/`_MAX_MS`), or without it for 15 s doubling to 120 s; a 429
  without Retry-After while a pause runs is the same burst and neither doubles nor extends it
  (`pacer.test.ts` P3b, P7, P8, P13). During a pause a GET by demand answers `rate_limited` with
  what is left of it.

The backend's `TIMING_CHAIN_HOLDS` adds the signal links, checked at import and in
`timing.test.ts`:
- for every interval of `SIGNAL_SCAN_INTERVALS`: `CANDLE_CLOSE_SLACK_MS < L` and
  `SIGNAL_FETCH_BUDGET_MS + CANDLE_CLOSE_SLACK_MS < L` with `L` the candle (3 500 < 5 000 on `5s`):
  a scan starts inside its candle, and a GET by demand asked at the boundary ends inside it;
- `SIGNAL_SCAN_BACKOFF_MIN_MS ≤ SIGNAL_SCAN_BACKOFF_MAX_MS`;
- the env bounds around the default; `MIN_SIGNAL_SCAN_PER_MINUTE` is the literal 25 (the lowest
  value `.env` files carry since #382), and `signalRestCapacity(25) ≥ 2`;
- the pacer's worst 60 s window at the highest ceiling, `signalRestWorstWindow(200)` = the ceiling,
  the bucket and the overflow token (200 + 18 + 1 = 219), below the broker's window;
- `SIGNAL_PACER_RETRY_SEC × 1000 ≤ SIGNAL_CACHE_MAX_TTL_MS`.

## MACD and MA on history (#483)

The question (owner, 2026-10-14): do the MACD cross and the MA50/MA200 trend filter the card shows
(#482) improve the win rate at the payout? Answered on the #381 stand ([signal-stand.md](signal-stand.md)),
the cache of 2026-10-01…10-15 (28 pairs, split at 2026-10-11T09:27Z, headline delay 1000 ms from
calibrate, the pause on), run on 2026-10-17 at `de95942` (the code of PR #589) with
`STAND_DIR=~/binarius-stand/stand NODE_OPTIONS=--max-old-space-size=4096 pnpm --filter @binarius/signal-stand stand run --variants v2,v2+macd,v2+ma,v2+macd+ma --intervals 5s,15s --out ~/binarius-stand/stand/out/483-de95942`
(28 of 28 pairs, about 16 min); the report is `~/binarius-stand/stand/out/483-de95942/report.md`,
outside the repository, quoted in PR #589.

Each variant starts from Signal v2 at the production point (15/5) and reads production's
`displayIndicators` over the 300-row window: `v2+macd` — `cross` (the histogram crosses zero in the
direction on the last closed candle) or `hist` (its sign agrees); `v2+ma` — the close on the
direction's side of MA200, of MA50, or of both; `v2+macd+ma` — both. The rule, fixed before the run
(owner's clarify answer В1, 2026-10-17): a point is `better` when its Wilson 95 % lower bound is
above v2's rate, it keeps ≥ 10 % of v2's trades (`MIN_KEPT_SHARE_PCT`) and its in-sample rate is
above v2's; an indicator is added only if one point is `better` on 5s and on 15s. The verdict is
the stand's own (table (h)), not computed by hand.

Out-of-sample (2026-10-11T09:27Z…10-15, 96.4 h), pooled over the 25 pairs paying ≥ 80 %
(break-even 55.6 %), the pause on, delay 1000 ms; trades = W + L + T, win % = W / (W + L):

| interval | variant | point | trades | kept % | win % | 95 % CI | v2 win % | Δ pp | in-sample Δ pp | trades/pair-h | PnL/trade | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 5s | v2 | production 15/5 | 339481 | 100 | 49.9 | 49.7-50.0 | — | — | — | 140.89 | -0.05 | (reference) |
| 5s | v2+macd | cross | 32268 | 9.5 | 49.9 | 49.4-50.5 | 49.9 | 0.1 | 0.1 | 13.39 | -0.05 | inconclusive |
| 5s | v2+macd | hist | 264231 | 77.8 | 49.8 | 49.6-50.0 | 49.9 | -0.1 | 0.0 | 109.66 | -0.05 | inconclusive |
| 5s | v2+ma | 200 | 241306 | 71.1 | 50.0 | 49.8-50.2 | 49.9 | 0.2 | 0.0 | 100.15 | -0.05 | inconclusive |
| 5s | v2+ma | 50 | 333621 | 98.3 | 49.9 | 49.7-50.0 | 49.9 | 0.0 | -0.0 | 138.46 | -0.05 | inconclusive |
| 5s | v2+ma | 50+200 | 239781 | 70.6 | 50.0 | 49.8-50.2 | 49.9 | 0.2 | 0.1 | 99.52 | -0.05 | inconclusive |
| 5s | v2+macd+ma | cross, 200 | 25699 | 7.6 | 49.9 | 49.3-50.5 | 49.9 | 0.0 | -0.1 | 10.67 | -0.05 | inconclusive |
| 5s | v2+macd+ma | cross, 50 | 32267 | 9.5 | 49.9 | 49.4-50.5 | 49.9 | 0.1 | 0.1 | 13.39 | -0.05 | inconclusive |
| 5s | v2+macd+ma | cross, 50+200 | 25698 | 7.6 | 49.9 | 49.3-50.5 | 49.9 | 0.0 | -0.1 | 10.67 | -0.05 | inconclusive |
| 5s | v2+macd+ma | hist, 200 | 174302 | 51.3 | 50.0 | 49.7-50.2 | 49.9 | 0.1 | 0.1 | 72.34 | -0.05 | inconclusive |
| 5s | v2+macd+ma | hist, 50 | 258488 | 76.1 | 49.8 | 49.6-50.0 | 49.9 | -0.0 | 0.0 | 107.28 | -0.05 | inconclusive |
| 5s | v2+macd+ma | hist, 50+200 | 172773 | 50.9 | 49.9 | 49.7-50.2 | 49.9 | 0.1 | 0.1 | 71.71 | -0.05 | inconclusive |
| 15s | v2 | production 15/5 | 174250 | 100 | 50.0 | 49.8-50.2 | — | — | — | 72.32 | -0.05 | (reference) |
| 15s | v2+macd | cross | 11420 | 6.6 | 49.9 | 48.9-50.8 | 50.0 | -0.1 | -0.2 | 4.74 | -0.05 | inconclusive |
| 15s | v2+macd | hist | 133364 | 76.5 | 50.2 | 49.9-50.4 | 50.0 | 0.2 | -0.0 | 55.35 | -0.05 | inconclusive |
| 15s | v2+ma | 200 | 119356 | 68.5 | 50.0 | 49.7-50.3 | 50.0 | 0.0 | -0.1 | 49.54 | -0.05 | inconclusive |
| 15s | v2+ma | 50 | 170818 | 98.0 | 50.0 | 49.8-50.2 | 50.0 | -0.0 | 0.0 | 70.89 | -0.05 | inconclusive |
| 15s | v2+ma | 50+200 | 118463 | 68.0 | 50.0 | 49.7-50.3 | 50.0 | 0.0 | -0.1 | 49.17 | -0.05 | inconclusive |
| 15s | v2+macd+ma | cross, 200 | 8813 | 5.1 | 49.8 | 48.7-50.9 | 50.0 | -0.2 | -0.1 | 3.66 | -0.05 | inconclusive |
| 15s | v2+macd+ma | cross, 50 | 11419 | 6.6 | 49.9 | 48.9-50.8 | 50.0 | -0.1 | -0.2 | 4.74 | -0.05 | inconclusive |
| 15s | v2+macd+ma | cross, 50+200 | 8812 | 5.1 | 49.8 | 48.7-50.8 | 50.0 | -0.2 | -0.1 | 3.66 | -0.05 | inconclusive |
| 15s | v2+macd+ma | hist, 200 | 83952 | 48.2 | 50.2 | 49.8-50.5 | 50.0 | 0.2 | -0.0 | 34.84 | -0.05 | inconclusive |
| 15s | v2+macd+ma | hist, 50 | 130001 | 74.6 | 50.2 | 49.9-50.4 | 50.0 | 0.2 | 0.0 | 53.95 | -0.05 | inconclusive |
| 15s | v2+macd+ma | hist, 50+200 | 83051 | 47.7 | 50.2 | 49.8-50.5 | 50.0 | 0.1 | -0.0 | 34.47 | -0.05 | inconclusive |

Every point is within 0.2 pp of v2, no lower bound clears v2's rate, and no point is `worse`
either; every row, v2 included, is below the 55.6 % break-even. The in-sample selection picked
`cross` / `50+200` / `cross, 50` on 5s and `hist` / `50` / `hist, 50` on 15s — different points on
the two intervals.

By pair type (table (i), out-of-sample, pooled within the type), win % of the selected points:

| interval | variant | point | currency | commodity | stock | cryptocurrency | index |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 5s | v2 | production | 49.5 | no trades | 50.1 | 50.0 | 50.0 |
| 5s | v2+macd | cross | 49.3 | no trades | 50.3 | 49.7 | 50.4 |
| 5s | v2+ma | 50+200 | 49.6 | no trades | 50.5 | 49.8 | 50.3 |
| 5s | v2+macd+ma | cross, 50 | 49.3 | no trades | 50.3 | 49.7 | 50.4 |
| 15s | v2 | production | 49.6 | 50.1 | 49.6 | 49.9 | 50.6 |
| 15s | v2+macd | hist | 50.0 | 50.4 | 49.8 | 49.9 | 50.7 |
| 15s | v2+ma | 50 | 49.7 | 49.9 | 49.6 | 49.9 | 50.5 |
| 15s | v2+macd+ma | hist, 50 | 50.0 | 50.2 | 49.7 | 49.8 | 50.7 |

No type reaches 55.6 % under any point; the best cell is 50.7 % (15s, index, `hist`). The one
commodity pair (XAG) makes no 5s trade at the production point (the whole range, not only
out-of-sample).

Refusal shares (table (e), whole range, % of decisions) of the new gates at the selected points:
5s `cross` — `macd_no_cross` 34.5; 5s `50+200` — `ma200_disagrees` 11.2, `ma200_no_data` 0.8,
`ma50_disagrees` 0.2; 15s `hist` — `macd_hist_disagrees` 10.6; 15s `50` — `ma50_disagrees` 0.8.
`indicators_unavailable` never occurs.

Decision (В1):

- **MACD cross** — not added: it keeps 9.5 % (5s) and 6.6 % (15s) of v2's trades, below the
  10 % floor, at 49.9 % against v2's 49.9 % and 50.0 %.
- **MACD histogram sign** — not added: 49.8 % against 49.9 % on 5s (Δ −0.1 pp), 50.2 % against
  50.0 % on 15s with the lower bound 49.9 % under v2's rate and an in-sample Δ of −0.0 pp.
- **MA200 / MA50 / both** — not added: Δ 0.0…0.2 pp on both intervals with every lower bound
  under v2's rate; MA50 keeps 98 % of v2's trades, so it barely filters.
- **MACD and MA together** — not added: no one of the six points is `better` on either interval.

Signal v3: not created — table (h)'s line «Points better on every interval of this run (5s, 15s):
none». The decision stays Signal v2; MACD and MA stay on the card only.

## What it is not

- It gives no probability and no confidence score. The decision is the direction or the reason,
  plus the features (owner's decision 2026-10-03).
- It does no tuning or backtesting and makes no profitability claim — the stand (#381) does,
  outside the processes.
- **The stand (#381).** The backtest lives in `packages/signal-stand`
  ([signal-stand.md](signal-stand.md)): a CLI that replays this decider, `chartWindow` and the
  journal replay unchanged on cached broker candles. No process imports it, and it has its own
  request cap outside [The budget](#the-budget)'s three loops (it runs from another IP).
- The decider makes no network calls, writes no logs and contains no user-facing text (the feed
  does the fetching and the logging). The Russian wording of a reason belongs to the bot (#126).
- It does not read volume or price ticks; it works from the chart and the pair's `digits` only.
  #392's spike measures tick-built candles ([broker-socket.md → The candle spike](broker-socket.md#the-candle-spike-392));
  the socket source is #404 and its consumers, the feed and the scanner, #405.
- **A second detector, H1 (#667).** `packages/signal/src/h1.ts` decides on end-labelled 1s closes
  at the closed second: a 5-second move against the RMS of the 5-second moves of the last 300 s
  ([signal-stand.md → H1](signal-stand.md#h1-on-the-1s-series-667)). It is not a candle decider
  and not a version of this one: `SIGNAL_ALGORITHM_VERSIONS` stays `v1`, `v2`. The stand runs it on
  history, and since #669 the backend's shadow runs it on a 1s series of live ticks with two sets,
  R1 and the reference, without trading ([h1.md](h1.md)).

## Boundaries

- #287 (shipped): session orchestration, which asks `POST /trading/signal` inside a session
  (docs/trading-session.md). #90: the broker base URL in the worker's env and compose.
- #404, #590, #405 (shipped): the data socket's ring, its REST backfill, and the feed and the
  scanner reading it ([market-data.md](market-data.md)).
- #320 (shipped): the bot's «Сигналы сейчас» screen reads `GET /trading/signals` and joins it
  with the pairs catalog for the symbol and payout ([bot-demo.md](bot-demo.md#the-signals-screen-320)).
  The scanner keeps no history in the database.
- #126: the analysis screen and its texts in the bot, on `POST /trading/signal`
  ([bot-demo.md](bot-demo.md#the-analysis)). #127: the stake button's press and the intent status. Stake size: docs/stake.md.
- The decision's wire shape and codes are in `packages/shared/src/signal.ts` (#258).
  `packages/db` is not changed.
- #483: MACD and MA as decision gates, backtested on the stand and not added
  ([MACD and MA on history](#macd-and-ma-on-history-483)); no Signal v3 task follows from it.
- #667 (H1 detector and its stand run), #669 (the live 1s series and shadow mode), #670 (H1
  sessions on a marked account).
