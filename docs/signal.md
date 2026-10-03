# Signal v1 (issue #132)

`apps/trading-worker/src/signal/` turns a series of candles into a trade direction (`up` or
`down`) or into a reason why there is none. It does not use an LLM. It is a pure function: it
reads no clock, no environment and no network, and writes no log. The same candles, `intervalMs`,
`nowMs` and parameters always give the same decision. Nothing in the worker calls it yet. Fetching
the candles, keeping a decision journal and wiring the module into the process are #133.

Nobody has shown that this algorithm makes money. It is a technical baseline: the defaults are not
tuned and no backtest was run.

```bash
pnpm test --project unit apps/trading-worker/src/signal   # needs no database or Redis
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

| `reason` | `detail` | What the caller (#133, #126) does |
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
exact series. For decisions to be comparable, #133 fetches a fixed `limit` and records the series.

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
#133 can log it as it is. All codes come from `as const` constants in `codes.ts`: `SignalKind`,
`NoSignalReason`, `CandleProblem`, `TrendDirection` and `MomentumDirection`. The direction is
shared's `TradeAction`.

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

## What it is not

- It gives no probability and no confidence score. The decision is the direction or the reason,
  plus the features (owner's decision 2026-10-03).
- It does no tuning or backtesting and makes no profitability claim.
- It makes no network calls, writes no logs and contains no user-facing text. The Russian wording
  of a reason belongs to the bot (#126).
- It does not read volume or price ticks. v1 works from the chart only.

## Boundaries

- #133: fetching candles (`getChart`), the decision journal, wiring the module into `index.ts` and
  the env.
- #126: the user-facing texts. #19: stake size. #130: session orchestration.
- `packages/shared` and `packages/db` are not changed. When the first issue carries a decision
  across a process boundary, it moves the decision's wire shape into shared.
