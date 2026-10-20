# Signal stand (#381)

`packages/signal-stand` backtests the Signal decider on the broker's candle history. It is a CLI
with four commands. `fetch` caches candles from the public chart API. `run` replays the variants
below on that cache and writes a report. `calibrate` checks the stand against the live sessions'
trades and journal. `h1` replays the H1 detector on the cached `1s` series
([H1 on the 1s series](#h1-on-the-1s-series-667)). No process imports the package: no `apps/*` manifest names it, and
`grep -rn signal-stand apps/` is empty. It reuses production code unchanged:
- `createBrokerRestClient().getChart`/`listPairs`, with the wire parser;
- `chartWindow`, `SIGNAL_CHART_LIMIT` and `SIGNAL_FETCH_LIMIT`;
- `createSignalDecider`/`createSignalDeciderV1`, and `createH1Detector` (#667);
- `displayIndicators` (#482), the MACD and MA50/MA200 the analysis card shows;
- `replaySignalJournalEntry`;
- `breakEvenPct`, `MIN_CYCLE_PAYOUT_PCT` and `PAIR_TYPE_GROUPS`.

The stand computes no indicator of its own. Every variant reads a production decider's decision,
and the MACD/MA variants also read production's `displayIndicators`.

The report and the cache stay outside the repository. A run's summary goes to #381 as a comment.

## Commands

From the repository root, under the project's Node (`eval "$(fnm env)" && fnm use`):

```bash
export STAND_DIR=~/binarius-stand/stand            # required; missing or empty is a usage error
BROKER_API_BASE_URL=https://api.binodex.app pnpm --filter @binarius/signal-stand stand fetch
pnpm --filter @binarius/signal-stand stand calibrate \
  --journal ~/binarius-stand/live/journal-381.jsonl \
  --trades ~/binarius-stand/live/trades-381.json \
  --session-candles ~/binarius-stand/candles
pnpm --filter @binarius/signal-stand stand run      # -> $STAND_DIR/out/<timestamp>/report.md
pnpm --filter @binarius/signal-stand stand h1       # -> $STAND_DIR/out/<timestamp>/report-h1.md
```

| Command | Options (defaults) | Env |
|---|---|---|
| `fetch` | `--assets <id,…>` (`STAND_ASSET_IDS`, the 28 below), `--days <1-30>` (`STAND_DEFAULT_DAYS` 14), `--intervals` (`1s,5s,15s,1m`) | `BROKER_API_BASE_URL` (https, or http to localhost); `STAND_MAX_GETS_PER_MINUTE` (1..600, default 120) |
| `run` | `--assets` (the 28), `--out <dir>` (`$STAND_DIR/out/<ISO time>`), `--headline-delay <0\|1000\|3000>`, `--variants <name,…>` (every variant), `--intervals <5s,15s,1m>` (all three) | — |
| `calibrate` | `--journal` (`$STAND_DIR/live/journal-381.jsonl`), `--trades` (`$STAND_DIR/live/trades-381.json`), `--session-candles` (`$STAND_DIR/candles-sessions`) | — |
| `h1` | `--assets` (the 28), `--out <dir>` (`$STAND_DIR/out/<ISO time>`), `--move-sec <3,5>`, `--sd-step <3,5>` (both absent: the reference H1 and R1 shapes only; either one: the product of the two, the absent one the whole grid), `--thresholds <0.5,0.75,1,1.25,1.5,2>`, `--delays <1,2>`, `--expiries <5,15>` (each the whole grid; a value outside it or repeated is a usage error) | — |

`run --variants` and `--intervals` narrow a run; the report covers exactly what ran and names it
in its header. An unknown or repeated name is a usage error, and so is a variant that compares
with `v2` (`v2+…`) without `v2` in the list. A variant with none of its intervals left is skipped.
#483's run is `--variants v2,v2+macd,v2+ma,v2+macd+ma --intervals 5s,15s`: on the 2026-10-15
cache the 28 pairs took about 16 min (2026-10-17, `de95942`; the smoke run of EUR/USD alone took
about 66 s) with `NODE_OPTIONS=--max-old-space-size=4096` (one pair peaked at about 1 GB resident).

`--days` bounds only a series' first fetch. A later fetch continues from the cache's last row and
never extends a series backwards: to widen the range, fetch into an empty `$STAND_DIR`. `run`
warns on stderr, naming the pairs, when the pooled pairs' `1s` ranges differ by more than a day
(`run.test.ts` R5, R5b).

The exit codes are:
- 0: done; for `calibrate`, every gate passed.
- 1: a refusal. This covers a failed fetch, a damaged cache, an asset missing from `pairs.json`
  (on an empty `$STAND_DIR`, `h1` prints `h1: asset 237831086 is not in pairs.json; fetch it`), a
  cache without a `1s` series for any asked pair (`h1: no 1s series in <dir>`) and a failed
  `calibrate` gate.
- 2: a usage error. This covers an unknown command or option, a value out of range and a missing
  env.

Progress and refusals go to stderr as plain lines. A broker error is printed as its name, code,
status and `retryAfterSec`, never with its URL or body (Rule 8). The chart and pairs endpoints take
no token, and the stand reads none.

`calibrate` reads the owner's files and writes only `$STAND_DIR/calibration.json`, and only on
PASS. Run with the explicit flags above, it writes nothing next to them.

## The budget

`fetch` takes one token per GET from its own bucket of `STAND_MAX_GETS_PER_MINUTE` tokens.
The default is `STAND_DEFAULT_GETS_PER_MINUTE`, 120. The bucket is full again a minute after the
window it was drawn in opened. `config.ts` throws at import unless the default is below
`BROKER_RATE_LIMIT_PER_MINUTE` (600), which `config.test.ts` K1 and K2 check.

The stand is not one of the three budgeted loops (`broker-budget.ts` is unchanged). It runs from
the owner's machine, another IP than the pilot. A local dev stack polling the broker from the
same machine shares that IP's window, so do not fetch while one runs.

On a 429, `fetch` waits `retryAfterSec`, or 60 s without it, and asks for the same page again.
Any other error (`unauthorized`, `rejected`, `unavailable`, `contract_violation`, `aborted`) ends
the command with exit 1. Every complete page stays in the cache, and a re-run continues after the
last stored row.

Each request is one window of `STAND_PAGE_LIMIT` (5 000) steps. For 14 days, one pair costs
about 313 GETs: `1s` 242, `5s` 49, `15s` 17 and `1m` 5. All 28 pairs cost about 8.7k GETs, which
is about 73 min at 120/min. The `1s` series takes about 96 MB per pair and the four series
about 120 MB, so 28 pairs take about 3.4 GB (measured on NZD/USD, 2026-10-15).

## The cache

```
$STAND_DIR/
  pairs.json                      the catalog snapshot of the fetched pairs: id, symbol, type, digits, payout, minTimeframe, fetchedAt
  candles/<assetId>/<interval>.jsonl   one [timestamp, open, high, low, close] per line, ascending
  calibration.json                calibrate's choice of the headline delay
  out/<run>/report.md, report.json
```

- **Appending.** A page is appended after it was parsed. The forming candle is never stored,
  because its close is not final and a stored row is never fetched again. Only rows with
  `timestamp + step <= now` at the answer are kept.
- **The first row of an answer is never stored.** Its `open` is the first tick inside the
  requested window, not the previous close. Each request therefore starts one step before the
  first wanted row, and drops its first row (`fetch.test.ts` F1c). After a gap longer than a
  page, the first row past the gap is the dropped one: one row is lost there (F1b).
- **Reading.** Every line is checked against the wire's shape (`candleWireSchema`). A broken last
  line is the trace of a crash mid-append. It is dropped with one stderr line, and the next
  append cuts it first. A broken line anywhere else is an error naming the file and the line
  (exit 1). A row at or before its predecessor is skipped (the monotonic guard), with one stderr
  line.
- **Concurrency.** Run one process per `$STAND_DIR` at a time. There is no lock file.
- **Pairs.** A `fetch` of some pairs keeps the snapshot of the others. `digits`, `payout` and
  `type` are read only from `pairs.json`.

## The cadence model

Each pair and interval is simulated as one session running through the whole cached range. The
timing constants are copied from `apps/trading-worker/src/trading-session/config.ts`, which a
package cannot import:

| Stand constant | Value | Worker's constant |
|---|---|---|
| `DECISION_SLACK_MS` | 2 000 | `TRADING_SESSION_CANDLE_SLACK_MS` |
| `SETTLE_TICK_MS` | 5 000 | `TRADING_SESSION_TICK_MS` |
| `ATTEMPT_WINDOW_MS` | 10 000 | `TRADING_SESSION_ATTEMPT_TIMEOUT_MS` |

The simulation runs as follows (`simulate.ts`):
1. The first decision falls at the first interval boundary after the range start, plus the slack.
2. The decision at moment `D` sees `seriesAt(series, intervalMs, D)`. These are the cached rows
   from `chartWindow(D)`'s `start_time` to the boundary of `D`: the rows the broker would have
   answered, with the forming candle that the decider drops (`window.test.ts` W1, on the mock
   broker).
3. No trade means the next decision is at the next boundary plus the slack.
4. A trade enters at `D + openDelay` and exits after its duration. The next decision is at the
   exit plus `SETTLE_TICK_MS`, so trades never overlap.
5. The range ends when a trade's exit would pass its end.

The trade intervals and their durations are `5s` with 5 s, `15s` with 15 s, and `1m` with 60 s.

**The pause overlay** is Rule 28's rule, `pausedDirection` in the orchestrator. Suppose the last
two priced trades lost in one direction, and the last decision was that same direction. A new
decision in that direction is then skipped and counted as `pause_after_two_losses`. Any no-signal
or opposite decision clears the pause. A tie breaks the streak, and an unpriced trade is skipped
by it. Every variant runs with and without the pause.

**The memo.** `v2` at the production point and the display indicators depend only on the interval
and `D`, so each pair keeps them per interval and `D` while it runs (`createDecisionMemo`), and the
six pause × delay runs of a point read them back. A memoised run equals an unmemoised one
(`simulate.test.ts` S10). `v2` at an explicit grid point is not memoised.

## Pricing

`priceAt(ms)` is the close of the `1s` row labelled `floor(ms / 1000) × 1000`. A missing row
leaves the trade `unpriced`: it is counted and excluded from the rate. The stand never takes the
nearest row.

Outcomes work as follows:
- `up` wins when `exit > entry`, and `down` wins when `exit < entry`.
- An equal exit is a tie: the stake comes back, and the trade is neither a win nor a loss.
- The rate is `wins / (wins + losses)`.
- PnL at stake 1 is `+payout/100` per win, `−1` per loss and 0 per tie. It is illustrative only.

`openDelay` counts from the decision moment `D`, the boundary plus `DECISION_SLACK_MS`. A trade
enters at `priceAt(D + openDelay)` and exits at `priceAt(D + openDelay + duration)`. The stand
never enters at the last closed candle's close: at `openDelay` 0 the entry is the close of the
`1s` row at `D`, about 2 s after that candle closed (`price.test.ts` P3, through `simulate`).

The grid is `OPEN_DELAY_GRID_MS = [0, 1000, 3000]`:
- 0 is the open inside `D`'s own second, the expected case.
- 1 000 is the open in the next second: a slow open, or the `1s` label shift (148 of 495 live
  trades, see Observed live).
- 3 000 is a late entry, about 2.4 s later than live. It is a sensitivity point, never the
  expected headline.

The headline delay is `--headline-delay`, else `calibrate`'s choice from `calibration.json` (see
Calibration), else the fallback `FALLBACK_HEADLINE_DELAY_MS`, 0 (`run.test.ts` S9). The live open
is `D` + 397 ms at the median and `D` + 927 ms at the p95, so it falls in `D`'s own one-second
bucket in most trades.

## Variants

| Variant | Intervals | Grid | Headline pause |
|---|---|---|---|
| `v1` | 5s, 15s, 1m | — | off (v1 had none) |
| `v2` | 5s, 15s, 1m | `rsiExtremeBand` {10, 15, 20} × `minAtrTicks` {3, 5, 8} | on (production) |
| `revert` | 5s, 15s | `band` {10, 15, 20} | on |
| `v2+1m` | 5s, 15s | — | on |
| `v2+macd` | 5s, 15s | `macd` {cross, hist} | on |
| `v2+ma` | 5s, 15s | `ma` {200, 50, 50+200} | on |
| `v2+macd+ma` | 5s, 15s | `macd` {cross, hist} × `ma` {200, 50, 50+200} | on |

- **`v1`** is `createSignalDeciderV1(DEFAULT_SIGNAL_PARAMS_V1)`. It is the reference and the v1
  era's comparison.
- **`v2`** is `createSignalDecider({ ...DEFAULT_SIGNAL_PARAMS, rsiExtremeBand, minAtrTicks })`,
  with `digits` from `pairs.json`. Every grid point passes `assertSignalParams` (V9). The point
  15/5 is production: it is always reported, selected or not. At that point the stand's decision
  equals `createSignalDecider()`'s on the fixture (V2).
- **`revert`** trades against the rush. It reads `v2`'s decision at the default point. A data
  refusal or a volatility refusal (`volatility_too_low/high`, `volatility_below_tick_floor`)
  means no trade. Otherwise `rsi ≥ 50 + band` means `down` and `rsi ≤ 50 − band` means `up`; the
  EMA trend is ignored.
- **`v2+1m`** is #380's first variant. It takes `v2`'s action only when the `1m` decision (v2,
  default point, same `nowMs`) has `features.trend` equal to the action. A `1m` data refusal means
  no trade.
- **60 s trades** are `v1` and `v2` on the `1m` interval, where the cadence runs on minute
  boundaries.

- **`v2+macd`, `v2+ma`, `v2+macd+ma`** are #483's. Each starts from `v2`'s decision at the
  production point; its refusal stands. Then it reads `displayIndicators` over
  `seriesAt(…, SIGNAL_FETCH_LIMIT)`, the 300 rows the feed fetches since #482, with
  `DEFAULT_SIGNAL_PARAMS`: the numbers the analysis card shows at the same moment. No indicators
  (the tail failed the candle checks) is `indicators_unavailable`. The gates come in this order,
  and the first one that holds names the refusal in table (e):
  - `macd=cross`: the histogram crossed zero in the action's direction on the last closed candle
    (`macd.cross === action`), else `macd_no_cross`;
  - `macd=hist`: the histogram's sign agrees (`> 0` for `up`, `< 0` for `down`; zero agrees with
    neither), else `macd_hist_disagrees`;
  - `ma=200` / `ma=50`: the last close is on the action's side of the average (above for `up`,
    below for `down`; equal is neither side), else `ma200_disagrees` / `ma50_disagrees`;
  - `ma=50+200`: both, MA200 first;
  - an indicator short of rows is `macd_no_data`, `ma200_no_data` or `ma50_no_data`.

  A point of the wrong shape (a string where a number belongs, a mode outside the grid) is a
  `RangeError`, never a default (V14).

The decision's window is `seriesAt`'s default `limit`, `SIGNAL_CHART_LIMIT` (60 rows), as in
production; only the indicators read the longer `SIGNAL_FETCH_LIMIT` window (V12).

## Statistics

- The win rate's 95 % interval is Wilson's (`z = 1.959964`). Its reference values are
  `8/30 → [14.2, 44.4]`, `0/10 → [0, 27.8]` and `180/300 → [54.4, 65.4]`
  (`packages/shared/src/wilson.test.ts` W1). Wilson, the verdict and the markdown table live in
  `packages/shared/src/wilson.ts`, one source with the H1 shadow report
  ([h1.md → The report](h1.md#the-report)).
- Break-even at a payout is `100 × 100 / (100 + payout)`, so 80 % gives 55.6 %.
- **Split.** The range runs from the first to the last cached `1s` row of the run's pairs. It
  splits at `since + 5/7 × (until − since)`. A trade is in-sample when its decision falls before
  the split (S7).
- **Selection.** For each variant and interval, the stand pools the in-sample trades over the
  pooled pairs, at the headline delay and the variant's headline pause. Among the grid points
  with at least `MIN_IN_SAMPLE_TRADES` (100) trades, it takes the one with the highest rate. The
  report then shows that point's out-of-sample numbers.
- **Pooling.** Only pairs whose payout is ≥ `MIN_CYCLE_PAYOUT_PCT` (80) enter the pooled rows,
  and a pooled row's break-even is at 80 %. Every pair keeps its own row, with its own payout's
  break-even.
- **Verdict.** `beats break-even` needs the interval's lower bound above the break-even.
  `below` means the upper bound is under it. Anything else is `inconclusive`, including a bound
  that equals the break-even.
- **Against v2** (#483, fixed before the run). Every point of a `v2+…` variant is compared with
  `v2` at the production point, out-of-sample, pooled, at the headline delay with the pause on
  (`againstV2`, T6–T9):
  - `no evidence`: the variant or `v2` has no decided trade in the in-sample or the
    out-of-sample part;
  - `better`: the variant's Wilson lower bound is above `v2`'s rate, it keeps at least
    `MIN_KEPT_SHARE_PCT` (10) % of `v2`'s priced trades (W + L + T), and its in-sample rate is
    above `v2`'s;
  - `worse`: the upper bound is below `v2`'s rate;
  - `inconclusive`: anything else.

  An indicator is added only if one and the same point is `better` on `5s` and on `15s`. At the
  pooled payout of 80 the PnL per trade is monotone in the rate, so the verdict is on the rate.
- **Trades per pair-hour** is a row's trades over its pairs (pooled pairs, the type's pooled
  pairs, or 1) times the hours of its sample: in-sample `split − since`, out-of-sample
  `until − split` (`run.test.ts` R9). Pooled pairs with a range shorter than the run's by more
  than a day (R5's warning) are under-counted by it.

## Reading the report

`report.md` has nine tables, and `report.json` holds every number they print. `run` prints table
(a) to stdout. Each row shows the interval, variant, parameters, pause, delay, scope, trades,
W/L/T, win %, its interval, break-even, verdict, PnL and `trades/pair-h`.

- **(a) Headline.** The selected point of each variant and interval, out-of-sample, pooled. `v2`
  also gets the production point. A variant with no point at 100 in-sample trades keeps a line:
  a single-point variant (`v1`, `v2+1m`) is shown with its numbers, and the others get a line
  `no point with >= 100 in-sample trades (best: N)`, `N` being the most in-sample trades of any
  of its points (`run.test.ts` R4).
- **(b) Per pair**, grouped by pair type (`PAIR_TYPE_GROUPS`). These rows use the pair's own
  payout and break-even. The scope column also gives the pair's trade count over the whole range.
  Acceptance criterion 1 reads this column: at least 300 trades per pair and interval.
- **(c)** The selected points at each `openDelay`.
- **(d)** The selected points with the pause off and on. This table answers whether the pause
  helps.
- **(e)** The refusal shares by reason, over the whole range, for each selected point.
- **(f)** The full in-sample grid, pooled. Selection reads it.
- **(g)** The pairs snapshot (`fetchedAt`), and each series' rows, first and last timestamp.
- **(h) Against v2 production.** One row per point of every `v2+…` variant and interval of the
  run, the selected point marked `(selected)`: trades, `kept %` of `v2` production's trades,
  W/L/T, win % and its interval, `v2`'s rate, the out-of-sample and in-sample differences in
  percentage points, `trades/pair-h`, PnL per trade and the verdict above (`run.test.ts` R7,
  R7b). Its first line names the points `better` on every interval of the run, with those
  intervals, and reminds that adding an indicator needs 5s and 15s. A run with no `v2+…` variant
  prints `no variant against v2 in this run`.
- **(i) Per pair type.** `v2` production and each `v2+…` variant's selected point, out-of-sample,
  pooled within each `PAIR_TYPE_GROUPS` type over its paying pairs, break-even at 80. A type with
  no pooled pair has no row (R8).

The header names the range, the split, the headline delay and where that delay came from: the
`--headline-delay` flag, `calibration.json`, or the fallback 0 ms when `calibrate` has not
run. It also names the run's variants and intervals, the hours behind `trades/pair-h`, and the
pairs left out of pooling.

`stand h1` writes `report-h1.md` and `report-h1.json` instead; its tables are in
[H1 on the 1s series](#h1-on-the-1s-series-667).

## H1 on the 1s series (#667)

The hypothesis of #667: on the broker's synthetic quotes a strong 5-second move continues over
the next 5 seconds. `stand h1` replays the production detector (`packages/signal/src/h1.ts`,
Architecture Rule 43) on every pair's cached `1s` series and reproduces the backtest of the
analysis session that found it.

**The rule.** `closes[i]` is the close of the end-labelled second `first + i·1000`, `NaN` where the
chart has no row. At the last closed second `f`, `move = c[f] − c[f − m]` and `sd` is the root mean
square, without centring, of the moves `c[j] − c[j − m]` for `j = f − 300 + k … f` in steps of `k`:
the move `m` (`moveSec`) and the step `k` (`sdStepSec`) are 5 and 5 in the backtest's rule
(`DEFAULT_H1_PARAMS`, 60 moves) and 3 and 5 in R1 (`H1_R1_PARAMS`, #669). The current move is one
of them, so `z = |move| / sd ≤ √(300 / k)` (7.75 at `k` = 5), to the last bit of rounding.
A close outside `H1_PRICE_RANGE` (10^-100 to 10^100, a close ≤ 0 included) reads as a missing row.
A missing move is skipped, not counted as 0. `z >` the threshold (strict; 2 in the backtest's rule,
1 in R1) is a signal in the direction of `move`. Otherwise the decision is `no_signal` with
`no_price` (no close in the range at `f` or `f − m`), `no_volatility` or `below_threshold`. `no_volatility` is a window without movement:
`sd = 0`, hence `move = 0`. Inside the range a move's square neither overflows nor underflows a
double, so `sd` is finite and every decision passes `h1DecisionSchema`. The detector and the
script agree on every second whose closes lie in the range; the script computes 0/0 on a flat
window and does not trade either. Every close of both caches lies in the range: 0.0014835 to
97 335.01 in `~/binarius-stand/stand`, 0.0014835 to 110 548.15 in `stand-30d`, scanned
2026-10-20. Outside the range the script could lose a square to 0 and trade on `|move| / 0`, or
overflow `sd`; the detector refuses there.

**The cadence** is the script's. Per pair, the first decision is at index 300, so a partial
window never decides at the series' start. A `no_signal` moves to the next second. A signal at `f`
opens at `c[f + g]` and closes at `c[f + g + H]`, and the next decision is at `f + g + H + 1`: one
trade at a time per pair. A missing open or close is `unpriced`, counted and left out of the rate,
and the cadence still jumps. The loop ends at the last `f` whose close `f + g + H` is in the series.
The entry delay `g` and the expiry `H` are the trade plan's, not the detector's:
`H1_ENTRY_WINDOW_SEC` (1 to 2 s) and `H1_EXPIRY_SEC` (5) in `packages/shared/src/h1.ts`.

**The grid and the pools.** The shapes (`moveSec`, `sdStepSec`) × threshold {0.5, 0.75, 1, 1.25,
1.5, 2} × entry delay {1, 2 s} × expiry {5, 15 s} (`H1_THRESHOLD_GRID`, `H1_ENTRY_DELAY_GRID_SEC`,
`H1_EXPIRY_GRID_SEC`). A run without `--move-sec` and `--sd-step` takes two shapes,
`H1_DEFAULT_SHAPES`: the reference (5, 5) and R1's (3, `H1_R1_PARAMS.sdStepSec`); with either one
it takes the product of `H1_MOVE_SEC_GRID` {3, 5} and `H1_SD_STEP_GRID` {3, 5} narrowed by the
options (#669, owner's answer of 2026-10-20). The grids hold both live points (`config.test.ts`
K6), so the stand always reproduces them. Each point is pooled twice:
`pay>=94`, the pairs paying at least `H1_MIN_PAYOUT_PCT` (94, break-even 51.5 %), and `pooled>=80`,
the pairs paying at least 80 (break-even 55.6 %, as `run`). A trade belongs to the sample its
decision fell in, split at 5/7 of the run's range. The rate excludes ties and its interval is
Wilson's (Statistics). `EV/trade %` is `100 × PnL / (W + L + T)` at stake 1 and each pair's own
payout. `trades/pair-h` is `run`'s.

**The report.** The headline, out-of-sample, both pools: R1 (`H1_R1_PARAMS`, +1 s, expiry 5 s)
first and the reference H1 (`DEFAULT_H1_PARAMS`, +2 s, expiry 5 s) second line (#669, owner's
answer of 2026-10-20); `stand h1` prints it to stdout, or table (a) whole when the run has
neither point. (a) Every grid point × both pools, out-of-sample. (b) The same, in-sample. (c) Per
pair type over its pairs paying at least 80, out-of-sample, at the headline point's shape and
threshold, every delay and expiry. (d) Per pair at the headline point, with its own payout and
break-even and its whole-range trade count. The headline point is R1's, else the reference's,
else the run's first cell. Every table names the move and the sd step of its rows. (e) Per grid point, the shares of
`no_price`, `no_volatility`, `below_threshold` and signals among the decisions, and the unpriced
count. (f) The pairs snapshot and each series' rows, first and last timestamp. A row with no
decided trade says `no trades`. A grid subset (`--thresholds 2 --delays 2 --expiries 5`) runs
only its points, and every table covers exactly them.

**The reproduction** (`~/binarius-stand/stand`, 2026-10-01 08:30 to 10-15 09:50 UTC, 28 pairs,
7 of them in `pay>=94`), table (a) against #667's table:

| Row of #667 | #667 | `stand h1` |
|---|---|---|
| `pay>=94`, threshold 2, +1 s, 5 s | 59.7 ± 0.4; +16.1 %; ~92/h | 59.74 (59.35-60.14); +16.10 %; 90.97/h |
| `pay>=94`, threshold 2, +2 s, 5 s | 60.5 ± 0.4; +17.5 %; ~87/h | 60.51 (60.11-60.91); +17.56 %; 86.88/h |
| `pooled>=80`, threshold 2, +2 s, 5 s | 60.0 ± 0.2; +13.3 %; ~88/h | 60.03 (59.81-60.24); +13.31 %; 87.82/h |
| `pay>=94`, threshold 1, +1 s, 5 s | 57.0 ± 0.2; +10.9 %; ~306/h | 57.02 (56.80-57.23); +10.90 %; 303.75/h |
| `pay>=94`, threshold 2, +2 s, 15 s | 56.2 ± 0.5; +9.4 %; ~69/h | 56.19 (55.73-56.64); +9.49 %; 68.20/h |

Every win rate is within 0.05 pp of #667's; the acceptance band is ±0.5 pp. The script split
each pair at 5/7 of its own index range and divided by each pair's own hours; the stand uses the
run-wide split and hours, which moves `trades/pair-h` by up to 1 %. The 30-day cache
(`~/binarius-stand/stand-30d`) is the owner's step after its re-fetch of all 28 pairs.
The run reads one pair at a time and its time grows with the pairs and the cells: on `stand-30d`
a cell costs about 0.8 s per pair (#669 Step 0: 24 cells × 7 pairs in 138 s, 2026-10-20,
`NODE_OPTIONS=--max-old-space-size=4096`). The default grid has 48 cells (2 shapes × 6 thresholds
× 2 delays × 2 expiries), six times #667's eight: the default run on `stand-30d`'s 7 pairs ≥ 94
took 178 s (2026-10-20). The whole grid, `--move-sec 3,5 --sd-step 3,5`, has 96, twelve times
#667's. On those 7 pairs the default headline reproduces #667's optimisation: R1 58.77 %,
311.2 trades/pair-h; the reference H1 60.08 %, 87.6 trades/pair-h (60.1 %, 88 there). The detector and the cadence keep no memo across the grid.

**R1's point (#669 Step 0).** The analysis of #667 found R1 (3-second move, threshold 1, +1 s,
5 s: 58.5 %, 321 trades/pair-h on the 7 pairs ≥ 94) with sd as the RMS of the 5-second moves
scaled by √(3/5); the detector takes the RMS of the 3-second moves, so the step and the threshold
were chosen on the stand: the point of `--move-sec 3` whose out-of-sample `trades/pair-h` in
`pay>=94` at +1 s is closest to 321 (a tie to the smaller step), its win rate to stay within
1.5 pp of 58.5 %. Run on `stand-30d`, 7 pairs ≥ 94:

```bash
STAND_DIR=~/binarius-stand/stand-30d NODE_OPTIONS=--max-old-space-size=4096 \
  pnpm --filter @binarius/signal-stand stand h1 \
  --assets 237831086,364060136,759228819,1430524430,1605169136,1775154181,2025372713 \
  --move-sec 3 --sd-step 3,5 --delays 1,2 --expiries 5
```

| sd step | threshold | win % (+1 s) | trades/pair-h (+1 s) |
|---|---|---|---|
| 3 | 0.75 | 57.90 | 366.6 |
| 3 | 1 | 58.63 | 308.6 |
| 3 | 1.25 | 59.22 | 253.0 |
| 5 | 0.75 | 57.96 | 368.9 |
| **5** | **1** | **58.77** | **311.2** |
| 5 | 1.25 | 59.28 | 256.3 |

`H1_R1_PARAMS = { moveSec: 3, sdWindowSec: 300, sdStepSec: 5, threshold: 1 }`: 311.2 trades/pair-h
at 58.77 % (0.27 pp from the analysis). The whole table (a) is on #669's PR. A shadow row of the
trade log (`version: h1`) is read by `parseJournalLine` as `{ kind: 'h1', entry }` and decided
again by `replayH1Entry` ([h1.md](h1.md#replay-and-reading)); `calibrate` counts such a line as
`h1_shadow`, apart from lines of an unknown version.

## Calibration

The owner exports two files from the pilot's compose directory with the trade log's export
(#666, [trade-log.md](trade-log.md#the-export)): the decisions as journal lines and the closed
session trades. `--from` is the start of the period; `--silent` keeps pnpm's own banner out of the
files.

```bash
docker compose exec -T backend pnpm --silent --filter @binarius/backend trade-log export --from 2026-10-20T00:00:00Z > trade-log.jsonl
docker compose exec -T backend pnpm --silent --filter @binarius/backend trade-log export --from 2026-10-20T00:00:00Z --format trades-json > trades.json
STAND_DIR=~/binarius-stand/stand pnpm --filter @binarius/signal-stand stand calibrate --journal trade-log.jsonl --trades trades.json --session-candles ~/binarius-stand/candles
```

The trade log holds decisions from its deploy on. The #381 files (`journal-381.jsonl` from
`docker compose logs … | grep -F '"msg":"signal decision"'`, `trades-381.json` from the psql query
of `~/binarius-stand/export_trades.sh`) read the same way: a log line and an export line both carry
the entry under `signal`, and the trades of both files pass `tradeLogTradeJsonSchema`
(`calibrate.test.ts` C1 the log, C12 the export).

**Journal lines.** A line is a pino line or a `trade-log export` line whose `signal` key holds a
journal entry. A bare entry is accepted too. The entry is validated by
`storedSignalJournalEntrySchema` (`packages/shared/src/signal.ts`, the shared schema of
`SignalJournalEntry`/`…V1`, #666), with the decision checked by
`signalDecisionSchema`/`signalDecisionV1Schema`. A line failing that is `malformed_line`, and a
`version` that is neither v1 nor v2 is `unsupported_version`. A shadow row of the H1 shadow
(`version: h1`, #669) is parsed by `h1ShadowEntrySchema` into `{ kind: 'h1', entry }` (a broken one
is `malformed_line`); `calibrate` compares candle decisions with session trades and counts it as
`h1_shadow`. The trades file is validated by `tradeLogTradeJsonSchema` (`packages/shared/src/trade-log.ts`).

**Session files** (`--session-candles`) are the owner's raw `1s` rows per session:
`{session, asset_id, interval, start_time, limit, rows}`. A file failing `candlesWireSchema` is
`malformed_session_file`. These files are a second source of prices:
- For each file, the rows are compared with the cache rows of the same asset and timestamps. An
  equal file counts `price_series_match`. Any OHLC difference counts `price_series_revised`,
  printed with the first differing timestamp. Rows the cache lacks are `price_rows_not_in_cache`,
  not revisions, and a file with no row compared counts only `price_files_not_compared`, never
  `price_series_match`. A file's first row is not compared: it is its answer's first row, whose `open` is
  the window's first tick (The cache → the first-row rule).
- A price comes from the cache first. When the cache lacks the row, it comes from the session
  files (`priced_from_session_file`). With neither, the trade is `unpriced`.

**Version eras.** A trade's era is set by its `created_at`:
- `v1` before `V2_MERGED_AT` (#379's merge, 2026-10-09 16:13 UTC).
- `ambiguous` before `V2_FIRST_CLEAN_AT` (2026-10-10 00:00 UTC). The deploy time is unknown, so
  these trades are counted and left out of every comparison.
- `v2` from then on.

A matched line whose version is not its trade's era counts `version_mismatch`.

**Matching.** For each trade, the stand takes the latest journal line of the same `assetId` and
`intervalForDuration(duration_sec)` whose `nowMs` is at or before `created_at` and within
`ATTEMPT_WINDOW_MS`. This may be the scanner's line for the same candle. A trade with no such
line is `unmatched`. For each matched trade, the stand checks:
- `replaySignalJournalEntry(entry)` deep-equals the logged decision, and its action is the
  trade's (`replayed` / `replay_mismatch`).
- The line's closed candles equal the cache's interval rows at the same timestamps
  (`series_match` / `series_revised`). The forming row is skipped because it was not final when
  logged, and so is the first row, the first row of the feed's answer. Rows the cache lacks are
  `series_rows_not_in_cache`, and a line with no row compared counts only
  `series_lines_not_compared`.
- The delays `open_timestamp − created_at` and `open_timestamp − nowMs`.

**The refusal.** Before any gate, every asset of a non-ambiguous trade needs its `pairs.json`
entry and a non-empty cached `1s` series and series of each interval its trades use. Otherwise
`calibrate` names every missing one (`<id>: not in pairs.json`, `<id>: no 5s series`) with
"fetch it first", exits 1 and writes nothing. A trade whose duration has no `TRADE_INTERVALS`
entry counts `unsupported_duration`; it stays in gate 2 and the delay choice, and in no era.

**The pass rule.** Exit 0 needs all three gates:
1. `series_revised` = 0 and `price_series_revised` = 0, with at least one session file and one
   journal line compared (a `*_match` or `*_revised` count above 0). Nothing compared is
   "FAIL no revision evidence". A revised history invalidates the stand.
2. The outcome match is at least `CALIBRATE_MIN_OUTCOME_MATCH_PCT` (85 %) of the priced trades.
   The match is the sign of `close − open`, priced at the trade's own timestamps shifted by `k`,
   in the trade's direction, against the sign of `profit`. `k` is in `{−1000, 0, +1000}`, and the
   best `k` counts.
3. For each era × duration with at least `CALIBRATE_MIN_ERA_TRADES` (30) live trades, the live
   win rate lies inside the Wilson interval of the stand's own rate. The stand's rate comes from
   v1, or v2 at 15/5 with the pause, simulated inside each session's window: from its first
   `created_at` to its last `close_timestamp`, at the headline delay. A gated row whose stand
   has no win or loss is "FAIL no stand evidence": an empty sample's interval would hold any
   rate. Smaller rows are reported, not gated.

The totals print in this order: revisions, outcome match, per-era comparison, the delay choice,
the delay distributions, the price error in ticks per `k` (`× 10^digits`), and the counters.

**The headline delay.** For every priced, non-ambiguous trade and each `openDelay` in the grid,
the stand prices `entry = created_at + openDelay` and `exit = entry + duration`. It then compares
the simulated outcome with the sign of `profit`. `created_at` stands in for the decision moment:
the intent is created right after the decision. Since #666 the gap is in the trade log
(`decision.decidedAtMs`/`takenAtMs` of the export line); calibrate does not read it yet.
The delay with the highest match share wins, and a tie goes to the smaller delay. A trade
unpriced at one delay leaves only that delay's denominator. `calibrate` writes the choice to
`$STAND_DIR/calibration.json` on PASS, which `run` reads. Gate 3 compares the stand at this
delay; gates 1 and 2 do not depend on it. A FAIL saves nothing, so an earlier PASS's file stays,
with its own date in `run`'s delay origin.

## Pairs

These are the 28 ids of `STAND_ASSET_IDS`: the 27 that the live sessions traded, plus USD/CHF.
The symbols and payouts below are a 2026-10-15 snapshot for reading. The stand uses its own
`pairs.json`.

| id | symbol | type | digits | payout |
|---|---|---|---|---|
| 237831086 | NZD/USD | currency | 5 | 96 |
| 364060136 | GBP/USD | currency | 5 | 96 |
| 759228819 | USD/JPY | currency | 3 | 96 |
| 1430524430 | AUD/USD | currency | 5 | 96 |
| 1605169136 | EUR/USD | currency | 5 | 96 |
| 1775154181 | USD/CAD | currency | 5 | 96 |
| 2025372713 | USD/CHF | currency | 5 | 96 |
| 170776436 | XRP | cryptocurrency | 4 | 90 |
| 902971489 | ETH | cryptocurrency | 2 | 92 |
| 210684974 | BTC | cryptocurrency | 2 | 87 |
| 1357020902 | SOL | cryptocurrency | 2 | 89 |
| 1492698122 | AIGENSYN | cryptocurrency | 5 | 78 |
| 1493041974 | 1000PEPE | cryptocurrency | 7 | 55 |
| 1560777949 | 1000BONK | cryptocurrency | 7 | 55 |
| 561905183 | I:DJI | index | 2 | 86 |
| 993131238 | I:SPX | index | 2 | 87 |
| 202036987 | I:SOX | index | 2 | 84 |
| 901627288 | I:OEX | index | 2 | 89 |
| 905901932 | I:NDX | index | 2 | 90 |
| 1080246146 | I:COMP | index | 2 | 86 |
| 1786057035 | I:RUT | index | 2 | 90 |
| 1988152589 | I:DJT | index | 2 | 84 |
| 37439809 | SNDK | stock | 2 | 82 |
| 539345642 | MU | stock | 2 | 82 |
| 727957842 | NVDA | stock | 2 | 84 |
| 1202345528 | INTC | stock | 2 | 81 |
| 1798757939 | CRCL | stock | 2 | 84 |
| 2126847458 | XAG | commodity | 2 | 79 |

Four of them pay below 80 (1000PEPE, 1000BONK, AIGENSYN and XAG). They get their own rows and stay
out of pooling.

## Observed live

- **2026-10-09.** `1s` answered 5 000 rows, and `500ms` answered `[]` (2026-10-03). The mock
  broker answers from a 1 s step (`MIN_CANDLE_STEP_MS`). The broker keeps `open_{n+1} = close_n`.
  The close of a `5s` candle equals the close of the `1s` row labelled `t + 5 s` in 961 of 1 000
  cases.
- **2026-10-15, depth.** `1s` and `5s` answer from 720 h back, and 721 h back answers `[]`.
  `15s` and `1m` answer from a day later.
- **2026-10-15, paging.** A request answers the time window
  `[start_time, start_time + limit × step)`. Gaps shorten the page: a `15s` page of NZD/USD held
  4 971 rows across 5 000 steps, with nine 60-90 s holes. A gap longer than the window answers
  `[]`. The pager therefore starts the next window after the page's last row, or after the whole
  window when the page was empty. It does not stop on a short page.
- **2026-10-15, first rows.** A first cache of 11 pairs was compared with the owner's 102 session
  files. All 68 differing rows differed only in `open`. 52 were the first row of a session file,
  and the other 16 fell exactly on the cache's own page starts. The cache was fetched again with
  the first-row rule above.
- **2026-10-15, the owner's trades export** (#381, the plan's export query). For all 495 trades:
  - `open_price` equals the close of the `1s` row at `floor(open_timestamp)` in 232 trades, and
    at `floor(open_timestamp) + 1 s` in 148.
  - The outcome from the `1s` row at `floor(ts)` matched the sign of `profit` in 443 of 494
    trades.
  - `open_timestamp − created_at` has a median of 397 ms and a p95 of 927 ms.
  - The journal's `nowMs` falls about 0.5 s after the candle boundary (the backend feed's moment).
    That is the scanner's moment, not the session's `D`: sessions ask at the boundary + 2 s
    (`DECISION_SLACK_MS`).
- **2026-10-15, journal shape.** Every line is a pino line with `signal`, and every entry is `v2`
  with `digits`.

## Accepted risks

1. **Copied constants.** The three worker constants above are copies. This is falsifiable:
   `grep -n 'TRADING_SESSION_CANDLE_SLACK_MS\|TRADING_SESSION_TICK_MS\|TRADING_SESSION_ATTEMPT_TIMEOUT_MS' apps/trading-worker/src/trading-session/config.ts`
   would show other values.
2. **The `1s` price is a one-second bucket, not the broker's tick.** `calibrate` prints the error
   in ticks per `k`.
3. **The broker may revise history.** Revisions are the first total, and any revision fails
   `calibrate`.
4. **Sessions of five are not modelled.** The pause streak runs across what would be session
   boundaries, and the stake is a fixed 1. PnL is illustrative.
5. **Payout at fetch time.** Pooling and the per-pair break-even use `pairs.json`'s payout, not
   the payout at each trade.
6. **Lucky in-sample points.** In-sample selection over 9 points may pick a lucky one. The
   out-of-sample part, untouched by the selection, is the headline.
7. **History depth is an observation, not a contract.** Thirty days were observed on 2026-10-15.
   This is falsifiable by `fetch --days 14` returning a first `5s` row more than an hour after
   `since`.
8. **One process per `$STAND_DIR`.** There is no lock file.
9. **Non-overlapping trades under-use the data.** No per-candle hit rate is reported, because it
   would count correlated, overlapping trades as independent.
10. **One row may be lost after a long gap** (the first-row rule above). That row then shows up
    as a `candle_gap` or an unpriced trade, never as a guessed value.
11. **The era cut is the merge time, not the deploy time.** A v2 deploy later than 10-10 00:00
    UTC would mislabel v1 trades as v2.
12. **The 85 % floor comes from one sample** (443/494). A sample below it fails `calibrate`, and
    the floor is not lowered silently.
13. **The mock broker pages differently.** It caps a page by rows, not by the time window. The
    pager's next-window rule is right under both: `fetch.test.ts` F1 runs on the mock, and F1b
    runs on a time-window fake with a long gap.
14. **Display indicators on the cache against production's answer.** Production computes them on
    the broker's 300-row answer, whose first row's `open` is the window's first tick (The cache);
    that row can fail the candle checks and cut the tail by one row. MACD and MA read closes only
    and need at most 200 of the 299 closed rows, so the values are the same. Stated, not tested.
15. **`trades/pair-h` is a non-stop simulated session's cadence** (one trade at a time, settle tick
    5 s), not the length of the scanner's list. Falsifiable: the scanner's signals per minute in
    its log against the stand's rate × the scanned pairs / 60.
16. **Selection among 2, 3 or 6 points may pick a lucky in-sample point** (as risk 6). Table (h)
    prints every point, and «added» needs the same point `better` on both intervals.
17. **The 10 % floor is a product choice made before the data**, a constant, not derived from
    the cache.

## Boundaries

- #379 (merged): v2 and its two parameters. The stand tunes them, and the change of production's
  values is #379's follow-up, not here.
- #380: `v2+1m` and the 60 s trades are its two variants.
- #392: socket candles could fill the same cache format later.
- #483: `v2+macd`, `v2+ma` and `v2+macd+ma` (Variants) and table (h)'s verdict; the run's
  numbers and the decision are in [signal.md](signal.md#macd-and-ma-on-history-483). The run of
  2026-10-17 found every point `inconclusive` on 5s and 15s: no indicator is added and no
  Signal v3 task is created.
- #667: the H1 detector and `stand h1`. #669: the R1 grid and point, and the live 1s series from
  ticks with the shadow's rows ([h1.md](h1.md)); #681 reports the shadow; #670 runs H1 sessions on
  a marked account.
- #313: 5 s and 15 s trades are analysed on their own candles, never on `1m`. `v2+1m` adds the
  `1m` trend as a confirmation, not as the analysis interval.
