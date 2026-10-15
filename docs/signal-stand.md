# Signal stand (#381)

`packages/signal-stand` backtests the Signal decider on the broker's candle history. It is a CLI
with two commands. `fetch` caches candles from the public chart API. `run` replays the variants
below on that cache and writes a report. The second part of #381 adds `calibrate`, which checks the
stand against the live sessions' trades and journal, together with the `v2+1m` and 60 s variants.
No process imports the package: no `apps/*` manifest names it, and
`grep -rn signal-stand apps/` is empty. It reuses production code unchanged:
- `createBrokerRestClient().getChart`/`listPairs`, with the wire parser;
- `chartWindow` and `SIGNAL_CHART_LIMIT`;
- `createSignalDecider`/`createSignalDeciderV1`;
- `breakEvenPct`, `MIN_CYCLE_PAYOUT_PCT` and `PAIR_TYPE_GROUPS`.

The stand computes no indicator of its own. Every variant reads a production decider's decision.

The report and the cache stay outside the repository. A run's summary goes to #381 as a comment.

## Commands

From the repository root, under the project's Node (`eval "$(fnm env)" && fnm use`):

```bash
export STAND_DIR=~/binarius-stand/stand            # required; missing or empty is a usage error
BROKER_API_BASE_URL=https://api.binodex.app pnpm --filter @binarius/signal-stand stand fetch
pnpm --filter @binarius/signal-stand stand run      # -> $STAND_DIR/out/<timestamp>/report.md
```

| Command | Options (defaults) | Env |
|---|---|---|
| `fetch` | `--assets <id,…>` (`STAND_ASSET_IDS`, the 28 below), `--days <1-30>` (`STAND_DEFAULT_DAYS` 14), `--intervals` (`1s,5s,15s,1m`) | `BROKER_API_BASE_URL` (https, or http to localhost); `STAND_MAX_GETS_PER_MINUTE` (1..600, default 120) |
| `run` | `--assets` (the 28), `--out <dir>` (`$STAND_DIR/out/<ISO time>`), `--headline-delay <0\|1000\|3000>` | — |

The exit codes are:
- 0: done.
- 1: a refusal. This covers a failed fetch, a damaged cache and an asset missing from
  `pairs.json`.
- 2: a usage error. This covers an unknown command or option, a value out of range and a missing
  env.

Progress and refusals go to stderr as plain lines. A broker error is printed as its name, code,
status and `retryAfterSec`, never with its URL or body (Rule 8). The chart and pairs endpoints take
no token, and the stand reads none.

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
  out/<run>/report.md, report.json
```

- **Appending.** A page is appended after it was parsed. The forming candle is never stored,
  because its close is not final and a stored row is never fetched again. Only rows with
  `timestamp + step <= now` at the answer are kept.
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

The trade intervals and their durations are `5s` with 5 s and `15s` with 15 s. `fetch` also
caches `1m`, which the second part's `v2+1m` and 60 s variants read.

**The pause overlay** is Rule 28's rule, `pausedDirection` in the orchestrator. Suppose the last
two priced trades lost in one direction, and the last decision was that same direction. A new
decision in that direction is then skipped and counted as `pause_after_two_losses`. Any no-signal
or opposite decision clears the pause. A tie breaks the streak, and an unpriced trade is skipped
by it. Every variant runs with and without the pause.

## Pricing

`priceAt(ms)` is the close of the `1s` row labelled `floor(ms / 1000) × 1000`. A missing row
leaves the trade `unpriced`: it is counted and excluded from the rate. The stand never takes the
nearest row.

Outcomes work as follows:
- `up` wins when `exit > entry`, and `down` wins when `exit < entry`.
- An equal exit is a tie: the stake comes back, and the trade is neither a win nor a loss.
- The rate is `wins / (wins + losses)`.
- PnL at stake 1 is `+payout/100` per win, `−1` per loss and 0 per tie. It is illustrative only.

`openDelay` takes values from the grid `OPEN_DELAY_GRID_MS = [0, 1000, 3000]`. With `openDelay`
0, the entry is the close of the last closed candle, which is the interval-candle model
(`price.test.ts` P3). The headline delay is `--headline-delay`, or 3 000 ms (the plan's live
estimate: 2 s slack plus 0.5-1 s to open). The second part's `calibrate` chooses it from the live
trades.

## Variants

| Variant | Intervals | Grid | Headline pause |
|---|---|---|---|
| `v1` | 5s, 15s | — | off (v1 had none) |
| `v2` | 5s, 15s | `rsiExtremeBand` {10, 15, 20} × `minAtrTicks` {3, 5, 8} | on (production) |
| `revert` | 5s, 15s | `band` {10, 15, 20} | on |

- **`v1`** is `createSignalDeciderV1(DEFAULT_SIGNAL_PARAMS_V1)`, the reference.
- **`v2`** is `createSignalDecider({ ...DEFAULT_SIGNAL_PARAMS, rsiExtremeBand, minAtrTicks })`,
  with `digits` from `pairs.json`. Every grid point passes `assertSignalParams` (V9). The point
  15/5 is production: it is always reported, selected or not. At that point the stand's decision
  equals `createSignalDecider()`'s on the fixture (V2).
- **`revert`** trades against the rush. It reads `v2`'s decision at the default point. A data
  refusal or a volatility refusal (`volatility_too_low/high`, `volatility_below_tick_floor`)
  means no trade. Otherwise `rsi ≥ 50 + band` means `down` and `rsi ≤ 50 − band` means `up`; the
  EMA trend is ignored.
A variant's window length is `seriesAt`'s `limit` parameter (default `SIGNAL_CHART_LIMIT`). A
variant needing a longer history, such as #483's MA200, plugs in without touching the simulator.

## Statistics

- The win rate's 95 % interval is Wilson's (`z = 1.959964`). Its reference values are
  `8/30 → [14.2, 44.4]`, `0/10 → [0, 27.8]` and `180/300 → [54.4, 65.4]` (T1).
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

## Reading the report

`report.md` has seven tables, and `report.json` holds every number they print. `run` prints table
(a) to stdout. Each row shows the interval, variant, parameters, pause, delay, scope, trades,
W/L/T, win %, its interval, break-even, verdict and PnL.

- **(a) Headline.** The selected point of each variant and interval, out-of-sample, pooled. `v2`
  also gets the production point.
- **(b) Per pair**, grouped by pair type (`PAIR_TYPE_GROUPS`). These rows use the pair's own
  payout and break-even. The scope column also gives the pair's trade count over the whole range.
  Acceptance criterion 1 reads this column: at least 300 trades per pair and interval.
- **(c)** The selected points at each `openDelay`.
- **(d)** The selected points with the pause off and on. This table answers whether the pause
  helps.
- **(e)** The refusal shares by reason, over the whole range, for each selected point.
- **(f)** The full in-sample grid, pooled. Selection reads it.
- **(g)** The pairs snapshot (`fetchedAt`), and each series' rows, first and last timestamp.

The header names the range, the split, the headline delay and where that delay came from: the
`--headline-delay` flag or the fallback 3 000 ms. It also names the pairs left out of pooling.

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
- **2026-10-15, the owner's trades export** (#381, the plan's export query). For all 495 trades:
  - `open_price` equals the close of the `1s` row at `floor(open_timestamp)` in 232 trades, and
    at `floor(open_timestamp) + 1 s` in 148.
  - The outcome from the `1s` row at `floor(ts)` matched the sign of `profit` in 443 of 494
    trades.
  - `open_timestamp − created_at` has a median of 397 ms and a p95 of 927 ms.

## Accepted risks

1. **Copied constants.** The two worker constants above are copies. This is falsifiable:
   `grep -n 'TRADING_SESSION_CANDLE_SLACK_MS\|TRADING_SESSION_TICK_MS' apps/trading-worker/src/trading-session/config.ts`
   would show other values.
2. **The `1s` price is a one-second bucket, not the broker's tick.** The second part's
   `calibrate` measures the error against the live trades.
3. **The broker may revise history.** The second part's `calibrate` compares the cache with the
   live journal and the owner's session files.
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
10. **The mock broker pages differently.** It caps a page by rows, not by the time window. The
    pager's next-window rule is right under both: `fetch.test.ts` F1 runs on the mock, and F1b
    runs on a time-window fake with a long gap.

## Boundaries

- #379 (merged): v2 and its two parameters. The stand tunes them, and the change of production's
  values is #379's follow-up, not here.
- #380: `v2+1m` and the 60 s trades are its two variants, in the second part.
- #392: socket candles could fill the same cache format later.
- #483: more variants (MACD, MA50/MA200) through `seriesAt`'s `limit`.
- #313: 5 s and 15 s trades are analysed on their own candles, never on `1m`.
